import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkService } from '../../src/contracts/org-work.js';
import { OWNER, SYSTEM } from '../../src/contracts/types.js';
import { createTestKernel, seedAgent, type TestKernel } from '../helpers/kernel.js';
import { as, codeOf, recordEvents, seedCompany, setup, type Fixture } from './helpers.js';

describe('work: goals and projects', () => {
  let k: TestKernel;
  let work: WorkService;
  let f: Fixture;
  beforeEach(() => {
    k = createTestKernel();
    ({ work, f } = setup(k));
  });
  afterEach(() => k.dispose());

  it('builds the org → dept → agent goal tree with rolled-up issue counts', () => {
    const events = recordEvents(k);
    const orgGoal = work.createGoal(f.org.id, { title: 'Reach $1M ARR' }, OWNER);
    const deptGoal = work.createGoal(f.org.id, { title: 'Ship v2', parentGoalId: orgGoal.id, deptId: f.eng.id }, OWNER);
    const agentGoal = work.createGoal(f.org.id, { title: 'Fix flaky tests', parentGoalId: deptGoal.id, ownerAgentId: f.dev.id }, OWNER);
    expect([orgGoal.level, deptGoal.level, agentGoal.level]).toEqual(['org', 'dept', 'agent']);
    expect(agentGoal.deptId).toBe(f.eng.id);
    expect(events.of('goal.created')).toHaveLength(3);

    const a = work.createIssue(f.org.id, { title: 'A', goalId: agentGoal.id }, OWNER);
    work.createIssue(f.org.id, { title: 'B', goalId: agentGoal.id }, OWNER);
    work.createIssue(f.org.id, { title: 'C', goalId: deptGoal.id }, OWNER);
    const cancelled = work.createIssue(f.org.id, { title: 'D', goalId: orgGoal.id }, OWNER);
    work.updateIssue(f.org.id, a.id, { status: 'todo' }, OWNER);
    work.updateIssue(f.org.id, a.id, { status: 'done' }, OWNER);
    work.updateIssue(f.org.id, cancelled.id, { status: 'cancelled' }, OWNER);

    const tree = work.goalTree(f.org.id);
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root.goal.id).toBe(orgGoal.id);
    expect(root.issueCounts).toEqual({ open: 2, done: 1 });
    const dept = root.children[0]!;
    expect(dept.issueCounts).toEqual({ open: 2, done: 1 });
    expect(dept.children[0]!.issueCounts).toEqual({ open: 1, done: 1 });
  });

  it('validates goal shape and parentage', () => {
    const orgGoal = work.createGoal(f.org.id, { title: 'Org' }, OWNER);
    const agentGoal = work.createGoal(f.org.id, { title: 'Mine', ownerAgentId: f.dev.id }, OWNER);
    expect(codeOf(() => work.createGoal(f.org.id, { title: '' }, OWNER))).toBe('validation');
    expect(codeOf(() => work.createGoal(f.org.id, { title: 'x', level: 'dept' }, OWNER))).toBe('validation');
    expect(codeOf(() => work.createGoal(f.org.id, { title: 'x', parentGoalId: agentGoal.id, level: 'org' }, OWNER))).toBe('validation');
    expect(codeOf(() => work.createGoal(f.org.id, { title: 'x', parentGoalId: 'goal_missing' }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.updateGoal(f.org.id, orgGoal.id, { parentGoalId: orgGoal.id }, OWNER))).toBe('validation');

    const updated = work.updateGoal(f.org.id, agentGoal.id, { status: 'achieved', weight: 5 }, OWNER);
    expect(updated).toMatchObject({ status: 'achieved', weight: 5 });
    expect(work.listGoals(f.org.id, { status: 'active' }).map((g) => g.id)).toEqual([orgGoal.id]);
    expect(work.listGoals(f.org.id, { ownerAgentId: f.dev.id })).toHaveLength(1);
  });

  it('applies autonomy rules to agents setting goals', () => {
    // autonomy 1 cannot set goals; autonomy 2 sets its own; only a lead sets department goals.
    expect(codeOf(() => work.createGoal(f.org.id, { title: 'x' }, as(f.junior)))).toBe('forbidden');
    const own = work.createGoal(f.org.id, { title: 'Own' }, as(f.dev));
    expect(own).toMatchObject({ level: 'agent', ownerAgentId: f.dev.id });
    expect(codeOf(() => work.createGoal(f.org.id, { title: 'x', level: 'dept' }, as(f.dev)))).toBe('forbidden');
    expect(codeOf(() => work.createGoal(f.org.id, { title: 'x', level: 'org' }, as(f.lead)))).toBe('forbidden');
    const dept = work.createGoal(f.org.id, { title: 'Dept', level: 'dept' }, as(f.lead));
    expect(dept).toMatchObject({ level: 'dept', deptId: f.eng.id });
    // Marketing is not the engineering lead's department; the CEO manages both.
    expect(codeOf(() => work.createGoal(f.org.id, { title: 'x', level: 'dept', deptId: f.mkt.id }, as(f.lead)))).toBe('forbidden');
    expect(work.createGoal(f.org.id, { title: 'Mkt', level: 'dept', deptId: f.mkt.id }, as(f.ceo)).deptId).toBe(f.mkt.id);
    // dev may not rewrite a goal owned by a peer.
    const peerGoal = work.createGoal(f.org.id, { title: 'Peer', ownerAgentId: f.junior.id }, OWNER);
    expect(codeOf(() => work.updateGoal(f.org.id, peerGoal.id, { title: 'hijack' }, as(f.dev)))).toBe('forbidden');
  });

  it('creates and lists projects, validating the workspace path', () => {
    const goal = work.createGoal(f.org.id, { title: 'Org' }, OWNER);
    const p = work.createProject(f.org.id, { name: 'Site', goalId: goal.id, workspacePath: '/tmp/site/../site' }, OWNER);
    expect(p.workspacePath).toBe('/tmp/site');
    expect(work.getProject(f.org.id, p.id).name).toBe('Site');
    expect(work.listProjects(f.org.id)).toHaveLength(1);
    expect(codeOf(() => work.createProject(f.org.id, { name: 'x', workspacePath: 'relative/path' }, OWNER))).toBe('validation');
    expect(codeOf(() => work.createProject(f.org.id, { name: 'x', workspacePath: '/etc' }, as(f.dev)))).toBe('forbidden');
    expect(codeOf(() => work.createProject(f.org.id, { name: 'x' }, as(f.junior)))).toBe('forbidden');
  });
});

