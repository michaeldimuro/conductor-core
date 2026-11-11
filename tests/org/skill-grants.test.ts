import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { OWNER, type Actor } from '../../src/contracts/types.js';
import type { Agent, Department, Organization } from '../../src/contracts/rows.js';
import { skills } from '../../src/db/schema/index.js';
import type { OrgContext } from '../../src/org/index.js';
import { codeOf, setup, type FakeApprovals } from './fakes.js';

describe('approval-gated skill grants (grant_skill)', () => {
  let k: TestKernel;
  let org: OrgContext;
  let approvals: FakeApprovals;
  let acme: Organization;
  let eng: Department;
  let ops: Department;
  let lead: Agent;
  let dev: Agent;
  let outsider: Agent;
  let asLead: Actor;

  const addSkill = (name: string, orgId: string | null, status: 'active' | 'draft' | 'quarantined' = 'active') =>
    k.db.insert(skills).values({
      id: `skl_${name}_${orgId ?? 'global'}`, orgId, scope: orgId ? 'org' : 'global', scopeId: orgId, name, status, path: `/skills/${name}`, contentHash: 'h',
      createdAt: k.clock.now(), updatedAt: k.clock.now(),
    }).run();

  beforeEach(() => {
    k = createTestKernel();
    ({ org, approvals } = setup(k));
    acme = org.createOrg({ name: 'Acme' }, OWNER);
    eng = org.createDept(acme.id, { name: 'Eng' }, OWNER);
    ops = org.createDept(acme.id, { name: 'Ops' }, OWNER);
    lead = org.hireAgent(acme.id, { deptId: eng.id, name: 'Lead', role: 'Lead', autonomyLevel: 3, isLead: true }, OWNER).agent!;
    dev = org.hireAgent(acme.id, { deptId: eng.id, name: 'Dev', role: 'Engineer', autonomyLevel: 2, reportsTo: lead.id }, OWNER).agent!;
    outsider = org.hireAgent(acme.id, { deptId: ops.id, name: 'Olga', role: 'Operator', autonomyLevel: 3, isLead: true }, OWNER).agent!;
    asLead = { kind: 'agent', id: lead.id, runId: 'run_1' };
    addSkill('release-notes', acme.id);
    addSkill('web-research', null);
  });
  afterEach(() => {
    org.dispose();
    k.dispose();
  });

  it('lets the owner grant directly at every scope, never asking for approval', () => {
    expect(org.proposeSkillGrant(acme.id, { scope: 'agent', id: dev.id, skill: 'release-notes' }, OWNER).agent?.skills).toEqual(['release-notes']);
    expect(org.proposeSkillGrant(acme.id, { scope: 'dept', id: eng.id, skill: 'web-research' }, OWNER).department?.sharedSkills).toEqual(['web-research']);
    expect(org.proposeSkillGrant(acme.id, { scope: 'org', skill: 'release-notes' }, OWNER).organization?.defaultSkills).toEqual(['release-notes']);
    // Granting twice changes nothing.
    expect(org.proposeSkillGrant(acme.id, { scope: 'agent', id: dev.id, skill: 'release-notes' }, OWNER).agent?.skills).toEqual(['release-notes']);
    expect(approvals.rows.size).toBe(0);
    expect(approvals.svc.requiresApproval).not.toHaveBeenCalledWith(acme.id, 'grant_skill');
    expect(org.listRevisions(acme.id, 'agent', dev.id)[0]).toMatchObject({ note: 'skill release-notes granted' });
  });

  it('files a grant_skill approval for a lead and grants only once the board approves', () => {
    const res = org.proposeSkillGrant(acme.id, { scope: 'agent', id: dev.id, skill: 'release-notes', reason: 'Dev writes the changelog now' }, asLead);
    expect(res.agent).toBeUndefined();
    expect(res.approval).toMatchObject({ kind: 'grant_skill', status: 'pending', orgId: acme.id, requesterAgentId: lead.id, runId: 'run_1', title: 'Grant skill "release-notes" to Dev' });
    expect(res.approval?.payload).toMatchObject({
      matchKey: `grant_skill:agent:${dev.id}:release-notes`, context: 'org', requestedBy: lead.id,
      input: { scope: 'agent', id: dev.id, skill: 'release-notes', reason: 'Dev writes the changelog now' },
    });
    expect(approvals.svc.requiresApproval).toHaveBeenCalledWith(acme.id, 'grant_skill');
    expect(org.getAgent(acme.id, dev.id).skills).toEqual([]);
    // The same proposal reuses the open approval.
    expect(org.proposeSkillGrant(acme.id, { scope: 'agent', id: dev.id, skill: 'release-notes' }, asLead).approval?.id).toBe(res.approval?.id);
    expect(approvals.rows.size).toBe(1);

    approvals.decide(res.approval!.id, 'approved');
    expect(org.getAgent(acme.id, dev.id).skills).toEqual(['release-notes']);
    expect(approvals.rows.get(res.approval!.id)?.consumedAt).not.toBeNull();
    const audit = k.audit.query({ orgId: acme.id, action: 'config.changed', entityId: dev.id }).find((r) => r.data?.change === 'skill_grant');
    expect(audit?.actor).toMatchObject({ kind: 'agent', id: lead.id });
    expect(audit?.data).toMatchObject({ skill: 'release-notes', approvalId: res.approval!.id });
    // Replaying the decision does not grant twice.
    k.bus.emit('approval.decided', { orgId: acme.id, approvalId: res.approval!.id, status: 'approved', requesterAgentId: lead.id });
    expect(org.getAgent(acme.id, dev.id).skills).toEqual(['release-notes']);
  });

  it('gates department shared skills and org default skills the same way; a denial grants nothing', () => {
    const shared = org.proposeSkillGrant(acme.id, { scope: 'dept', id: eng.id, skill: 'web-research' }, asLead).approval!;
    const defaults = org.proposeSkillGrant(acme.id, { scope: 'org', skill: 'release-notes' }, asLead).approval!;
    expect(shared.title).toContain('department Eng');
    expect(defaults.payload).toMatchObject({ matchKey: `grant_skill:org:${acme.id}:release-notes` });
    approvals.decide(shared.id, 'approved');
    approvals.decide(defaults.id, 'denied');
    expect(org.getDept(acme.id, eng.id).sharedSkills).toEqual(['web-research']);
    expect(org.getOrg(acme.id).defaultSkills).toEqual([]);
  });

  it('grants directly for a lead when the org switched the grant_skill gate off', () => {
    approvals.gated = false;
    const res = org.proposeSkillGrant(acme.id, { scope: 'agent', id: dev.id, skill: 'release-notes' }, asLead);
    expect(res.approval).toBeUndefined();
    expect(res.agent?.skills).toEqual(['release-notes']);
    expect(approvals.rows.size).toBe(0);
  });

  it('only lets leads propose, inside their reporting line, for skills the org can use', () => {
    const grant = (input: Parameters<OrgContext['proposeSkillGrant']>[1], actor: Actor) => codeOf(() => org.proposeSkillGrant(acme.id, input, actor));
    expect(grant({ scope: 'agent', id: dev.id, skill: 'release-notes' }, { kind: 'agent', id: dev.id })).toBe('forbidden');
    expect(grant({ scope: 'agent', id: outsider.id, skill: 'release-notes' }, asLead)).toBe('forbidden');
    expect(grant({ scope: 'dept', id: ops.id, skill: 'release-notes' }, asLead)).toBe('forbidden');
    expect(grant({ scope: 'agent', id: 'agt_missing', skill: 'release-notes' }, asLead)).toBe('not_found');
    expect(grant({ scope: 'agent', id: dev.id, skill: 'no-such-skill' }, asLead)).toBe('not_found');
    expect(grant({ scope: 'agent', id: dev.id, skill: 'no-such-skill' }, OWNER)).toBe('not_found');
    expect(grant({ scope: 'agent', skill: 'release-notes' }, OWNER)).toBe('not_found');
    expect(grant({ scope: 'team', id: dev.id, skill: 'release-notes' } as never, OWNER)).toBe('validation');
    // Another org's skill, and a quarantined one, cannot be granted.
    const globex = org.createOrg({ name: 'Globex' }, OWNER);
    addSkill('globex-only', globex.id);
    addSkill('risky', acme.id, 'quarantined');
    expect(grant({ scope: 'org', skill: 'globex-only' }, OWNER)).toBe('not_found');
    expect(grant({ scope: 'org', skill: 'risky' }, OWNER)).toBe('not_found');
    // A lead may propose for itself.
    expect(org.proposeSkillGrant(acme.id, { scope: 'agent', id: lead.id, skill: 'web-research' }, asLead).approval?.kind).toBe('grant_skill');
    expect(approvals.rows.size).toBe(1);
  });

  it('sends a lead\'s hire that comes with skills to the board even when hiring itself is ungated', () => {
    (approvals.svc.requiresApproval as unknown as { mockImplementation(fn: (orgId: string, kind: string) => boolean): void })
      .mockImplementation((_orgId, kind) => kind === 'grant_skill');
    const plain = org.hireAgent(acme.id, { deptId: eng.id, name: 'Plain', role: 'QA' }, asLead);
    expect(plain.agent?.slug).toBe('plain');
    const skilled = org.hireAgent(acme.id, { deptId: eng.id, name: 'Skilled', role: 'QA', skills: ['release-notes'] }, asLead);
    expect(skilled.agent).toBeUndefined();
    expect(skilled.approval).toMatchObject({ kind: 'hire_agent', status: 'pending' });
    expect(org.findAgent(acme.id, 'skilled')).toBeNull();
    // The owner hires with skills directly.
    expect(org.hireAgent(acme.id, { deptId: eng.id, name: 'Direct', role: 'QA', skills: ['release-notes'] }, OWNER).agent?.skills).toEqual(['release-notes']);
  });
});
