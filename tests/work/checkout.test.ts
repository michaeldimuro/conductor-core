import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkService } from '../../src/contracts/org-work.js';
import { OWNER } from '../../src/contracts/types.js';
import { issues } from '../../src/db/schema/index.js';
import { eq } from 'drizzle-orm';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { as, codeOf, recordEvents, setup, type Fixture } from './helpers.js';

const WORKER = fileURLToPath(new URL('./checkout-worker.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface WorkerReport {
  winners: string[];
  numbers: number[];
  attempts: number;
}

/**
 * Start `count` real OS processes, each with its own connection to the same
 * SQLite file; release them at one shared instant and collect their reports.
 */
async function race(k: TestKernel, orgId: string, mode: 'checkout' | 'create', target: string, count: number, attempts: number): Promise<WorkerReport[]> {
  const children: ChildProcess[] = [];
  try {
    const ready: Array<Promise<void>> = [];
    const reports: Array<Promise<WorkerReport>> = [];
    for (let i = 0; i < count; i++) {
      const child = fork(WORKER, [k.paths.home, orgId, mode, target, `p${i}`, String(attempts)], {
        cwd: REPO_ROOT,
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      let markReady!: () => void;
      ready.push(new Promise<void>((res) => (markReady = res)));
      reports.push(
        new Promise<WorkerReport>((res, rej) => {
          child.on('message', (m: { ready?: boolean } & Partial<WorkerReport>) => {
            if (m.ready) markReady();
            else res(m as WorkerReport);
          });
          child.on('error', rej);
          child.on('exit', (code) => {
            if (code !== 0) rej(new Error(`worker ${i} exited with code ${code}`));
          });
        }),
      );
    }
    await Promise.race([Promise.all(ready), Promise.all(reports)]);
    const startAt = Date.now() + 200;
    for (const child of children) child.send({ startAt });
    return await Promise.all(reports);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}

describe('work: atomic checkout (FR-4)', () => {
  let k: TestKernel;
  let work: WorkService;
  let f: Fixture;
  beforeEach(() => {
    k = createTestKernel();
    ({ work, f } = setup(k));
  });
  afterEach(() => k.dispose());

  it('50 parallel in-process attempts yield exactly one owner', async () => {
    const issue = work.createIssue(f.org.id, { title: 'Contended', assigneeAgentId: f.dev.id }, OWNER);
    const events = recordEvents(k);
    const results = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => ({ runId: `run_${i}`, won: work.checkout(f.org.id, issue.id, `run_${i}`) })),
    );
    const winners = results.filter((r) => r.won);
    expect(winners).toHaveLength(1);
    const after = work.getIssue(f.org.id, issue.id);
    expect(after).toMatchObject({ checkoutLock: winners[0]!.runId, status: 'in_progress', checkoutAt: k.clock.now() });
    expect(events.of('issue.updated')).toEqual([{ orgId: f.org.id, issueId: issue.id, status: 'in_progress' }]);
    const audit = k.audit.query({ orgId: f.org.id, issueId: issue.id, action: 'issue.checked_out' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ runId: winners[0]!.runId });
  });

  it('50 attempts across 5 real processes on the same DB file yield exactly one owner overall', async () => {
    const issue = work.createIssue(f.org.id, { title: 'Contended across connections', assigneeAgentId: f.dev.id }, OWNER);
    const reports = await race(k, f.org.id, 'checkout', issue.id, 5, 10);

    expect(reports.reduce((n, r) => n + r.attempts, 0)).toBe(50);
    const winners = reports.flatMap((r) => r.winners);
    expect(winners).toHaveLength(1);
    const after = work.getIssue(f.org.id, issue.id);
    expect(after.checkoutLock).toBe(winners[0]);
    expect(after.status).toBe('in_progress');
    // The parent's own connection loses too.
    expect(work.checkout(f.org.id, issue.id, 'run_parent')).toBe(false);
  }, 60_000);

  it('allocates unique issue numbers across concurrent connections', async () => {
    const reports = await race(k, f.org.id, 'create', 'Bulk', 4, 25);
    const numbers = reports.flatMap((r) => r.numbers).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    const stored = k.db.select({ n: issues.number }).from(issues).where(eq(issues.orgId, f.org.id)).all();
    expect(new Set(stored.map((r) => r.n)).size).toBe(100);
  }, 60_000);

  it('only checks out workable issues: right org, workable status, blockers done', () => {
    const backlog = work.createIssue(f.org.id, { title: 'Backlog' }, OWNER);
    const blocker = work.createIssue(f.org.id, { title: 'First', assigneeAgentId: f.dev.id }, OWNER);
    const gated = work.createIssue(f.org.id, { title: 'Second', assigneeAgentId: f.dev.id, blockedBy: [blocker.id] }, OWNER);
    const blocked = work.createIssue(f.org.id, { title: 'Blocked', assigneeAgentId: f.dev.id, status: 'blocked' }, OWNER);

    expect(work.checkout(f.org.id, backlog.id, 'run_a')).toBe(false);
    expect(work.checkout(f.org.id, blocked.id, 'run_a')).toBe(false);
    expect(work.checkout(f.org.id, 'iss_missing', 'run_a')).toBe(false);
    expect(work.checkout(f.org.id, gated.id, 'run_a')).toBe(false);
    expect(work.getIssue(f.org.id, gated.id)).toMatchObject({ checkoutLock: null, status: 'todo' });
    expect(codeOf(() => work.checkout(f.org.id, gated.id, ''))).toBe('validation');

    expect(work.checkout(f.org.id, blocker.id, 'run_a')).toBe(true);
    work.updateIssue(f.org.id, blocker.id, { status: 'done' }, as(f.dev, 'run_a'));
    expect(work.checkout(f.org.id, gated.id, 'run_b')).toBe(true);
    // A done issue cannot be checked out even once its lock is released.
    work.release(f.org.id, blocker.id, 'run_a');
    expect(work.checkout(f.org.id, blocker.id, 'run_c')).toBe(false);
  });

  it('release frees the lock for its holder only and can set a status', () => {
    const issue = work.createIssue(f.org.id, { title: 'Hold', assigneeAgentId: f.dev.id }, OWNER);
    expect(work.checkout(f.org.id, issue.id, 'run_a')).toBe(true);

    work.release(f.org.id, issue.id, 'run_intruder', { status: 'todo' });
    expect(work.getIssue(f.org.id, issue.id)).toMatchObject({ checkoutLock: 'run_a', status: 'in_progress' });

    work.release(f.org.id, issue.id, 'run_a', { status: 'blocked', blockedReason: 'needs_human' });
    expect(work.getIssue(f.org.id, issue.id)).toMatchObject({
      checkoutLock: null, checkoutAt: null, status: 'blocked', blockedReason: 'needs_human',
    });
    expect(k.audit.query({ issueId: issue.id, action: 'issue.released' })).toHaveLength(1);

    work.updateIssue(f.org.id, issue.id, { status: 'todo' }, OWNER);
    expect(work.checkout(f.org.id, issue.id, 'run_b')).toBe(true);
    work.release(f.org.id, issue.id, 'run_b');
    // Released without a status: still in_progress, and workable again.
    expect(work.getIssue(f.org.id, issue.id)).toMatchObject({ checkoutLock: null, status: 'in_progress' });
    expect(work.checkout(f.org.id, issue.id, 'run_c')).toBe(true);
  });

  it('release never reopens work the run already closed', () => {
    const issue = work.createIssue(f.org.id, { title: 'Finish', assigneeAgentId: f.dev.id }, OWNER);
    work.checkout(f.org.id, issue.id, 'run_a');
    work.updateIssue(f.org.id, issue.id, { status: 'done' }, as(f.dev, 'run_a'));
    work.release(f.org.id, issue.id, 'run_a', { status: 'todo' });
    expect(work.getIssue(f.org.id, issue.id)).toMatchObject({ checkoutLock: null, status: 'done' });
  });

  it('releaseAllForRun frees every lock of a crashed run, returning in-flight work to todo', () => {
    const mk = (title: string) => work.createIssue(f.org.id, { title, assigneeAgentId: f.dev.id }, OWNER);
    const [inFlight, reviewed, other] = [mk('in flight'), mk('reported'), mk('someone else')];
    work.checkout(f.org.id, inFlight!.id, 'run_crash');
    work.checkout(f.org.id, reviewed!.id, 'run_crash');
    work.updateIssue(f.org.id, reviewed!.id, { status: 'in_review' }, as(f.dev, 'run_crash'));
    work.checkout(f.org.id, other!.id, 'run_alive');

    const released = work.releaseAllForRun(f.org.id, 'run_crash');
    expect(released.sort()).toEqual([inFlight!.id, reviewed!.id].sort());
    expect(work.getIssue(f.org.id, inFlight!.id)).toMatchObject({ checkoutLock: null, status: 'todo' });
    expect(work.getIssue(f.org.id, reviewed!.id)).toMatchObject({ checkoutLock: null, status: 'in_review' });
    expect(work.getIssue(f.org.id, other!.id)).toMatchObject({ checkoutLock: 'run_alive', status: 'in_progress' });
    expect(work.releaseAllForRun(f.org.id, 'run_crash')).toEqual([]);

    work.checkout(f.org.id, inFlight!.id, 'run_2');
    expect(work.releaseAllForRun(f.org.id, 'run_2', 'blocked')).toEqual([inFlight!.id]);
    expect(work.getIssue(f.org.id, inFlight!.id).status).toBe('blocked');
  });
});
