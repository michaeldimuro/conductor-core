import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import { goals } from '../../src/db/schema/index.js';
import type { OrgChartNode } from '../../src/contracts/org-work.js';
import type { OrgContext } from '../../src/org/index.js';
import { codeOf, recordEvents, setup } from './fakes.js';

const flatten = (nodes: OrgChartNode[]): OrgChartNode[] => nodes.flatMap((n) => [n, ...flatten(n.reports)]);

describe('org templates (core use case 1)', () => {
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

  it('ships the four templates, each internally consistent', () => {
    const templates = org.listTemplates();
    expect(templates.map((t) => t.id)).toEqual(['saas-startup', 'content-studio', 'agency', 'solo-operator']);
    for (const t of templates) {
      const all = t.departments.flatMap((d) => d.agents);
      const roles = all.map((a) => a.role);
      expect(new Set(roles).size).toBe(roles.length);
      expect(all.filter((a) => a.reportsToRole === undefined)).toHaveLength(1);
      for (const a of all) {
        if (a.reportsToRole) expect(roles).toContain(a.reportsToRole);
        expect(a.goal?.length).toBeGreaterThan(20);
        expect(a.backstory?.length).toBeGreaterThan(40);
        expect(a.heartbeatCron).toBe(a.autonomyLevel === 3 ? '*/30 * * * *' : '0 * * * *');
      }
      for (const d of t.departments) expect(d.agents.filter((a) => a.isLead)).toHaveLength(1);
    }
    // The catalogue is a copy: callers cannot corrupt the built-ins.
    templates[0]!.departments.length = 0;
    expect(org.listTemplates()[0]?.departments.length).toBeGreaterThan(0);
  });

  it('stands up the SaaS startup: CEO + Engineering, Marketing, Support', () => {
    const events = recordEvents(k);
    const started = performance.now();
    const acme = org.createFromTemplate('saas-startup', { name: 'Acme', defaultProvider: { adapter: 'claude_local', model: 'sonnet' } }, OWNER);
    const elapsedMs = performance.now() - started;

    expect(acme).toMatchObject({ slug: 'acme', status: 'active', defaultProvider: { adapter: 'claude_local', model: 'sonnet' } });
    expect(acme.mission.length).toBeGreaterThan(0);
    const depts = org.listDepts(acme.id);
    expect(depts.map((d) => d.name)).toEqual(['Executive', 'Engineering', 'Marketing', 'Support']);

    const chart = org.orgChart(acme.id);
    expect(chart).toHaveLength(1);
    const ceo = chart[0]!;
    // The CEO is autonomy 3 and reports to the Owner (root).
    expect(ceo.agent).toMatchObject({ role: 'Chief Executive Officer', autonomyLevel: 3, reportsTo: null, heartbeatCron: '*/30 * * * *' });
    // Department leads report to the CEO.
    expect(ceo.reports.map((r) => r.department.name)).toEqual(['Engineering', 'Marketing', 'Support']);
    for (const leadNode of ceo.reports) {
      expect(leadNode.isLead).toBe(true);
      expect(leadNode.agent).toMatchObject({ autonomyLevel: 3, heartbeatCron: '*/30 * * * *', reportsTo: ceo.agent.id });
      expect(org.leadOf(acme.id, leadNode.department.id)?.id).toBe(leadNode.agent.id);
      expect(leadNode.reports.length).toBeGreaterThanOrEqual(1);
      expect(leadNode.reports.length).toBeLessThanOrEqual(2);
      for (const s of leadNode.reports) {
        expect(s.agent).toMatchObject({ heartbeatCron: '0 * * * *', reportsTo: leadNode.agent.id, deptId: leadNode.department.id });
        expect(s.agent.autonomyLevel).toBeLessThan(3);
        expect(s.agent.role.length).toBeGreaterThan(0);
        expect(s.agent.goal.length).toBeGreaterThan(0);
        expect(s.agent.backstory.length).toBeGreaterThan(0);
      }
    }

    const everyone = flatten(chart);
    expect(everyone).toHaveLength(org.listAgents(acme.id).length);
    for (const n of everyone) {
      expect(existsSync(k.paths.agentWorkspace(acme.slug, n.agent.slug))).toBe(true);
      expect(org.listRevisions(acme.id, 'agent', n.agent.id)).toHaveLength(1);
    }
    expect(events.filter(([name]) => name === 'agent.hired')).toHaveLength(everyone.length);
    expect(events.filter(([name]) => name === 'org.created')).toHaveLength(1);
    expect(k.db.select().from(goals).where(eq(goals.orgId, acme.id)).all().length).toBeGreaterThanOrEqual(1);
    // "Under 5 minutes end to end" — the call itself is milliseconds.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('creates every template, and the same template twice without collisions', () => {
    for (const t of org.listTemplates()) {
      const created = org.createFromTemplate(t.id, { name: `Org ${t.name}`, mission: 'Custom mission' }, OWNER);
      expect(created.mission).toBe('Custom mission');
      expect(org.listDepts(created.id)).toHaveLength(t.departments.length);
      expect(org.listAgents(created.id)).toHaveLength(t.departments.reduce((n, d) => n + d.agents.length, 0));
      expect(org.orgChart(created.id)).toHaveLength(1);
    }
    const again = org.createFromTemplate('solo-operator', { name: 'Org Solo operator' }, OWNER);
    expect(again.slug).toBe('org-solo-operator-2');
  });

  it('is a single transaction: a failure leaves nothing behind', () => {
    const events = recordEvents(k);
    const before = org.listOrgs({ includeArchived: true }).length;
    // Fail on the last write of the template (seeding goals).
    const spy = vi.spyOn(k.audit, 'record').mockImplementation((entry) => {
      if (entry.action === 'goal.created') throw new Error('disk full');
    });
    expect(() => org.createFromTemplate('saas-startup', { name: 'Doomed' }, OWNER)).toThrow('disk full');
    spy.mockRestore();

    expect(org.listOrgs({ includeArchived: true })).toHaveLength(before);
    expect(org.getOrgBySlug('doomed')).toBeNull();
    expect(k.sqlite.prepare('select count(*) as n from agents').get()).toEqual({ n: 0 });
    expect(k.sqlite.prepare('select count(*) as n from departments').get()).toEqual({ n: 0 });
    expect(k.sqlite.prepare('select count(*) as n from config_revisions').get()).toEqual({ n: 0 });
    // No events for state that never committed, and no dirs.
    expect(events).toEqual([]);
    expect(existsSync(k.paths.org('doomed'))).toBe(false);
  });

  it('validates the template id, input and actor', () => {
    expect(codeOf(() => org.createFromTemplate('nope', { name: 'X' }, OWNER))).toBe('not_found');
    expect(codeOf(() => org.createFromTemplate('agency', { name: '' }, OWNER))).toBe('validation');
    expect(codeOf(() => org.createFromTemplate('agency', { name: 'X' }, { kind: 'agent', id: 'agt_1' }))).toBe('forbidden');
  });
});
