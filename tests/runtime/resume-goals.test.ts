import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import { OWNER } from '../../src/contracts/types.js';
import type { RunEvent } from '../../src/contracts/adapter.js';
import { jobs, runs } from '../../src/db/schema/index.js';
import { RESUMED_FROM, RunJournal } from '../../src/runtime/journal.js';
import { MAX_PLANNING_ATTEMPTS, PLANNING_REQUESTED, PLANNING_RETRY_BASE_MS, PLANNING_RETRY_CAP_MS, planningBackoffMs } from '../../src/runtime/goal-router.js';

const MIN = 60_000;
const text = (t: string): RunEvent => ({ type: 'text', text: t });

describe('journal-backed sessions chain across repeated interruptions', () => {
  let h: Harness;
  afterEach(() => h.dispose());

  const seedRun = (id: string, issueId: string | null, over: Partial<typeof runs.$inferInsert> = {}) => {
    const now = h.k.clock.now();
    h.k.db.insert(runs).values({
      id, orgId: h.acme.id, agentId: h.ada.id, issueId, trigger: 'assignment', provider: 'fake',
      status: 'failed', outcome: 'crashed', phase: 'done', startedAt: now, createdAt: now, sessionId: `conductor-run:${id}`, ...over,
    }).run();
    h.k.clock.advance(1000);
  };

  it('sessionEvents walks back through every earlier run of the session, oldest first', async () => {
    h = await createHarness({ start: false });
    const journal = new RunJournal(h.k);
    const issue = h.work.createIssue(h.acme.id, { title: 'Long job', assigneeAgentId: h.ada.id }, OWNER);
    for (const id of ['run_a', 'run_b', 'run_c']) seedRun(id, issue.id);
    journal.append({ id: 'run_a', orgId: h.acme.id }, text('a1'));
    journal.append({ id: 'run_b', orgId: h.acme.id }, { type: 'status', status: `${RESUMED_FROM}run_a` });
    journal.append({ id: 'run_b', orgId: h.acme.id }, text('b1'));
    journal.append({ id: 'run_c', orgId: h.acme.id }, { type: 'status', status: `${RESUMED_FROM}run_b` });
    journal.append({ id: 'run_c', orgId: h.acme.id }, text('c1'));

    const texts = (id: string) => journal.sessionEvents(h.acme.id, id).filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(texts('run_c')).toEqual(['a1', 'b1', 'c1']);
    expect(texts('run_b')).toEqual(['a1', 'b1']);
    expect(texts('run_a')).toEqual(['a1']);
    expect(() => journal.sessionEvents('org_other', 'run_c')).toThrow(/not found/);

    // A marker pointing at a run of another issue (or agent) is not followed.
    const elsewhere = h.work.createIssue(h.acme.id, { title: 'Other', assigneeAgentId: h.ada.id }, OWNER);
    seedRun('run_x', elsewhere.id);
    journal.append({ id: 'run_x', orgId: h.acme.id }, text('x1'));
    seedRun('run_d', issue.id);
    journal.append({ id: 'run_d', orgId: h.acme.id }, { type: 'status', status: `${RESUMED_FROM}run_x` });
    journal.append({ id: 'run_d', orgId: h.acme.id }, text('d1'));
    expect(texts('run_d')).toEqual(['d1']);
    // A marker loop terminates.
    seedRun('run_l', issue.id);
    journal.append({ id: 'run_l', orgId: h.acme.id }, { type: 'status', status: `${RESUMED_FROM}run_l` });
    expect(journal.sessionEvents(h.acme.id, 'run_l')).toHaveLength(1);
  });

  it('a run that crashes a second time resumes with the transcript of BOTH interrupted runs', async () => {
    h = await createHarness({ start: false, resume: true });
    const journal = new RunJournal(h.k);
    const issue = h.work.createIssue(h.acme.id, { title: 'Twice interrupted', assigneeAgentId: h.ada.id }, OWNER);
    // First run crashed earlier and was resumed by a second run…
    seedRun('run_first', issue.id);
    journal.append({ id: 'run_first', orgId: h.acme.id }, text('step one done'));
    // …which is in flight (and holds the lock) when the daemon dies again.
    seedRun('run_second', issue.id, { status: 'running', outcome: null, phase: 'execute' });
    journal.append({ id: 'run_second', orgId: h.acme.id }, { type: 'status', status: `${RESUMED_FROM}run_first` });
    journal.append({ id: 'run_second', orgId: h.acme.id }, text('step two done'));
    expect(h.work.checkout(h.acme.id, issue.id, 'run_second')).toBe(true);
    h.k.db.update(jobs).set({ status: 'cancelled' }).run();

    await h.runtime.start();
    await h.drain();

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ resumeSessionId: 'conductor-run:run_second', issueId: issue.id });
    const prior = (h.calls[0]!.priorEvents ?? []).filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(prior).toEqual(['step one done', 'step two done']);
    // The third run records what it continued, so a third crash would chain through it as well.
    const third = h.runtime.listRuns(h.acme.id, { issueId: issue.id }).find((r) => r.trigger === 'resume')!;
    expect(h.runtime.transcript(h.acme.id, third.id).some((e) => e.event.type === 'status' && e.event.status === `${RESUMED_FROM}run_second`)).toBe(true);
  });
});