describe('work: issues', () => {
  let k: TestKernel;
  let work: WorkService;
  let f: Fixture;
  beforeEach(() => {
    k = createTestKernel();
    ({ work, f } = setup(k));
  });
  afterEach(() => k.dispose());

  it('allocates sequential per-org numbers and finds issues by id or number', () => {
    const other = seedCompany(k, 'Beta');
    const first = work.createIssue(f.org.id, { title: 'One' }, OWNER);
    const second = work.createIssue(f.org.id, { title: 'Two' }, OWNER);
    const foreign = work.createIssue(other.org.id, { title: 'Other org' }, OWNER);
    expect([first.number, second.number, foreign.number]).toEqual([1, 2, 1]);
    expect(work.findIssue(f.org.id, 2)?.id).toBe(second.id);
    expect(work.findIssue(f.org.id, '#2')?.id).toBe(second.id);
    expect(work.findIssue(f.org.id, 'ACME-1')?.id).toBe(first.id);
    expect(work.findIssue(f.org.id, second.id)?.number).toBe(2);
    expect(work.findIssue(f.org.id, 99)).toBeNull();
  });

  it('never duplicates a number under concurrent creation', async () => {
    const created = await Promise.all(
      Array.from({ length: 60 }, async (_, i) => work.createIssue(f.org.id, { title: `Issue ${i}` }, OWNER)),
    );
    const numbers = created.map((i) => i.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it('defaults status from the assignee and emits creation events', () => {
    const events = recordEvents(k);
    const unassigned = work.createIssue(f.org.id, { title: 'Later' }, OWNER);
    const assigned = work.createIssue(f.org.id, { title: 'Now', assigneeAgentId: f.dev.id }, OWNER);
    const explicit = work.createIssue(f.org.id, { title: 'Parked', assigneeAgentId: f.dev.id, status: 'backlog' }, OWNER);
    expect([unassigned.status, assigned.status, explicit.status]).toEqual(['backlog', 'todo', 'backlog']);
    expect(assigned).toMatchObject({ creatorKind: 'human', creatorId: 'owner', priority: 2 });
    expect(events.of('issue.created')).toHaveLength(3);
    expect(events.of('issue.assigned')).toEqual([
      { orgId: f.org.id, issueId: assigned.id, agentId: f.dev.id },
      { orgId: f.org.id, issueId: explicit.id, agentId: f.dev.id },
    ]);
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', status: 'done' }, OWNER))).toBe('validation');
  });

  it('traces every issue to a goal: parent → assignee → creator → org goal', () => {
    const orgGoal = work.createGoal(f.org.id, { title: 'Org' }, OWNER);
    const devGoal = work.createGoal(f.org.id, { title: 'Dev', ownerAgentId: f.dev.id }, OWNER);
    const leadGoal = work.createGoal(f.org.id, { title: 'Lead', ownerAgentId: f.lead.id }, OWNER);
    const explicitGoal = work.createGoal(f.org.id, { title: 'Explicit', deptId: f.mkt.id }, OWNER);

    expect(work.createIssue(f.org.id, { title: 'fallback' }, OWNER).goalId).toBe(orgGoal.id);
    expect(work.createIssue(f.org.id, { title: 'assignee', assigneeAgentId: f.dev.id }, OWNER).goalId).toBe(devGoal.id);
    // junior has no goal of its own, so the creating agent's goal applies.
    expect(work.createIssue(f.org.id, { title: 'creator', assigneeAgentId: f.junior.id }, as(f.lead)).goalId).toBe(leadGoal.id);
    const parent = work.createIssue(f.org.id, { title: 'explicit', goalId: explicitGoal.id }, OWNER);
    expect(parent.goalId).toBe(explicitGoal.id);
    expect(work.createIssue(f.org.id, { title: 'child', parentIssueId: parent.id, assigneeAgentId: f.dev.id }, OWNER).goalId).toBe(explicitGoal.id);

    work.updateGoal(f.org.id, devGoal.id, { status: 'achieved' }, OWNER);
    expect(work.createIssue(f.org.id, { title: 'inactive goal skipped', assigneeAgentId: f.dev.id }, OWNER).goalId).toBe(orgGoal.id);
  });

  it('enforces the status machine and stamps closedAt', () => {
    const events = recordEvents(k);
    const issue = work.createIssue(f.org.id, { title: 'Flow', assigneeAgentId: f.dev.id }, OWNER);
    const step = (status: Parameters<WorkService['updateIssue']>[2]['status']) =>
      work.updateIssue(f.org.id, issue.id, { status }, OWNER);

    expect(step('in_progress').closedAt).toBeNull();
    expect(step('in_review').status).toBe('in_review');
    k.clock.advance(1000);
    const done = step('done');
    expect(done.closedAt).toBe(k.clock.now());
    expect(events.of('issue.done')).toEqual([{ orgId: f.org.id, issueId: issue.id }]);

    // A closed issue does not silently resume: only an explicit reopen to todo.
    expect(codeOf(() => step('in_progress'))).toBe('conflict');
    expect(codeOf(() => step('in_review'))).toBe('conflict');
    expect(codeOf(() => step('blocked'))).toBe('conflict');
    const reopened = step('todo');
    expect(reopened).toMatchObject({ status: 'todo', closedAt: null });

    const blocked = work.updateIssue(f.org.id, issue.id, { status: 'blocked', blockedReason: 'waiting on vendor' }, OWNER);
    expect(blocked.blockedReason).toBe('waiting on vendor');
    expect(codeOf(() => step('done'))).toBe('conflict');
    expect(step('todo').blockedReason).toBeNull();
    expect(step('cancelled').closedAt).toBe(k.clock.now());
    expect(codeOf(() => step('done'))).toBe('conflict');

    const backlog = work.createIssue(f.org.id, { title: 'Idea' }, OWNER);
    expect(codeOf(() => work.updateIssue(f.org.id, backlog.id, { status: 'done' }, OWNER))).toBe('conflict');
    expect(codeOf(() => work.updateIssue(f.org.id, backlog.id, { status: 'in_review' }, OWNER))).toBe('conflict');
  });

  it('lets human and system actors do anything', () => {
    const issue = work.createIssue(f.org.id, { title: 'Any', assigneeAgentId: f.intern.id }, SYSTEM);
    expect(work.assign(f.org.id, issue.id, f.marketer.id, OWNER).assigneeAgentId).toBe(f.marketer.id);
    expect(work.updateIssue(f.org.id, issue.id, { title: 'Renamed', priority: 0 }, SYSTEM)).toMatchObject({ title: 'Renamed', priority: 0 });
  });

  it('autonomy 0 may not create issues and only acts on its own assignments', () => {
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x' }, as(f.intern)))).toBe('forbidden');
    const mine = work.createIssue(f.org.id, { title: 'Mine', assigneeAgentId: f.intern.id }, OWNER);
    const theirs = work.createIssue(f.org.id, { title: 'Theirs', assigneeAgentId: f.dev.id }, OWNER);
    expect(work.updateIssue(f.org.id, mine.id, { status: 'in_progress' }, as(f.intern)).status).toBe('in_progress');
    expect(codeOf(() => work.updateIssue(f.org.id, theirs.id, { title: 'nope' }, as(f.intern)))).toBe('forbidden');
    expect(codeOf(() => work.addComment(f.org.id, theirs.id, { body: 'hi' }, as(f.intern)))).toBe('forbidden');
    expect(work.addComment(f.org.id, mine.id, { body: 'on it' }, as(f.intern)).authorId).toBe(f.intern.id);
    expect(codeOf(() => work.delegate(f.org.id, mine.id, [{ title: 'sub', assigneeAgentId: f.intern.id }], as(f.intern)))).toBe('forbidden');
  });

  it('enforces the reporting line on assignment (end to end over real rows)', () => {
    // down the line: lead → its reports; ceo → transitive reports
    const byLead = work.createIssue(f.org.id, { title: 'L→dev', assigneeAgentId: f.dev.id }, as(f.lead));
    expect(byLead.assigneeAgentId).toBe(f.dev.id);
    expect(work.createIssue(f.org.id, { title: 'ceo→dev', assigneeAgentId: f.dev.id }, as(f.ceo)).assigneeAgentId).toBe(f.dev.id);
    // self
    expect(work.createIssue(f.org.id, { title: 'self', assigneeAgentId: f.dev.id }, as(f.dev)).status).toBe('todo');
    // up the line, or sideways without being the lead: refused
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', assigneeAgentId: f.lead.id }, as(f.dev)))).toBe('forbidden');
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', assigneeAgentId: f.junior.id }, as(f.dev)))).toBe('forbidden');
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', assigneeAgentId: f.dev.id }, as(f.marketer)))).toBe('forbidden');
    // a peer only through its lead: the engineering lead does not lead Marketing, but does lead Stan's department
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', assigneeAgentId: f.marketer.id }, as(f.lead)))).toBe('forbidden');
    const staff = seedAgent(k, f.org.id, f.eng.id, 'Stan', { role: 'Staff Engineer', reportsTo: f.ceo.id });
    expect(work.createIssue(f.org.id, { title: 'peer', assigneeAgentId: staff.id }, as(f.lead)).assigneeAgentId).toBe(staff.id);
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', assigneeAgentId: f.lead.id }, as(staff)))).toBe('forbidden');

    // assign(): same rule, and the actor must be entitled to the issue
    expect(work.assign(f.org.id, byLead.id, f.junior.id, as(f.lead)).assigneeAgentId).toBe(f.junior.id);
    expect(codeOf(() => work.assign(f.org.id, byLead.id, f.ceo.id, as(f.lead)))).toBe('forbidden');
    expect(codeOf(() => work.assign(f.org.id, byLead.id, f.dev.id, as(f.dev)))).toBe('forbidden');
    expect(codeOf(() => work.assign(f.org.id, byLead.id, 'agt_missing', OWNER))).toBe('not_found');
  });

  it('lets an agent update only issues it is assigned, created, or that its reports hold', () => {
    const devIssue = work.createIssue(f.org.id, { title: 'dev work', assigneeAgentId: f.dev.id }, OWNER);
    const mktIssue = work.createIssue(f.org.id, { title: 'mkt work', assigneeAgentId: f.marketer.id }, OWNER);
    const created = work.createIssue(f.org.id, { title: 'filed by dev' }, as(f.dev));

    expect(work.updateIssue(f.org.id, devIssue.id, { priority: 1 }, as(f.dev)).priority).toBe(1);
    expect(work.updateIssue(f.org.id, created.id, { body: 'more detail' }, as(f.dev)).body).toBe('more detail');
    expect(work.updateIssue(f.org.id, devIssue.id, { priority: 0 }, as(f.lead)).priority).toBe(0); // direct report
    expect(work.updateIssue(f.org.id, devIssue.id, { labels: ['x'] }, as(f.ceo)).labels).toEqual(['x']); // transitive
    expect(codeOf(() => work.updateIssue(f.org.id, mktIssue.id, { priority: 0 }, as(f.dev)))).toBe('forbidden');
    expect(codeOf(() => work.updateIssue(f.org.id, devIssue.id, { priority: 3 }, as(f.junior)))).toBe('forbidden');
    expect(codeOf(() => work.updateIssue(f.org.id, mktIssue.id, { priority: 0 }, as(f.lead)))).toBe('forbidden');
  });

  it('emits issue.assigned / issue.updated and audits every change with the issueId', () => {
    const issue = work.createIssue(f.org.id, { title: 'Audit me' }, OWNER);
    const events = recordEvents(k);
    const assigned = work.assign(f.org.id, issue.id, f.dev.id, OWNER);
    expect(assigned.status).toBe('todo'); // assigning backlog work makes it ready
    expect(events.of('issue.assigned')).toEqual([{ orgId: f.org.id, issueId: issue.id, agentId: f.dev.id }]);
    work.updateIssue(f.org.id, issue.id, { title: 'Audited', body: 'secret sk-ant-abcdefghijklmnopqrstuvwx' }, as(f.dev, 'run_1'));
    expect(events.of('issue.updated').map((e) => e.status)).toEqual(['todo', 'todo']);

    // No-op updates neither audit nor emit.
    events.clear();
    work.updateIssue(f.org.id, issue.id, { title: 'Audited' }, OWNER);
    expect(events.all).toEqual([]);

    const trail = k.audit.query({ orgId: f.org.id, issueId: issue.id }).reverse();
    expect(trail.map((r) => r.action)).toEqual(['issue.created', 'issue.assigned', 'issue.updated']);
    expect(trail[2]).toMatchObject({ actor: { kind: 'agent', id: f.dev.id }, runId: 'run_1', entityKind: 'issue', entityId: issue.id });
    // Long text is not copied into the audit trail.
    expect(JSON.stringify(trail[2]!.data)).not.toContain('sk-ant');
  });

  it('validates input and references', () => {
    const issue = work.createIssue(f.org.id, { title: 'Base' }, OWNER);
    expect(codeOf(() => work.createIssue(f.org.id, { title: '   ' }, OWNER))).toBe('validation');
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', priority: 9 }, OWNER))).toBe('validation');
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', bogus: 1 } as never, OWNER))).toBe('validation');
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', goalId: 'goal_missing' }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', blockedBy: ['iss_missing'] }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.createIssue('org_missing', { title: 'x' }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.createIssue(f.org.id, { title: 'x' }, { kind: 'agent' }))).toBe('validation');
    expect(codeOf(() => work.updateIssue(f.org.id, issue.id, { blockedBy: [issue.id] }, OWNER))).toBe('validation');
    expect(codeOf(() => work.updateIssue(f.org.id, issue.id, { parentIssueId: issue.id }, OWNER))).toBe('validation');
    const child = work.createIssue(f.org.id, { title: 'Child', parentIssueId: issue.id }, OWNER);
    expect(codeOf(() => work.updateIssue(f.org.id, issue.id, { parentIssueId: child.id }, OWNER))).toBe('validation');
    expect(codeOf(() => work.listIssues(f.org.id, { limit: 0 }))).toBe('validation');
  });

  it('filters and searches issues', () => {
    const goal = work.createGoal(f.org.id, { title: 'G', deptId: f.eng.id }, OWNER);
    const a = work.createIssue(f.org.id, { title: 'Audit homepage SEO', labels: ['seo'], assigneeAgentId: f.dev.id, priority: 1 }, OWNER);
    const b = work.createIssue(f.org.id, { title: 'Write launch post', body: 'mention SEO keywords', goalId: goal.id }, OWNER);
    const c = work.createIssue(f.org.id, { title: '100% coverage_report', parentIssueId: a.id, priority: 0 }, OWNER);

    const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);
    expect(ids(work.listIssues(f.org.id))).toEqual([c.id, a.id, b.id]); // priority first
    expect(ids(work.listIssues(f.org.id, { status: 'todo' }))).toEqual([a.id]);
    expect(ids(work.listIssues(f.org.id, { status: ['todo', 'backlog'], limit: 2 }))).toEqual([c.id, a.id]);
    expect(ids(work.listIssues(f.org.id, { assigneeAgentId: f.dev.id }))).toEqual([a.id]);
    expect(ids(work.listIssues(f.org.id, { goalId: goal.id }))).toEqual([b.id]);
    expect(ids(work.listIssues(f.org.id, { label: 'seo' }))).toEqual([a.id]);
    expect(ids(work.listIssues(f.org.id, { parentIssueId: a.id }))).toEqual([c.id]);
    expect(ids(work.listIssues(f.org.id, { parentIssueId: null }))).toEqual([a.id, b.id]);
    expect(ids(work.listIssues(f.org.id, { search: 'seo' }))).toEqual([a.id, b.id]);
    expect(ids(work.listIssues(f.org.id, { search: 'seo homepage' }))).toEqual([a.id]);
    expect(ids(work.listIssues(f.org.id, { search: '100%' }))).toEqual([c.id]); // LIKE wildcards are literal
    expect(ids(work.listIssues(f.org.id, { search: 'coverage_' }))).toEqual([c.id]);
    expect(ids(work.listIssues(f.org.id, { search: '%' }))).toEqual([c.id]);
    expect(ids(work.listIssues(f.org.id, { offset: 2 }))).toEqual([b.id]);
  });
});

