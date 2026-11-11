import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { and, eq, lte } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { createGovernance, type GovernanceHandle } from '../../src/governance/index.js';
import { createOrgService } from '../../src/org/index.js';
import { createWorkService } from '../../src/work/index.js';
import { createMemoryService, createUtilityModel, LocalHashEmbedder } from '../../src/memory/index.js';
import { createSkillService } from '../../src/skills/index.js';
import { JobQueue } from '../../src/runtime/jobs.js';
import { nextCron, type JobHandler, type Scheduler } from '../../src/runtime/scheduler.js';
import { registerSystemJobs, SKILL_ADAPT_TASK_TYPE, type SystemJobs } from '../../src/runtime/system-jobs.js';
import type { RuntimeDeps } from '../../src/runtime/types.js';
import type { OrgService, WorkService } from '../../src/contracts/org-work.js';
import type { MemoryService, SkillService } from '../../src/contracts/services.js';
import type { Agent, Department, Organization } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import { jobs, runs, skillUsages, type JobKind } from '../../src/db/schema/index.js';
import type { DomainEvents } from '../../src/shared/events.js';

const DAY = 86_400_000;

interface Rig {
  k: TestKernel;
  governance: GovernanceHandle;
  org: OrgService;
  work: WorkService;
  memory: Record<'consolidate' | 'snapshotScorecards' | 'weeklyReview' | 'reflect', ReturnType<typeof vi.fn>> & Partial<MemoryService>;
  skills: Record<'retireStale' | 'recordUsage' | 'evaluate' | 'activate' | 'get', ReturnType<typeof vi.fn>> & Partial<SkillService>;
  sys: SystemJobs;
  acme: Organization;
  dept: Department;
  ada: Agent;
  pending(key: string): { runAt: number; kind: JobKind; payload: Record<string, unknown> } | undefined;
  /** Run every job due at the current clock, like one scheduler pass. Returns the kinds that ran. */
  runDue(): Promise<string[]>;
  /** Run the pending job with this dedupe key at its scheduled time. */
  fire(key: string): Promise<void>;
}

/** Real kernel, governance, org and work; a minimal scheduler over the real job table. */
function rig(opts: { systemJobs?: boolean; memory?: MemoryService; skills?: SkillService } = {}): Rig {
  const k = createTestKernel();
  const governance = createGovernance(k);
  const org = createOrgService(k, { approvals: governance.approvals });
  const work = createWorkService(k, { org });
  const memory = {
    consolidate: vi.fn(async () => ({ merged: 0, decayed: 0, promotedToSkillDrafts: 0, profileTokens: 0 })),
    snapshotScorecards: vi.fn(() => []),
    weeklyReview: vi.fn(async () => []),
    reflect: vi.fn(),
  } as Rig['memory'];
  const skills = {
    retireStale: vi.fn(async () => ['skl_old']),
    recordUsage: vi.fn(async () => {}),
    evaluate: vi.fn(),
    activate: vi.fn(async () => ({})),
    get: vi.fn(),
  } as Rig['skills'];

  const handlers = new Map<JobKind, JobHandler>();
  const queue = new JobQueue(k, 'test-worker');
  const scheduler = { queue, registerHandler: (kind: JobKind, h: JobHandler) => void handlers.set(kind, h) } as unknown as Scheduler;
  const deps = {
    org, work, governance, memory: (opts.memory ?? memory) as MemoryService, skills: (opts.skills ?? skills) as SkillService,
    options: { systemJobs: opts.systemJobs },
  } as unknown as RuntimeDeps;
  const sys = registerSystemJobs(k, deps, scheduler);

  const acme = org.createOrg({ name: 'Acme', defaultProvider: { adapter: 'fake', model: 'fake-1' }, budgetMonthlyUsd: 100 }, OWNER);
  const dept = org.createDept(acme.id, { name: 'Engineering' }, OWNER);
  const ada = org.hireAgent(acme.id, { deptId: dept.id, name: 'Ada', role: 'Engineer', autonomyLevel: 2 }, OWNER).agent!;

  const runDue = async (): Promise<string[]> => {
    const due = k.db.select().from(jobs).where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, k.clock.now()))).all();
    for (const job of due) {
      k.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job.id)).run();
      await handlers.get(job.kind)?.(job);
    }
    return due.map((j) => j.kind);
  };
  const pending: Rig['pending'] = (key) => k.db.select().from(jobs).where(and(eq(jobs.dedupeKey, key), eq(jobs.status, 'pending'))).get();
  return {
    k, governance, org, work, memory, skills, sys, acme, dept, ada, pending, runDue,
    async fire(key) {
      const job = pending(key);
      if (!job) throw new Error(`no pending job ${key}`);
      k.clock.set(job.runAt);
      await runDue();
    },
  };
}

