import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { OrgChartNode } from '../../src/contracts/org-work.js';
import type { OrgContext } from '../../src/org/index.js';
import { codeOf, setup } from './fakes.js';

/** Render the chart as nested `slug[*]` names so assertions read like the chart. */
const render = (nodes: OrgChartNode[]): unknown[] =>
  nodes.map((n) => (n.reports.length ? { [`${n.agent.slug}${n.isLead ? '*' : ''}`]: render(n.reports) } : `${n.agent.slug}${n.isLead ? '*' : ''}`));

describe('FR-3: departments and agents with an org chart', () => {
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

  function build() {
    const acme = org.createOrg({ name: 'Acme' }, OWNER);
    const exec = org.createDept(acme.id, { name: 'Executive' }, OWNER);
    const eng = org.createDept(acme.id, { name: 'Engineering' }, OWNER);
    const mkt = org.createDept(acme.id, { name: 'Marketing' }, OWNER);
    const hire = (deptId: string, name: string, extra: { reportsTo?: string; isLead?: boolean } = {}) =>
      org.hireAgent(acme.id, { deptId, name, role: name, ...extra }, OWNER).agent!;
    const ceo = hire(exec.id, 'ceo', { isLead: true });
    const engLead = hire(eng.id, 'eng-lead', { reportsTo: ceo.id, isLead: true });
    const dev1 = hire(eng.id, 'dev1', { reportsTo: engLead.id });
    const dev2 = hire(eng.id, 'dev2', { reportsTo: engLead.id });
    const junior = hire(eng.id, 'junior', { reportsTo: dev1.id });
    const mktLead = hire(mkt.id, 'mkt-lead', { reportsTo: ceo.id, isLead: true });
    const writer = hire(mkt.id, 'writer', { reportsTo: mktLead.id });
    return { acme, eng, mkt, ceo, engLead, dev1, dev2, junior, mktLead, writer };
  }

  it('create dept, hire agent, set reports_to — and the chart renders', () => {
    const acme = org.createOrg({ name: 'Acme' }, OWNER);
    const dept = org.createDept(acme.id, { name: 'Engineering', charter: 'Build' }, OWNER);
    const lead = org.hireAgent(acme.id, { deptId: dept.id, name: 'Lead', role: 'Lead', isLead: true }, OWNER).agent!;
    const dev = org.hireAgent(acme.id, { deptId: dept.id, name: 'Dev', role: 'Engineer' }, OWNER).agent!;
    expect(render(org.orgChart(acme.id))).toEqual(['lead*', 'dev']);

    org.updateAgent(acme.id, dev.id, { reportsTo: lead.id }, OWNER);
    const chart = org.orgChart(acme.id);
    expect(render(chart)).toEqual([{ 'lead*': ['dev'] }]);
    expect(chart[0]?.department.id).toBe(dept.id);
    expect(chart[0]?.reports[0]?.agent.id).toBe(dev.id);
    expect(org.managerOf(acme.id, dev.id)?.id).toBe(lead.id);
    expect(org.managerOf(acme.id, lead.id)).toBeNull();
  });

  it('renders a multi-level chart rooted at the owner and omits terminated agents', () => {
    const t = build();
    expect(render(org.orgChart(t.acme.id))).toEqual([
      { 'ceo*': [{ 'eng-lead*': [{ dev1: ['junior'] }, 'dev2'] }, { 'mkt-lead*': ['writer'] }] },
    ]);
    org.terminateAgent(t.acme.id, t.dev1.id, OWNER);
    expect(render(org.orgChart(t.acme.id))).toEqual([
      { 'ceo*': [{ 'eng-lead*': ['dev2', 'junior'] }, { 'mkt-lead*': ['writer'] }] },
    ]);
  });

  it('answers managerOf / reportsOf (direct and transitive) / leadOf', () => {
    const t = build();
    const slugs = (xs: Array<{ slug: string }>) => xs.map((x) => x.slug).sort();
    expect(org.managerOf(t.acme.id, t.junior.id)?.slug).toBe('dev1');
    expect(slugs(org.reportsOf(t.acme.id, t.engLead.id))).toEqual(['dev1', 'dev2']);
    expect(slugs(org.reportsOf(t.acme.id, t.engLead.id, { transitive: true }))).toEqual(['dev1', 'dev2', 'junior']);
    expect(slugs(org.reportsOf(t.acme.id, t.ceo.id, { transitive: true }))).toEqual(['dev1', 'dev2', 'eng-lead', 'junior', 'mkt-lead', 'writer']);
    expect(org.reportsOf(t.acme.id, t.junior.id)).toEqual([]);
    expect(org.leadOf(t.acme.id, t.eng.id)?.slug).toBe('eng-lead');
    expect(org.leadOf(t.acme.id, t.mkt.id)?.slug).toBe('mkt-lead');
  });

  it('canAssign respects the reporting lines', () => {
    const t = build();
    const can = (from: { id: string }, to: { id: string }) => org.canAssign(t.acme.id, from.id, to.id);

    // self
    expect(can(t.dev1, t.dev1)).toBe(true);
    // direct and transitive reports
    expect(can(t.engLead, t.dev1)).toBe(true);
    expect(can(t.engLead, t.junior)).toBe(true);
    expect(can(t.ceo, t.writer)).toBe(true);
    // never upward
    expect(can(t.dev1, t.engLead)).toBe(false);
    expect(can(t.junior, t.ceo)).toBe(false);
    // peers: only through the lead — a non-lead may not assign sideways…
    expect(can(t.dev1, t.dev2)).toBe(false);
    expect(can(t.dev2, t.dev1)).toBe(false);
    // …but a department lead may assign to a peer under the same manager.
    expect(can(t.engLead, t.mktLead)).toBe(true);
    expect(can(t.mktLead, t.engLead)).toBe(true);
    // across lines without a shared manager
    expect(can(t.engLead, t.writer)).toBe(false);
    expect(can(t.dev1, t.writer)).toBe(false);
    expect(can(t.writer, t.junior)).toBe(false);

    // lines follow re-parenting
    org.updateAgent(t.acme.id, t.writer.id, { reportsTo: t.engLead.id }, OWNER);
    expect(can(t.engLead, t.writer)).toBe(true);
    expect(can(t.mktLead, t.writer)).toBe(false);

    // nothing can be assigned to a terminated agent; unknown agents are not_found
    org.terminateAgent(t.acme.id, t.dev2.id, OWNER);
    expect(can(t.engLead, t.dev2)).toBe(false);
    expect(codeOf(() => org.canAssign(t.acme.id, t.engLead.id, 'agt_missing'))).toBe('not_found');
  });
});
