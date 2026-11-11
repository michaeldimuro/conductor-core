import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServices } from '../../src/daemon/compose.js';
import { MemorySecretStore } from '../../src/kernel/index.js';

/**
 * Crash safety, end to end: a real daemon process (the real composition root)
 * is SIGKILLed while a real forked run worker is executing a real agent
 * process. The services are then started again on the same home.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/crash-daemon.ts', import.meta.url));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms: number, what: string): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('end-to-end: daemon killed mid-run, services restarted on the same home', () => {
  let home: string;
  let scratch: string;
  let daemon: ChildProcess | null = null;
  let s: Awaited<ReturnType<typeof createServices>> | null = null;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'conductor-restart-'));
    // The agent process is sandboxed to its workspace + temp dirs; its signal files live outside the daemon home.
    scratch = mkdtempSync(join(tmpdir(), 'conductor-restart-flags-'));
  });
  afterAll(async () => {
    daemon?.kill('SIGKILL');
    await s?.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it('journals the interrupted run as crashed, releases its issue, and the issue is worked again to completion', async () => {
    const marker = join(scratch, 'marker.json');
    const flag = join(scratch, 'restarted.flag');
    const started = join(scratch, 'agent-started');
    let stderr = '';
    daemon = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), FIXTURE, home, marker, flag, started], {
      stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CONDUCTOR_LOG_LEVEL: 'silent' },
    });
    daemon.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<void>((resolve) => daemon!.once('exit', () => resolve()));

    await until(() => existsSync(marker) || daemon!.exitCode !== null, 60_000, 'the first daemon to get a run in flight').catch((e) => {
      throw new Error(`${(e as Error).message}\n${stderr.slice(-2000)}`);
    });
    expect(existsSync(marker), `daemon exited early:\n${stderr.slice(-2000)}`).toBe(true);
    const m = JSON.parse(readFileSync(marker, 'utf8')) as { orgId: string; agentId: string; issueId: string; runId: string; workerPid: number; daemonPid: number };
    expect(alive(m.workerPid)).toBe(true);

    // ── Kill the daemon mid-run: no shutdown hooks, nothing gets to clean up. ──
    daemon.kill('SIGKILL');
    await exited;

    // ── Restart on the same home. ──
    writeFileSync(flag, 'restarted');
    s = await createServices({
      home, secrets: new MemorySecretStore(), config: { port: 1, host: '127.0.0.1' },
      runtime: { tickMs: 0, systemJobs: false, powerAssertion: false },
    });
    // What the dead daemon left behind: a run that still claims to be running and a locked issue.
    expect(s.runtime.getRun(m.orgId, m.runId)).toMatchObject({ status: 'running', phase: 'execute' });
    expect(s.work.getIssue(m.orgId, m.issueId)).toMatchObject({ status: 'in_progress', checkoutLock: m.runId });

    await s.runtime.start();

    // Recovery: the run is journaled as crashed, its token is dead, the issue is released with a note.
    expect(s.runtime.getRun(m.orgId, m.runId)).toMatchObject({ status: 'failed', outcome: 'crashed', pid: null });
    const released = s.work.getIssue(m.orgId, m.issueId);
    expect(released.checkoutLock).toBeNull();
    expect(released.status).toBe('todo');
    expect(s.work.listComments(m.orgId, m.issueId).some((c) => /interrupted by a daemon restart/.test(c.body))).toBe(true);
    expect(s.kernel.audit.query({ orgId: m.orgId, action: 'run.recovered', runId: m.runId })).toHaveLength(1);
    // The orphaned worker does not outlive its daemon.
    await until(() => !alive(m.workerPid), 10_000, 'the orphaned worker to exit');

    // The released issue is picked up again — the agent has no heartbeat, the recovery wake does it.
    const deadline = Date.now() + 30_000;
    for (;;) {
      await s.runtime.tick();
      await s.runtime.idle();
      const due = (s.kernel.sqlite.prepare("select count(*) as n from jobs where status = 'pending' and run_at <= ?").get(Date.now()) as { n: number }).n;
      if (due === 0 && s.runtime.status().running === 0) break;
      if (Date.now() > deadline) throw new Error('drain timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
    const runs = s.runtime.listRuns(m.orgId, { issueId: m.issueId });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ status: 'succeeded', outcome: 'completed', provider: 'process' });
    expect(runs[0]!.id).not.toBe(m.runId);
    const done = s.work.getIssue(m.orgId, m.issueId);
    expect(done).toMatchObject({ status: 'done', checkoutLock: null });
    expect(s.work.listComments(m.orgId, m.issueId).some((c) => c.body.includes('finished after restart'))).toBe(true);
    // Nothing is left in flight.
    expect(s.runtime.listRuns(m.orgId).filter((r) => ['queued', 'running', 'paused'].includes(r.status))).toHaveLength(0);
  }, 150_000);
});