describe('work: cross-org isolation', () => {
  let k: TestKernel;
  let work: WorkService;
  let a: Fixture;
  let b: Fixture;
  beforeEach(() => {
    k = createTestKernel();
    ({ work, f: a } = setup(k));
    b = seedCompany(k, 'Beta');
  });
  afterEach(() => k.dispose());

  it('treats ids from another org as not found', () => {
    const goalB = work.createGoal(b.org.id, { title: 'B goal' }, OWNER);
    const projectB = work.createProject(b.org.id, { name: 'B project' }, OWNER);
    const issueB = work.createIssue(b.org.id, { title: 'B issue', assigneeAgentId: b.dev.id }, OWNER);
    const commentB = work.addComment(b.org.id, issueB.id, { body: 'B comment' }, OWNER);
    const playbookB = work.createPlaybook(b.org.id, { name: 'B play', steps: [{ title: 's', description: '', expectedOutput: '' }] }, OWNER);
    const issueA = work.createIssue(a.org.id, { title: 'A issue' }, OWNER);

    const A = a.org.id;
    expect(codeOf(() => work.getGoal(A, goalB.id))).toBe('not_found');
    expect(codeOf(() => work.updateGoal(A, goalB.id, { title: 'x' }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.getProject(A, projectB.id))).toBe('not_found');
    expect(codeOf(() => work.getIssue(A, issueB.id))).toBe('not_found');
    expect(work.findIssue(A, issueB.id)).toBeNull();
    expect(codeOf(() => work.updateIssue(A, issueB.id, { title: 'x' }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.assign(A, issueB.id, a.dev.id, OWNER))).toBe('not_found');
    expect(codeOf(() => work.assign(A, issueA.id, b.dev.id, OWNER))).toBe('not_found');
    expect(codeOf(() => work.addComment(A, issueB.id, { body: 'x' }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.addComment(A, issueA.id, { body: 'x', parentCommentId: commentB.id }, OWNER))).toBe('validation');
    expect(codeOf(() => work.listComments(A, issueB.id))).toBe('not_found');
    expect(codeOf(() => work.timeline(A, issueB.id))).toBe('not_found');
    expect(codeOf(() => work.delegate(A, issueB.id, [{ title: 'x' }], OWNER))).toBe('not_found');
    expect(codeOf(() => work.escalate(A, issueB.id, 'help', OWNER))).toBe('not_found');
    expect(codeOf(() => work.review(A, issueB.id, 'accepted', undefined, OWNER))).toBe('not_found');
    expect(codeOf(() => work.runPlaybook(A, playbookB.id, issueA.id, OWNER))).toBe('not_found');
    expect(codeOf(() => work.inbox(A, b.dev.id))).toBe('not_found');
    expect(codeOf(() => work.markInboxSeen(A, b.dev.id))).toBe('not_found');
    expect(codeOf(() => work.release(A, issueB.id, 'run_x'))).toBe('not_found');
    // References to another org's rows are refused on write.
    expect(codeOf(() => work.createIssue(A, { title: 'x', goalId: goalB.id }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.createIssue(A, { title: 'x', projectId: projectB.id }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.createIssue(A, { title: 'x', parentIssueId: issueB.id }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.createIssue(A, { title: 'x', blockedBy: [issueB.id] }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.createIssue(A, { title: 'x', assigneeAgentId: b.dev.id }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.createIssue(A, { title: 'x', reviewerAgentId: b.dev.id }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.createGoal(A, { title: 'x', ownerAgentId: b.dev.id }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.createGoal(A, { title: 'x', deptId: b.eng.id }, OWNER))).toBe('not_found');
    // An agent of org B cannot act inside org A.
    expect(codeOf(() => work.createIssue(A, { title: 'x' }, as(b.ceo)))).toBe('not_found');
    // A checkout attempt through the wrong org loses, and the issue is untouched.
    expect(work.checkout(A, issueB.id, 'run_x')).toBe(false);
    expect(work.getIssue(b.org.id, issueB.id)).toMatchObject({ checkoutLock: null, status: 'todo' });
  });

  it('keeps lists, trees, inboxes and playbooks per org', () => {
    work.createGoal(a.org.id, { title: 'A goal' }, OWNER);
    work.createGoal(b.org.id, { title: 'B goal' }, OWNER);
    work.createProject(b.org.id, { name: 'B project' }, OWNER);
    work.createPlaybook(b.org.id, { name: 'Shared name', steps: [{ title: 's', description: '', expectedOutput: '' }] }, OWNER);
    work.createPlaybook(a.org.id, { name: 'Shared name', steps: [{ title: 's', description: '', expectedOutput: '' }] }, OWNER);
    work.createIssue(a.org.id, { title: 'A1', assigneeAgentId: a.dev.id }, OWNER);
    const b1 = work.createIssue(b.org.id, { title: 'B1 widget', assigneeAgentId: b.dev.id }, OWNER);
    // Same slug in both orgs: the mention resolves inside the comment's org only.
    const comment = work.addComment(b.org.id, b1.id, { body: 'ping @dev' }, OWNER);
    expect(comment.mentions).toEqual([b.dev.id]);

    expect(work.listGoals(a.org.id).map((g) => g.title)).toEqual(['A goal']);
    expect(work.goalTree(a.org.id)).toHaveLength(1);
    expect(work.goalTree(a.org.id)[0]!.issueCounts).toEqual({ open: 1, done: 0 });
    expect(work.listProjects(a.org.id)).toEqual([]);
    expect(work.listPlaybooks(a.org.id)).toHaveLength(1);
    expect(work.listIssues(a.org.id).map((i) => i.title)).toEqual(['A1']);
    expect(work.listIssues(a.org.id, { search: 'widget' })).toEqual([]);
    expect(work.inbox(a.org.id, a.dev.id).issues.map((i) => i.title)).toEqual(['A1']);
    expect(work.inbox(a.org.id, a.dev.id).mentions).toEqual([]);
    expect(work.inbox(b.org.id, b.dev.id).mentions.map((c) => c.id)).toEqual([comment.id]);
    expect(work.releaseAllForRun(a.org.id, 'run_none')).toEqual([]);
  });
});
