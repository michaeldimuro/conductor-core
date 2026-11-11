import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHarness, type Harness } from './harness.js';
import { deferBackoffMs, foldWakes, mergeWakePayloads, wakePayload, wakesOf, MAX_QUEUED_WAKES, type Wake } from '../../src/runtime/wakes.js';
import { jobs, runs } from '../../src/db/schema/index.js';
import type { DomainEvents } from '../../src/shared/events.js';
import { OWNER } from '../../src/contracts/types.js';

const MIN = 60_000;

describe('wake payloads (pure)', () => {
  const assign = (issueId: string): Wake => ({ trigger: 'assignment', issueId, triggerNote: 'You were assigned an issue.' });
  const webhook = (n: number): Wake => ({ trigger: 'webhook', prompt: `payload ${n}` });

  it('merges a second wake into the pending payload instead of dropping it', () => {
    const merged = mergeWakePayloads(wakePayload([assign('iss_1')]), wakePayload([webhook(1)]));
    expect(wakesOf(merged)).toEqual([assign('iss_1'), webhook(1)]);
    // identical wakes collapse (bursts)
    expect(wakesOf(mergeWakePayloads(merged, wakePayload([webhook(1)])))).toHaveLength(2);
    // re-queued leftovers go to the front
    expect(wakesOf(mergeWakePayloads(merged, wakePayload([webhook(0)]), { front: true }))[0]).toEqual(webhook(0));
  });

  it('reads a legacy flat payload as one wake', () => {
    expect(wakesOf({ trigger: 'manual', issueId: 'iss_9', prompt: 'do it' })).toEqual([{ trigger: 'manual', issueId: 'iss_9', prompt: 'do it' }]);
  });

  it('folds plain nudges into one run and keeps payload-carrying wakes separate', () => {
    const mention: Wake = { trigger: 'mention', triggerNote: 'You were mentioned in a comment.' };
    const approval: Wake = { trigger: 'approval', triggerNote: 'Your approval request apr_1 was approved.' };
    const { request, rest } = foldWakes([mention, assign('iss_1'), webhook(1), approval, assign('iss_2')]);
    expect(request).toMatchObject({ trigger: 'assignment', issueId: 'iss_1' });
    expect(request!.triggerNote).toContain('mentioned');
    expect(request!.triggerNote).toContain('apr_1 was approved'); // the approval note survives the merge
    expect(rest).toEqual([webhook(1), assign('iss_2')]); // different issue and the webhook prompt stay queued
    expect(foldWakes(rest).request).toEqual(webhook(1)); // a prompt runs alone
  });

  it('bounds the queue by dropping only redundant nudges first', () => {
    const many = [...Array.from({ length: MAX_QUEUED_WAKES + 20 }, (_, i) => assign(`iss_${i}`)), webhook(1)];
    const kept = wakesOf(wakePayload(many));
    expect(kept).toHaveLength(MAX_QUEUED_WAKES);
    expect(kept.at(-1)).toEqual(webhook(1));
  });

  it('backs off exponentially up to the cap', () => {
    expect([0, 1, 2, 10].map((n) => deferBackoffMs(n, 15 * MIN))).toEqual([MIN, 2 * MIN, 4 * MIN, 15 * MIN]);
  });
});

