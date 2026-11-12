import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgService, WorkService } from '../../src/contracts/org-work.js';
import type { BuiltinToolProvider, ToolCallContext } from '../../src/contracts/tools.js';
import type { Agent, Issue } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import { conflict } from '../../src/shared/errors.js';
import { createTasksToolProvider, createWorkService } from '../../src/work/index.js';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import {
  createFakeOrg, errorOf, fakeApproval, mockApprovals, payloadOf, recordEvents, seedCompany, toolCtx,
  type Fixture,
} from './helpers.js';

type Brief = { id: string; number: number; title: string; status: string; assigneeAgentId: string | null };

describe('conductor-tasks tool provider', () => {
  let k: TestKernel;
  let org: OrgService;
  let work: WorkService;
  let approvals: ReturnType<typeof mockApprovals>;
  let tools: BuiltinToolProvider;
  let f: Fixture;

  beforeEach(() => {
    k = createTestKernel();
    org = createFakeOrg(k);
    work = createWorkService(k, { org });
    approvals = mockApprovals();
    tools = createTasksToolProvider(k, { work, org, approvals });
    f = seedCompany(k);
  });
  afterEach(() => k.dispose());

  const call = (agent: Agent, tool: string, args: Record<string, unknown> = {}, extra: Partial<ToolCallContext> = {}) =>
    tools.call(toolCtx(agent, extra), tool, args);
  const names = async (agent: Agent): Promise<string[]> => (await tools.tools(toolCtx(agent))).map((t) => t.name);

  it('identifies itself and describes every tool with a JSON Schema and a risk', async () => {
    expect(tools.id).toBe('conductor-tasks');
    const defs = await tools.tools(toolCtx(f.ceo));
    expect(defs.map((d) => d.name).sort()).toEqual(
      [
        'inbox', 'get_issue', 'search_issues', 'create_issue', 'update_issue', 'comment', 'delegate', 'escalate',
        'report_progress', 'review_issue', 'list_goals', 'create_goal', 'list_team', 'propose_hire', 'reassign',
        'request_approval', 'run_playbook', 'list_playbooks', 'propose_termination', 'propose_budget_change', 'propose_skill_grant', 'save_artifact',
        'view_attachment',
      ].sort(),
    );
    const reads = ['inbox', 'get_issue', 'search_issues', 'list_goals', 'list_team', 'list_playbooks', 'view_attachment'];
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(20);
      expect(def.risk).toBe(reads.includes(def.name) ? 'read' : 'write');
      expect(def.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      // Identity is never an argument.
      const props = Object.keys((def.inputSchema.properties ?? {}) as object);
      expect(props).not.toEqual(expect.arrayContaining(['agentId']));
      expect(props).not.toEqual(expect.arrayContaining(['orgId']));
      expect(props).not.toEqual(expect.arrayContaining(['runId']));
    }
    const report = defs.find((d) => d.name === 'report_progress')!.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(report.required.sort()).toEqual(['status', 'summary']);
    expect(report.properties.status!.enum).toEqual(['done', 'in_review', 'blocked']);
  });

  it('varies tool visibility by autonomy level and refuses hidden tools', async () => {
    const l0 = await names(f.intern);
    const l1 = await names(f.junior);
    const l2 = await names(f.dev);
    const l3 = await names(f.lead);
    expect(l0).not.toContain('create_issue');
    expect(l0).not.toContain('delegate');
    expect(l0).toEqual(expect.arrayContaining(['inbox', 'get_issue', 'comment', 'report_progress', 'escalate', 'request_approval']));
    expect(l1).toEqual(expect.arrayContaining(['create_issue', 'delegate', 'run_playbook']));
    expect(l1).not.toContain('create_goal');
    expect(l2).toContain('create_goal');
    expect(l2).not.toContain('propose_hire');
    expect(l2).not.toContain('propose_termination');
    expect(l2).not.toContain('propose_budget_change');
    expect(l2).not.toContain('reassign');
    expect(l3).toEqual(expect.arrayContaining(['propose_hire', 'propose_termination', 'propose_budget_change', 'reassign', 'create_goal']));
    expect(l0.length).toBeLessThan(l1.length);
    expect(l1.length).toBeLessThan(l2.length);
    expect(l2.length).toBeLessThan(l3.length);

    expect(errorOf(await call(f.intern, 'create_issue', { title: 'x' }))).toMatch(/forbidden.*autonomy level 1/);
    expect(errorOf(await call(f.dev, 'reassign', { issue: 1, assignee: 'june' }))).toMatch(/forbidden/);
    expect(errorOf(await call(f.dev, 'propose_hire', { name: 'x', role: 'y' }))).toMatch(/forbidden/);
    expect(errorOf(await call(f.junior, 'create_goal', { title: 'x' }))).toMatch(/forbidden/);
    expect(errorOf(await call(f.dev, 'nope'))).toMatch(/unknown tool/);
  });

  it('returns domain and validation failures as isError results instead of throwing', async () => {
    expect(errorOf(await call(f.dev, 'create_issue', {}))).toMatch(/validation.*title/);
    expect(errorOf(await call(f.dev, 'create_issue', { title: 'x', agentId: f.ceo.id }))).toMatch(/validation/);
    expect(errorOf(await call(f.dev, 'get_issue', { issue: 999 }))).toMatch(/not_found/);
    expect(errorOf(await call(f.dev, 'get_issue'))).toMatch(/validation.*no issue given/);
    expect(errorOf(await call(f.dev, 'create_issue', { title: 'x', assignee: 'lena' }))).toMatch(/forbidden/);
    expect(errorOf(await call(f.dev, 'create_issue', { title: 'x', assignee: 'ghost' }))).toMatch(/not_found/);

    // London style: a collaborator's ConductorError is reported; anything else is a bug and propagates.
    const mockWork = { inbox: vi.fn(() => { throw conflict('inbox is busy'); }) } as unknown as WorkService;
    const mocked = createTasksToolProvider(k, { work: mockWork, org, approvals });
    expect(errorOf(await mocked.call(toolCtx(f.dev), 'inbox', {}))).toBe('conflict: inbox is busy');
    const broken = createTasksToolProvider(k, {
      work: { inbox: () => { throw new TypeError('bug'); } } as unknown as WorkService,
      org,
      approvals,
    });
    await expect(broken.call(toolCtx(f.dev), 'inbox', {})).rejects.toThrow('bug');
  });

  it('takes identity from the call context, never from arguments', async () => {
    const mockWork = { createIssue: vi.fn((): Issue => ({ id: 'iss_1' }) as Issue) };
    const mocked = createTasksToolProvider(k, { work: mockWork as unknown as WorkService, org, approvals });
    await mocked.call(toolCtx(f.dev, { runId: 'run_42' }), 'create_issue', { title: 'Mine' });
    expect(mockWork.createIssue).toHaveBeenCalledWith(
      f.org.id,
      expect.objectContaining({ title: 'Mine' }),
      { kind: 'agent', id: f.dev.id, runId: 'run_42' },
    );
  });

  it('create_issue, search_issues, get_issue, update_issue and comment work end to end', async () => {
    const goal = work.createGoal(f.org.id, { title: 'Dev goal', ownerAgentId: f.dev.id }, OWNER);
    const created = payloadOf<{ issue: Brief & { goalId: string; creator: string } }>(
      await call(f.dev, 'create_issue', { title: 'Audit homepage SEO', body: 'check meta tags', labels: ['seo'], assignee: 'dev' }),
    ).issue;
    expect(created).toMatchObject({ number: 1, status: 'todo', assigneeAgentId: f.dev.id, goalId: goal.id, creator: `agent:${f.dev.id}` });

    // duplicate check
    const dupes = payloadOf<{ count: number; issues: Brief[] }>(await call(f.dev, 'search_issues', { query: 'homepage seo' }));
    expect(dupes.count).toBe(1);
    expect(dupes.issues[0]!.id).toBe(created.id);
    expect(payloadOf<{ count: number }>(await call(f.dev, 'search_issues', { query: 'seo', status: ['done'] })).count).toBe(0);

    const child = payloadOf<{ issue: Brief & { parentIssueId: string } }>(
      await call(f.dev, 'create_issue', { title: 'Fix titles', parentIssue: '#1', blockedBy: [1] }),
    ).issue;
    expect(child.parentIssueId).toBe(created.id);

    const updated = payloadOf<{ issue: Brief & { priority: number } }>(
      await call(f.dev, 'update_issue', { issue: 1, priority: 0, status: 'in_progress' }),
    ).issue;
    expect(updated).toMatchObject({ priority: 0, status: 'in_progress' });
    // update_issue cannot close work: that is report_progress / review_issue.
    expect(errorOf(await call(f.dev, 'update_issue', { issue: 1, status: 'done' }))).toMatch(/validation/);

    const comment = payloadOf<{ comment: { id: string; mentions: string[]; author: string } }>(
      await call(f.dev, 'comment', { body: 'need a hand @june' }, { issueId: created.id }),
    ).comment;
    expect(comment).toMatchObject({ mentions: [f.junior.id], author: `agent:${f.dev.id}` });
    expect(work.listComments(f.org.id, created.id)[0]!.runId).toBe('run_dev');

    const full = payloadOf<{ issue: Brief & { body: string }; comments: Array<{ id: string }>; children: Brief[] }>(
      await call(f.dev, 'get_issue', { issue: created.id }),
    );
    expect(full.issue.body).toBe('check meta tags');
    expect(full.comments.map((c) => c.id)).toEqual([comment.id]);
    expect(full.children.map((c) => c.id)).toEqual([child.id]);
    const childView = payloadOf<{ blockers: Array<{ number: number; status: string }> }>(await call(f.dev, 'get_issue', { issue: 2 }));
    expect(childView.blockers).toEqual([expect.objectContaining({ number: 1, status: 'in_progress' })]);
  });

  it('inbox returns the caller\'s queue, comments and mentions', async () => {
    const issue = work.createIssue(f.org.id, { title: 'For dev', assigneeAgentId: f.dev.id, expectedOutput: 'A report' }, OWNER);
    work.createIssue(f.org.id, { title: 'For junior', assigneeAgentId: f.junior.id }, OWNER);
    k.clock.advance(5);
    work.addComment(f.org.id, issue.id, { body: 'hello @dev' }, OWNER);
    const box = payloadOf<{ issues: Array<Brief & { expectedOutput: string }>; newComments: unknown[]; mentions: unknown[] }>(
      await call(f.dev, 'inbox'),
    );
    expect(box.issues.map((i) => i.title)).toEqual(['For dev']);
    expect(box.issues[0]!.expectedOutput).toBe('A report');
    expect(box.newComments).toHaveLength(1);
    expect(box.mentions).toHaveLength(1);
  });

  it('delegate and escalate follow the reporting line', async () => {
    const parent = work.createIssue(f.org.id, { title: 'Big job', assigneeAgentId: f.lead.id }, OWNER);
    const out = payloadOf<{ children: Brief[] }>(
      await call(
        f.lead,
        'delegate',
        { children: [{ title: 'Part 1', assignee: 'dev', expectedOutput: 'PR' }, { title: 'Part 2', assignee: f.junior.id }] },
        { issueId: parent.id },
      ),
    );
    expect(out.children.map((c) => c.assigneeAgentId)).toEqual([f.dev.id, f.junior.id]);
    expect(errorOf(await call(f.lead, 'delegate', { issue: parent.id, children: [{ title: 'x', assignee: 'mara' }] }))).toMatch(/forbidden/);
    expect(errorOf(await call(f.lead, 'delegate', { issue: parent.id, children: [] }))).toMatch(/validation/);

    const part1 = out.children[0]!;
    const escalated = payloadOf<{ issue: Brief; escalatedTo: string }>(
      await call(f.dev, 'escalate', { reason: 'no access' }, { issueId: part1.id }),
    );
    expect(escalated).toMatchObject({ escalatedTo: f.lead.id, issue: { assigneeAgentId: f.lead.id, status: 'todo' } });

    const ceoIssue = work.createIssue(f.org.id, { title: 'Strategy', assigneeAgentId: f.ceo.id }, OWNER);
    const events = recordEvents(k);
    const top = payloadOf<{ escalatedTo: string; issue: Brief }>(await call(f.ceo, 'escalate', { issue: ceoIssue.number, reason: 'owner call' }));
    expect(top).toMatchObject({ escalatedTo: 'owner', issue: { status: 'blocked' } });
    expect(events.of('notification')).toHaveLength(1);
  });

  describe('report_progress', () => {
    const report = (agent: Agent, issue: Issue, args: Record<string, unknown>) =>
      call(agent, 'report_progress', args, { issueId: issue.id, runId: 'run_r' });

    it('done closes directly only without a reviewer and at autonomy ≥ 2', async () => {
      const issue = work.createIssue(f.org.id, { title: 'Solo', assigneeAgentId: f.dev.id }, OWNER);
      work.checkout(f.org.id, issue.id, 'run_r');
      const events = recordEvents(k);
      const out = payloadOf<{ status: string; note?: string; commentId: string }>(
        await report(f.dev, issue, { status: 'done', summary: 'Shipped it.', artifacts: [{ name: 'report', path: 'out/report.md' }] }),
      );
      expect(out.status).toBe('done');
      expect(out.note).toBeUndefined();
      expect(work.getIssue(f.org.id, issue.id).status).toBe('done');
      expect(events.of('issue.done')).toHaveLength(1);
      const comment = work.listComments(f.org.id, issue.id)[0]!;
      expect(comment).toMatchObject({ id: out.commentId, body: 'Shipped it.', runId: 'run_r', authorId: f.dev.id });
      expect(comment.attachments).toEqual([{ name: 'report', path: '/tmp/conductor-ws/out/report.md' }]);
    });

    it('done becomes in_review when the issue has a reviewer, and wakes the reviewer', async () => {
      const issue = work.createIssue(f.org.id, { title: 'Reviewed', assigneeAgentId: f.dev.id, reviewerAgentId: f.lead.id }, OWNER);
      const out = payloadOf<{ status: string; note: string }>(await report(f.dev, issue, { status: 'done', summary: 'Ready.' }));
      expect(out.status).toBe('in_review');
      expect(out.note).toMatch(/reviewer/);
      const comment = work.listComments(f.org.id, issue.id)[0]!;
      expect(comment.mentions).toEqual([f.lead.id]);
      expect(work.inbox(f.org.id, f.lead.id).newComments.map((c) => c.id)).toEqual([comment.id]);

      // The reviewer gives the verdict through review_issue.
      const verdict = payloadOf<{ issue: Brief; reviewOutcome: string; reworkCount: number }>(
        await call(f.lead, 'review_issue', { issue: issue.id, outcome: 'rejected', note: 'add tests' }),
      );
      expect(verdict).toMatchObject({ issue: { status: 'todo' }, reviewOutcome: 'rejected', reworkCount: 1 });
      expect(errorOf(await call(f.dev, 'review_issue', { issue: issue.id, outcome: 'accepted' }))).toMatch(/conflict/);
    });

    it('done becomes in_review below autonomy 2', async () => {
      const issue = work.createIssue(f.org.id, { title: 'Supervised', assigneeAgentId: f.junior.id }, OWNER);
      const out = payloadOf<{ status: string; note: string }>(await report(f.junior, issue, { status: 'done', summary: 'Done?' }));
      expect(out.status).toBe('in_review');
      expect(out.note).toMatch(/autonomy 2/);
      const internIssue = work.createIssue(f.org.id, { title: 'Assist', assigneeAgentId: f.intern.id }, OWNER);
      expect(payloadOf<{ status: string }>(await report(f.intern, internIssue, { status: 'done', summary: 'ok' })).status).toBe('in_review');
    });

    it('blocked records the reason; explicit in_review is honoured', async () => {
      const issue = work.createIssue(f.org.id, { title: 'Stuck', assigneeAgentId: f.dev.id }, OWNER);
      const out = payloadOf<{ issue: Brief & { blockedReason: string }; status: string }>(
        await report(f.dev, issue, { status: 'blocked', summary: 'Tried twice.', blockedReason: 'needs_human: login wall' }),
      );
      expect(out).toMatchObject({ status: 'blocked', issue: { blockedReason: 'needs_human: login wall' } });
      expect(work.listComments(f.org.id, issue.id)[0]!.body).toContain('needs_human: login wall');

      const other = work.createIssue(f.org.id, { title: 'Check me', assigneeAgentId: f.dev.id }, OWNER);
      expect(payloadOf<{ status: string }>(await report(f.dev, other, { status: 'in_review', summary: 'please look' })).status).toBe('in_review');
    });

    it('refuses bad input without leaving a stray comment', async () => {
      const theirs = work.createIssue(f.org.id, { title: 'Not mine', assigneeAgentId: f.marketer.id }, OWNER);
      expect(errorOf(await report(f.dev, theirs, { status: 'done', summary: 'hijack' }))).toMatch(/forbidden/);
      expect(work.listComments(f.org.id, theirs.id)).toEqual([]);

      const mine = work.createIssue(f.org.id, { title: 'Mine', assigneeAgentId: f.dev.id }, OWNER);
      expect(errorOf(await report(f.dev, mine, { status: 'done', summary: 'x', artifacts: [{ name: 'p', path: '../../etc/passwd' }] }))).toMatch(/validation.*escapes/);
      expect(errorOf(await report(f.dev, mine, { status: 'done', summary: 'x', artifacts: [{ name: 'p', path: '/etc/passwd' }] }))).toMatch(/validation.*outside/);
      expect(errorOf(await report(f.dev, mine, { status: 'cancelled', summary: 'x' }))).toMatch(/validation/);
      expect(errorOf(await report(f.dev, mine, { status: 'done' }))).toMatch(/validation.*summary/);
      expect(work.getIssue(f.org.id, mine.id).status).toBe('todo');
      expect(work.listComments(f.org.id, mine.id)).toEqual([]);

      const backlog = work.createIssue(f.org.id, { title: 'Parked', assigneeAgentId: f.dev.id, status: 'backlog' }, OWNER);
      expect(errorOf(await report(f.dev, backlog, { status: 'done', summary: 'x' }))).toMatch(/conflict.*backlog → done/);
      expect(work.listComments(f.org.id, backlog.id)).toEqual([]);
    });
  });

  it('goals: list_goals, create_goal by autonomy', async () => {
    const orgGoal = work.createGoal(f.org.id, { title: 'Org goal' }, OWNER);
    const own = payloadOf<{ goal: { id: string; level: string; ownerAgentId: string; parentGoalId: string } }>(
      await call(f.dev, 'create_goal', { title: 'Cut build time', parentGoalId: orgGoal.id, weight: 3 }),
    ).goal;
    expect(own).toMatchObject({ level: 'agent', ownerAgentId: f.dev.id, parentGoalId: orgGoal.id });
    expect(errorOf(await call(f.dev, 'create_goal', { title: 'Dept', level: 'dept' }))).toMatch(/forbidden.*autonomy 3/);
    const dept = payloadOf<{ goal: { level: string; deptId: string } }>(await call(f.lead, 'create_goal', { title: 'Dept', level: 'dept' })).goal;
    expect(dept).toMatchObject({ level: 'dept', deptId: f.eng.id });

    expect(payloadOf<{ goals: unknown[] }>(await call(f.intern, 'list_goals')).goals).toHaveLength(3);
    const mine = payloadOf<{ goals: Array<{ id: string }> }>(await call(f.dev, 'list_goals', { mine: true })).goals;
    expect(mine.map((g) => g.id)).toEqual([own.id]);
  });

  it('list_team shows the manager, peers and reports', async () => {
    const team = payloadOf<{
      manager: { id: string } | null; reportsToOwner: boolean; departmentLead: { id: string } | null;
      peers: Array<{ id: string }>; reports: Array<{ id: string }>;
    }>(await call(f.lead, 'list_team'));
    expect(team.manager?.id).toBe(f.ceo.id);
    expect(team.departmentLead?.id).toBe(f.lead.id);
    expect(team.peers.map((a) => a.id)).toEqual([f.marketer.id]);
    expect(team.reports.map((a) => a.id).sort()).toEqual([f.dev.id, f.junior.id, f.intern.id].sort());

    const root = payloadOf<{ manager: null; reportsToOwner: boolean; peers: unknown[]; reports: unknown[] }>(await call(f.ceo, 'list_team'));
    expect(root).toMatchObject({ manager: null, reportsToOwner: true, peers: [] });
    expect(root.reports).toHaveLength(2);
  });

  it('propose_hire asks the Org context to hire as the agent and returns the approval', async () => {
    const hireAgent = vi.fn<OrgService['hireAgent']>((orgId, input) => ({
      approval: fakeApproval({ orgId, kind: 'hire_agent', title: `Hire ${input.name}`, requesterAgentId: f.lead.id }),
    }));
    const orgWithHire = Object.assign(Object.create(org) as OrgService, { hireAgent });
    const provider = createTasksToolProvider(k, { work, org: orgWithHire, approvals });

    const out = payloadOf<{ approval: { id: string; kind: string; status: string } }>(
      await provider.call(toolCtx(f.lead, { runId: 'run_h' }), 'propose_hire', { name: 'Sam', role: 'SRE', goal: 'Keep prod up', autonomyLevel: 1 }),
    );
    expect(out.approval).toMatchObject({ kind: 'hire_agent', status: 'pending' });
    expect(hireAgent).toHaveBeenCalledWith(
      f.org.id,
      expect.objectContaining({ name: 'Sam', role: 'SRE', deptId: f.eng.id, reportsTo: f.lead.id, autonomyLevel: 1 }),
      { kind: 'agent', id: f.lead.id, runId: 'run_h' },
    );
    expect(errorOf(await provider.call(toolCtx(f.lead), 'propose_hire', { name: 'Sam', role: 'SRE', reportsTo: 'ghost' }))).toMatch(/not_found/);
    expect(errorOf(await provider.call(toolCtx(f.lead), 'propose_hire', { name: 'Sam' }))).toMatch(/validation.*role/);
  });

  it('propose_skill_grant goes through the Org context\'s grant_skill gate as the agent', async () => {
    const proposeSkillGrant = vi.fn<NonNullable<OrgService['proposeSkillGrant']>>((orgId, input) => (input.skill === 'already-there'
      ? { agent: { ...f.dev, skills: ['already-there'] } }
      : { approval: fakeApproval({ orgId, kind: 'grant_skill', title: `Grant skill "${input.skill}"`, requesterAgentId: f.lead.id }) }));
    const gated = Object.assign(Object.create(org) as OrgService, { proposeSkillGrant });
    const provider = createTasksToolProvider(k, { work, org: gated, approvals });
    const asLead = toolCtx(f.lead, { runId: 'run_g' });
    const actor = { kind: 'agent', id: f.lead.id, runId: 'run_g' };

    const res = payloadOf<{ approval: { kind: string; status: string }; note: string }>(
      await provider.call(asLead, 'propose_skill_grant', { skill: 'release-notes', target: 'dev', reason: 'Dev owns the changelog; key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345' }),
    );
    expect(res.approval).toMatchObject({ kind: 'grant_skill', status: 'pending' });
    expect(res.note).toMatch(/only if the owner approves/);
    expect(proposeSkillGrant).toHaveBeenLastCalledWith(f.org.id, { scope: 'agent', id: f.dev.id, skill: 'release-notes', reason: expect.stringContaining('[REDACTED]') }, actor);
    expect(JSON.stringify(proposeSkillGrant.mock.calls)).not.toContain('abcdefghijklmnopqrstuvwxyz');
    // Defaults: the caller itself, its own department, or the whole org.
    await provider.call(asLead, 'propose_skill_grant', { skill: 'x', reason: 'r' });
    expect(proposeSkillGrant).toHaveBeenLastCalledWith(f.org.id, expect.objectContaining({ scope: 'agent', id: f.lead.id }), actor);
    await provider.call(asLead, 'propose_skill_grant', { skill: 'x', scope: 'dept', reason: 'r' });
    expect(proposeSkillGrant).toHaveBeenLastCalledWith(f.org.id, expect.objectContaining({ scope: 'dept', id: f.eng.id }), actor);
    await provider.call(asLead, 'propose_skill_grant', { skill: 'x', scope: 'org', reason: 'r' });
    expect(proposeSkillGrant).toHaveBeenLastCalledWith(f.org.id, expect.objectContaining({ scope: 'org', id: undefined }), actor);
    // An ungated (or already present) grant reports the result instead of an approval.
    const direct = payloadOf<{ granted: boolean; agent: { skills: string[] } }>(await provider.call(asLead, 'propose_skill_grant', { skill: 'already-there', target: 'dev', reason: 'r' }));
    expect(direct).toMatchObject({ granted: true, agent: { skills: ['already-there'] } });

    expect(errorOf(await provider.call(asLead, 'propose_skill_grant', { skill: 'x' }))).toMatch(/validation.*reason/);
    expect(errorOf(await provider.call(asLead, 'propose_skill_grant', { skill: 'x', target: 'ghost', reason: 'r' }))).toMatch(/not_found/);
    const calls = proposeSkillGrant.mock.calls.length;
    expect(errorOf(await provider.call(toolCtx(f.dev), 'propose_skill_grant', { skill: 'x', reason: 'r' }))).toMatch(/forbidden.*autonomy level 3/);
    expect(proposeSkillGrant).toHaveBeenCalledTimes(calls);
    // An Org context without the operation says so instead of failing obscurely.
    const without = createTasksToolProvider(k, { work, org: Object.assign(Object.create(org) as OrgService, { proposeSkillGrant: undefined }), approvals });
    expect(errorOf(await without.call(asLead, 'propose_skill_grant', { skill: 'x', reason: 'r' }))).toMatch(/unavailable/);
  });

  it('propose_termination and propose_budget_change go through the Org context\'s gated actions as the agent', async () => {
    const terminateAgent = vi.fn<OrgService['terminateAgent']>((orgId) => ({
      approval: fakeApproval({ orgId, kind: 'terminate_agent', title: 'Terminate June', requesterAgentId: f.lead.id }),
    }));
    const proposeBudgetChange = vi.fn<NonNullable<OrgService['proposeBudgetChange']>>((orgId) => ({
      approval: fakeApproval({ orgId, kind: 'budget_raise', title: 'Set Dev budget', requesterAgentId: f.lead.id }),
    }));
    const gated = Object.assign(Object.create(org) as OrgService, { terminateAgent, proposeBudgetChange });
    const provider = createTasksToolProvider(k, { work, org: gated, approvals });
    const asLead = toolCtx(f.lead, { runId: 'run_g' });
    const actor = { kind: 'agent', id: f.lead.id, runId: 'run_g' };

    const fired = payloadOf<{ approval: { kind: string; status: string }; note: string }>(
      await provider.call(asLead, 'propose_termination', { agent: 'june', reason: 'Duplicates the QA suite; key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345' }),
    );
    expect(fired.approval).toMatchObject({ kind: 'terminate_agent', status: 'pending' });
    expect(fired.note).toMatch(/only if the owner approves/);
    expect(terminateAgent).toHaveBeenCalledWith(f.org.id, f.junior.id, actor, { reason: expect.stringContaining('[REDACTED]') });
    expect(JSON.stringify(terminateAgent.mock.calls)).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(errorOf(await provider.call(asLead, 'propose_termination', { agent: 'ghost', reason: 'x' }))).toMatch(/not_found/);
    expect(errorOf(await provider.call(asLead, 'propose_termination', { agent: 'june' }))).toMatch(/validation.*reason/);

    const raise = payloadOf<{ approval: { kind: string } }>(
      await provider.call(asLead, 'propose_budget_change', { scope: 'agent', target: 'dev', budgetUsd: 120, reason: 'More review load' }),
    );
    expect(raise.approval.kind).toBe('budget_raise');
    expect(proposeBudgetChange).toHaveBeenLastCalledWith(f.org.id, { scope: 'agent', id: f.dev.id, budgetUsd: 120, reason: 'More review load' }, actor);
    // Defaults: the caller itself, or its own department.
    await provider.call(asLead, 'propose_budget_change', { scope: 'agent', budgetUsd: null, reason: 'Uncap' });
    expect(proposeBudgetChange).toHaveBeenLastCalledWith(f.org.id, expect.objectContaining({ scope: 'agent', id: f.lead.id, budgetUsd: null }), actor);
    await provider.call(asLead, 'propose_budget_change', { scope: 'dept', budgetUsd: 500, reason: 'Q3' });
    expect(proposeBudgetChange).toHaveBeenLastCalledWith(f.org.id, expect.objectContaining({ scope: 'dept', id: f.eng.id }), actor);
    expect(errorOf(await provider.call(asLead, 'propose_budget_change', { scope: 'agent', budgetUsd: -1, reason: 'x' }))).toMatch(/validation/);

    // Below autonomy 3 the tools are refused before the Org context is asked.
    expect(errorOf(await provider.call(toolCtx(f.dev), 'propose_termination', { agent: 'june', reason: 'x' }))).toMatch(/forbidden.*autonomy level 3/);
    expect(errorOf(await provider.call(toolCtx(f.dev), 'propose_budget_change', { scope: 'agent', budgetUsd: 1, reason: 'x' }))).toMatch(/forbidden/);
    expect(terminateAgent).toHaveBeenCalledTimes(1);
  });

  it('create_issue at autonomy 1 makes sub-issues of the agent\'s own work only', async () => {
    const mine = work.createIssue(f.org.id, { title: 'Test the release', assigneeAgentId: f.junior.id }, OWNER);
    const theirs = work.createIssue(f.org.id, { title: 'Build the release', assigneeAgentId: f.dev.id }, OWNER);

    // Inside a run the parent defaults to the issue being worked on.
    const sub = payloadOf<{ issue: Brief & { parentIssueId: string; goalId: string } }>(
      await call(f.junior, 'create_issue', { title: 'Write regression cases' }, { issueId: mine.id }),
    ).issue;
    expect(sub.parentIssueId).toBe(mine.id);
    expect(sub.goalId).toBe(work.getIssue(f.org.id, mine.id).goalId);
    // …and a sub-issue of its own sub-issue is still its own work.
    expect(payloadOf<{ issue: Brief }>(await call(f.junior, 'create_issue', { title: 'Deeper', parentIssue: sub.number })).issue.title).toBe('Deeper');

    expect(errorOf(await call(f.junior, 'create_issue', { title: 'Free-floating' }))).toMatch(/forbidden.*autonomy 1.*sub-issues of its own work/);
    expect(errorOf(await call(f.junior, 'create_issue', { title: 'Not mine', parentIssue: theirs.number }))).toMatch(/forbidden/);
    // Autonomy 2 creates any issue.
    expect(payloadOf<{ issue: Brief }>(await call(f.dev, 'create_issue', { title: 'Proactive' })).issue.title).toBe('Proactive');
  });

  it('reassign (autonomy 3) moves work within the reporting line', async () => {
    const issue = work.createIssue(f.org.id, { title: 'Move me', assigneeAgentId: f.dev.id }, OWNER);
    const moved = payloadOf<{ issue: Brief }>(await call(f.lead, 'reassign', { issue: issue.number, assignee: 'june' })).issue;
    expect(moved.assigneeAgentId).toBe(f.junior.id);
    expect(errorOf(await call(f.lead, 'reassign', { issue: issue.id, assignee: 'mara' }))).toMatch(/forbidden/);
    expect(payloadOf<{ issue: Brief }>(await call(f.lead, 'reassign', { issue: issue.id, assignee: null })).issue.assigneeAgentId).toBeNull();
  });

  it('request_approval forwards to the ApprovalService with the caller\'s identity', async () => {
    const out = payloadOf<{ approval: { id: string; status: string } }>(
      await call(
        f.dev,
        'request_approval',
        { kind: 'payment', title: 'Buy domain', payload: { amountUsd: 12, note: 'key sk-ant-abcdefghijklmnopqrstuvwx' } },
        { issueId: 'iss_ctx', runId: 'run_9' },
      ),
    );
    expect(out.approval).toMatchObject({ id: 'apr_test', status: 'pending' });
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(approvals.request).toHaveBeenCalledWith({
      orgId: f.org.id,
      kind: 'payment',
      title: 'Buy domain',
      payload: { amountUsd: 12, note: 'key [REDACTED]' },
      requesterAgentId: f.dev.id,
      runId: 'run_9',
      issueId: 'iss_ctx',
    });
    // Kinds that belong to dedicated flows (hires, grants…) cannot be forged here.
    expect(errorOf(await call(f.dev, 'request_approval', { kind: 'hire_agent', title: 'x' }))).toMatch(/validation/);
    expect(approvals.request).toHaveBeenCalledTimes(1);
  });

  it('list_playbooks and run_playbook', async () => {
    const pb = work.createPlaybook(
      f.org.id,
      { name: 'Ship It', steps: [{ title: 'Build', description: 'compile', expectedOutput: 'binary', agentRole: 'Engineer' }, { title: 'Test', description: '', expectedOutput: 'report', agentRole: 'QA Tester' }] },
      OWNER,
    );
    const listed = payloadOf<{ playbooks: Array<{ id: string; name: string; steps: unknown[] }> }>(await call(f.intern, 'list_playbooks'));
    expect(listed.playbooks).toEqual([expect.objectContaining({ id: pb.id, name: 'Ship It' })]);

    const parent = work.createIssue(f.org.id, { title: 'Release', assigneeAgentId: f.lead.id }, OWNER);
    const run = payloadOf<{ children: Array<Brief & { blockedBy: string[] }> }>(
      await call(f.lead, 'run_playbook', { playbook: 'ship it' }, { issueId: parent.id }),
    );
    expect(run.children.map((c) => c.assigneeAgentId)).toEqual([f.dev.id, f.junior.id]);
    expect(run.children[1]!.blockedBy).toEqual([run.children[0]!.id]);
    expect(errorOf(await call(f.lead, 'run_playbook', { playbook: 'missing', issue: parent.id }))).toMatch(/not_found/);
  });

  it('keeps organizations isolated', async () => {
    const other = seedCompany(k, 'Beta');
    const foreign = work.createIssue(other.org.id, { title: 'Beta secret', assigneeAgentId: other.dev.id }, OWNER);
    work.createGoal(other.org.id, { title: 'Beta goal' }, OWNER);
    work.createPlaybook(other.org.id, { name: 'Beta play', steps: [{ title: 's', description: '', expectedOutput: '' }] }, OWNER);

    expect(errorOf(await call(f.ceo, 'get_issue', { issue: foreign.id }))).toMatch(/not_found/);
    expect(errorOf(await call(f.ceo, 'comment', { issue: foreign.id, body: 'hi' }))).toMatch(/not_found/);
    expect(errorOf(await call(f.ceo, 'report_progress', { issue: foreign.id, status: 'done', summary: 'x' }))).toMatch(/not_found/);
    expect(errorOf(await call(f.ceo, 'reassign', { issue: foreign.id, assignee: 'dev' }))).toMatch(/not_found/);
    expect(errorOf(await call(f.ceo, 'create_issue', { title: 'x', assignee: other.dev.id }))).toMatch(/not_found/);
    expect(payloadOf<{ count: number }>(await call(f.ceo, 'search_issues', { query: 'secret' })).count).toBe(0);
    expect(payloadOf<{ goals: unknown[] }>(await call(f.ceo, 'list_goals')).goals).toEqual([]);
    expect(payloadOf<{ playbooks: unknown[] }>(await call(f.ceo, 'list_playbooks')).playbooks).toEqual([]);
    expect(payloadOf<{ issues: unknown[] }>(await call(f.ceo, 'inbox')).issues).toEqual([]);
    expect(work.getIssue(other.org.id, foreign.id)).toMatchObject({ status: 'todo', assigneeAgentId: other.dev.id });
  });
});
