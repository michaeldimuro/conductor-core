import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { OrgContext } from '../../src/org/index.js';
import { codeOf, recordEvents, setup } from './fakes.js';

describe('org context: orgs, departments, agents', () => {
  let k: TestKernel;
  let org: OrgContext;
  beforeEach(() => {
    k = createTestKernel();
    ({ org } = setup(k));
  });
  afterEach(() => {
    org.dispose();
    k.dispose();
  });

  it('creates an org with a revision, audit entry, event and on-disk dir', () => {
    const events = recordEvents(k);
    const acme = org.createOrg({ name: 'Acme Inc', mission: 'Ship', budgetMonthlyUsd: 500 }, OWNER);
    expect(acme.slug).toBe('acme-inc');
    expect(acme.status).toBe('active');
    expect(acme.createdAt).toBe(k.clock.now());
    expect(existsSync(k.paths.org('acme-inc'))).toBe(true);
    expect(events).toContainEqual(['org.created', { orgId: acme.id }]);
    expect(org.listRevisions(acme.id, 'org', acme.id).map((r) => r.revision)).toEqual([1]);
    expect(k.audit.query({ orgId: acme.id, action: 'org.created' })).toHaveLength(1);
    expect(org.getOrgBySlug('acme-inc')?.id).toBe(acme.id);
    expect(org.getOrgBySlug('nope')).toBeNull();
  });

  it('auto-suffixes derived slugs and rejects explicit collisions', () => {
    const a = org.createOrg({ name: 'Acme' }, OWNER);
    const b = org.createOrg({ name: 'Acme' }, OWNER);
    expect([a.slug, b.slug]).toEqual(['acme', 'acme-2']);
    expect(codeOf(() => org.createOrg({ name: 'Other', slug: 'acme' }, OWNER))).toBe('conflict');

    const d1 = org.createDept(a.id, { name: 'Engineering' }, OWNER);
    const d2 = org.createDept(a.id, { name: 'Engineering' }, OWNER);
    expect([d1.slug, d2.slug]).toEqual(['engineering', 'engineering-2']);
    expect(codeOf(() => org.createDept(a.id, { name: 'X', slug: 'engineering' }, OWNER))).toBe('conflict');
    // The same slug is fine in another org.
    expect(org.createDept(b.id, { name: 'Engineering' }, OWNER).slug).toBe('engineering');

    const g1 = org.hireAgent(a.id, { deptId: d1.id, name: 'Ada', role: 'Engineer' }, OWNER).agent!;
    const g2 = org.hireAgent(a.id, { deptId: d1.id, name: 'Ada', role: 'Engineer' }, OWNER).agent!;
    expect([g1.slug, g2.slug]).toEqual(['ada', 'ada-2']);
    expect(codeOf(() => org.hireAgent(a.id, { deptId: d1.id, name: 'Zed', slug: 'ada', role: 'Engineer' }, OWNER))).toBe('conflict');
  });

  it('validates input at the boundary', () => {
    expect(codeOf(() => org.createOrg({ name: '' }, OWNER))).toBe('validation');
    expect(codeOf(() => org.createOrg({ name: 'X', slug: '../etc' }, OWNER))).toBe('validation');
    expect(codeOf(() => org.createOrg({ name: 'X', budgetMonthlyUsd: -1 }, OWNER))).toBe('validation');
    expect(codeOf(() => org.createOrg({ name: 'X', extra: true } as never, OWNER))).toBe('validation');
    // Credentials must be referenced, never embedded in a provider binding.
    expect(codeOf(() => org.createOrg({
      name: 'X',
      defaultProvider: { adapter: 'claude_api', config: { apiKey: 'sk-ant-abcdefghijklmnopqrstuvwxyz012345' } },
    }, OWNER))).toBe('validation');

    const acme = org.createOrg({ name: 'Acme' }, OWNER);
    const dept = org.createDept(acme.id, { name: 'Eng' }, OWNER);
    const hire = (extra: Record<string, unknown>) =>
      codeOf(() => org.hireAgent(acme.id, { deptId: dept.id, name: 'Ada', role: 'Engineer', ...extra }, OWNER));
    expect(hire({ autonomyLevel: 4 })).toBe('validation');
    expect(hire({ heartbeatCron: 'every tuesday-ish' })).toBe('validation');
    expect(hire({ role: '' })).toBe('validation');
    expect(hire({ deptId: 'dept_missing' })).toBe('validation');
    expect(hire({ reportsTo: 'agt_missing' })).toBe('validation');
    expect(org.listAgents(acme.id)).toHaveLength(0);
    expect(codeOf(() => org.updateOrg(acme.id, { slug: 'renamed' }, OWNER))).toBe('validation');
    expect(codeOf(() => org.updateOrg(acme.id, { maxConcurrentRuns: 0 }, OWNER))).toBe('validation');
  });

  it('updates and archives an org, revisioning each change', () => {
    const events = recordEvents(k);
    const acme = org.createOrg({ name: 'Acme' }, OWNER);
    k.clock.advance(1000);
    const updated = org.updateOrg(acme.id, { mission: 'New mission', defaultSkills: ['writing', 'writing'], maxConcurrentRuns: 2, budgetMonthlyUsd: null }, OWNER);
    expect(updated).toMatchObject({ mission: 'New mission', defaultSkills: ['writing'], maxConcurrentRuns: 2, name: 'Acme' });
    expect(updated.updatedAt).toBe(acme.updatedAt + 1000);
    expect(events).toContainEqual(['org.updated', { orgId: acme.id }]);

    const archived = org.archiveOrg(acme.id, OWNER);
    expect(archived.status).toBe('archived');
    expect(org.listOrgs().map((o) => o.id)).not.toContain(acme.id);
    expect(org.listOrgs({ includeArchived: true }).map((o) => o.id)).toContain(acme.id);
    expect(org.listRevisions(acme.id, 'org', acme.id).map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(codeOf(() => org.createDept(acme.id, { name: 'Late' }, OWNER))).toBe('conflict');
  });

  it('hires an agent directly for a human, creating its dirs and emitting agent.hired', () => {
    const events = recordEvents(k);
    const acme = org.createOrg({ name: 'Acme' }, OWNER);
    const dept = org.createDept(acme.id, { name: 'Eng' }, OWNER);
    const { agent, approval } = org.hireAgent(acme.id, {
      deptId: dept.id, name: 'Ada Lovelace', role: 'Engineer', goal: 'Ship', heartbeatCron: '0 * * * *', isLead: true, autonomyLevel: 3,
    }, OWNER);
    expect(approval).toBeUndefined();
    expect(agent).toMatchObject({ slug: 'ada-lovelace', orgId: acme.id, deptId: dept.id, status: 'active', autonomyLevel: 3, reportsTo: null });
    expect(existsSync(k.paths.agentDir('acme', 'ada-lovelace'))).toBe(true);
    expect(existsSync(k.paths.agentWorkspace('acme', 'ada-lovelace'))).toBe(true);
    expect(events).toContainEqual(['agent.hired', { orgId: acme.id, agentId: agent!.id }]);
    expect(org.getDept(acme.id, dept.id).leadAgentId).toBe(agent!.id);
    expect(org.leadOf(acme.id, dept.id)?.id).toBe(agent!.id);
    expect(org.findAgent(acme.id, 'ada-lovelace')?.id).toBe(agent!.id);
    expect(org.findAgent(acme.id, agent!.id)?.id).toBe(agent!.id);
    expect(org.findAgent(acme.id, 'ghost')).toBeNull();
    // dept: created + lead set
    expect(org.listRevisions(acme.id, 'dept', dept.id)).toHaveLength(2);
    expect(org.listRevisions(acme.id, 'agent', agent!.id)).toHaveLength(1);
  });

  it('rejects self-reports and reporting cycles; validates lead and dept ownership', () => {
    const acme = org.createOrg({ name: 'Acme' }, OWNER);
    const other = org.createOrg({ name: 'Other' }, OWNER);
    const dept = org.createDept(acme.id, { name: 'Eng' }, OWNER);
    const otherDept = org.createDept(other.id, { name: 'Eng' }, OWNER);
    const hire = (name: string, reportsTo?: string) =>
      org.hireAgent(acme.id, { deptId: dept.id, name, role: 'Engineer', reportsTo }, OWNER).agent!;
    const a = hire('A');
    const b = hire('B', a.id);
    const c = hire('C', b.id);
    const outsider = org.hireAgent(other.id, { deptId: otherDept.id, name: 'Out', role: 'Engineer' }, OWNER).agent!;

    expect(codeOf(() => org.updateAgent(acme.id, a.id, { reportsTo: a.id }, OWNER))).toBe('validation');
    expect(codeOf(() => org.updateAgent(acme.id, a.id, { reportsTo: c.id }, OWNER))).toBe('validation');
    expect(codeOf(() => org.updateAgent(acme.id, a.id, { reportsTo: outsider.id }, OWNER))).toBe('validation');
    expect(codeOf(() => org.updateAgent(acme.id, a.id, { deptId: otherDept.id }, OWNER))).toBe('validation');
    expect(codeOf(() => org.updateDept(acme.id, dept.id, { leadAgentId: outsider.id }, OWNER))).toBe('validation');
    expect(org.getAgent(acme.id, a.id).reportsTo).toBeNull();

    // A legal re-parent still works.
    expect(org.updateAgent(acme.id, c.id, { reportsTo: a.id }, OWNER).reportsTo).toBe(a.id);
    expect(org.updateDept(acme.id, dept.id, { leadAgentId: a.id }, OWNER).leadAgentId).toBe(a.id);
    expect(org.updateAgent(acme.id, a.id, { isLead: false }, OWNER).id).toBe(a.id);
    expect(org.getDept(acme.id, dept.id).leadAgentId).toBeNull();
  });

  it('pauses, resumes and terminates with the matching events; termination keeps the row', () => {
    const events = recordEvents(k);
    const acme = org.createOrg({ name: 'Acme' }, OWNER);
    const dept = org.createDept(acme.id, { name: 'Eng' }, OWNER);
    const boss = org.hireAgent(acme.id, { deptId: dept.id, name: 'Boss', role: 'Lead' }, OWNER).agent!;
    const mid = org.hireAgent(acme.id, { deptId: dept.id, name: 'Mid', role: 'Manager', reportsTo: boss.id, isLead: true }, OWNER).agent!;
    const leaf = org.hireAgent(acme.id, { deptId: dept.id, name: 'Leaf', role: 'Engineer', reportsTo: mid.id }, OWNER).agent!;

    const paused = org.pauseAgent(acme.id, leaf.id, 'budget', OWNER);
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'budget' });
    expect(events).toContainEqual(['agent.paused', { orgId: acme.id, agentId: leaf.id, reason: 'budget' }]);
    const resumed = org.resumeAgent(acme.id, leaf.id, OWNER);
    expect(resumed).toMatchObject({ status: 'active', pausedReason: null });
    expect(events).toContainEqual(['agent.resumed', { orgId: acme.id, agentId: leaf.id }]);

    events.length = 0;
    const { agent: gone } = org.terminateAgent(acme.id, mid.id, OWNER);
    expect(gone?.status).toBe('terminated');
    expect(events).toContainEqual(['agent.updated', { orgId: acme.id, agentId: mid.id }]);
    // Row is kept, reports move up, the lead seat is vacated.
    expect(org.getAgent(acme.id, mid.id).status).toBe('terminated');
    expect(org.listAgents(acme.id).map((a) => a.id)).toContain(mid.id);
    expect(org.listAgents(acme.id, { status: 'active' }).map((a) => a.id).sort()).toEqual([boss.id, leaf.id].sort());
    expect(org.getAgent(acme.id, leaf.id).reportsTo).toBe(boss.id);
    expect(org.getDept(acme.id, dept.id).leadAgentId).toBeNull();
    expect(k.audit.query({ orgId: acme.id, action: 'agent.terminated' })).toHaveLength(1);

    expect(codeOf(() => org.pauseAgent(acme.id, mid.id, 'x', OWNER))).toBe('conflict');
    expect(codeOf(() => org.updateAgent(acme.id, mid.id, { name: 'Zombie' }, OWNER))).toBe('conflict');
    expect(org.terminateAgent(acme.id, mid.id, OWNER).agent?.status).toBe('terminated');
  });

  it('revisions every agent change monotonically and rolls back as a new revision', () => {
    const events = recordEvents(k);
    const acme = org.createOrg({ name: 'Acme' }, OWNER);
    const dept = org.createDept(acme.id, { name: 'Eng' }, OWNER);
    const ada = org.hireAgent(acme.id, { deptId: dept.id, name: 'Ada', role: 'Engineer', goal: 'v1', skills: ['git'] }, OWNER).agent!;
    org.updateAgent(acme.id, ada.id, { goal: 'v2', skills: ['git', 'review'], maxSteps: 10 }, OWNER);
    org.updateAgent(acme.id, ada.id, { goal: 'v3', autonomyLevel: 2 }, OWNER);

    const revs = org.listRevisions(acme.id, 'agent', ada.id);
    expect(revs.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(revs[2]?.snapshot).toMatchObject({ id: ada.id, goal: 'v1', skills: ['git'] });
    expect(revs[0]?.author).toBe('human:owner');

    events.length = 0;
    org.rollback(acme.id, 'agent', ada.id, 1, OWNER);
    expect(org.getAgent(acme.id, ada.id)).toMatchObject({ goal: 'v1', skills: ['git'], maxSteps: 60, autonomyLevel: 1 });
    expect(org.listRevisions(acme.id, 'agent', ada.id).map((r) => r.revision)).toEqual([4, 3, 2, 1]);
    expect(events).toContainEqual(['agent.updated', { orgId: acme.id, agentId: ada.id }]);
    const [audit] = k.audit.query({ orgId: acme.id, action: 'config.changed', entityId: ada.id, limit: 1 });
    expect(audit?.data).toMatchObject({ change: 'rollback', rollbackTo: 1, revision: 4 });

    // Org and dept rollbacks too.
    org.updateOrg(acme.id, { mission: 'changed' }, OWNER);
    org.rollback(acme.id, 'org', acme.id, 1, OWNER);
    expect(org.getOrg(acme.id).mission).toBe('');
    org.updateDept(acme.id, dept.id, { charter: 'changed' }, OWNER);
    org.rollback(acme.id, 'dept', dept.id, 1, OWNER);
    expect(org.getDept(acme.id, dept.id).charter).toBe('');

    expect(codeOf(() => org.rollback(acme.id, 'agent', ada.id, 99, OWNER))).toBe('not_found');
    expect(codeOf(() => org.rollback(acme.id, 'connector', 'con_1', 1, OWNER))).toBe('validation');
  });

  it('resolves capability refs as org ∪ dept ∪ agent minus the deny lists', () => {
    const acme = org.createOrg({ name: 'Acme' }, OWNER);
    org.updateOrg(acme.id, { defaultSkills: ['house-style', 'triage'], defaultConnectors: ['con_slack'] }, OWNER);
    const dept = org.createDept(acme.id, { name: 'Eng', sharedSkills: ['code-review', 'triage'], sharedConnectors: ['con_github'] }, OWNER);
    const ada = org.hireAgent(acme.id, { deptId: dept.id, name: 'Ada', role: 'Engineer', skills: ['rust'], connectors: ['con_linear'] }, OWNER).agent!;

    expect(org.resolveCapabilityRefs(acme.id, ada.id)).toEqual({
      skillNames: ['house-style', 'triage', 'code-review', 'rust'],
      connectorIds: ['con_slack', 'con_github', 'con_linear'],
      denySkills: [],
      denyConnectors: [],
    });

    org.updateAgent(acme.id, ada.id, { denySkills: ['triage'], denyConnectors: ['con_slack'] }, OWNER);
    expect(org.resolveCapabilityRefs(acme.id, ada.id)).toEqual({
      skillNames: ['house-style', 'code-review', 'rust'],
      connectorIds: ['con_github', 'con_linear'],
      denySkills: ['triage'],
      denyConnectors: ['con_slack'],
    });
  });

  it('keeps org structure changes board-only for agent actors', () => {
    const acme = org.createOrg({ name: 'Acme' }, OWNER);
    const dept = org.createDept(acme.id, { name: 'Eng' }, OWNER);
    const lead = org.hireAgent(acme.id, { deptId: dept.id, name: 'Lead', role: 'Lead', autonomyLevel: 3 }, OWNER).agent!;
    const report = org.hireAgent(acme.id, { deptId: dept.id, name: 'Rep', role: 'Engineer', reportsTo: lead.id }, OWNER).agent!;
    const peer = org.hireAgent(acme.id, { deptId: dept.id, name: 'Peer', role: 'Engineer' }, OWNER).agent!;
    const asLead = { kind: 'agent' as const, id: lead.id };

    expect(codeOf(() => org.updateAgent(acme.id, lead.id, { budgetUsd: 1e6 }, asLead))).toBe('forbidden');
    expect(codeOf(() => org.updateOrg(acme.id, { budgetMonthlyUsd: 1e6 }, asLead))).toBe('forbidden');
    expect(codeOf(() => org.createDept(acme.id, { name: 'Shadow' }, asLead))).toBe('forbidden');
    expect(codeOf(() => org.rollback(acme.id, 'agent', lead.id, 1, asLead))).toBe('forbidden');
    // A lead may pause its own reports, but nobody else.
    expect(org.pauseAgent(acme.id, report.id, 'misbehaving', asLead).status).toBe('paused');
    expect(codeOf(() => org.pauseAgent(acme.id, peer.id, 'nope', asLead))).toBe('forbidden');
    expect(codeOf(() => org.pauseAgent(acme.id, lead.id, 'nope', { kind: 'agent', id: report.id }))).toBe('forbidden');
  });
});
