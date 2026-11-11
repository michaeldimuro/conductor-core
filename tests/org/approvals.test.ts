import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { OWNER, type Actor } from '../../src/contracts/types.js';
import type { Agent, Department, Organization } from '../../src/contracts/rows.js';
import type { OrgContext } from '../../src/org/index.js';
import { codeOf, recordEvents, setup, type FakeApprovals } from './fakes.js';

describe('approval-gated hiring and termination', () => {
  let k: TestKernel;
  let org: OrgContext;
  let approvals: FakeApprovals;
  let acme: Organization;
  let dept: Department;
  let lead: Agent;
  let dev: Agent;
  let asLead: Actor;

  beforeEach(() => {
    k = createTestKernel();
    ({ org, approvals } = setup(k));
    acme = org.createOrg({ name: 'Acme' }, OWNER);
    dept = org.createDept(acme.id, { name: 'Eng' }, OWNER);
    lead = org.hireAgent(acme.id, { deptId: dept.id, name: 'Lead', role: 'Lead', autonomyLevel: 3, isLead: true }, OWNER).agent!;
    dev = org.hireAgent(acme.id, { deptId: dept.id, name: 'Dev', role: 'Engineer', autonomyLevel: 2, reportsTo: lead.id }, OWNER).agent!;
    asLead = { kind: 'agent', id: lead.id, runId: 'run_1' };
  });
  afterEach(() => {
    org.dispose();
    k.dispose();
  });

  const hireInput = () => ({ deptId: dept.id, name: 'Newbie', role: 'QA Engineer', goal: 'Test things', heartbeatCron: '0 * * * *' });

  it('never asks for approval when the owner hires or terminates', () => {
    expect(org.hireAgent(acme.id, hireInput(), OWNER).agent?.slug).toBe('newbie');
    expect(org.terminateAgent(acme.id, dev.id, OWNER).agent?.status).toBe('terminated');
    expect(approvals.rows.size).toBe(0);
  });

  it('forbids agents below autonomy level 3 from proposing hires or terminations', () => {
    const asDev: Actor = { kind: 'agent', id: dev.id };
    expect(codeOf(() => org.hireAgent(acme.id, hireInput(), asDev))).toBe('forbidden');
    expect(codeOf(() => org.terminateAgent(acme.id, lead.id, asDev))).toBe('forbidden');
    expect(codeOf(() => org.hireAgent(acme.id, hireInput(), { kind: 'agent', id: 'agt_unknown' }))).toBe('forbidden');
    // A paused lead cannot propose either.
    org.pauseAgent(acme.id, lead.id, 'budget', OWNER);
    expect(codeOf(() => org.hireAgent(acme.id, hireInput(), asLead))).toBe('forbidden');
    expect(approvals.rows.size).toBe(0);
    expect(org.listAgents(acme.id)).toHaveLength(2);
  });

  it('files a hire_agent approval for a lead and hires only once the board approves', () => {
    const events = recordEvents(k);
    const res = org.hireAgent(acme.id, hireInput(), asLead);
    expect(res.agent).toBeUndefined();
    expect(res.approval).toMatchObject({ kind: 'hire_agent', status: 'pending', orgId: acme.id, requesterAgentId: lead.id, runId: 'run_1' });
    expect(res.approval?.payload).toMatchObject({
      matchKey: expect.stringMatching(/^hire_agent:/),
      // The full input travels in the payload; a lead's hire defaults into its own line.
      input: { ...hireInput(), reportsTo: lead.id },
      requestedBy: lead.id,
    });
    expect(approvals.svc.requiresApproval).toHaveBeenCalledWith(acme.id, 'hire_agent');
    expect(org.findAgent(acme.id, 'newbie')).toBeNull();

    // Asking again for the same hire reuses the open approval instead of duplicating it.
    expect(org.hireAgent(acme.id, hireInput(), asLead).approval?.id).toBe(res.approval?.id);
    expect(approvals.rows.size).toBe(1);

    approvals.decide(res.approval!.id, 'approved');
    const hired = org.findAgent(acme.id, 'newbie');
    expect(hired).toMatchObject({ role: 'QA Engineer', goal: 'Test things', reportsTo: lead.id, deptId: dept.id, status: 'active' });
    expect(events).toContainEqual(['agent.hired', { orgId: acme.id, agentId: hired!.id }]);
    expect(approvals.rows.get(res.approval!.id)?.consumedAt).not.toBeNull();
    const [audit] = k.audit.query({ orgId: acme.id, action: 'agent.hired', entityId: hired!.id });
    expect(audit?.actor).toMatchObject({ kind: 'agent', id: lead.id });
    expect(audit?.data).toMatchObject({ approvalId: res.approval!.id });
  });

  it('executes an approved hire exactly once, even if the event is replayed', () => {
    const { approval } = org.hireAgent(acme.id, hireInput(), asLead);
    approvals.decide(approval!.id, 'approved');
    const replay = { orgId: acme.id, approvalId: approval!.id, status: 'approved' as const, requesterAgentId: lead.id };
    k.bus.emit('approval.decided', replay);
    k.bus.emit('approval.decided', replay);
    expect(org.listAgents(acme.id).filter((a) => a.name === 'Newbie')).toHaveLength(1);
    expect(approvals.svc.consume).toHaveBeenCalledTimes(3);
  });

  it('does nothing when the board denies', () => {
    const { approval } = org.hireAgent(acme.id, hireInput(), asLead);
    approvals.decide(approval!.id, 'denied');
    expect(org.findAgent(acme.id, 'newbie')).toBeNull();
    expect(approvals.svc.consume).not.toHaveBeenCalled();
  });

  it('ignores approvals that belong to other contexts or other orgs', () => {
    const foreign = approvals.svc.request({ orgId: acme.id, kind: 'hire_agent', title: 'not ours', payload: { matchKey: 'x', input: hireInput() } });
    const otherKind = approvals.svc.request({ orgId: acme.id, kind: 'payment', title: 'pay', payload: { matchKey: 'y', context: 'org' } });
    approvals.decide(foreign.id, 'approved');
    approvals.decide(otherKind.id, 'approved');
    k.bus.emit('approval.decided', { orgId: acme.id, approvalId: 'apr_missing', status: 'approved', requesterAgentId: null });
    // Right approval id, wrong org on the event.
    const { approval } = org.hireAgent(acme.id, hireInput(), asLead);
    approvals.rows.get(approval!.id)!.status = 'approved';
    k.bus.emit('approval.decided', { orgId: 'org_other', approvalId: approval!.id, status: 'approved', requesterAgentId: lead.id });

    expect(approvals.svc.consume).not.toHaveBeenCalled();
    expect(org.listAgents(acme.id)).toHaveLength(2);
  });

  it('rejects an invalid hire before filing an approval', () => {
    expect(codeOf(() => org.hireAgent(acme.id, { ...hireInput(), deptId: 'dept_missing' }, asLead))).toBe('validation');
    expect(codeOf(() => org.hireAgent(acme.id, { ...hireInput(), slug: 'dev' }, asLead))).toBe('conflict');
    expect(approvals.rows.size).toBe(0);
  });

  it('reports a failed execution instead of throwing into the bus', () => {
    const events = recordEvents(k);
    const { approval } = org.hireAgent(acme.id, { ...hireInput(), slug: 'newbie' }, asLead);
    // The slug is taken between request and approval.
    org.hireAgent(acme.id, { ...hireInput(), slug: 'newbie' }, OWNER);
    approvals.decide(approval!.id, 'approved');
    expect(org.listAgents(acme.id).filter((a) => a.slug === 'newbie')).toHaveLength(1);
    expect(k.audit.query({ orgId: acme.id, action: 'approval.execution_failed' })).toHaveLength(1);
    expect(events.some(([name, p]) => name === 'notification' && p.kind === 'approval.execution_failed')).toBe(true);
  });

  it('hires directly when the owner has switched the hire gate off', () => {
    approvals.gated = false;
    const res = org.hireAgent(acme.id, hireInput(), asLead);
    expect(res.approval).toBeUndefined();
    expect(res.agent).toMatchObject({ slug: 'newbie', reportsTo: lead.id });
    expect(approvals.rows.size).toBe(0);
  });

  it('gates termination the same way and never deletes the row', () => {
    const events = recordEvents(k);
    const res = org.terminateAgent(acme.id, dev.id, asLead);
    expect(res.agent).toBeUndefined();
    expect(res.approval).toMatchObject({ kind: 'terminate_agent', status: 'pending', requesterAgentId: lead.id });
    expect(res.approval?.payload).toMatchObject({ matchKey: `terminate_agent:${dev.id}`, agentId: dev.id });
    expect(org.getAgent(acme.id, dev.id).status).toBe('active');
    expect(org.terminateAgent(acme.id, dev.id, asLead).approval?.id).toBe(res.approval?.id);

    approvals.decide(res.approval!.id, 'approved');
    k.bus.emit('approval.decided', { orgId: acme.id, approvalId: res.approval!.id, status: 'approved', requesterAgentId: lead.id });
    expect(org.getAgent(acme.id, dev.id).status).toBe('terminated');
    expect(events.filter(([name, p]) => name === 'agent.updated' && p.agentId === dev.id)).toHaveLength(1);
    expect(k.audit.query({ orgId: acme.id, action: 'agent.terminated' })).toHaveLength(1);
    expect(org.listAgents(acme.id)).toHaveLength(2);
  });

  it('stops executing approvals after dispose', () => {
    const { approval } = org.hireAgent(acme.id, hireInput(), asLead);
    org.dispose();
    approvals.decide(approval!.id, 'approved');
    expect(org.findAgent(acme.id, 'newbie')).toBeNull();
  });
});
