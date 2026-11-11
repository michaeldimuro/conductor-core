import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER } from '../../src/contracts/types.js';
import { configRevisions, issues } from '../../src/db/schema/index.js';
import { newId } from '../../src/shared/ids.js';
import type { WorkContext } from '../../src/work/index.js';
import { createWorkService } from '../../src/work/index.js';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { as, codeOf, createFakeOrg, recordEvents, seedCompany, type Fixture } from './helpers.js';

describe('work: goals, projects and playbooks lifecycle', () => {
  let k: TestKernel;
  let work: WorkContext;
  let f: Fixture;
  beforeEach(() => {
    k = createTestKernel();
    work = createWorkService(k, { org: createFakeOrg(k) });
    f = seedCompany(k);
  });
  afterEach(() => k.dispose());

  const revisions = (kind: string, id: string) =>
    k.db.select().from(configRevisions).where(and(eq(configRevisions.orgId, f.org.id), eq(configRevisions.entityKind, kind), eq(configRevisions.entityId, id))).all();
  const steps = [{ title: 'Research', description: '', expectedOutput: 'Sources' }];

  describe('every issue traces to a goal', () => {
    it('creates the org\'s default goal on first use instead of leaving goalId null', () => {
      const events = recordEvents(k);
      expect(work.listGoals(f.org.id)).toEqual([]);
      const first = work.createIssue(f.org.id, { title: 'No goals yet' }, OWNER);
      const [fallback] = work.listGoals(f.org.id);
      expect(fallback).toMatchObject({ level: 'org', status: 'active', title: 'Acme: general operations' });
      expect(first.goalId).toBe(fallback!.id);
      expect(events.of('goal.created')).toEqual([{ orgId: f.org.id, goalId: fallback!.id }]);
      expect(k.audit.query({ orgId: f.org.id, action: 'goal.created' })[0]).toMatchObject({ actor: { kind: 'system' }, data: { default: true } });

      // It is created once and reused; other orgs get their own.
      expect(work.createIssue(f.org.id, { title: 'Second' }, OWNER).goalId).toBe(fallback!.id);
      expect(work.listGoals(f.org.id)).toHaveLength(1);
      const other = seedCompany(k, 'Other');
      const theirs = work.createIssue(other.org.id, { title: 'Elsewhere' }, OWNER);
      expect(theirs.goalId).not.toBe(fallback!.id);
      expect(work.getGoal(other.org.id, theirs.goalId!).orgId).toBe(other.org.id);
    });

    it('inherits the parent\'s goal, then the project\'s, before any agent or org goal', () => {
      const orgGoal = work.createGoal(f.org.id, { title: 'Org' }, OWNER);
      const projectGoal = work.createGoal(f.org.id, { title: 'Launch', deptId: f.eng.id }, OWNER);
      work.createGoal(f.org.id, { title: 'Dev goal', ownerAgentId: f.dev.id }, OWNER);
      const project = work.createProject(f.org.id, { name: 'Launch site', goalId: projectGoal.id }, OWNER);

      const top = work.createIssue(f.org.id, { title: 'In project', projectId: project.id, assigneeAgentId: f.dev.id }, OWNER);
      expect(top.goalId).toBe(projectGoal.id);
      const child = work.createIssue(f.org.id, { title: 'Child', parentIssueId: top.id }, OWNER);
      expect(child).toMatchObject({ goalId: projectGoal.id, projectId: project.id });
      expect(work.createIssue(f.org.id, { title: 'Plain' }, OWNER).goalId).toBe(orgGoal.id);
    });

    it('never clears a goal: goalId null falls back to the inherited one, and legacy rows are repaired on update', () => {
      const orgGoal = work.createGoal(f.org.id, { title: 'Org' }, OWNER);
      const special = work.createGoal(f.org.id, { title: 'Special', deptId: f.eng.id }, OWNER);
      const issue = work.createIssue(f.org.id, { title: 'Pinned', goalId: special.id }, OWNER);
      expect(work.updateIssue(f.org.id, issue.id, { goalId: null }, OWNER).goalId).toBe(orgGoal.id);
      expect(codeOf(() => work.updateIssue(f.org.id, issue.id, { goalId: 'goal_missing' }, OWNER))).toBe('not_found');

      // A row written before the rule existed.
      const legacy = newId('issue');
      k.db.insert(issues).values({ id: legacy, orgId: f.org.id, number: 900, title: 'Legacy', createdAt: 1, updatedAt: 1 }).run();
      expect(work.getIssue(f.org.id, legacy).goalId).toBeNull();
      expect(work.updateIssue(f.org.id, legacy, { priority: 1 }, OWNER).goalId).toBe(orgGoal.id);
    });
  });

  describe('autonomy 1 creates only its own sub-issues', () => {
    it('refuses top-level issues and children of other agents\' work', () => {
      const mine = work.createIssue(f.org.id, { title: 'Mine', assigneeAgentId: f.junior.id }, OWNER);
      const theirs = work.createIssue(f.org.id, { title: 'Theirs', assigneeAgentId: f.dev.id }, OWNER);
      expect(codeOf(() => work.createIssue(f.org.id, { title: 'Top level' }, as(f.junior)))).toBe('forbidden');
      expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', parentIssueId: theirs.id }, as(f.junior)))).toBe('forbidden');

      const sub = work.createIssue(f.org.id, { title: 'Sub', parentIssueId: mine.id }, as(f.junior));
      expect(sub).toMatchObject({ parentIssueId: mine.id, creatorId: f.junior.id });
      // Its own sub-issue is its own work too, even while unassigned.
      expect(work.createIssue(f.org.id, { title: 'Sub-sub', parentIssueId: sub.id }, as(f.junior)).parentIssueId).toBe(sub.id);

      // delegate and run_playbook split the agent's own issue, never someone else's.
      expect(work.delegate(f.org.id, mine.id, [{ title: 'Part', assigneeAgentId: f.junior.id }], as(f.junior))).toHaveLength(1);
      expect(codeOf(() => work.delegate(f.org.id, theirs.id, [{ title: 'Part', assigneeAgentId: f.junior.id }], as(f.junior)))).toBe('forbidden');
      const pb = work.createPlaybook(f.org.id, { name: 'QA', steps }, OWNER);
      expect(work.runPlaybook(f.org.id, pb.id, mine.id, as(f.junior))).toHaveLength(1);

      // Autonomy 0 creates nothing; autonomy 2 and 3 create freely.
      const interns = work.createIssue(f.org.id, { title: 'Intern task', assigneeAgentId: f.intern.id }, OWNER);
      expect(codeOf(() => work.createIssue(f.org.id, { title: 'x', parentIssueId: interns.id }, as(f.intern)))).toBe('forbidden');
      expect(work.createIssue(f.org.id, { title: 'Proactive' }, as(f.dev)).creatorId).toBe(f.dev.id);
      expect(work.createIssue(f.org.id, { title: 'Lead task', assigneeAgentId: f.junior.id }, as(f.lead)).assigneeAgentId).toBe(f.junior.id);
    });
  });

  describe('deleteGoal', () => {
    it('moves child goals, projects and issues to the parent, keeps a revision and emits goal.deleted', () => {
      const root = work.createGoal(f.org.id, { title: 'Root' }, OWNER);
      const mid = work.createGoal(f.org.id, { title: 'Mid', parentGoalId: root.id, deptId: f.eng.id }, OWNER);
      const leaf = work.createGoal(f.org.id, { title: 'Leaf', parentGoalId: mid.id, ownerAgentId: f.dev.id }, OWNER);
      const project = work.createProject(f.org.id, { name: 'P', goalId: mid.id }, OWNER);
      const issue = work.createIssue(f.org.id, { title: 'On mid', goalId: mid.id }, OWNER);
      const events = recordEvents(k);

      work.deleteGoal(f.org.id, mid.id, OWNER);
      expect(codeOf(() => work.getGoal(f.org.id, mid.id))).toBe('not_found');
      expect(work.getGoal(f.org.id, leaf.id).parentGoalId).toBe(root.id);
      expect(work.getProject(f.org.id, project.id).goalId).toBe(root.id);
      expect(work.getIssue(f.org.id, issue.id).goalId).toBe(root.id);
      expect(events.of('goal.deleted')).toEqual([{ orgId: f.org.id, goalId: mid.id }]);
      expect(k.audit.query({ orgId: f.org.id, action: 'goal.deleted' })[0]?.data).toMatchObject({ title: 'Mid', childGoals: 1, projects: 1, issues: 1, issuesMovedTo: root.id });
      const revs = revisions('goal', mid.id);
      expect(revs.map((r) => r.note)).toEqual(['created', 'deleted']);
      expect(revs[1]?.snapshot).toMatchObject({ title: 'Mid', parentGoalId: root.id });
      expect(work.goalTree(f.org.id)[0]?.children.map((c) => c.goal.id)).toEqual([leaf.id]);
    });

    it('sends a root goal\'s issues to the default goal, so none is left without one', () => {
      const only = work.createGoal(f.org.id, { title: 'Only goal' }, OWNER);
      const issue = work.createIssue(f.org.id, { title: 'Orphan-to-be' }, OWNER);
      expect(issue.goalId).toBe(only.id);
      work.deleteGoal(f.org.id, only.id, OWNER);
      const moved = work.getIssue(f.org.id, issue.id);
      expect(moved.goalId).not.toBeNull();
      expect(moved.goalId).not.toBe(only.id);
      expect(work.getGoal(f.org.id, moved.goalId!).level).toBe('org');
    });

    it('applies the goal-setting rules to agents and stays inside the org', () => {
      const orgGoal = work.createGoal(f.org.id, { title: 'Org' }, OWNER);
      const devGoal = work.createGoal(f.org.id, { title: 'Dev', ownerAgentId: f.dev.id }, OWNER);
      expect(codeOf(() => work.deleteGoal(f.org.id, orgGoal.id, as(f.lead)))).toBe('forbidden');
      expect(codeOf(() => work.deleteGoal(f.org.id, devGoal.id, as(f.junior)))).toBe('forbidden');
      const other = seedCompany(k, 'Other');
      expect(codeOf(() => work.deleteGoal(other.org.id, devGoal.id, OWNER))).toBe('not_found');
      work.deleteGoal(f.org.id, devGoal.id, as(f.dev));
      expect(work.listGoals(f.org.id).map((g) => g.id)).toEqual([orgGoal.id]);
    });
  });

  describe('updateProject', () => {
    it('edits and archives a project with revisions, audit and events', () => {
      const goal = work.createGoal(f.org.id, { title: 'G' }, OWNER);
      const project = work.createProject(f.org.id, { name: 'Site', budgetUsd: 10 }, OWNER);
      const events = recordEvents(k);

      const updated = work.updateProject(f.org.id, project.id, { name: 'Website', goalId: goal.id, budgetUsd: 25 }, OWNER);
      expect(updated).toMatchObject({ name: 'Website', goalId: goal.id, budgetUsd: 25, status: 'active' });
      expect(events.of('project.updated')).toEqual([{ orgId: f.org.id, projectId: project.id }]);
      expect(events.of('budget.updated')).toEqual([{ orgId: f.org.id, scope: 'project', scopeId: project.id }]);
      expect(work.updateProject(f.org.id, project.id, { status: 'archived' }, OWNER).status).toBe('archived');
      expect(k.audit.query({ orgId: f.org.id, action: 'project.archived' })).toHaveLength(1);
      expect(revisions('project', project.id).map((r) => r.revision)).toEqual([1, 2, 3]);

      // A no-op writes nothing.
      work.updateProject(f.org.id, project.id, { name: 'Website' }, OWNER);
      expect(revisions('project', project.id)).toHaveLength(3);
    });

    it('validates, keeps budgets board-only and confines agents to the org directory', () => {
      const project = work.createProject(f.org.id, { name: 'Site' }, OWNER);
      expect(codeOf(() => work.updateProject(f.org.id, project.id, { goalId: 'goal_missing' }, OWNER))).toBe('not_found');
      expect(codeOf(() => work.updateProject(f.org.id, project.id, { name: '' }, OWNER))).toBe('validation');
      expect(codeOf(() => work.updateProject(f.org.id, project.id, { workspacePath: 'relative/path' }, OWNER))).toBe('validation');
      expect(codeOf(() => work.updateProject(f.org.id, 'prj_missing', { name: 'x' }, OWNER))).toBe('not_found');
      expect(codeOf(() => work.updateProject(seedCompany(k, 'Other').org.id, project.id, { name: 'x' }, OWNER))).toBe('not_found');

      expect(codeOf(() => work.updateProject(f.org.id, project.id, { name: 'x' }, as(f.junior)))).toBe('forbidden');
      expect(codeOf(() => work.updateProject(f.org.id, project.id, { budgetUsd: 1000 }, as(f.dev)))).toBe('forbidden');
      expect(codeOf(() => work.updateProject(f.org.id, project.id, { workspacePath: '/etc' }, as(f.dev)))).toBe('forbidden');
      expect(work.updateProject(f.org.id, project.id, { name: 'Renamed by dev' }, as(f.dev)).name).toBe('Renamed by dev');
    });
  });

  describe('updatePlaybook / deletePlaybook', () => {
    it('edits a playbook with a revision and a playbook.changed event', () => {
      const pb = work.createPlaybook(f.org.id, { name: 'Content', steps }, OWNER);
      work.createPlaybook(f.org.id, { name: 'Taken', steps }, OWNER);
      const events = recordEvents(k);

      const updated = work.updatePlaybook(f.org.id, pb.id, {
        name: 'Content v2', process: 'hierarchical', managerAgentId: f.lead.id,
        steps: [...steps, { title: 'Publish', description: 'Ship', expectedOutput: 'URL', agentId: f.dev.id }],
      }, OWNER);
      expect(updated).toMatchObject({ name: 'Content v2', process: 'hierarchical', managerAgentId: f.lead.id });
      expect(updated.steps).toHaveLength(2);
      expect(events.of('playbook.changed')).toEqual([{ orgId: f.org.id, playbookId: pb.id, change: 'updated' }]);
      expect(revisions('playbook', pb.id).map((r) => r.note)).toEqual(['created', 'updated']);
      expect(k.audit.query({ orgId: f.org.id, action: 'playbook.updated' })[0]?.data).toMatchObject({ name: 'Content v2', steps: 2 });

      expect(codeOf(() => work.updatePlaybook(f.org.id, pb.id, { name: 'Taken' }, OWNER))).toBe('conflict');
      expect(codeOf(() => work.updatePlaybook(f.org.id, pb.id, { steps: [] }, OWNER))).toBe('validation');
      expect(codeOf(() => work.updatePlaybook(f.org.id, pb.id, { managerAgentId: 'agt_missing' }, OWNER))).toBe('not_found');
      expect(codeOf(() => work.updatePlaybook(f.org.id, pb.id, { description: 'x' }, as(f.junior)))).toBe('forbidden');
      expect(codeOf(() => work.updatePlaybook(seedCompany(k, 'Other').org.id, pb.id, { description: 'x' }, OWNER))).toBe('not_found');
    });

    it('deletes a playbook, unlinking the issues it created but keeping them', () => {
      const pb = work.createPlaybook(f.org.id, { name: 'Content', steps }, OWNER);
      const parent = work.createIssue(f.org.id, { title: 'Write post', assigneeAgentId: f.dev.id }, OWNER);
      const [child] = work.runPlaybook(f.org.id, pb.id, parent.id, OWNER);
      const events = recordEvents(k);

      expect(codeOf(() => work.deletePlaybook(f.org.id, pb.id, as(f.junior)))).toBe('forbidden');
      work.deletePlaybook(f.org.id, pb.id, OWNER);
      expect(work.listPlaybooks(f.org.id)).toEqual([]);
      expect(work.getIssue(f.org.id, child!.id)).toMatchObject({ playbookId: null, title: 'Research' });
      expect(work.getIssue(f.org.id, parent.id).playbookId).toBeNull();
      expect(events.of('playbook.changed')).toEqual([{ orgId: f.org.id, playbookId: pb.id, change: 'deleted' }]);
      expect(k.audit.query({ orgId: f.org.id, action: 'playbook.deleted' })[0]?.data).toMatchObject({ name: 'Content', issuesUnlinked: 2 });
      expect(revisions('playbook', pb.id).at(-1)).toMatchObject({ note: 'deleted', snapshot: { name: 'Content' } });
      expect(codeOf(() => work.deletePlaybook(f.org.id, pb.id, OWNER))).toBe('not_found');
      // The name is free again.
      expect(work.createPlaybook(f.org.id, { name: 'Content', steps }, OWNER).id).not.toBe(pb.id);
    });
  });

  it('emits issue.reviewed with the verdict', () => {
    const issue = work.createIssue(f.org.id, { title: 'Review me', assigneeAgentId: f.dev.id, status: 'in_progress' }, OWNER);
    work.updateIssue(f.org.id, issue.id, { status: 'in_review' }, OWNER);
    const events = recordEvents(k);
    work.review(f.org.id, issue.id, 'rejected', 'Missing tests', OWNER);
    expect(events.of('issue.reviewed')).toEqual([{ orgId: f.org.id, issueId: issue.id, outcome: 'rejected' }]);
  });
});
