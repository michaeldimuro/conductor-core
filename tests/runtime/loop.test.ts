import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, usage, type Harness } from './harness.js';
import { OWNER } from '../../src/contracts/types.js';
import { runs, jobs } from '../../src/db/schema/index.js';
import { eq } from 'drizzle-orm';

const MIN = 60_000;

describe('heartbeat loop', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  const runsOf = (agentId: string) => h.runtime.listRuns(h.acme.id, { agentId });

  it('wakes on assignment, checks out atomically, executes, reports and queues reflection', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Fix login bug', body: 'Users cannot log in', assigneeAgentId: h.ada.id }, OWNER);
    let lockDuringRun: string | null = null;
    h.script = (ctx) => {
      lockDuringRun = h.work.getIssue(h.acme.id, issue.id).checkoutLock;
      expect(h.work.getIssue(h.acme.id, issue.id).status).toBe('in_progress');
      expect(h.runtime.toolContext(ctx.runId)).toMatchObject({ agentId: h.ada.id, issueId: issue.id, orgId: h.acme.id });
      expect(h.governance.tokens.verify(ctx.runToken)).toMatchObject({ kind: 'run', runId: ctx.runId });
      return { finalText: 'Patched the session cookie bug.' };
    };
    await h.drain();

    expect(h.calls).toHaveLength(1);
    const ctx = h.calls[0]!;
    expect(ctx.prompt).toContain('Fix login bug');
    expect(ctx.systemPrompt).toContain('You are Ada, Engineer');
    expect(ctx.systemPrompt).toContain('Lena');
    expect(ctx.mcpEndpoints[0]).toMatchObject({ name: 'conductor', url: 'http://127.0.0.1:7420/mcp' });
    expect(lockDuringRun).toBe(ctx.runId);

    const after = h.work.getIssue(h.acme.id, issue.id);
    expect(after.checkoutLock).toBeNull();
    expect(after.status).toBe('in_review'); // autonomy 1 → needs review
    expect(h.work.listComments(h.acme.id, issue.id).some((c) => c.body.includes('Patched the session cookie bug.'))).toBe(true);

    const [run] = runsOf(h.ada.id);
    expect(run).toMatchObject({ status: 'succeeded', outcome: 'completed', trigger: 'assignment', provider: 'fake', costUsd: 0.01, issueId: issue.id });
    expect(run!.capabilitySnapshot?.provider.adapter).toBe('fake');
    expect(h.governance.tokens.verify(ctx.runToken)).toBeNull(); // run token revoked
    expect(h.governance.budgets.summary(h.acme.id).totalUsd).toBeCloseTo(0.01);
    expect(h.memory.reflect).toHaveBeenCalledWith(h.acme.id, run!.id);
    expect(h.runtime.toolContext(ctx.runId)).toBeNull();
  });

  it('honours the per-agent heartbeat cron and costs nothing when there is no work', async () => {
    await h.drain();
    expect(h.calls).toHaveLength(0);
    const hb = h.k.db.select().from(jobs).where(eq(jobs.dedupeKey, `hb:${h.ada.id}`)).all().filter((j) => j.status === 'pending');
    expect(hb).toHaveLength(1);
    const due = hb[0]!.runAt;
    expect(new Date(due).getMinutes()).toBe(0);

    h.work.createIssue(h.acme.id, { title: 'Backlog item', assigneeAgentId: h.ada.id, status: 'backlog' }, OWNER);
    h.k.bus.emit('issue.updated', { orgId: h.acme.id, issueId: 'x', status: 'backlog' });
    await h.drain();
    h.k.db.update(jobs).set({ status: 'cancelled' }).where(eq(jobs.dedupeKey, `wake:${h.ada.id}`)).run();

    h.k.clock.set(due - 1);
    await h.drain();
    expect(runsOf(h.ada.id)).toHaveLength(0);
    h.k.clock.set(due + 1000); // within ±1 min of the cron time
    await h.drain();
    // Nothing workable (backlog only) → skipped before a run row or model call exists.
    expect(h.calls).toHaveLength(0);
    // …and the next beat is scheduled an hour later.
    const next = h.k.db.select().from(jobs).where(eq(jobs.dedupeKey, `hb:${h.ada.id}`)).all().find((j) => j.status === 'pending');
    expect(next!.runAt - due).toBe(60 * MIN);
  });

  it('fires missed heartbeats once after sleep', async () => {
    const hbJobs = () => h.k.db.select().from(jobs).where(eq(jobs.dedupeKey, `hb:${h.ada.id}`)).all();
    await h.drain();
    expect(hbJobs()).toHaveLength(1);
    h.k.clock.advance(9 * 60 * MIN); // lid closed for nine hours: 9 hourly beats missed
    await h.drain();
    h.k.clock.advance(10_000); // staggered wake-ups land within seconds
    await h.drain();
    const all = hbJobs();
    expect(all.filter((j) => j.status === 'done')).toHaveLength(1); // one catch-up beat, not nine
    const pending = all.filter((j) => j.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.runAt).toBeGreaterThan(h.k.clock.now());
  });

  it('lets an autonomous agent with goals work proactively on heartbeat', async () => {
    h.work.createGoal(h.acme.id, { title: 'Ship v2', ownerAgentId: h.lead.id, level: 'agent' }, OWNER);
    await h.drain(); // the new goal wakes its owner to plan it (goal cascade)
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.prompt).toContain('not been broken down');
    h.k.clock.advance(31 * MIN);
    await h.drain();
    const proactive = h.calls.filter((c) => c.prompt.includes('Pursue your goals proactively'));
    expect(proactive).toHaveLength(1);
    expect(proactive[0]!.agentId).toBe(h.lead.id);
    expect(proactive[0]!.prompt).toContain('Ship v2');
    // The planning run produced no issues, so the same heartbeat also retried planning (see goals.test.ts).
    expect(h.calls.filter((c) => c.prompt.includes('not been broken down'))).toHaveLength(2);
    expect(h.calls).toHaveLength(3);
  });

  it('releases a failed issue to todo, then blocks and escalates after repeated failures', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Flaky task', assigneeAgentId: h.ada.id }, OWNER);
    h.script = () => ({ outcome: 'failed', finalText: '', error: { kind: 'other', message: 'tool exploded' } });
    await h.drain();
    let cur = h.work.getIssue(h.acme.id, issue.id);
    expect(cur).toMatchObject({ status: 'todo', checkoutLock: null });
    expect(h.work.listComments(h.acme.id, issue.id).some((c) => c.body.includes('tool exploded'))).toBe(true);

    for (let i = 0; i < 2; i++) {
      await h.runtime.runNow(h.acme.id, h.ada.id, { issueId: issue.id });
      await h.drain();
    }
    cur = h.work.getIssue(h.acme.id, issue.id);
    expect(runsOf(h.ada.id).filter((r) => r.status === 'failed')).toHaveLength(3);
    // Escalated up the reporting line to the lead.
    expect(cur.assigneeAgentId).toBe(h.lead.id);
  });

  it('parks a delegating parent and unparks it when the children finish', async () => {
    const parent = h.work.createIssue(h.acme.id, { title: 'Big project', assigneeAgentId: h.lead.id }, OWNER);
    let childId = '';
    h.script = (ctx) => {
      if (ctx.agentId === h.lead.id && !childId) {
        const [child] = h.work.delegate(h.acme.id, parent.id, [{ title: 'Part 1', assigneeAgentId: h.ada.id }], { kind: 'agent', id: h.lead.id, runId: ctx.runId });
        childId = child!.id;
        return { finalText: 'Split into parts.' };
      }
      if (ctx.agentId === h.ada.id) {
        h.work.updateIssue(h.acme.id, childId, { status: 'done' }, OWNER);
        return { finalText: 'Part 1 complete.' };
      }
      return { finalText: 'Integrated everything.' };
    };
    await h.drain();
    const calls = h.calls.map((c) => c.agentId);
    expect(calls).toEqual([h.lead.id, h.ada.id, h.lead.id]);
    expect(h.calls[2]!.prompt).toContain('All child issues are finished');
    expect(h.work.getIssue(h.acme.id, childId).status).toBe('done');
    expect(h.work.getIssue(h.acme.id, parent.id).status).toBe('done'); // lead is autonomy 3, no reviewer
  });

  it('never runs the same agent twice at once and respects the org concurrency limit', async () => {
    h.org.updateOrg(h.acme.id, { maxConcurrentRuns: 1 }, OWNER);
    h.work.createIssue(h.acme.id, { title: 'One', assigneeAgentId: h.ada.id }, OWNER);
    h.work.createIssue(h.acme.id, { title: 'Two', assigneeAgentId: h.lead.id }, OWNER);
    let live = 0;
    let peak = 0;
    h.script = async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 20));
      live--;
    };
    await h.drain();
    expect(h.calls).toHaveLength(2);
    expect(peak).toBe(1);
  });

  it('skips paused agents, exhausted budgets and engaged kill switches', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Work', assigneeAgentId: h.ada.id }, OWNER);
    h.governance.killSwitch.engage(h.acme.id, OWNER);
    await h.drain();
    expect(h.calls).toHaveLength(0);
    h.governance.killSwitch.release(h.acme.id, OWNER);

    h.org.updateAgent(h.acme.id, h.ada.id, { budgetUsd: 1 }, OWNER);
    h.governance.budgets.record({ orgId: h.acme.id, agentId: h.ada.id, costUsd: 1.5 });
    expect(h.org.getAgent(h.acme.id, h.ada.id)).toMatchObject({ status: 'paused', pausedReason: 'budget' }); // FR-16 hard stop
    await h.runtime.runNow(h.acme.id, h.ada.id, { issueId: issue.id });
    await h.drain();
    expect(h.calls).toHaveLength(0);
    expect(h.work.getIssue(h.acme.id, issue.id).status).toBe('todo');
  });

  it('ends an in-flight run cleanly when the kill switch is engaged', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Long task', assigneeAgentId: h.ada.id }, OWNER);
    h.script = async () => {
      h.governance.killSwitch.engage(h.acme.id, OWNER);
      await new Promise((r) => setTimeout(r, 5_000));
    };
    await h.drain();
    const [run] = runsOf(h.ada.id);
    expect(run).toMatchObject({ status: 'cancelled', outcome: 'cancelled' });
    expect(h.work.getIssue(h.acme.id, issue.id)).toMatchObject({ status: 'todo', checkoutLock: null });
  });

  it('pauses a run for a human and resumes it where it stopped', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Needs login', assigneeAgentId: h.ada.id }, OWNER);
    const seen: string[] = [];
    h.script = (ctx) => {
      h.runtime.pauseRun(ctx.runId, 'needs_human');
      seen.push(h.work.getIssue(h.acme.id, issue.id).status, h.runtime.getRun(h.acme.id, ctx.runId).status);
      h.runtime.resumeRun(ctx.runId);
      seen.push(h.work.getIssue(h.acme.id, issue.id).status, h.runtime.getRun(h.acme.id, ctx.runId).status);
    };
    await h.drain();
    expect(seen).toEqual(['blocked', 'paused', 'in_progress', 'running']);
    expect(h.work.getIssue(h.acme.id, issue.id).status).toBe('in_review');
  });

  it('enforces the max-runs-per-hour runaway guard', async () => {
    h.org.updateAgent(h.acme.id, h.ada.id, { maxRunsPerHour: 2 }, OWNER);
    for (let i = 0; i < 4; i++) {
      h.work.createIssue(h.acme.id, { title: `Task ${i}`, assigneeAgentId: h.ada.id }, OWNER);
      await h.drain();
    }
    expect(h.calls).toHaveLength(2);
  });

  it('answers a chat turn without checking out an issue', async () => {
    h.script = (ctx) => ({ finalText: `echo: ${ctx.prompt}` });
    const { reply, runId } = await h.runtime.chat(h.acme.id, h.ada.id, 'status?');
    expect(reply).toContain('echo: status?');
    expect(h.runtime.getRun(h.acme.id, runId).trigger).toBe('chat');
    expect(h.memory.reflect).not.toHaveBeenCalled();
  });

  it('journals events, redacts secrets and exposes the transcript', async () => {
    h.work.createIssue(h.acme.id, { title: 'Traced', assigneeAgentId: h.ada.id }, OWNER);
    h.script = (ctx, emit) => {
      emit({ type: 'text', text: `my token is ${ctx.runToken}` });
      emit({ type: 'tool_call', id: 't1', name: 'conductor-tasks__inbox', input: {} });
      emit({ type: 'tool_result', id: 't1', name: 'conductor-tasks__inbox', output: '[]', isError: false });
      emit({ type: 'session', sessionId: 'sess-42' });
    };
    await h.drain();
    const [run] = runsOf(h.ada.id);
    const events = h.runtime.transcript(h.acme.id, run!.id);
    expect(events.map((e) => e.event.type)).toEqual(['text', 'tool_call', 'tool_result', 'session']);
    expect(JSON.stringify(events)).not.toContain(h.calls[0]!.runToken);
    expect(run!.sessionId).toBe('sess-42');
    expect(() => h.runtime.getRun('org_other', run!.id)).toThrow(/not found/);
  });
});