describe('wake queue (scheduler)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  const wakeJobs = (agentId: string) => h.k.db.select().from(jobs).where(eq(jobs.dedupeKey, `wake:${agentId}`)).all();
  const pendingWake = (agentId: string) => wakeJobs(agentId).find((j) => j.status === 'pending');

  it('loses none of: a webhook prompt, an approval note and a pinned issue arriving in one burst', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Pinned work', assigneeAgentId: h.ada.id }, OWNER);
    h.k.bus.emit('webhook.received', { orgId: h.acme.id, webhookId: 'wh_1', agentId: h.ada.id, payload: { order: 4711 } });
    h.k.bus.emit('approval.decided', { orgId: h.acme.id, approvalId: 'apr_77', status: 'approved', requesterAgentId: h.ada.id });
    h.k.bus.emit('webhook.received', { orgId: h.acme.id, webhookId: 'wh_2', agentId: h.ada.id, payload: { order: 4712 } });
    expect(wakeJobs(h.ada.id).filter((j) => j.status === 'pending')).toHaveLength(1); // still one pending job per agent

    await h.drain();
    const prompts = h.calls.map((c) => c.prompt);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('Pinned work');
    expect(prompts[0]).toContain('apr_77 was approved'); // approval note folded into the issue run
    expect(h.calls[0]!.issueId).toBe(issue.id);
    expect(prompts.some((p) => p.includes('4711'))).toBe(true);
    expect(prompts.some((p) => p.includes('4712'))).toBe(true);
    expect(h.runtime.listRuns(h.acme.id, { agentId: h.ada.id }).map((r) => r.trigger).sort()).toEqual(['assignment', 'webhook', 'webhook']);
  });

  it('defers a wake for a paused agent with no heartbeat and runs it when the agent resumes', async () => {
    const solo = h.org.hireAgent(h.acme.id, { deptId: h.dept.id, name: 'Solo', role: 'Analyst', autonomyLevel: 1, reportsTo: h.lead.id }, OWNER).agent!;
    expect(solo.heartbeatCron).toBeNull();
    h.org.pauseAgent(h.acme.id, solo.id, 'owner', OWNER);
    const skips: Array<DomainEvents['run.skipped']> = [];
    h.k.bus.on('run.skipped', (e) => void skips.push(e));

    const issue = h.work.createIssue(h.acme.id, { title: 'Wait for me', assigneeAgentId: solo.id }, OWNER);
    await h.drain();
    expect(h.calls).toHaveLength(0);
    const deferred = pendingWake(solo.id)!;
    expect(deferred).toBeDefined(); // NOT marked done
    expect(deferred.runAt).toBe(h.k.clock.now() + MIN);
    expect(skips.at(-1)).toMatchObject({ agentId: solo.id, code: 'agent_paused', deferredUntil: deferred.runAt });

    // Still paused at the retry: backs off further, still not lost.
    h.k.clock.advance(MIN + 1);
    await h.drain();
    expect(pendingWake(solo.id)!.runAt).toBe(h.k.clock.now() + 2 * MIN);

    // Resuming pulls the wake forward — no cron heartbeat needed.
    h.org.resumeAgent(h.acme.id, solo.id, OWNER);
    await h.drain();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ agentId: solo.id, issueId: issue.id });
    expect(pendingWake(solo.id)).toBeUndefined();
  });

  it('defers a rate-limited wake and runs it once the hourly window has room', async () => {
    h.org.updateAgent(h.acme.id, h.ada.id, { maxRunsPerHour: 1, heartbeatCron: null }, OWNER);
    h.work.createIssue(h.acme.id, { title: 'First', assigneeAgentId: h.ada.id }, OWNER);
    await h.drain();
    const second = h.work.createIssue(h.acme.id, { title: 'Second', assigneeAgentId: h.ada.id }, OWNER);
    await h.drain();
    expect(h.calls).toHaveLength(1);
    expect(pendingWake(h.ada.id)).toBeDefined();

    h.k.clock.advance(61 * MIN);
    await h.drain();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.issueId).toBe(second.id);
  });

  it('defers wakes while the kill switch is engaged and releases them with it', async () => {
    h.governance.killSwitch.engage(h.acme.id, OWNER);
    h.work.createIssue(h.acme.id, { title: 'Held', assigneeAgentId: h.ada.id }, OWNER);
    await h.drain();
    expect(h.calls).toHaveLength(0);
    h.governance.killSwitch.release(h.acme.id, OWNER);
    await h.drain();
    expect(h.calls).toHaveLength(1);
  });

  it('completes (does not retry) a wake that simply has no work', async () => {
    const skips: Array<DomainEvents['run.skipped']> = [];
    h.k.bus.on('run.skipped', (e) => void skips.push(e));
    await h.runtime.runNow(h.acme.id, h.ada.id);
    await h.drain();
    expect(pendingWake(h.ada.id)).toBeUndefined();
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ code: 'no_work', trigger: 'manual', deferredUntil: null });
  });

  describe('resume session binding', () => {
    const seedSession = (issueId: string, sessionId: string) =>
      h.k.db.insert(runs).values({
        id: `run_old_${sessionId}`, orgId: h.acme.id, agentId: h.ada.id, issueId, trigger: 'assignment', provider: 'fake',
        status: 'failed', outcome: 'crashed', startedAt: h.k.clock.now(), createdAt: h.k.clock.now() - 2 * 3_600_000, sessionId,
      }).run();

    it('resumes the session on the issue it belonged to', async () => {
      const a = h.work.createIssue(h.acme.id, { title: 'A', assigneeAgentId: h.ada.id }, OWNER);
      h.k.db.update(jobs).set({ status: 'cancelled' }).run();
      seedSession(a.id, 'sess-a');
      h.runtime.enqueue({ kind: 'event', orgId: h.acme.id, agentId: h.ada.id, payload: { trigger: 'resume', issueId: a.id, resumeSessionId: 'sess-a' } });
      await h.drain();
      expect(h.calls[0]).toMatchObject({ issueId: a.id, resumeSessionId: 'sess-a' });
    });

    it('never attaches the session to a different issue', async () => {
      const a = h.work.createIssue(h.acme.id, { title: 'A', assigneeAgentId: h.ada.id }, OWNER);
      const b = h.work.createIssue(h.acme.id, { title: 'B', assigneeAgentId: h.ada.id }, OWNER);
      h.k.db.update(jobs).set({ status: 'cancelled' }).run();
      seedSession(a.id, 'sess-a');
      expect(h.work.checkout(h.acme.id, a.id, 'run_someone_else')).toBe(true); // A cannot be checked out
      h.runtime.enqueue({ kind: 'event', orgId: h.acme.id, agentId: h.ada.id, payload: { trigger: 'resume', issueId: a.id, resumeSessionId: 'sess-a' } });
      await h.drain();
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]!.issueId).toBe(b.id);
      expect(h.calls[0]!.resumeSessionId).toBeUndefined();
    });

    it('ignores a session id that was never journaled for that issue', async () => {
      const a = h.work.createIssue(h.acme.id, { title: 'A', assigneeAgentId: h.ada.id }, OWNER);
      const b = h.work.createIssue(h.acme.id, { title: 'B', assigneeAgentId: h.lead.id }, OWNER);
      h.k.db.update(jobs).set({ status: 'cancelled' }).run();
      seedSession(b.id, 'sess-b');
      h.runtime.enqueue({ kind: 'event', orgId: h.acme.id, agentId: h.ada.id, payload: { trigger: 'resume', issueId: a.id, resumeSessionId: 'sess-b' } });
      await h.drain();
      expect(h.calls[0]!.issueId).toBe(a.id);
      expect(h.calls[0]!.resumeSessionId).toBeUndefined();
    });
  });
});
