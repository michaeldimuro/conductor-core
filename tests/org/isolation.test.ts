import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Agent, Department, Organization } from '../../src/contracts/rows.js';
import type { OrgContext } from '../../src/org/index.js';
import { codeOf, setup } from './fakes.js';

interface Tenant {
  org: Organization;
  dept: Department;
  lead: Agent;
  dev: Agent;
}

describe('FR-2: multiple organizations with zero cross-org data', () => {
  let k: TestKernel;
  let svc: OrgContext;
  let tenants: Tenant[];

  beforeEach(() => {
    k = createTestKernel();
    ({ org: svc } = setup(k));
    // Three orgs with identically named departments and agents.
    tenants = ['Acme', 'Acme Labs', 'Acme Holdings'].map((name) => {
      const org = svc.createOrg({ name }, OWNER);
      const dept = svc.createDept(org.id, { name: 'Engineering', sharedSkills: [`${org.slug}-skill`] }, OWNER);
      const lead = svc.hireAgent(org.id, { deptId: dept.id, name: 'Ada', role: 'Lead', isLead: true }, OWNER).agent!;
      const dev = svc.hireAgent(org.id, { deptId: dept.id, name: 'Grace', role: 'Engineer', reportsTo: lead.id }, OWNER).agent!;
      return { org, dept, lead, dev };
    });
  });
  afterEach(() => {
    svc.dispose();
    k.dispose();
  });

  it('gives every org the same slugs without collisions', () => {
    for (const t of tenants) {
      expect(t.dept.slug).toBe('engineering');
      expect([t.lead.slug, t.dev.slug]).toEqual(['ada', 'grace']);
    }
    expect(new Set(tenants.map((t) => t.org.slug)).size).toBe(3);
    expect(svc.listOrgs()).toHaveLength(3);
  });

  it('returns only the org\'s own rows from every list/tree method', () => {
    for (const t of tenants) {
      const foreign = new Set(tenants.filter((o) => o !== t).flatMap((o) => [o.org.id, o.dept.id, o.lead.id, o.dev.id]));
      const agentsOf = svc.listAgents(t.org.id);
      expect(agentsOf.map((a) => a.id).sort()).toEqual([t.lead.id, t.dev.id].sort());
      expect(agentsOf.every((a) => a.orgId === t.org.id)).toBe(true);
      expect(svc.listAgents(t.org.id, { deptId: t.dept.id })).toHaveLength(2);
      expect(svc.listDepts(t.org.id).map((d) => d.id)).toEqual([t.dept.id]);

      const chart = svc.orgChart(t.org.id);
      expect(chart).toHaveLength(1);
      expect(chart[0]?.agent.id).toBe(t.lead.id);
      expect(chart[0]?.reports.map((r) => r.agent.id)).toEqual([t.dev.id]);
      expect(svc.reportsOf(t.org.id, t.lead.id, { transitive: true }).map((a) => a.id)).toEqual([t.dev.id]);
      expect(svc.managerOf(t.org.id, t.dev.id)?.id).toBe(t.lead.id);
      expect(svc.leadOf(t.org.id, t.dept.id)?.id).toBe(t.lead.id);
      expect(svc.findAgent(t.org.id, 'ada')?.id).toBe(t.lead.id);
      expect(svc.resolveCapabilityRefs(t.org.id, t.dev.id).skillNames).toEqual([`${t.org.slug}-skill`]);

      const revisions = [
        ...svc.listRevisions(t.org.id, 'org', t.org.id),
        ...svc.listRevisions(t.org.id, 'dept', t.dept.id),
        ...svc.listRevisions(t.org.id, 'agent', t.lead.id),
      ];
      expect(revisions.length).toBeGreaterThan(0);
      expect(revisions.every((r) => r.orgId === t.org.id)).toBe(true);

      const bundle = JSON.stringify(svc.exportOrg(t.org.id));
      for (const id of foreign) expect(bundle).not.toContain(id);
    }
  });

  it('treats ids from another org as not_found in every method', () => {
    const [a, b] = tenants as [Tenant, Tenant, Tenant];
    const A = a.org.id;
    const nf = (fn: () => unknown) => expect(codeOf(fn)).toBe('not_found');

    nf(() => svc.getDept(A, b.dept.id));
    nf(() => svc.getAgent(A, b.lead.id));
    expect(svc.findAgent(A, b.lead.id)).toBeNull();
    expect(svc.listAgents(A, { deptId: b.dept.id })).toEqual([]);
    nf(() => svc.updateDept(A, b.dept.id, { charter: 'hijack' }, OWNER));
    nf(() => svc.updateAgent(A, b.lead.id, { goal: 'hijack' }, OWNER));
    nf(() => svc.pauseAgent(A, b.lead.id, 'hijack', OWNER));
    nf(() => svc.resumeAgent(A, b.lead.id, OWNER));
    nf(() => svc.terminateAgent(A, b.lead.id, OWNER));
    nf(() => svc.managerOf(A, b.dev.id));
    nf(() => svc.reportsOf(A, b.lead.id));
    nf(() => svc.leadOf(A, b.dept.id));
    nf(() => svc.canAssign(A, a.lead.id, b.dev.id));
    nf(() => svc.canAssign(A, b.lead.id, a.dev.id));
    nf(() => svc.resolveCapabilityRefs(A, b.dev.id));
    nf(() => svc.rollback(A, 'agent', b.lead.id, 1, OWNER));
    nf(() => svc.rollback(A, 'dept', b.dept.id, 1, OWNER));
    nf(() => svc.rollback(A, 'org', b.org.id, 1, OWNER));
    expect(svc.listRevisions(A, 'agent', b.lead.id)).toEqual([]);
    expect(svc.listRevisions(A, 'org', b.org.id)).toEqual([]);
    nf(() => svc.getOrg('org_missing'));
    nf(() => svc.listAgents('org_missing'));
    nf(() => svc.orgChart('org_missing'));

    // Foreign references on input are rejected and nothing leaks across.
    expect(codeOf(() => svc.hireAgent(A, { deptId: b.dept.id, name: 'Spy', role: 'Spy' }, OWNER))).toBe('validation');
    expect(codeOf(() => svc.hireAgent(A, { deptId: a.dept.id, name: 'Spy', role: 'Spy', reportsTo: b.lead.id }, OWNER))).toBe('validation');

    // Org B is untouched by all of the above.
    expect(svc.getAgent(b.org.id, b.lead.id)).toMatchObject({ status: 'active', goal: '' });
    expect(svc.getDept(b.org.id, b.dept.id).charter).toBe('');
    expect(svc.listAgents(b.org.id)).toHaveLength(2);
  });

  it('archiving or changing one org leaves the others alone', () => {
    const [a, b, c] = tenants as [Tenant, Tenant, Tenant];
    svc.archiveOrg(a.org.id, OWNER);
    svc.terminateAgent(b.org.id, b.dev.id, OWNER);
    expect(svc.listOrgs().map((o) => o.id).sort()).toEqual([b.org.id, c.org.id].sort());
    expect(svc.listAgents(c.org.id, { status: 'active' })).toHaveLength(2);
    expect(svc.listAgents(a.org.id, { status: 'active' })).toHaveLength(2);
    expect(svc.listAgents(b.org.id, { status: 'terminated' }).map((x) => x.id)).toEqual([b.dev.id]);
  });
});