describe('crash recovery', () => {
  const seedCrashed = (h: Harness, sessionId: string | null) => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Interrupted', assigneeAgentId: h.ada.id }, OWNER);
    h.k.db.insert(runs).values({
      id: 'run_crashed', orgId: h.acme.id, agentId: h.ada.id, issueId: issue.id, trigger: 'assignment', provider: 'fake',
      status: 'running', phase: 'execute', startedAt: h.k.clock.now(), createdAt: h.k.clock.now(), sessionId,
    }).run();
    expect(h.work.checkout(h.acme.id, issue.id, 'run_crashed')).toBe(true);
    h.k.db.update(jobs).set({ status: 'cancelled' }).run(); // the assignment wake was consumed by the crashed run
    return issue;
  };

  it('releases in-flight issues back to todo with a comment on restart', async () => {
    const h = await createHarness({ start: false });
    try {
      const issue = seedCrashed(h, null);
      await h.runtime.start();
      expect(h.runtime.getRun(h.acme.id, 'run_crashed')).toMatchObject({ status: 'failed', outcome: 'crashed' });
      expect(h.work.getIssue(h.acme.id, issue.id)).toMatchObject({ status: 'todo', checkoutLock: null });
      expect(h.work.listComments(h.acme.id, issue.id).some((c) => /interrupted by a daemon restart/.test(c.body))).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it('resumes the provider session when the adapter supports resume', async () => {
    const h = await createHarness({ start: false, resume: true });
    try {
      const issue = seedCrashed(h, 'sess-9');
      await h.runtime.start();
      await h.drain();
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]).toMatchObject({ resumeSessionId: 'sess-9', issueId: issue.id });
      expect(h.runtime.listRuns(h.acme.id, { issueId: issue.id }).map((r) => r.trigger)).toContain('resume');
    } finally {
      await h.dispose();
    }
  });
});

export { usage };