describe('scheduled system jobs', () => {
  let r: Rig;
  afterEach(() => {
    r.sys.dispose();
    r.governance.dispose();
    r.k.dispose();
  });

  it('registers every recurring job at its next cron time (and none when system jobs are off)', () => {
    r = rig();
    const now = r.k.clock.now();
    const expected: Array<[string, JobKind, string]> = [
      ['sys:dream', 'dream', '0 3 * * *'],
      ['sys:backup', 'backup', '30 3 * * *'],
      ['sys:skill_retire', 'skill_retire', '0 4 * * *'],
      ['sys:digest', 'digest', '30 7 * * *'],
      ['sys:weekly_review', 'weekly_review', '0 8 * * 1'],
      ['sys:governance_sweep', 'dream', '*/15 * * * *'],
    ];
    for (const [key, kind, cron] of expected) expect(r.pending(key), key).toMatchObject({ kind, runAt: nextCron(cron, now) });
    expect(r.pending('sys:governance_sweep')?.payload).toEqual({ task: 'governance_sweep' });

    const off = rig({ systemJobs: false });
    expect(off.k.db.select().from(jobs).all()).toHaveLength(0);
    off.sys.dispose();
    off.governance.dispose();
    off.k.dispose();
  });

  it('nightly backup: VACUUM INTO writes a restorable snapshot, keeps the last 7, audits and re-schedules', async () => {
    r = rig();
    const dir = r.k.paths.ensure(r.k.paths.backups);
    for (let d = 1; d <= 9; d++) writeFileSync(join(dir, `conductor-2020-01-0${d}.db`), 'old');
    writeFileSync(join(dir, 'notes.txt'), 'not a backup');

    await r.fire('sys:backup');
    const stamp = new Date(r.k.clock.now()).toISOString().slice(0, 10);
    const file = join(dir, `conductor-${stamp}.db`);
    expect(existsSync(file)).toBe(true);

    // Restorable: the snapshot opens on its own and holds the data.
    const snap = new Database(file, { readonly: true });
    expect(snap.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(snap.prepare('select name from organizations').all()).toEqual([{ name: 'Acme' }]);
    expect(snap.prepare('select name from agents').all()).toEqual([{ name: 'Ada' }]);
    snap.close();

    const kept = readdirSync(dir).filter((f) => f.startsWith('conductor-')).sort();
    expect(kept).toHaveLength(7);
    expect(kept.at(-1)).toBe(`conductor-${stamp}.db`);
    expect(kept[0]).toBe('conductor-2020-01-04.db');
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(r.k.audit.query({ orgId: null, action: 'backup.created' })[0]?.data).toEqual({ file });
    expect(r.pending('sys:backup')!.runAt).toBe(nextCron('30 3 * * *', r.k.clock.now()));

    // A second backup on the same day replaces the file instead of failing.
    r.k.clock.set(r.pending('sys:backup')!.runAt - DAY + 60_000);
    r.k.db.update(jobs).set({ runAt: r.k.clock.now() }).where(eq(jobs.dedupeKey, 'sys:backup')).run();
    await r.runDue();
    expect(existsSync(file)).toBe(true);
  });

  it('morning digest: one notification per org with runs, spend, closed issues and what waits on the owner', async () => {
    r = rig();
    const notes: Array<DomainEvents['notification']> = [];
    r.k.bus.on('notification', (n) => void (n.kind === 'digest' && notes.push(n)));
    const quiet = r.org.createOrg({ name: 'Globex' }, OWNER);

    const done = r.work.createIssue(r.acme.id, { title: 'Ship the changelog', assigneeAgentId: r.ada.id }, OWNER);
    r.work.updateIssue(r.acme.id, done.id, { status: 'done' }, OWNER);
    r.work.createIssue(r.acme.id, { title: 'Waiting on DNS', assigneeAgentId: r.ada.id, status: 'blocked' }, OWNER);
    r.k.db.insert(runs).values({ id: 'run_d1', orgId: r.acme.id, agentId: r.ada.id, trigger: 'heartbeat', status: 'failed', outcome: 'failed', createdAt: r.k.clock.now() }).run();
    r.governance.budgets.record({ orgId: r.acme.id, agentId: r.ada.id, runId: 'run_d1', category: 'run', provider: 'fake', model: 'fake-1', tokensIn: 10, tokensOut: 5, costUsd: 1.25 });
    r.governance.approvals.request({ orgId: r.acme.id, kind: 'external_send', title: 'Email the customer' });

    await r.fire('sys:digest');
    expect(notes.map((n) => n.orgId).sort()).toEqual([r.acme.id, quiet.id].sort());
    const acme = notes.find((n) => n.orgId === r.acme.id)!;
    expect(acme.title).toBe('Morning digest — Acme');
    expect(acme.body).toContain('Runs: 1 (1 failed) · Spend: $1.25');
    expect(acme.body).toContain('Issues closed: 1');
    expect(acme.body).toContain('Ship the changelog');
    expect(acme.body).toContain('Approvals waiting on you: 1');
    expect(acme.body).toContain('Blocked: 1');
    expect(notes.find((n) => n.orgId === quiet.id)!.body).toContain('Quiet night');
    expect(r.pending('sys:digest')!.runAt).toBe(nextCron('30 7 * * *', r.k.clock.now()));
  });

  it('dream: consolidates every active agent, snapshots scorecards per org, and one failure does not stop the rest', async () => {
    r = rig();
    const bea = r.org.hireAgent(r.acme.id, { deptId: r.dept.id, name: 'Bea', role: 'Engineer' }, OWNER).agent!;
    const cy = r.org.hireAgent(r.acme.id, { deptId: r.dept.id, name: 'Cy', role: 'Engineer' }, OWNER).agent!;
    r.org.pauseAgent(r.acme.id, cy.id, 'manual', OWNER);
    const halted = r.org.createOrg({ name: 'Globex' }, OWNER);
    const hDept = r.org.createDept(halted.id, { name: 'Ops' }, OWNER);
    r.org.hireAgent(halted.id, { deptId: hDept.id, name: 'Hal', role: 'Operator' }, OWNER);
    r.governance.killSwitch.engage(halted.id, OWNER);
    r.memory.consolidate.mockImplementationOnce(async () => {
      throw new Error('consolidation blew up');
    });

    await r.fire('sys:dream');
    // Paused agents and kill-switched orgs are skipped; a throwing agent does not block the next one.
    expect(r.memory.consolidate.mock.calls.map((c) => c[1]).sort()).toEqual([r.ada.id, bea.id].sort());
    expect(r.memory.snapshotScorecards.mock.calls.map((c) => c[0]).sort()).toEqual([r.acme.id, halted.id].sort());
    expect(r.pending('sys:dream')!.runAt).toBe(nextCron('0 3 * * *', r.k.clock.now()));
  });

  it('weekly review and stale-skill retirement run per schedule and re-arm themselves, even after a failure', async () => {
    r = rig();
    const globex = r.org.createOrg({ name: 'Globex' }, OWNER);
    r.memory.weeklyReview.mockImplementationOnce(async () => {
      throw new Error('no work service');
    });
    await r.fire('sys:weekly_review');
    expect(r.memory.weeklyReview.mock.calls.map((c) => c[0]).sort()).toEqual([r.acme.id, globex.id].sort());
    const next = r.pending('sys:weekly_review')!.runAt;
    expect(next).toBe(nextCron('0 8 * * 1', r.k.clock.now()));
    expect(new Date(next).getDay()).toBe(1); // Mondays

    await r.fire('sys:skill_retire');
    expect(r.skills.retireStale).toHaveBeenCalledWith(r.k.clock.now());
    expect(r.pending('sys:skill_retire')!.runAt).toBe(nextCron('0 4 * * *', r.k.clock.now()));

    r.skills.retireStale.mockRejectedValueOnce(new Error('git is busy'));
    await expect(r.fire('sys:skill_retire')).rejects.toThrow('git is busy');
    expect(r.pending('sys:skill_retire')).toBeDefined(); // re-armed in `finally`
  });
});

describe('budget auto-resume and approval expiry', () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });
  afterEach(() => {
    r.sys.dispose();
    r.governance.dispose();
    r.k.dispose();
  });
  const status = () => r.org.getAgent(r.acme.id, r.ada.id);
  const spend = (costUsd: number) =>
    r.governance.budgets.record({ orgId: r.acme.id, agentId: r.ada.id, category: 'run', provider: 'fake', model: 'fake-1', tokensIn: 1, tokensOut: 1, costUsd });

  it('agents paused at 100% resume on the governance sweep after the month rolls over', async () => {
    r.org.updateAgent(r.acme.id, r.ada.id, { budgetUsd: 5 }, OWNER);
    spend(6);
    expect(status()).toMatchObject({ status: 'paused', pausedReason: 'budget' });

    // Same month: the sweep runs but the cap is still exhausted.
    await r.fire('sys:governance_sweep');
    expect(status().status).toBe('paused');
    expect(r.pending('sys:governance_sweep')!.runAt).toBe(nextCron('*/15 * * * *', r.k.clock.now()));

    const resumed: string[] = [];
    r.k.bus.on('agent.resumed', (e) => void resumed.push(e.agentId));
    const d = new Date(r.k.clock.now());
    r.k.clock.set(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 1));
    r.k.db.update(jobs).set({ runAt: r.k.clock.now() }).where(and(eq(jobs.dedupeKey, 'sys:governance_sweep'), eq(jobs.status, 'pending'))).run();
    expect(await r.runDue()).toContain('dream');
    expect(status()).toMatchObject({ status: 'active', pausedReason: null });
    expect(resumed).toEqual([r.ada.id]);
    // The sweep is not the nightly consolidation.
    expect(r.memory.consolidate).not.toHaveBeenCalled();
  });

  it('a cap edit resumes at once; a manual pause is never undone', async () => {
    r.org.updateAgent(r.acme.id, r.ada.id, { budgetUsd: 5 }, OWNER);
    spend(6);
    const bea = r.org.hireAgent(r.acme.id, { deptId: r.dept.id, name: 'Bea', role: 'Engineer' }, OWNER).agent!;
    r.org.pauseAgent(r.acme.id, bea.id, 'manual', OWNER);
    expect(status().status).toBe('paused');

    r.org.updateAgent(r.acme.id, r.ada.id, { budgetUsd: 1000 }, OWNER); // emits agent.updated
    expect(status()).toMatchObject({ status: 'active', pausedReason: null });
    expect(r.org.getAgent(r.acme.id, bea.id).status).toBe('paused');
    expect(r.k.audit.query({ orgId: r.acme.id, action: 'agent.resumed', entityId: r.ada.id })[0]?.data).toMatchObject({ reason: 'budget' });

    // Org-level cap: paused at the org cap, resumed by `budget.updated` / `org.updated` once it is raised.
    spend(120);
    expect(status()).toMatchObject({ status: 'paused', pausedReason: 'budget' });
    r.org.updateOrg(r.acme.id, { budgetMonthlyUsd: 500 }, OWNER);
    expect(status().status).toBe('active');
  });

  it('the sweep also expires approvals past their deadline', async () => {
    const a = r.governance.approvals.request({ orgId: r.acme.id, kind: 'external_send', title: 'Send it', expiresAt: r.k.clock.now() + 60_000 });
    await r.fire('sys:governance_sweep');
    expect(r.governance.approvals.get(r.acme.id, a.id).status).toBe('expired');
  });
});

