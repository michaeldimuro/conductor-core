import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import { OWNER } from '../../src/contracts/types.js';

/** The holder of an issue is whoever acts next — and it is woken to act. */
describe('reassignment and review wakes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  const lead = () => ({ kind: 'agent' as const, id: h.lead.id });
  const runsOf = (agentId: string) => h.runtime.listRuns(h.acme.id, { agentId });

  /** Ada finished; the work waits in review for Lena. No ping went out (it was lost, or set from the dashboard). */
  const waitingForLead = () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Dashboard counts', assigneeAgentId: h.ada.id, reviewerAgentId: h.lead.id }, OWNER);
    h.work.updateIssue(h.acme.id, issue.id, { status: 'in_review' }, OWNER);
    return issue;
  };

  it('an in_review issue reassigned to its reviewer wakes it into a review run that can give the verdict', async () => {
    const issue = waitingForLead();
    await h.drain();
    h.calls.length = 0; // the assignment to Ada's wake: nothing workable, no run

    h.script = (ctx) => {
      expect(ctx.issueId).toBeNull(); // a review checks nothing out
      h.work.review(h.acme.id, issue.id, 'accepted', 'Looks right.', lead());
    };
    h.work.assign(h.acme.id, issue.id, h.lead.id, OWNER);
    await h.drain();

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.prompt).toContain('waiting for YOUR review');
    expect(h.calls[0]!.prompt).toContain('Dashboard counts');
    expect(h.work.getIssue(h.acme.id, issue.id)).toMatchObject({ status: 'done', reviewOutcome: 'accepted' });
    expect(runsOf(h.lead.id)[0]).toMatchObject({ trigger: 'assignment', issueId: null });
  });

  it('an in_review issue reassigned to someone else is reopened and worked', async () => {
    const issue = waitingForLead();
    await h.drain();
    h.calls.length = 0;

    const other = h.org.hireAgent(h.acme.id, { deptId: h.dept.id, name: 'Quinn', role: 'QA', autonomyLevel: 1, reportsTo: h.lead.id }, OWNER).agent!;
    h.work.assign(h.acme.id, issue.id, other.id, OWNER);
    await h.drain();

    expect(h.calls.map((c) => c.agentId)).toEqual([other.id, h.lead.id]);
    expect(h.calls[0]!.prompt).toContain('You have checked out issue');
    expect(runsOf(other.id)[0]).toMatchObject({ trigger: 'assignment', issueId: issue.id });
    // Quinn's finished work went back to review, and the reviewer was woken onto it.
    expect(h.calls[1]!.prompt).toContain('waiting for YOUR review');
  });

  it('a review ping runs the review even when the reviewer has other work queued', async () => {
    const own = h.work.createIssue(h.acme.id, { title: 'Lead roadmap', assigneeAgentId: h.lead.id }, OWNER);
    const issue = waitingForLead();
    await h.drain();
    h.calls.length = 0;

    h.script = () => {};
    h.work.addComment(h.acme.id, issue.id, { body: '@lena this is ready for your review.' }, { kind: 'system', id: 'runtime' });
    await h.drain();

    const reviewRun = h.calls.find((c) => c.prompt.includes('waiting for YOUR review'));
    expect(reviewRun).toBeDefined();
    expect(reviewRun!.prompt).toContain('Dashboard counts');
    // The review run did not swallow the lead's own work: it is still there to check out.
    expect(h.work.getIssue(h.acme.id, own.id).status).not.toBe('in_review');
  });

  it('lists waiting reviews in a run about other work', async () => {
    const issue = waitingForLead();
    await h.drain();
    h.calls.length = 0;

    h.work.createIssue(h.acme.id, { title: 'Lead roadmap', assigneeAgentId: h.lead.id }, OWNER);
    await h.drain();

    const run = h.calls.find((c) => c.prompt.includes('Lead roadmap'))!;
    expect(run.prompt).toContain('Also waiting for your review (1)');
    expect(run.prompt).toContain(`id ${issue.id}`);
  });
});
