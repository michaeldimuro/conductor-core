import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import { OWNER } from '../../src/contracts/types.js';
import type { RunContext } from '../../src/contracts/adapter.js';
import type { GovernanceHandle } from '../../src/governance/index.js';
import { approvalBrief, AWAITING_APPROVAL } from '../../src/runtime/approval-wake.js';
import type { RuntimeDeps } from '../../src/runtime/types.js';

/**
 * FR-10 / FR-13: an approved action is actually executed. A run that ends with
 * an approval it asked for unresolved parks its issue; the decision (or the
 * expiry) brings the agent back onto that issue, told what the board said.
 */
describe('approval → park → wake → retry', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  /** What the connector gateway does for an "Ask first" call: consume an approved grant, or file / report the pending one. */
  const gatedCall = (ctx: RunContext, matchKey: string, title = `Send email (${matchKey})`): 'executed' | 'pending' => {
    const a = h.governance.approvals;
    if (a.consume(h.acme.id, 'tool_call', matchKey)) return 'executed';
    if (!a.findOpen(h.acme.id, 'tool_call', matchKey)) {
      a.request({
        orgId: h.acme.id, kind: 'tool_call', title, payload: { matchKey, tool: 'mail__send' },
        requesterAgentId: ctx.agentId, runId: ctx.runId, issueId: ctx.issueId,
      });
    }
    return 'pending';
  };
  const pending = () => h.governance.approvals.list(h.acme.id, { status: 'pending' });
  const issueOf = (id: string) => h.work.getIssue(h.acme.id, id);

  it('parks the issue instead of settling it, and the approval alone gets the action executed', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Email the customer', assigneeAgentId: h.ada.id }, OWNER);
    const results: string[] = [];
    h.script = (ctx) => {
      results.push(gatedCall(ctx, 'mk-1'));
      return { finalText: 'Asked for approval to send the email.' };
    };
    await h.drain();

    expect(results).toEqual(['pending']);
    expect(issueOf(issue.id)).toMatchObject({ status: 'blocked', blockedReason: AWAITING_APPROVAL, checkoutLock: null });
    expect(h.work.listComments(h.acme.id, issue.id).some((c) => /Parked: waiting for the board/.test(c.body) && c.body.includes(pending()[0]!.id))).toBe(true);
    expect(h.k.audit.query({ orgId: h.acme.id, action: 'issue.parked', issueId: issue.id })).toHaveLength(1);
    await h.drain();
    expect(h.calls).toHaveLength(1); // nothing runs while the board has not decided

    const approval = pending()[0]!;
    h.governance.approvals.decide(h.acme.id, approval.id, 'approved', OWNER, 'ok, but cc legal');
    await h.drain();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ agentId: h.ada.id, issueId: issue.id });
    expect(h.calls[1]!.prompt).toContain('Email the customer'); // the issue itself, checked out again
    expect(h.calls[1]!.prompt).toContain('## Board decisions');
    expect(h.calls[1]!.prompt).toContain(approval.id);
    expect(h.calls[1]!.prompt).toMatch(/was APPROVED/);
    expect(h.calls[1]!.prompt).toContain('ok, but cc legal');
    expect(h.calls[1]!.prompt).toMatch(/repeat the exact action/i);
    expect(results).toEqual(['pending', 'executed']); // the gateway's consume path let the retry through
    expect(h.governance.approvals.get(h.acme.id, approval.id).consumedAt).not.toBeNull();
    expect(h.runtime.listRuns(h.acme.id, { issueId: issue.id }).map((r) => r.trigger).sort()).toEqual(['approval', 'assignment']);
    // Nothing left with the board: the issue settles the normal way (supervised agent → review).
    expect(issueOf(issue.id)).toMatchObject({ status: 'in_review', checkoutLock: null });
  });

  it('wakes the agent on a denial with the board note so it changes course', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Refund order 4711', assigneeAgentId: h.ada.id }, OWNER);
    h.script = (ctx) => void (h.calls.length === 1 && gatedCall(ctx, 'mk-refund'));
    await h.drain();
    expect(issueOf(issue.id).status).toBe('blocked');

    const approval = pending()[0]!;
    h.governance.approvals.decide(h.acme.id, approval.id, 'denied', OWNER, 'offer store credit instead');
    await h.drain();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.issueId).toBe(issue.id);
    expect(h.calls[1]!.prompt).toMatch(/was DENIED/);
    expect(h.calls[1]!.prompt).toContain('offer store credit instead');
    expect(h.calls[1]!.prompt).toMatch(/must not be attempted again\. Change course/);
    expect(issueOf(issue.id)).toMatchObject({ status: 'in_review', checkoutLock: null });
  });

  it('wakes the agent when its request expires undecided', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Publish the changelog', assigneeAgentId: h.ada.id }, OWNER);
    h.script = (ctx) => {
      if (h.calls.length > 1) return;
      h.governance.approvals.request({
        orgId: h.acme.id, kind: 'publish', title: 'Publish changelog', payload: { matchKey: 'mk-pub' },
        requesterAgentId: ctx.agentId, runId: ctx.runId, issueId: ctx.issueId, expiresAt: h.k.clock.now() + 60_000,
      });
    };
    await h.drain();
    expect(issueOf(issue.id)).toMatchObject({ status: 'blocked', blockedReason: AWAITING_APPROVAL });

    h.k.clock.advance(61_000);
    const expired = (h.governance as GovernanceHandle).expireApprovals();
    expect(expired).toHaveLength(1);
    await h.drain();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.issueId).toBe(issue.id);
    expect(h.calls[1]!.prompt).toContain(expired[0]!.id);
    expect(h.calls[1]!.prompt).toMatch(/EXPIRED without a decision/);
    expect(issueOf(issue.id).status).toBe('in_review');
  });

  it('handles several pending approvals on one issue: re-parks until the last one is decided', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Launch day', assigneeAgentId: h.ada.id }, OWNER);
    const results: string[][] = [];
    h.script = (ctx) => void results.push([gatedCall(ctx, 'mk-a', 'Tweet the launch'), gatedCall(ctx, 'mk-b', 'Email the press list')]);
    await h.drain();
    expect(pending()).toHaveLength(2);
    expect(issueOf(issue.id).status).toBe('blocked');

    const a = pending().find((p) => p.title === 'Tweet the launch')!;
    const b = pending().find((p) => p.title === 'Email the press list')!;
    h.governance.approvals.decide(h.acme.id, a.id, 'approved', OWNER);
    await h.drain();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.prompt).toContain(a.id);
    expect(h.calls[1]!.prompt).toMatch(/Still awaiting a decision/);
    expect(h.calls[1]!.prompt).toContain(b.id);
    expect(results[1]).toEqual(['executed', 'pending']);
    // One is done, one is still with the board → parked again, not in review.
    expect(issueOf(issue.id)).toMatchObject({ status: 'blocked', blockedReason: AWAITING_APPROVAL, checkoutLock: null });

    h.governance.approvals.decide(h.acme.id, b.id, 'approved', OWNER);
    await h.drain();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.issueId).toBe(issue.id);
    expect(results[2]).toEqual(['pending', 'executed']); // mk-a needs a fresh approval; mk-b went through
  });

  it('tells the agent about two decisions in one run when both land before it wakes', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Two asks', assigneeAgentId: h.ada.id }, OWNER);
    h.script = (ctx) => void (h.calls.length === 1 && [gatedCall(ctx, 'mk-x', 'Ask X'), gatedCall(ctx, 'mk-y', 'Ask Y')]);
    await h.drain();
    const [p1, p2] = pending();
    h.governance.approvals.decide(h.acme.id, p1!.id, 'approved', OWNER);
    h.governance.approvals.decide(h.acme.id, p2!.id, 'denied', OWNER, 'not this quarter');
    await h.drain();

    expect(h.calls).toHaveLength(2); // one run, both outcomes
    expect(h.calls[1]!.issueId).toBe(issue.id);
    expect(h.calls[1]!.prompt).toContain(p1!.id);
    expect(h.calls[1]!.prompt).toContain(p2!.id);
    expect(h.calls[1]!.prompt).toMatch(/was APPROVED/);
    expect(h.calls[1]!.prompt).toMatch(/was DENIED/);
  });

  it('keeps the issue for the agent when the board decides while the run is still going', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Fast board', assigneeAgentId: h.ada.id }, OWNER);
    const results: string[] = [];
    h.script = (ctx) => {
      results.push(gatedCall(ctx, 'mk-fast'));
      // The owner approves before the run has ended; the wake is queued behind the busy agent.
      if (h.calls.length === 1) h.governance.approvals.decide(h.acme.id, pending()[0]!.id, 'approved', OWNER);
    };
    await h.drain();

    expect(results).toEqual(['pending', 'executed']);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.issueId).toBe(issue.id); // not settled as in_review under the agent's feet
    expect(h.calls[1]!.prompt).toMatch(/was APPROVED/);
    expect(issueOf(issue.id).status).toBe('in_review');
  });

  it('still delivers the decision when the agent had reported the issue done itself', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Self-reported', assigneeAgentId: h.ada.id }, OWNER);
    h.script = (ctx) => {
      if (h.calls.length > 1) return;
      gatedCall(ctx, 'mk-self');
      h.work.updateIssue(h.acme.id, issue.id, { status: 'done' }, { kind: 'agent', id: ctx.agentId, runId: ctx.runId });
    };
    await h.drain();
    expect(issueOf(issue.id).status).toBe('done'); // the agent's own report stands

    const approval = pending()[0]!;
    h.governance.approvals.decide(h.acme.id, approval.id, 'approved', OWNER);
    await h.drain();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.issueId).toBeNull(); // a closed issue is not checked out again
    expect(h.calls[1]!.prompt).toMatch(/was APPROVED/);
    expect(h.calls[1]!.prompt).toContain('Self-reported'); // …but the agent is told what the approval was for
  });

  it('unparks an issue the agent reported blocked itself while waiting', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Agent-blocked', assigneeAgentId: h.ada.id }, OWNER);
    h.script = (ctx) => {
      if (h.calls.length > 1) return;
      gatedCall(ctx, 'mk-blocked');
      h.work.updateIssue(h.acme.id, issue.id, { status: 'blocked', blockedReason: 'waiting for the board' }, { kind: 'agent', id: ctx.agentId, runId: ctx.runId });
    };
    await h.drain();
    expect(issueOf(issue.id)).toMatchObject({ status: 'blocked', blockedReason: 'waiting for the board' });
    h.governance.approvals.decide(h.acme.id, pending()[0]!.id, 'approved', OWNER);
    await h.drain();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.issueId).toBe(issue.id);
  });

  it('does not park for approvals their own context executes (a proposed hire)', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Propose a hire', assigneeAgentId: h.ada.id }, OWNER);
    h.script = (ctx) => {
      h.governance.approvals.request({ orgId: h.acme.id, kind: 'hire_agent', title: 'Hire a designer', requesterAgentId: ctx.agentId, runId: ctx.runId, issueId: ctx.issueId });
    };
    await h.drain();
    expect(issueOf(issue.id).status).toBe('in_review');
  });

  it('never describes another agent\'s or another org\'s approval', () => {
    const deps = { governance: h.governance, work: h.work } as unknown as RuntimeDeps;
    const mine = h.governance.approvals.request({ orgId: h.acme.id, kind: 'other', title: 'Mine', requesterAgentId: h.ada.id });
    const theirs = h.governance.approvals.request({ orgId: h.acme.id, kind: 'other', title: 'Theirs', requesterAgentId: h.lead.id });
    h.governance.approvals.decide(h.acme.id, mine.id, 'approved', OWNER);
    h.governance.approvals.decide(h.acme.id, theirs.id, 'approved', OWNER);
    const beta = h.org.createOrg({ name: 'Beta', defaultProvider: { adapter: 'fake', model: 'fake-1' } }, OWNER);

    expect(approvalBrief(h.k, deps, h.acme.id, h.ada.id, [mine.id, theirs.id, 'apr_missing'], null)).toContain('"Mine"');
    expect(approvalBrief(h.k, deps, h.acme.id, h.ada.id, [mine.id, theirs.id], null)).not.toContain('Theirs');
    expect(approvalBrief(h.k, deps, h.acme.id, h.ada.id, [theirs.id], null)).toBeNull();
    expect(approvalBrief(h.k, deps, beta.id, h.ada.id, [mine.id], null)).toBeNull();
    // A still-pending approval is not a decision.
    const open = h.governance.approvals.request({ orgId: h.acme.id, kind: 'other', title: 'Open', requesterAgentId: h.ada.id });
    expect(approvalBrief(h.k, deps, h.acme.id, h.ada.id, [open.id], null)).toBeNull();
  });
});