describe('goal cascade: a failed planning run is retried', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  const planningRuns = () => h.calls.filter((c) => c.prompt.includes('not been broken down'));
  const beat = async (minutes = 31) => {
    h.k.clock.advance(minutes * MIN);
    await h.drain();
  };

  it('backs off exponentially up to a cap', () => {
    expect(planningBackoffMs(1)).toBe(PLANNING_RETRY_BASE_MS);
    expect(planningBackoffMs(2)).toBe(2 * PLANNING_RETRY_BASE_MS);
    expect(planningBackoffMs(3)).toBe(4 * PLANNING_RETRY_BASE_MS);
    expect(planningBackoffMs(30)).toBe(PLANNING_RETRY_CAP_MS);
  });

  it('re-plans an owned goal that still has no issues, then gives up after the cap and tells the owner once', async () => {
    const notes: string[] = [];
    h.k.bus.on('notification', (n) => void (n.kind === 'goal' && notes.push(n.title)));
    h.script = () => ({ outcome: 'failed', error: { kind: 'other', message: 'model unavailable' } });
    const goal = h.work.createGoal(h.acme.id, { title: 'Open the EU market' }, OWNER);
    await h.drain();
    expect(planningRuns()).toHaveLength(1);
    expect(h.work.getGoal(h.acme.id, goal.id).ownerAgentId).toBe(h.lead.id); // owned, and unplanned

    await beat(); // first heartbeat after the base backoff
    expect(planningRuns()).toHaveLength(2);
    await beat(); // 31 min after attempt 2: its 30 min backoff has passed
    expect(planningRuns()).toHaveLength(3);
    await beat(); // attempt 3 needs 60 min
    expect(planningRuns()).toHaveLength(3);

    for (let i = 0; i < 40; i++) await beat();
    expect(planningRuns()).toHaveLength(MAX_PLANNING_ATTEMPTS);
    expect(h.k.audit.query({ orgId: h.acme.id, entityId: goal.id, action: PLANNING_REQUESTED, limit: 50 })).toHaveLength(MAX_PLANNING_ATTEMPTS);
    expect(h.k.audit.query({ orgId: h.acme.id, entityId: goal.id, action: 'goal.planning_abandoned' })).toHaveLength(1);
    expect(notes).toEqual(['Goal not broken down: Open the EU market']);
  });

  it('stops retrying as soon as the goal has an issue', async () => {
    const goal = h.work.createGoal(h.acme.id, { title: 'Cut churn' }, OWNER);
    await h.drain();
    expect(planningRuns()).toHaveLength(1);
    h.work.createIssue(h.acme.id, { title: 'Interview churned users', goalId: goal.id }, OWNER);
    for (let i = 0; i < 6; i++) await beat();
    expect(planningRuns()).toHaveLength(1);
  });
});
