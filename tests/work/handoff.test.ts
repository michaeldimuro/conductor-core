import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgService, WorkService } from '../../src/contracts/org-work.js';
import type { BuiltinToolProvider, ToolCallContext } from '../../src/contracts/tools.js';
import type { Agent } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import { runs } from '../../src/db/schema/index.js';
import { createTasksToolProvider, createWorkService } from '../../src/work/index.js';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { as, codeOf, createFakeOrg, errorOf, mockApprovals, payloadOf, recordEvents, seedCompany, toolCtx, type Fixture } from './helpers.js';

/** Issue ownership: whoever holds an issue must be able to act on it the moment it reaches them. */
describe('hand-offs and reassignment', () => {
  let k: TestKernel;
  let org: OrgService;
  let work: WorkService;
  let tools: BuiltinToolProvider;
  let f: Fixture;

  beforeEach(() => {
    k = createTestKernel();
    org = createFakeOrg(k);
    work = createWorkService(k, { org });
    tools = createTasksToolProvider(k, { work, org, approvals: mockApprovals() });
    f = seedCompany(k);
  });
  afterEach(() => k.dispose());

  const call = (agent: Agent, tool: string, args: Record<string, unknown> = {}, extra: Partial<ToolCallContext> = {}) =>
    tools.call(toolCtx(agent, extra), tool, args);
  const seedRun = (id: string, agent: Agent) =>
    k.db.insert(runs).values({ id, orgId: f.org.id, agentId: agent.id, trigger: 'manual', createdAt: k.clock.now() }).run();

  /** Junior did the work and it now waits for the lead's review. */
  const inReview = () => {
    const issue = work.createIssue(f.org.id, { title: 'Fix the counter', assigneeAgentId: f.junior.id, reviewerAgentId: f.lead.id }, OWNER);
    seedRun('run_work', f.junior);
    expect(work.checkout(f.org.id, issue.id, 'run_work')).toBe(true);
    work.release(f.org.id, issue.id, 'run_work', { status: 'in_review' });
    return work.getIssue(f.org.id, issue.id);
  };

  describe('reassigning reopens the issue for its new holder', () => {
    it('keeps work in review when it goes to its reviewer, who may then give the verdict', () => {
      const issue = inReview();
      expect(work.inbox(f.org.id, f.lead.id).reviews.map((r) => r.id)).toEqual([issue.id]);

      const moved = work.assign(f.org.id, issue.id, f.lead.id, OWNER);
      expect(moved).toMatchObject({ status: 'in_review', assigneeAgentId: f.lead.id });
      // Still listed: holding the issue does not make it the lead's own work — it never worked it.
      expect(work.inbox(f.org.id, f.lead.id).reviews.map((r) => r.id)).toEqual([issue.id]);
      expect(work.review(f.org.id, issue.id, 'accepted', undefined, as(f.lead)).status).toBe('done');
    });

    it('reopens review work handed to anyone else so it can be checked out', () => {
      const issue = inReview();
      expect(work.assign(f.org.id, issue.id, f.dev.id, OWNER).status).toBe('todo');
      expect(work.inbox(f.org.id, f.dev.id).issues.map((i) => i.id)).toEqual([issue.id]);
      expect(work.inbox(f.org.id, f.lead.id).reviews).toEqual([]);
    });

    it('unblocks blocks the new holder is meant to clear, but not system parks', () => {
      const escalated = work.createIssue(f.org.id, { title: 'Escalated', assigneeAgentId: f.dev.id }, OWNER);
      work.updateIssue(f.org.id, escalated.id, { status: 'blocked', blockedReason: 'escalated_to_owner' }, OWNER);
      expect(work.assign(f.org.id, escalated.id, f.junior.id, OWNER)).toMatchObject({ status: 'todo', blockedReason: null });

      const parked = work.createIssue(f.org.id, { title: 'Parked', assigneeAgentId: f.dev.id }, OWNER);
      work.updateIssue(f.org.id, parked.id, { status: 'blocked', blockedReason: 'waiting_on_children' }, OWNER);
      expect(work.assign(f.org.id, parked.id, f.junior.id, OWNER)).toMatchObject({ status: 'blocked', blockedReason: 'waiting_on_children' });

      const backlog = work.createIssue(f.org.id, { title: 'Someday', status: 'backlog' }, OWNER);
      expect(work.assign(f.org.id, backlog.id, f.dev.id, OWNER).status).toBe('todo');
    });

    it('an explicit status wins over the reopen', () => {
      const issue = inReview();
      expect(work.updateIssue(f.org.id, issue.id, { assigneeAgentId: f.dev.id, status: 'blocked' }, OWNER).status).toBe('blocked');
    });
  });

  describe('nobody reviews their own work', () => {
    it('refuses the verdict, and does not list the review, for a reviewer that worked the issue', () => {
      const issue = work.createIssue(f.org.id, { title: 'Self-reviewed', assigneeAgentId: f.lead.id, reviewerAgentId: f.lead.id }, OWNER);
      seedRun('run_lead', f.lead);
      expect(work.checkout(f.org.id, issue.id, 'run_lead')).toBe(true);
      work.release(f.org.id, issue.id, 'run_lead', { status: 'in_review' });

      expect(work.inbox(f.org.id, f.lead.id).reviews).toEqual([]);
      expect(codeOf(() => work.review(f.org.id, issue.id, 'accepted', undefined, as(f.lead)))).toBe('forbidden');
    });

    it('still refuses an assignee that is not the named reviewer', () => {
      const issue = inReview();
      expect(codeOf(() => work.review(f.org.id, issue.id, 'accepted', undefined, as(f.junior)))).toBe('forbidden');
    });
  });

  describe('hand_off tool', () => {
    it('lets an autonomy-1 agent hand work it holds up to its manager, releasing its checkout', async () => {
      const issue = work.createIssue(f.org.id, { title: 'Needs a decision', assigneeAgentId: f.junior.id }, OWNER);
      seedRun('run_june', f.junior);
      expect(work.checkout(f.org.id, issue.id, 'run_june')).toBe(true);
      const events = recordEvents(k);

      const out = payloadOf<{ status: string; handedTo: string }>(
        await call(f.junior, 'hand_off', { issue: issue.number, to: 'lena', note: 'Pick the API shape; options are in the thread.' }, { runId: 'run_june', issueId: issue.id }),
      );
      expect(out).toMatchObject({ status: 'todo', handedTo: 'lena' });
      expect(work.getIssue(f.org.id, issue.id)).toMatchObject({ assigneeAgentId: f.lead.id, checkoutLock: null, status: 'todo' });
      expect(events.of('issue.assigned')).toEqual([{ orgId: f.org.id, issueId: issue.id, agentId: f.lead.id }]);
      const note = work.listComments(f.org.id, issue.id).at(-1)!;
      expect(note.body).toMatch(/^Handed to @lena by June: Pick the API shape/);
      expect(note.mentions).toEqual([f.lead.id]);
      expect(work.inbox(f.org.id, f.lead.id).issues.map((i) => i.id)).toEqual([issue.id]);
    });

    it('hands review work to its reviewer without reopening it', async () => {
      const issue = inReview();
      const out = payloadOf<{ status: string }>(await call(f.junior, 'hand_off', { issue: issue.id, to: 'lena', note: 'Ready for you.' }));
      expect(out.status).toBe('in_review');
    });

    it('allows peers and the issue\'s reviewer or creator, and refuses everyone else', async () => {
      const toPeer = work.createIssue(f.org.id, { title: 'QA next', assigneeAgentId: f.dev.id }, OWNER);
      expect(payloadOf<{ handedTo: string }>(await call(f.dev, 'hand_off', { issue: toPeer.id, to: 'june', note: 'Please test.' })).handedTo).toBe('june');

      const crossDept = work.createIssue(f.org.id, { title: 'Copy review', assigneeAgentId: f.junior.id, reviewerAgentId: f.marketer.id }, OWNER);
      expect(payloadOf<{ handedTo: string }>(await call(f.junior, 'hand_off', { issue: crossDept.id, to: 'mara', note: 'Your call.' })).handedTo).toBe('mara');

      const stray = work.createIssue(f.org.id, { title: 'Not marketing', assigneeAgentId: f.junior.id }, OWNER);
      expect(errorOf(await call(f.junior, 'hand_off', { issue: stray.id, to: 'mara', note: 'Here.' }))).toMatch(/forbidden.*escalate instead/);
      expect(errorOf(await call(f.junior, 'hand_off', { issue: stray.id, to: 'june', note: 'Me?' }))).toMatch(/already assigned/);
    });
  });
});
