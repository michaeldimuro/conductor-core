import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createGovernance, type GovernanceHandle } from '../../src/governance/index.js';
import type { Agent, Department, Organization } from '../../src/contracts/rows.js';
import { agentRow, captureEvents, codeOf, seedProject, setAgentCap, setDeptCap, setOrgCaps, type Captured } from './fixtures.js';

const DAY = 86_400_000;

describe('governance / budgets', () => {
  let k: TestKernel;
  let gov: GovernanceHandle;
  let org: Organization;
  let dept: Department;
  let ada: Agent;
  let bob: Agent;
  let events: Captured;

  beforeEach(() => {
    k = createTestKernel();
    k.clock.set(Date.UTC(2026, 10, 10, 12)); // 2026-11-10
    gov = createGovernance(k);
    org = seedOrg(k, 'Acme');
    dept = seedDept(k, org.id, 'Engineering');
    ada = seedAgent(k, org.id, dept.id, 'Ada');
    bob = seedAgent(k, org.id, dept.id, 'Bob');
    events = captureEvents(k);
  });
  afterEach(() => {
    gov.dispose();
    k.dispose();
  });

  const spend = (agent: Agent, costUsd: number, extra: Record<string, unknown> = {}) =>
    gov.budgets.record({ orgId: org.id, agentId: agent.id, costUsd, ...extra });

  describe('check', () => {
    it('is uncapped by default', () => {
      const s = gov.budgets.check(org.id, ada.id);
      expect(s).toMatchObject({ allowed: true, remainingUsd: null, tightest: null });
      expect(s.lines.map((l) => l.scope)).toEqual(['org', 'dept', 'agent']);
      expect(s.seat).toEqual({ capSeconds: null, usedSeconds: 0, allowed: true });
      expect(s.reason).toBeUndefined();
    });

    it('returns every line and the tightest cap', () => {
      setOrgCaps(k, org.id, { budgetMonthlyUsd: 100 });
      setDeptCap(k, dept.id, 20);
      setAgentCap(k, ada.id, 15);
      const project = seedProject(k, org.id, 'Launch', 50);
      spend(ada, 4, { projectId: project.id });
      spend(bob, 12);

      const s = gov.budgets.check(org.id, ada.id, project.id);
      expect(s.lines).toEqual([
        { scope: 'org', id: org.id, capUsd: 100, spentUsd: 16, pct: 16 },
        { scope: 'dept', id: dept.id, capUsd: 20, spentUsd: 16, pct: 80 },
        { scope: 'agent', id: ada.id, capUsd: 15, spentUsd: 4, pct: 26.67 },
        { scope: 'project', id: project.id, capUsd: 50, spentUsd: 4, pct: 8 },
      ]);
      expect(s.tightest).toMatchObject({ scope: 'dept', id: dept.id });
      expect(s.remainingUsd).toBe(4);
      expect(s.allowed).toBe(true);
    });

    it('denies with a readable reason at 100% of any cap', () => {
      setDeptCap(k, dept.id, 10);
      spend(bob, 10);
      const s = gov.budgets.check(org.id, ada.id);
      expect(s.allowed).toBe(false);
      expect(s.remainingUsd).toBe(0);
      expect(s.reason).toMatch(/department budget exhausted: \$10\.00 of \$10\.00/);
    });

    it('isolates orgs', () => {
      const other = seedOrg(k, 'Beta');
      const stranger = seedAgent(k, other.id, seedDept(k, other.id).id, 'Eve');
      const foreignProject = seedProject(k, other.id);
      expect(codeOf(() => gov.budgets.check(org.id, stranger.id))).toBe('not_found');
      expect(codeOf(() => gov.budgets.check(org.id, ada.id, foreignProject.id))).toBe('not_found');
      expect(codeOf(() => gov.budgets.check('org_nope', ada.id))).toBe('not_found');
      expect(codeOf(() => gov.budgets.record({ orgId: org.id, agentId: stranger.id, costUsd: 1 }))).toBe('not_found');
      expect(codeOf(() => gov.budgets.record({ orgId: org.id, projectId: foreignProject.id, costUsd: 1 }))).toBe('not_found');

      gov.budgets.record({ orgId: other.id, agentId: stranger.id, costUsd: 99 });
      expect(gov.budgets.check(org.id, ada.id).lines[0]!.spentUsd).toBe(0);
      expect(gov.budgets.ledger(org.id)).toHaveLength(0);
      expect(gov.budgets.summary(org.id).totalUsd).toBe(0);
    });
  });

  describe('record', () => {
    it('writes a ledger row with the agent department resolved', () => {
      const status = spend(ada, 1.25, { runId: 'run_1', provider: 'claude_api', model: 'm', tokensIn: 100, tokensOut: 20, category: 'reflection' });
      expect(status?.allowed).toBe(true);
      const [row] = gov.budgets.ledger(org.id);
      expect(row).toMatchObject({
        orgId: org.id, deptId: dept.id, agentId: ada.id, runId: 'run_1', category: 'reflection', provider: 'claude_api',
        tokensIn: 100, tokensOut: 20, costUsd: 1.25, subscription: false, seatSeconds: 0, ts: k.clock.now(),
      });
      expect(gov.budgets.record({ orgId: org.id, costUsd: 0.5, category: 'embedding' })).toBeNull();
      expect(gov.budgets.ledger(org.id)).toHaveLength(2);
    });

    it('rejects invalid entries', () => {
      expect(codeOf(() => spend(ada, -1))).toBe('validation');
      expect(codeOf(() => spend(ada, Number.NaN))).toBe('validation');
      expect(codeOf(() => spend(ada, 1, { tokensIn: 1.5 }))).toBe('validation');
      expect(codeOf(() => spend(ada, 1, { seatSeconds: -5 }))).toBe('validation');
      expect(gov.budgets.ledger(org.id)).toHaveLength(0);
    });

    it('FR-16: hard stop pauses the agent at 100% of its cap', () => {
      setAgentCap(k, ada.id, 10);
      expect(spend(ada, 9.99)?.allowed).toBe(true);
      expect(agentRow(k, ada.id).status).toBe('active');
      events.clear();

      const status = spend(ada, 0.01);
      expect(status).toMatchObject({ allowed: false, remainingUsd: 0 });
      expect(status?.reason).toMatch(/agent budget exhausted/);
      expect(agentRow(k, ada.id)).toMatchObject({ status: 'paused', pausedReason: 'budget' });
      expect(agentRow(k, bob.id).status).toBe('active');

      expect(events.of('budget.alert')).toEqual([{ orgId: org.id, level: 'hard', scope: 'agent', scopeId: ada.id, pct: 100 }]);
      expect(events.of('agent.paused')).toEqual([{ orgId: org.id, agentId: ada.id, reason: 'budget' }]);
      expect(events.of('notification')).toHaveLength(1);
      expect(events.of('notification')[0]).toMatchObject({ kind: 'budget', data: { level: 'hard', pausedAgentIds: [ada.id] } });
      expect(k.audit.query({ orgId: org.id, action: 'agent.paused', entityId: ada.id })).toHaveLength(1);
      expect(k.audit.query({ orgId: org.id, action: 'budget.hard_stop' })).toHaveLength(1);

      // spend from the in-flight run ending does not alert again
      events.clear();
      spend(ada, 0.5);
      expect(events.all).toHaveLength(0);
    });

    it('pauses again if someone resumed the agent while still over cap', () => {
      setAgentCap(k, ada.id, 1);
      spend(ada, 2);
      setAgentCap(k, ada.id, 1); // no-op; agent manually reactivated below
      k.sqlite.prepare("update agents set status = 'active', paused_reason = null where id = ?").run(ada.id);
      events.clear();
      spend(ada, 0.1);
      expect(agentRow(k, ada.id).status).toBe('paused');
      expect(events.of('agent.paused')).toHaveLength(1);
    });

    it('sends the soft alert once per scope per month and again after rollover', () => {
      setAgentCap(k, ada.id, 10);
      spend(ada, 7.9);
      expect(events.of('budget.alert')).toHaveLength(0);

      spend(ada, 0.1); // 80%
      expect(events.of('budget.alert')).toEqual([{ orgId: org.id, level: 'soft', scope: 'agent', scopeId: ada.id, pct: 80 }]);
      expect(events.of('notification')).toHaveLength(1);
      expect(agentRow(k, ada.id).status).toBe('active');

      spend(ada, 0.5);
      spend(ada, 0.5);
      expect(events.of('budget.alert')).toHaveLength(1);
      expect(events.of('notification')).toHaveLength(1);
      expect(k.audit.query({ action: 'budget.alert' })).toHaveLength(1);

      // December: the window resets, spend starts from zero, alerts re-arm
      k.clock.advance(25 * DAY);
      const fresh = gov.budgets.check(org.id, ada.id);
      expect(fresh.lines.find((l) => l.scope === 'agent')).toMatchObject({ spentUsd: 0, pct: 0 });
      expect(fresh.remainingUsd).toBe(10);
      events.clear();
      spend(ada, 8.5);
      expect(events.of('budget.alert')).toEqual([{ orgId: org.id, level: 'soft', scope: 'agent', scopeId: ada.id, pct: 85 }]);
    });

    it('uses a UTC calendar-month window', () => {
      setAgentCap(k, ada.id, 10);
      k.clock.set(Date.UTC(2026, 10, 30, 23, 59, 59));
      spend(ada, 10);
      expect(gov.budgets.check(org.id, ada.id).allowed).toBe(false);
      k.clock.set(Date.UTC(2026, 11, 1, 0, 0, 0));
      expect(gov.budgets.check(org.id, ada.id).allowed).toBe(true);
      // still paused from November until something resumes it
      expect(agentRow(k, ada.id).status).toBe('paused');
      expect(gov.resumeBudgetPaused(org.id)).toEqual([ada.id]);
      expect(agentRow(k, ada.id)).toMatchObject({ status: 'active', pausedReason: null });
    });

    it('department cap pauses every active agent in that department only', () => {
      const sales = seedDept(k, org.id, 'Sales');
      const sam = seedAgent(k, org.id, sales.id, 'Sam');
      const retired = seedAgent(k, org.id, dept.id, 'Old', { status: 'terminated' });
      const manual = seedAgent(k, org.id, dept.id, 'Held', { status: 'paused', pausedReason: 'manual' });
      setDeptCap(k, dept.id, 5);
      spend(ada, 5);
      expect(agentRow(k, ada.id).status).toBe('paused');
      expect(agentRow(k, bob.id)).toMatchObject({ status: 'paused', pausedReason: 'budget' });
      expect(agentRow(k, sam.id).status).toBe('active');
      expect(agentRow(k, retired.id).status).toBe('terminated');
      expect(agentRow(k, manual.id).pausedReason).toBe('manual');
      expect(events.of('agent.paused').map((e) => e.agentId).sort()).toEqual([ada.id, bob.id].sort());
      expect(events.of('budget.alert')).toEqual([{ orgId: org.id, level: 'hard', scope: 'dept', scopeId: dept.id, pct: 100 }]);
    });

    it('org cap pauses every active agent in the org and no one else', () => {
      const other = seedOrg(k, 'Beta');
      const eve = seedAgent(k, other.id, seedDept(k, other.id).id, 'Eve');
      setOrgCaps(k, org.id, { budgetMonthlyUsd: 3 });
      gov.budgets.record({ orgId: org.id, costUsd: 3.5, category: 'embedding' }); // org-level spend, no agent
      expect(agentRow(k, ada.id).status).toBe('paused');
      expect(agentRow(k, bob.id).status).toBe('paused');
      expect(agentRow(k, eve.id).status).toBe('active');
      expect(events.of('budget.alert')[0]).toMatchObject({ level: 'hard', scope: 'org', scopeId: org.id });
      expect(events.of('budget.alert')[0]!.pct).toBeCloseTo(116.67, 2);
    });

    it('project cap pauses the recording agent', () => {
      const project = seedProject(k, org.id, 'Launch', 2);
      spend(bob, 1, { projectId: project.id });
      const status = spend(ada, 1, { projectId: project.id });
      expect(status?.allowed).toBe(false);
      expect(status?.tightest).toMatchObject({ scope: 'project', id: project.id });
      expect(agentRow(k, ada.id).status).toBe('paused');
      expect(agentRow(k, bob.id).status).toBe('active');
      expect(gov.budgets.check(org.id, bob.id).allowed).toBe(true);
      expect(gov.budgets.check(org.id, bob.id, project.id).allowed).toBe(false);
    });

    it('subscription runs cost $0, track tokens and draw down seat time', () => {
      setOrgCaps(k, org.id, { seatSecondsMonthly: 600 });
      setAgentCap(k, ada.id, 1);
      const s1 = spend(ada, 4.2, { subscription: true, seatSeconds: 300, tokensIn: 5000, tokensOut: 800, provider: 'claude_local' });
      expect(s1).toMatchObject({ allowed: true, seat: { capSeconds: 600, usedSeconds: 300, allowed: true } });
      expect(gov.budgets.ledger(org.id)[0]).toMatchObject({ costUsd: 0, subscription: true, seatSeconds: 300, tokensIn: 5000, tokensOut: 800 });
      expect(agentRow(k, ada.id).status).toBe('active');

      // API runs never consume seat time
      spend(bob, 0.1, { seatSeconds: 999 });
      expect(gov.budgets.check(org.id, bob.id).seat.usedSeconds).toBe(300);

      events.clear();
      const s2 = spend(ada, 0, { subscription: true, seatSeconds: 300 });
      expect(s2?.allowed).toBe(false);
      expect(s2?.seat).toEqual({ capSeconds: 600, usedSeconds: 600, allowed: false });
      expect(s2?.reason).toMatch(/seat-time quota exhausted: 600s of 600s/);
      expect(events.of('budget.alert')).toEqual([{ orgId: org.id, level: 'hard', scope: 'seat', scopeId: org.id, pct: 100 }]);
      expect(gov.budgets.summary(org.id).seatSeconds).toBe(600);

      k.clock.advance(25 * DAY);
      expect(gov.budgets.check(org.id, ada.id).seat).toEqual({ capSeconds: 600, usedSeconds: 0, allowed: true });
    });
  });

  describe('summary / ledger', () => {
    it('aggregates totals, per agent, per day and lines', () => {
      setOrgCaps(k, org.id, { budgetMonthlyUsd: 100 });
      setAgentCap(k, ada.id, 50);
      const project = seedProject(k, org.id, 'Launch', 40);
      spend(ada, 1, { runId: 'run_a', tokensIn: 10, tokensOut: 1 });
      spend(ada, 2, { runId: 'run_a', tokensIn: 20, tokensOut: 2, projectId: project.id });
      k.clock.advance(DAY);
      spend(ada, 3, { runId: 'run_b', tokensIn: 30, tokensOut: 3 });
      spend(bob, 4, { runId: 'run_c' });
      gov.budgets.record({ orgId: org.id, costUsd: 0.5, category: 'embedding' });

      const s = gov.budgets.summary(org.id);
      expect(s.totalUsd).toBeCloseTo(10.5);
      expect(s.byAgent).toEqual([
        { agentId: ada.id, costUsd: 6, tokensIn: 60, tokensOut: 6, runs: 2 },
        { agentId: bob.id, costUsd: 4, tokensIn: 0, tokensOut: 0, runs: 1 },
      ]);
      expect(s.byDay).toEqual([
        { day: '2026-11-10', costUsd: 3 },
        { day: '2026-11-11', costUsd: 7.5 },
      ]);
      expect(s.lines).toEqual([
        { scope: 'org', id: org.id, capUsd: 100, spentUsd: 10.5, pct: 10.5 },
        { scope: 'dept', id: dept.id, capUsd: null, spentUsd: 10, pct: null },
        { scope: 'agent', id: ada.id, capUsd: 50, spentUsd: 6, pct: 12 },
        { scope: 'agent', id: bob.id, capUsd: null, spentUsd: 4, pct: null },
        { scope: 'project', id: project.id, capUsd: 40, spentUsd: 2, pct: 5 },
      ]);

      const firstDay = gov.budgets.summary(org.id, { since: Date.UTC(2026, 10, 10), until: Date.UTC(2026, 10, 11) });
      expect(firstDay.totalUsd).toBe(3);
      expect(firstDay.byDay).toEqual([{ day: '2026-11-10', costUsd: 3 }]);

      expect(gov.budgets.ledger(org.id)).toHaveLength(5);
      expect(gov.budgets.ledger(org.id, { agentId: bob.id }).map((r) => r.costUsd)).toEqual([4]);
      expect(gov.budgets.ledger(org.id, { limit: 2 })).toHaveLength(2);
      expect(gov.budgets.ledger(org.id)[0]!.ts).toBeGreaterThanOrEqual(gov.budgets.ledger(org.id)[4]!.ts);
      expect(codeOf(() => gov.budgets.summary('org_nope'))).toBe('not_found');
    });
  });
});