describe('review verdicts feed the learning loop (real work, memory and skills)', () => {
  let r: Rig;
  let k: TestKernel;
  afterEach(() => {
    r.sys.dispose();
    r.governance.dispose();
    k.dispose();
  });

  it('edited review → run re-graded, skill usage corrected, the agent is asked to patch its skill (once)', async () => {
    // The rig builds its own kernel, so the real memory/skills services are bound to it lazily.
    const live: { memory?: MemoryService; skills?: SkillService } = {};
    const lazy = <T extends object>(get: () => T): T => new Proxy({} as T, { get: (_t, p) => Reflect.get(get(), p) as unknown });
    r = rig({ systemJobs: false, memory: lazy(() => live.memory!), skills: lazy(() => live.skills!) });
    k = r.k;
    const utility = createUtilityModel(k);
    const skillSvc = createSkillService(k, { org: r.org, approvals: r.governance.approvals, utility });
    live.skills = skillSvc;
    const memory = createMemoryService(k, { utility, embedder: new LocalHashEmbedder(), skills: skillSvc, work: r.work, org: r.org });
    live.memory = memory;

    const skill = await skillSvc
      .manage({ orgId: r.acme.id, agentId: r.ada.id }, { action: 'create', name: 'launch-email', description: 'Write launch emails', body: '# Launch email\n\n1. Draft.\n2. Send for review.\n' })
      .then((s) => skillSvc.activate(s.id, OWNER, { force: true }));

    /** One loop run on a fresh issue that used the skill and went to review; reflection has already run. */
    const reviewedWork = async (n: number, extra: { taskType?: string } = {}) => {
      const issue = r.work.createIssue(r.acme.id, { title: `Write launch email ${n}`, assigneeAgentId: r.ada.id, ...extra }, OWNER);
      const runId = `run_review_${n}`;
      k.db.insert(runs).values({ id: runId, orgId: r.acme.id, agentId: r.ada.id, issueId: issue.id, trigger: 'assignment', status: 'succeeded', outcome: 'completed', costUsd: 0.1, steps: 3, createdAt: k.clock.now() }).run();
      expect(r.work.checkout(r.acme.id, issue.id, runId)).toBe(true);
      r.work.release(r.acme.id, issue.id, runId, { status: 'in_review' });
      const reflection = await memory.reflect(r.acme.id, runId);
      expect(reflection.grade.reviewOutcome).toBe('pending');
      await skillSvc.recordUsage({ orgId: r.acme.id, runId, agentId: r.ada.id, skillIds: [skill.id], success: reflection.grade.success, humanEdited: false, costUsd: 0.1, steps: 3 });
      k.clock.advance(60_000);
      return { issue, runId };
    };
    const patchIssues = () => r.work.listIssues(r.acme.id, { label: `skill:${skill.id}` });

    const first = await reviewedWork(1);
    r.work.review(r.acme.id, first.issue.id, 'edited', 'Shorter subject line, please.', OWNER);
    await r.sys.idle();

    expect(k.db.select({ grade: runs.grade }).from(runs).where(eq(runs.id, first.runId)).get()?.grade).toMatchObject({ reviewOutcome: 'edited', issueClosed: true, success: true });
    expect(k.db.select().from(skillUsages).where(eq(skillUsages.runId, first.runId)).get()).toMatchObject({ humanEdited: true, success: true });
    const lessons = memory.list(r.acme.id, { kind: 'lesson', scope: 'agent', scopeId: r.ada.id });
    expect(lessons.some((m) => m.content.includes('Shorter subject line'))).toBe(true);
    // Adapt: the agent is asked to patch the skill a human had to correct.
    expect(patchIssues()).toHaveLength(1);
    expect(patchIssues()[0]).toMatchObject({ assigneeAgentId: r.ada.id, taskType: SKILL_ADAPT_TASK_TYPE, status: 'todo' });
    expect(patchIssues()[0]!.title).toContain(`Patch skill "launch-email"`);
    expect(k.audit.query({ orgId: r.acme.id, action: 'skill.patch_requested' })).toHaveLength(1);

    // A second corrected result while the request is open does not file another one…
    const second = await reviewedWork(2);
    r.work.review(r.acme.id, second.issue.id, 'rejected', 'Wrong audience.', OWNER);
    await r.sys.idle();
    expect(k.db.select().from(skillUsages).where(eq(skillUsages.runId, second.runId)).get()).toMatchObject({ success: false, humanEdited: false });
    expect(memory.scorecard(r.acme.id, r.ada.id)).toMatchObject({ runs: 2, successRate: 0.5 });
    expect(patchIssues()).toHaveLength(1);

    // …and an accepted review asks for nothing.
    const third = await reviewedWork(3);
    r.work.review(r.acme.id, third.issue.id, 'accepted', undefined, OWNER);
    await r.sys.idle();
    expect(k.db.select({ grade: runs.grade }).from(runs).where(eq(runs.id, third.runId)).get()?.grade).toMatchObject({ reviewOutcome: 'accepted', success: true });
    expect(patchIssues()).toHaveLength(1);
  });

  it('skill_eval: winners are activated; an undecidable evaluation notifies the owner instead of failing silently', async () => {
    r = rig({ systemJobs: false });
    k = r.k;
    const notes: Array<DomainEvents['notification']> = [];
    k.bus.on('notification', (n) => void notes.push(n));
    r.skills.get.mockReturnValue({ id: 'skl_1', name: 'triage', status: 'draft', author: `agent:${r.ada.id}`, orgId: r.acme.id });

    // An agent-authored draft is queued for evaluation.
    k.bus.emit('skill.changed', { orgId: r.acme.id, skillId: 'skl_1', status: 'draft' });
    expect(r.pending('skilleval:skl_1')).toMatchObject({ kind: 'skill_eval', payload: { skillId: 'skl_1' } });

    r.skills.evaluate.mockResolvedValueOnce({ passed: false, needsReview: true, score: 0.4, notes: 'NEEDS HUMAN REVIEW: file outputs cannot be verified' });
    await r.fire('skilleval:skl_1');
    expect(r.skills.activate).not.toHaveBeenCalled();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ orgId: r.acme.id, kind: 'skill_review', title: 'Skill "triage" needs your review', data: { skillId: 'skl_1' } });

    k.bus.emit('skill.changed', { orgId: r.acme.id, skillId: 'skl_1', status: 'draft' });
    r.skills.evaluate.mockResolvedValueOnce({ passed: true, score: 0.9 });
    await r.fire('skilleval:skl_1');
    expect(r.skills.activate).toHaveBeenCalledWith('skl_1', expect.objectContaining({ kind: 'system' }));
    expect(notes).toHaveLength(1);
  });
});
