import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createGovernance, type GovernanceHandle } from '../../src/governance/index.js';
import { departments, organizations, projects } from '../../src/db/schema/index.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Agent, Department, Organization } from '../../src/contracts/rows.js';
import { agentRow, captureEvents, seedProject, setAgentCap, setDeptCap, setOrgCaps, type Captured } from './fixtures.js';

describe('governance / budget_raise approvals', () => {
  let k: TestKernel;
  let gov: GovernanceHandle;
  let org: Organization;
  let dept: Department;
  let ada: Agent;
  let bob: Agent;
  let events: Captured;

  beforeEach(() => {
    k = createTestKernel();
    gov = createGovernance(k);
    org = seedOrg(k, 'Acme');
    dept = seedDept(k, org.id);
    ada = seedAgent(k, org.id, dept.id, 'Ada');
    bob = seedAgent(k, org.id, dept.id, 'Bob');
    events = captureEvents(k);
  });
  afterEach(() => {
    gov.dispose();
    k.dispose();
  });

  const raise = (payload: Record<string, unknown>, orgId = org.id) =>
    gov.approvals.request({ orgId, kind: 'budget_raise', title: 'Raise budget', payload, requesterAgentId: orgId === org.id ? ada.id : null });

  it('applies the new cap on approval and resumes agents now under cap', () => {
    setAgentCap(k, ada.id, 10);
    gov.budgets.record({ orgId: org.id, agentId: ada.id, costUsd: 10 });
    expect(agentRow(k, ada.id).status).toBe('paused');

    const a = raise({ scope: 'agent', id: ada.id, newCapUsd: 25 });
    expect(agentRow(k, ada.id).budgetUsd).toBe(10); // nothing happens until decided
    events.clear();
    gov.approvals.decide(org.id, a.id, 'approved', OWNER);

    expect(agentRow(k, ada.id)).toMatchObject({ budgetUsd: 25, status: 'active', pausedReason: null });
    expect(events.of('agent.resumed')).toEqual([{ orgId: org.id, agentId: ada.id }]);
    expect(gov.approvals.get(org.id, a.id).consumedAt).toBe(k.clock.now());
    expect(k.audit.query({ orgId: org.id, action: 'budget.raised' })[0]).toMatchObject({
      entityKind: 'agent', entityId: ada.id, data: { approvalId: a.id, oldCapUsd: 10, newCapUsd: 25 },
    });
    expect(k.audit.query({ orgId: org.id, action: 'agent.resumed', entityId: ada.id })).toHaveLength(1);
    expect(gov.budgets.check(org.id, ada.id)).toMatchObject({ allowed: true, remainingUsd: 15 });

    // alerts re-arm against the new cap
    events.clear();
    gov.budgets.record({ orgId: org.id, agentId: ada.id, costUsd: 10 });
    expect(events.of('budget.alert')).toEqual([{ orgId: org.id, level: 'soft', scope: 'agent', scopeId: ada.id, pct: 80 }]);
  });

  it('does nothing when denied', () => {
    setAgentCap(k, ada.id, 10);
    gov.budgets.record({ orgId: org.id, agentId: ada.id, costUsd: 10 });
    const a = raise({ scope: 'agent', id: ada.id, newCapUsd: 25 });
    gov.approvals.decide(org.id, a.id, 'denied', OWNER);
    expect(agentRow(k, ada.id)).toMatchObject({ budgetUsd: 10, status: 'paused' });
    expect(events.of('agent.resumed')).toHaveLength(0);
  });

  it('only resumes budget-paused agents that are under every cap', () => {
    setDeptCap(k, dept.id, 10);
    setAgentCap(k, bob.id, 4);
    const held = seedAgent(k, org.id, dept.id, 'Held', { status: 'paused', pausedReason: 'manual' });
    gov.budgets.record({ orgId: org.id, agentId: bob.id, costUsd: 4 }); // bob over his own cap
    gov.budgets.record({ orgId: org.id, agentId: ada.id, costUsd: 6 }); // dept at 100%
    expect(agentRow(k, ada.id).status).toBe('paused');
    expect(agentRow(k, bob.id).status).toBe('paused');

    const a = raise({ scope: 'dept', id: dept.id, newCapUsd: 50 });
    gov.approvals.decide(org.id, a.id, 'approved', OWNER);
    expect(k.db.select().from(departments).where(eq(departments.id, dept.id)).get()!.budgetUsd).toBe(50);
    expect(agentRow(k, ada.id).status).toBe('active');
    expect(agentRow(k, bob.id)).toMatchObject({ status: 'paused', pausedReason: 'budget' }); // still over his agent cap
    expect(agentRow(k, held.id)).toMatchObject({ status: 'paused', pausedReason: 'manual' });
    expect(events.of('agent.resumed')).toEqual([{ orgId: org.id, agentId: ada.id }]);
  });

  it('raises org and project caps', () => {
    setOrgCaps(k, org.id, { budgetMonthlyUsd: 5 });
    const project = seedProject(k, org.id, 'Launch', 1);
    gov.budgets.record({ orgId: org.id, agentId: ada.id, projectId: project.id, costUsd: 1 }); // project cap → ada paused
    expect(agentRow(k, ada.id).status).toBe('paused');

    gov.approvals.decide(org.id, raise({ scope: 'org', id: org.id, newCapUsd: 500 }).id, 'approved', OWNER);
    expect(k.db.select().from(organizations).where(eq(organizations.id, org.id)).get()!.budgetMonthlyUsd).toBe(500);
    expect(agentRow(k, ada.id).status).toBe('paused'); // the project she spent on is still exhausted

    gov.approvals.decide(org.id, raise({ scope: 'project', id: project.id, newCapUsd: 10 }).id, 'approved', OWNER);
    expect(k.db.select().from(projects).where(eq(projects.id, project.id)).get()!.budgetUsd).toBe(10);
    expect(agentRow(k, ada.id).status).toBe('active');
  });

  it('refuses malformed payloads and targets in another org', () => {
    const other = seedOrg(k, 'Beta');
    const eve = seedAgent(k, other.id, seedDept(k, other.id).id, 'Eve', { budgetUsd: 1 });

    const bad = raise({ scope: 'agent', id: ada.id, newCapUsd: -5 });
    gov.approvals.decide(org.id, bad.id, 'approved', OWNER);
    const crossAgent = raise({ scope: 'agent', id: eve.id, newCapUsd: 999 });
    gov.approvals.decide(org.id, crossAgent.id, 'approved', OWNER);
    const crossOrg = raise({ scope: 'org', id: other.id, newCapUsd: 999 });
    gov.approvals.decide(org.id, crossOrg.id, 'approved', OWNER);

    expect(agentRow(k, eve.id).budgetUsd).toBe(1);
    expect(k.db.select().from(organizations).where(eq(organizations.id, other.id)).get()!.budgetMonthlyUsd).toBeNull();
    expect(agentRow(k, ada.id).budgetUsd).toBeNull();
    expect(k.audit.query({ orgId: org.id, action: 'budget.raise_failed' })).toHaveLength(3);
    expect(k.audit.query({ action: 'budget.raised' })).toHaveLength(0);
    expect(gov.approvals.get(org.id, crossAgent.id).consumedAt).toBeNull();
    expect(events.of('notification').filter((n) => n.title.includes('could not be applied'))).toHaveLength(3);
  });

  it('ignores other approval kinds and stops listening after dispose', () => {
    const publish = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'Post', payload: { scope: 'agent', id: ada.id, newCapUsd: 77 } });
    gov.approvals.decide(org.id, publish.id, 'approved', OWNER);
    expect(agentRow(k, ada.id).budgetUsd).toBeNull();

    gov.dispose();
    const a = raise({ scope: 'agent', id: ada.id, newCapUsd: 77 });
    gov.approvals.decide(org.id, a.id, 'approved', OWNER);
    expect(agentRow(k, ada.id).budgetUsd).toBeNull();
  });
});
