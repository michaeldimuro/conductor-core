import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { OWNER, type Actor } from '../../src/contracts/types.js';
import type { Agent, Department, Organization } from '../../src/contracts/rows.js';
import type { OrgContext } from '../../src/org/index.js';
import { createWorkService, type WorkContext } from '../../src/work/index.js';
import { codeOf, recordEvents, setup, type FakeApprovals } from './fakes.js';

describe('org lifecycle, budget proposals and work-config rollback', () => {
  let k: TestKernel;
  let org: OrgContext;
  let work: WorkContext;
  let approvals: FakeApprovals;
  let acme: Organization;
  let eng: Department;
  let ops: Department;
  let lead: Agent;
  let dev: Agent;
  let outsider: Agent;
  let asLead: Actor;

  beforeEach(() => {
    k = createTestKernel();
    ({ org, approvals } = setup(k));
    work = createWorkService(k, { org });
    acme = org.createOrg({ name: 'Acme' }, OWNER);
    eng = org.createDept(acme.id, { name: 'Eng' }, OWNER);
    ops = org.createDept(acme.id, { name: 'Ops' }, OWNER);
    lead = org.hireAgent(acme.id, { deptId: eng.id, name: 'Lead', role: 'Lead', autonomyLevel: 3, isLead: true }, OWNER).agent!;
    dev = org.hireAgent(acme.id, { deptId: eng.id, name: 'Dev', role: 'Engineer', autonomyLevel: 2, reportsTo: lead.id }, OWNER).agent!;
    outsider = org.hireAgent(acme.id, { deptId: ops.id, name: 'Olly', role: 'Operator', autonomyLevel: 2 }, OWNER).agent!;
    asLead = { kind: 'agent', id: lead.id, runId: 'run_1' };
  });
  afterEach(() => {
    org.dispose();
    k.dispose();
  });

  it('archives and unarchives an org, announcing both on the bus', () => {
    const events = recordEvents(k);
    expect(org.archiveOrg(acme.id, OWNER).status).toBe('archived');
    // The runtime cancels in-flight runs off this event.
    expect(events).toContainEqual(['org.archived', { orgId: acme.id }]);
    expect(codeOf(() => org.createDept(acme.id, { name: 'Late' }, OWNER))).toBeDefined();

    expect(codeOf(() => org.unarchiveOrg(acme.id, asLead))).toBe('forbidden');
    expect(org.unarchiveOrg(acme.id, OWNER).status).toBe('active');
    expect(events).toContainEqual(['org.unarchived', { orgId: acme.id }]);
    expect(events.filter(([n]) => n === 'org.unarchived')).toHaveLength(1);
    // Idempotent: a second call changes nothing and announces nothing.
    org.unarchiveOrg(acme.id, OWNER);
    expect(events.filter(([n]) => n === 'org.unarchived')).toHaveLength(1);
    expect(org.createDept(acme.id, { name: 'Late' }, OWNER).slug).toBe('late');
    expect(k.audit.query({ orgId: acme.id, entityKind: 'org' }).map((a) => a.action)).toEqual(expect.arrayContaining(['org.archived', 'org.unarchived']));
  });

  it('archives a department only once it is empty, and can bring it back', () => {
    expect(codeOf(() => org.archiveDept(acme.id, eng.id, asLead))).toBe('forbidden');
    expect(codeOf(() => org.archiveDept(acme.id, eng.id, OWNER))).toBe('conflict');
    expect(org.getDept(acme.id, eng.id).status).toBe('active');

    org.terminateAgent(acme.id, dev.id, OWNER);
    org.terminateAgent(acme.id, lead.id, OWNER);
    const archived = org.archiveDept(acme.id, eng.id, OWNER);
    expect(archived).toMatchObject({ status: 'archived', leadAgentId: null });
    expect(org.listRevisions(acme.id, 'dept', eng.id)[0]?.snapshot).toMatchObject({ status: 'archived' });
    // Nobody can be hired into an archived department.
    expect(codeOf(() => org.hireAgent(acme.id, { deptId: eng.id, name: 'Late', role: 'Engineer' }, OWNER))).toBeDefined();

    expect(org.unarchiveDept(acme.id, eng.id, OWNER).status).toBe('active');
    expect(org.hireAgent(acme.id, { deptId: eng.id, name: 'Late', role: 'Engineer' }, OWNER).agent?.slug).toBe('late');
    // Another org's department is not reachable.
    const other = org.createOrg({ name: 'Other' }, OWNER);
    expect(codeOf(() => org.archiveDept(other.id, ops.id, OWNER))).toBe('not_found');
  });

  it('lets the owner change a budget directly', () => {
    const events = recordEvents(k);
    expect(org.proposeBudgetChange(acme.id, { scope: 'agent', id: dev.id, budgetUsd: 25 }, OWNER).agent?.budgetUsd).toBe(25);
    expect(org.proposeBudgetChange(acme.id, { scope: 'dept', id: eng.id, budgetUsd: 300 }, OWNER).department?.budgetUsd).toBe(300);
    expect(approvals.rows.size).toBe(0);
    expect(events).toContainEqual(['budget.updated', { orgId: acme.id, scope: 'agent', scopeId: dev.id }]);
    expect(events).toContainEqual(['budget.updated', { orgId: acme.id, scope: 'dept', scopeId: eng.id }]);
    expect(codeOf(() => org.proposeBudgetChange(acme.id, { scope: 'agent', id: dev.id, budgetUsd: -1 }, OWNER))).toBe('validation');
  });

  it('files a budget_raise approval for a lead and applies it once approved', () => {
    const events = recordEvents(k);
    const res = org.proposeBudgetChange(acme.id, { scope: 'agent', id: dev.id, budgetUsd: 80, reason: 'Bigger test matrix' }, asLead);
    expect(res.agent).toBeUndefined();
    expect(res.approval).toMatchObject({ kind: 'budget_raise', status: 'pending', requesterAgentId: lead.id, runId: 'run_1' });
    expect(res.approval?.payload).toMatchObject({
      matchKey: `budget_raise:agent:${dev.id}:80`, context: 'org', previousUsd: null, requestedBy: lead.id,
      input: { scope: 'agent', id: dev.id, budgetUsd: 80, reason: 'Bigger test matrix' },
    });
    expect(org.getAgent(acme.id, dev.id).budgetUsd).toBeNull();
    expect(k.audit.query({ orgId: acme.id, action: 'budget.change_requested' })[0]?.data).toMatchObject({ scope: 'agent', id: dev.id, budgetUsd: 80 });
    // Asking again reuses the open approval.
    expect(org.proposeBudgetChange(acme.id, { scope: 'agent', id: dev.id, budgetUsd: 80 }, asLead).approval?.id).toBe(res.approval?.id);
    expect(approvals.rows.size).toBe(1);

    approvals.decide(res.approval!.id, 'approved');
    expect(org.getAgent(acme.id, dev.id).budgetUsd).toBe(80);
    expect(events).toContainEqual(['budget.updated', { orgId: acme.id, scope: 'agent', scopeId: dev.id }]);
    // A replayed decision does not apply twice.
    org.proposeBudgetChange(acme.id, { scope: 'agent', id: dev.id, budgetUsd: 10 }, OWNER);
    k.bus.emit('approval.decided', { orgId: acme.id, approvalId: res.approval!.id, status: 'approved', requesterAgentId: lead.id });
    expect(org.getAgent(acme.id, dev.id).budgetUsd).toBe(10);
  });

  it('keeps budget proposals inside the reporting line and above autonomy level 3', () => {
    expect(codeOf(() => org.proposeBudgetChange(acme.id, { scope: 'agent', id: outsider.id, budgetUsd: 50 }, asLead))).toBe('forbidden');
    expect(codeOf(() => org.proposeBudgetChange(acme.id, { scope: 'dept', id: ops.id, budgetUsd: 50 }, asLead))).toBe('forbidden');
    expect(codeOf(() => org.proposeBudgetChange(acme.id, { scope: 'agent', id: dev.id, budgetUsd: 50 }, { kind: 'agent', id: dev.id }))).toBe('forbidden');
    expect(approvals.rows.size).toBe(0);

    // Its own department and itself are in line.
    const deptReq = org.proposeBudgetChange(acme.id, { scope: 'dept', id: eng.id, budgetUsd: 500 }, asLead);
    const selfReq = org.proposeBudgetChange(acme.id, { scope: 'agent', id: lead.id, budgetUsd: 40 }, asLead);
    expect(deptReq.approval?.payload.matchKey).toBe(`budget_raise:dept:${eng.id}:500`);
    approvals.decide(selfReq.approval!.id, 'denied');
    expect(org.getAgent(acme.id, lead.id).budgetUsd).toBeNull();
    approvals.decide(deptReq.approval!.id, 'approved');
    expect(org.getDept(acme.id, eng.id).budgetUsd).toBe(500);

    // With the gate switched off for the org, a lead's in-line change applies at once.
    approvals.gated = false;
    expect(org.proposeBudgetChange(acme.id, { scope: 'agent', id: dev.id, budgetUsd: 15 }, asLead).agent?.budgetUsd).toBe(15);
  });

  it('carries the reason for a proposed termination to the board', () => {
    const res = org.terminateAgent(acme.id, dev.id, asLead, { reason: 'Duplicate of the new QA role' });
    expect(res.approval).toMatchObject({ kind: 'terminate_agent', status: 'pending' });
    expect(res.approval?.payload).toMatchObject({ agentId: dev.id, reason: 'Duplicate of the new QA role' });
    expect(org.getAgent(acme.id, dev.id).status).toBe('active');
    approvals.decide(res.approval!.id, 'approved');
    expect(org.getAgent(acme.id, dev.id).status).toBe('terminated');
  });

  it('keeps revisions for goals and rolls them back, including a deleted goal', () => {
    const goal = work.createGoal(acme.id, { title: 'Ship v1', level: 'org' }, OWNER);
    const child = work.createGoal(acme.id, { title: 'Docs', level: 'dept', parentGoalId: goal.id, deptId: eng.id }, OWNER);
    work.updateGoal(acme.id, goal.id, { title: 'Ship v2', successMetric: 'GA' }, OWNER);
    const revs = org.listRevisions(acme.id, 'goal', goal.id);
    expect(revs.map((r) => r.revision)).toEqual([2, 1]);
    expect(revs[1]?.snapshot).toMatchObject({ title: 'Ship v1' });

    expect(codeOf(() => org.rollback(acme.id, 'goal', goal.id, 1, asLead))).toBe('forbidden');
    org.rollback(acme.id, 'goal', goal.id, 1, OWNER);
    expect(work.getGoal(acme.id, goal.id)).toMatchObject({ title: 'Ship v1', successMetric: '' });
    expect(org.listRevisions(acme.id, 'goal', goal.id)).toHaveLength(3);
    expect(k.audit.query({ orgId: acme.id, action: 'config.changed', entityId: goal.id })[0]?.data).toMatchObject({ rollbackTo: 1 });

    // Deleting is a revision too, so the goal can be brought back under its old id.
    work.deleteGoal(acme.id, child.id, OWNER);
    expect(codeOf(() => work.getGoal(acme.id, child.id))).toBe('not_found');
    const beforeDelete = org.listRevisions(acme.id, 'goal', child.id).find((r) => r.note !== 'deleted')!;
    org.rollback(acme.id, 'goal', child.id, beforeDelete.revision, OWNER);
    expect(work.getGoal(acme.id, child.id)).toMatchObject({ title: 'Docs', parentGoalId: goal.id, deptId: eng.id });

    // Revisions are per org, and unknown kinds are still refused.
    const other = org.createOrg({ name: 'Other' }, OWNER);
    expect(org.listRevisions(other.id, 'goal', goal.id)).toEqual([]);
    expect(codeOf(() => org.rollback(other.id, 'goal', goal.id, 1, OWNER))).toBe('not_found');
    expect(codeOf(() => org.rollback(acme.id, 'connector', 'con_1', 1, OWNER))).toBe('validation');
  });

  it('rolls back playbooks and projects', () => {
    const step = (title: string, agentId: string) => ({ title, description: '', expectedOutput: '', agentId });
    const playbook = (id: string) => work.listPlaybooks(acme.id).find((p) => p.id === id)!;
    const events = recordEvents(k);
    const pb = work.createPlaybook(acme.id, { name: 'Release', steps: [step('Build', dev.id), step('Announce', lead.id)] }, OWNER);
    work.updatePlaybook(acme.id, pb.id, { description: 'Weekly', steps: [step('Build', dev.id)] }, OWNER);
    org.rollback(acme.id, 'playbook', pb.id, 1, OWNER);
    expect(playbook(pb.id).steps.map((s) => s.title)).toEqual(['Build', 'Announce']);

    // A step's agent that has since been terminated is dropped rather than restored as a dangling reference.
    work.deletePlaybook(acme.id, pb.id, OWNER);
    org.terminateAgent(acme.id, dev.id, OWNER);
    org.rollback(acme.id, 'playbook', pb.id, 1, OWNER);
    const restored = playbook(pb.id);
    expect(restored.steps.map((s) => [s.title, s.agentId ?? null])).toEqual([['Build', null], ['Announce', lead.id]]);
    expect(events).toContainEqual(['playbook.changed', { orgId: acme.id, playbookId: pb.id, change: 'restored' }]);

    const goal = work.createGoal(acme.id, { title: 'Ship', level: 'org' }, OWNER);
    const project = work.createProject(acme.id, { name: 'Site', goalId: goal.id, budgetUsd: 20 }, OWNER);
    work.updateProject(acme.id, project.id, { name: 'Website', budgetUsd: 90, status: 'archived' }, OWNER);
    org.rollback(acme.id, 'project', project.id, 1, OWNER);
    expect(work.getProject(acme.id, project.id)).toMatchObject({ name: 'Site', budgetUsd: 20, status: 'active', goalId: goal.id });
    expect(events).toContainEqual(['project.updated', { orgId: acme.id, projectId: project.id }]);
    expect(codeOf(() => org.rollback(acme.id, 'project', 'prj_missing', 1, OWNER))).toBe('not_found');
  });
});
