import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createGovernance, expireApprovals, type GovernanceHandle } from '../../src/governance/index.js';
import { createKernel } from '../../src/kernel/index.js';
import { DEFAULT_GATED_ACTIONS, OWNER, SYSTEM } from '../../src/contracts/types.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { captureEvents, codeOf, setPolicies, type Captured } from './fixtures.js';

describe('governance / approvals', () => {
  let k: TestKernel;
  let gov: GovernanceHandle;
  let org: Organization;
  let other: Organization;
  let agent: Agent;
  let events: Captured;

  beforeEach(() => {
    k = createTestKernel();
    gov = createGovernance(k);
    org = seedOrg(k, 'Acme');
    other = seedOrg(k, 'Beta Labs');
    agent = seedAgent(k, org.id, seedDept(k, org.id).id);
    events = captureEvents(k);
  });
  afterEach(() => {
    gov.dispose();
    k.dispose();
  });

  describe('requiresApproval', () => {
    it('gates every default action and nothing unknown', () => {
      for (const kind of DEFAULT_GATED_ACTIONS) expect(gov.approvals.requiresApproval(org.id, kind)).toBe(true);
      expect(gov.approvals.requiresApproval(org.id, 'config_change')).toBe(false);
      expect(gov.approvals.requiresApproval(org.id, 'water_the_plants')).toBe(false);
    });

    it('always gates ask-first kinds', () => {
      for (const kind of ['tool_call', 'browser_action', 'connector_auth']) {
        expect(gov.approvals.requiresApproval(org.id, kind)).toBe(true);
      }
    });

    it('lets an org tighten with extraGated', () => {
      setPolicies(k, org.id, { extraGated: ['config_change', 'water_the_plants'] });
      expect(gov.approvals.requiresApproval(org.id, 'config_change')).toBe(true);
      expect(gov.approvals.requiresApproval(org.id, 'water_the_plants')).toBe(true);
      expect(gov.approvals.requiresApproval(other.id, 'config_change')).toBe(false);
    });

    it('loosens a default gate only with the explicit false toggle', () => {
      setPolicies(k, org.id, { approvalOverrides: { publish: true } });
      expect(gov.approvals.requiresApproval(org.id, 'publish')).toBe(true);
      setPolicies(k, org.id, { approvalOverrides: { publish: 0 as unknown as boolean, hire_agent: null as unknown as boolean } });
      expect(gov.approvals.requiresApproval(org.id, 'publish')).toBe(true);
      expect(gov.approvals.requiresApproval(org.id, 'hire_agent')).toBe(true);
      setPolicies(k, org.id, { approvalOverrides: { publish: false } });
      expect(gov.approvals.requiresApproval(org.id, 'publish')).toBe(false);
      expect(gov.approvals.requiresApproval(org.id, 'external_send')).toBe(true);
    });

    it('always gates payment above the spend threshold, even when loosened', () => {
      setPolicies(k, org.id, { approvalOverrides: { payment: false }, approvalSpendThresholdUsd: 50 });
      expect(gov.approvals.requiresApproval(org.id, 'payment')).toBe(false);
      expect(gov.approvals.requiresApproval(org.id, 'payment', { amountUsd: 50 })).toBe(false);
      expect(gov.approvals.requiresApproval(org.id, 'payment', { amountUsd: 50.01 })).toBe(true);
      // the threshold tightens non-default kinds too
      expect(gov.approvals.requiresApproval(org.id, 'other', { amountUsd: 10 })).toBe(false);
      expect(gov.approvals.requiresApproval(org.id, 'other', { amountUsd: 500 })).toBe(true);
    });

    it('applies the default $50 spend threshold when the org sets none', () => {
      setPolicies(k, org.id, { approvalOverrides: { payment: false } });
      expect(gov.approvals.requiresApproval(org.id, 'payment', { amountUsd: 50 })).toBe(false);
      expect(gov.approvals.requiresApproval(org.id, 'payment', { amountUsd: 50.01 })).toBe(true);
      // An org can raise it, or set 0 to gate every priced action.
      setPolicies(k, org.id, { approvalOverrides: { payment: false }, approvalSpendThresholdUsd: 200 });
      expect(gov.approvals.requiresApproval(org.id, 'payment', { amountUsd: 199 })).toBe(false);
      setPolicies(k, org.id, { approvalOverrides: { payment: false }, approvalSpendThresholdUsd: 0 });
      expect(gov.approvals.requiresApproval(org.id, 'payment', { amountUsd: 0.01 })).toBe(true);
      // Garbage in the policy falls back to the default rather than disabling the gate.
      setPolicies(k, org.id, { approvalOverrides: { payment: false }, approvalSpendThresholdUsd: Number.NaN });
      expect(gov.approvals.requiresApproval(org.id, 'payment', { amountUsd: 51 })).toBe(true);
    });

    it('treats an unknown org as not found', () => {
      expect(codeOf(() => gov.approvals.requiresApproval('org_nope', 'payment'))).toBe('not_found');
    });
  });

  describe('request', () => {
    it('stores a pending approval, audits and notifies with one-tap actions', () => {
      const a = gov.approvals.request({
        orgId: org.id,
        kind: 'external_send',
        title: 'Email vendor@example.com',
        payload: { to: 'vendor@example.com', apiKey: 'hunter2-plain', note: 'uses sk-ant-abcdefghijklmnopqrstuvwxyz', matchKey: 'mk1' },
        requesterAgentId: agent.id,
        runId: 'run_1',
      });
      expect(a.status).toBe('pending');
      expect(a.requesterAgentId).toBe(agent.id);
      expect(gov.approvals.get(org.id, a.id).payload.to).toBe('vendor@example.com');
      // credential-shaped values never reach the DB
      expect(JSON.stringify(gov.approvals.get(org.id, a.id).payload)).not.toContain('sk-ant-');

      expect(events.of('approval.requested')).toEqual([{ orgId: org.id, approvalId: a.id, kind: 'external_send' }]);
      const [n] = events.of('notification');
      expect(n).toMatchObject({
        orgId: org.id,
        kind: 'approval',
        actions: [
          { label: 'Approve', action: `approval:approve:${a.id}` },
          { label: 'Deny', action: `approval:deny:${a.id}` },
        ],
        data: { approvalId: a.id },
      });
      expect(n!.title).toContain('Email vendor@example.com');
      expect(n!.body).toContain('vendor@example.com');
      expect(n!.body).not.toContain('hunter2-plain');
      expect(n!.body).not.toContain('sk-ant-');
      expect(n!.body).not.toContain('mk1');

      const [rec] = k.audit.query({ orgId: org.id, action: 'approval.requested' });
      expect(rec).toMatchObject({ entityKind: 'approval', entityId: a.id, actor: { kind: 'agent', id: agent.id }, runId: 'run_1' });
    });

    it('rejects invalid input', () => {
      const base = { orgId: org.id, kind: 'publish' as const, title: 'Post' };
      expect(codeOf(() => gov.approvals.request({ ...base, kind: 'nonsense' as never }))).toBe('validation');
      expect(codeOf(() => gov.approvals.request({ ...base, title: '   ' }))).toBe('validation');
      expect(codeOf(() => gov.approvals.request({ ...base, expiresAt: k.clock.now() - 1 }))).toBe('validation');
      expect(codeOf(() => gov.approvals.request({ ...base, payload: 'x' as never }))).toBe('validation');
      expect(codeOf(() => gov.approvals.request({ ...base, orgId: 'org_nope' }))).toBe('not_found');
      // an agent from another org cannot be the requester
      expect(codeOf(() => gov.approvals.request({ ...base, orgId: other.id, requesterAgentId: agent.id }))).toBe('not_found');
      expect(gov.approvals.list(null)).toHaveLength(0);
    });
  });

  describe('decide', () => {
    it('records the decision, audits and emits approval.decided', () => {
      const a = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'Post', requesterAgentId: agent.id });
      const d = gov.approvals.decide(org.id, a.id, 'approved', OWNER, 'looks good');
      expect(d).toMatchObject({ status: 'approved', decidedBy: 'owner', decisionNote: 'looks good', decidedAt: k.clock.now() });
      expect(events.of('approval.decided')).toEqual([
        { orgId: org.id, approvalId: a.id, status: 'approved', requesterAgentId: agent.id },
      ]);
      const [rec] = k.audit.query({ orgId: org.id, action: 'approval.decided' });
      expect(rec).toMatchObject({ entityId: a.id, actor: { kind: 'human', id: 'owner' }, data: { status: 'approved' } });
    });

    it('only decides pending approvals', () => {
      const a = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'Post' });
      gov.approvals.decide(org.id, a.id, 'denied', OWNER);
      expect(codeOf(() => gov.approvals.decide(org.id, a.id, 'approved', OWNER))).toBe('conflict');
      expect(gov.approvals.get(org.id, a.id).status).toBe('denied');
      expect(events.of('approval.decided')).toHaveLength(1);
      expect(codeOf(() => gov.approvals.decide(org.id, a.id, 'maybe' as never, OWNER))).toBe('validation');
    });

    it('flips an expired approval to expired instead of deciding it', () => {
      const a = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'Post', expiresAt: k.clock.now() + 1000 });
      k.clock.advance(1000);
      expect(codeOf(() => gov.approvals.decide(org.id, a.id, 'approved', OWNER))).toBe('conflict');
      expect(gov.approvals.get(org.id, a.id).status).toBe('expired');
      expect(events.of('approval.decided')).toHaveLength(0);
      expect(k.audit.query({ action: 'approval.expired', entityId: a.id })).toHaveLength(1);
    });

    it('never lets an agent decide', () => {
      const a = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'Post', requesterAgentId: agent.id });
      expect(codeOf(() => gov.approvals.decide(org.id, a.id, 'approved', { kind: 'agent', id: agent.id }))).toBe('forbidden');
      expect(gov.approvals.get(org.id, a.id).status).toBe('pending');
    });

    it('isolates orgs: an approval id from another org is not found', () => {
      const a = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'Post' });
      expect(codeOf(() => gov.approvals.get(other.id, a.id))).toBe('not_found');
      expect(codeOf(() => gov.approvals.decide(other.id, a.id, 'approved', OWNER))).toBe('not_found');
      expect(gov.approvals.get(org.id, a.id).status).toBe('pending');
      expect(gov.approvals.list(other.id)).toHaveLength(0);
    });
  });

  describe('list', () => {
    it('filters by org, status and kind; null org lists everything', () => {
      const a = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'A' });
      k.clock.advance(10);
      const b = gov.approvals.request({ orgId: org.id, kind: 'payment', title: 'B' });
      const c = gov.approvals.request({ orgId: other.id, kind: 'publish', title: 'C' });
      gov.approvals.decide(org.id, a.id, 'approved', OWNER);
      expect(gov.approvals.list(org.id).map((x) => x.id)).toEqual([b.id, a.id]);
      expect(gov.approvals.list(org.id, { status: 'pending' }).map((x) => x.id)).toEqual([b.id]);
      expect(gov.approvals.list(org.id, { kind: 'publish' }).map((x) => x.id)).toEqual([a.id]);
      expect(gov.approvals.list(null).map((x) => x.id).sort()).toEqual([a.id, b.id, c.id].sort());
      expect(gov.approvals.list(null, { limit: 1 })).toHaveLength(1);
      expect(codeOf(() => gov.approvals.list(org.id, { status: 'bogus' as never }))).toBe('validation');
    });

    it('filters by issue and by explicit ids, never crossing orgs', () => {
      const a = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'A', issueId: 'iss_1' });
      k.clock.advance(10);
      const b = gov.approvals.request({ orgId: org.id, kind: 'payment', title: 'B' });
      const c = gov.approvals.request({ orgId: other.id, kind: 'publish', title: 'C', issueId: 'iss_1' });
      expect(gov.approvals.list(org.id, { issueId: 'iss_1' }).map((x) => x.id)).toEqual([a.id]);
      expect(gov.approvals.list(org.id, { ids: [a.id, b.id, c.id] }).map((x) => x.id)).toEqual([b.id, a.id]);
      expect(gov.approvals.list(org.id, { ids: [b.id], status: 'pending' }).map((x) => x.id)).toEqual([b.id]);
      expect(gov.approvals.list(org.id, { ids: [] })).toHaveLength(0);
    });
  });

  describe('consume / findOpen', () => {
    const ask = (matchKey: string, orgId = org.id) =>
      gov.approvals.request({ orgId, kind: 'tool_call', title: 'Call tool', payload: { matchKey, tool: 'gmail__send' } });

    it('matches on payload.matchKey and is single-use', () => {
      const a = ask('agent1:gmail__send:abc');
      expect(gov.approvals.findOpen(org.id, 'tool_call', 'agent1:gmail__send:abc')?.id).toBe(a.id);
      expect(gov.approvals.consume(org.id, 'tool_call', 'agent1:gmail__send:abc')).toBeNull(); // still pending

      gov.approvals.decide(org.id, a.id, 'approved', OWNER);
      expect(gov.approvals.findOpen(org.id, 'tool_call', 'agent1:gmail__send:abc')?.status).toBe('approved');
      expect(gov.approvals.consume(org.id, 'tool_call', 'other-key')).toBeNull();
      expect(gov.approvals.consume(org.id, 'browser_action', 'agent1:gmail__send:abc')).toBeNull();
      expect(gov.approvals.consume(other.id, 'tool_call', 'agent1:gmail__send:abc')).toBeNull();

      const used = gov.approvals.consume(org.id, 'tool_call', 'agent1:gmail__send:abc');
      expect(used).toMatchObject({ id: a.id, consumedAt: k.clock.now() });
      expect(gov.approvals.consume(org.id, 'tool_call', 'agent1:gmail__send:abc')).toBeNull();
      expect(gov.approvals.findOpen(org.id, 'tool_call', 'agent1:gmail__send:abc')).toBeNull();
      expect(k.audit.query({ action: 'approval.consumed', entityId: a.id })).toHaveLength(1);
    });

    it('does not treat denied or expired approvals as open', () => {
      const denied = ask('k-denied');
      gov.approvals.decide(org.id, denied.id, 'denied', OWNER);
      expect(gov.approvals.findOpen(org.id, 'tool_call', 'k-denied')).toBeNull();
      expect(gov.approvals.consume(org.id, 'tool_call', 'k-denied')).toBeNull();

      gov.approvals.request({ orgId: org.id, kind: 'tool_call', title: 'T', payload: { matchKey: 'k-exp' }, expiresAt: k.clock.now() + 5 });
      expect(gov.approvals.findOpen(org.id, 'tool_call', 'k-exp')).not.toBeNull();
      k.clock.advance(5);
      expect(gov.approvals.findOpen(org.id, 'tool_call', 'k-exp')).toBeNull();
    });

    it('gives a single approval to exactly one of several concurrent consumers', async () => {
      const a = ask('race');
      gov.approvals.decide(org.id, a.id, 'approved', OWNER);

      // Separate connections to the same database file, as separate workers would have.
      const k2 = createKernel({ home: k.paths.home, clock: k.clock, secrets: k.secrets });
      const k3 = createKernel({ home: k.paths.home, clock: k.clock, secrets: k.secrets });
      const gov2 = createGovernance(k2);
      const gov3 = createGovernance(k3);
      try {
        const contenders = [gov, gov2, gov3, gov2, gov, gov3];
        const results = await Promise.all(
          contenders.map(async (g) => {
            await Promise.resolve();
            return g.approvals.consume(org.id, 'tool_call', 'race');
          }),
        );
        const winners = results.filter((r) => r !== null);
        expect(winners).toHaveLength(1);
        expect(winners[0]!.id).toBe(a.id);
        expect(k.audit.query({ action: 'approval.consumed', entityId: a.id })).toHaveLength(1);
      } finally {
        gov2.dispose();
        gov3.dispose();
        k2.close();
        k3.close();
      }
    });

    it('consumes two approvals for the same action one at a time', () => {
      const a = ask('twice');
      const b = ask('twice');
      gov.approvals.decide(org.id, a.id, 'approved', OWNER);
      k.clock.advance(1);
      gov.approvals.decide(org.id, b.id, 'approved', OWNER);
      expect(gov.approvals.consume(org.id, 'tool_call', 'twice')?.id).toBe(a.id);
      expect(gov.approvals.consume(org.id, 'tool_call', 'twice')?.id).toBe(b.id);
      expect(gov.approvals.consume(org.id, 'tool_call', 'twice')).toBeNull();
    });

    it('validates its arguments', () => {
      expect(codeOf(() => gov.approvals.consume(org.id, 'tool_call', ''))).toBe('validation');
      expect(codeOf(() => gov.approvals.findOpen(org.id, 'nope' as never, 'x'))).toBe('validation');
    });
  });

  describe('known recipients', () => {
    it('is case-insensitive and org-scoped', () => {
      expect(gov.approvals.isKnownRecipient(org.id, 'Vendor@Example.com')).toBe(false);
      gov.approvals.rememberRecipient(org.id, '  Vendor@Example.com ');
      gov.approvals.rememberRecipient(org.id, 'vendor@example.COM');
      expect(gov.approvals.isKnownRecipient(org.id, 'VENDOR@example.com')).toBe(true);
      expect(gov.approvals.isKnownRecipient(other.id, 'vendor@example.com')).toBe(false);
      expect(codeOf(() => gov.approvals.rememberRecipient(org.id, '  '))).toBe('validation');
      expect(codeOf(() => gov.approvals.rememberRecipient('org_nope', 'a@b.c'))).toBe('not_found');
    });
  });

  describe('expireApprovals', () => {
    it('gives every approval a default expiry from org policy (72h), which the scheduler hook then enforces', () => {
      const now = k.clock.now();
      const byDefault = gov.approvals.request({ orgId: org.id, kind: 'tool_call', title: 'default', payload: { matchKey: 'k-default' }, requesterAgentId: agent.id });
      expect(byDefault.expiresAt).toBe(now + 72 * 3_600_000);
      expect(k.audit.query({ action: 'approval.requested', entityId: byDefault.id })[0]!.data).toMatchObject({ expiresAt: now + 72 * 3_600_000 });

      setPolicies(k, other.id, { approvalExpiryHours: 2 });
      const short = gov.approvals.request({ orgId: other.id, kind: 'publish', title: 'short' });
      expect(short.expiresAt).toBe(now + 2 * 3_600_000);
      // The requester's own choice always wins: an explicit time, or null for "never".
      const explicit = gov.approvals.request({ orgId: other.id, kind: 'publish', title: 'explicit', expiresAt: now + 5_000 });
      const never = gov.approvals.request({ orgId: other.id, kind: 'publish', title: 'never', expiresAt: null });
      expect([explicit.expiresAt, never.expiresAt]).toEqual([now + 5_000, null]);
      // Policy 0 switches the default off; nonsense falls back to 72h.
      setPolicies(k, other.id, { approvalExpiryHours: 0 });
      expect(gov.approvals.request({ orgId: other.id, kind: 'publish', title: 'off' }).expiresAt).toBeNull();
      setPolicies(k, other.id, { approvalExpiryHours: -3 });
      expect(gov.approvals.request({ orgId: other.id, kind: 'publish', title: 'bad' }).expiresAt).toBe(now + 72 * 3_600_000);

      k.clock.advance(2 * 3_600_000);
      expect(gov.expireApprovals().map((a) => a.id).sort()).toEqual([short.id, explicit.id].sort());
      expect(gov.approvals.findOpen(org.id, 'tool_call', 'k-default')?.id).toBe(byDefault.id);
      k.clock.advance(70 * 3_600_000);
      expect(gov.expireApprovals().map((a) => a.id)).toContain(byDefault.id);
      expect(gov.approvals.get(org.id, byDefault.id).status).toBe('expired');
      // An expired request is no longer open, cannot be decided, and the same action may be requested again.
      expect(gov.approvals.findOpen(org.id, 'tool_call', 'k-default')).toBeNull();
      expect(codeOf(() => gov.approvals.decide(org.id, byDefault.id, 'approved', OWNER))).toBe('conflict');
      expect(gov.approvals.get(other.id, never.id).status).toBe('pending');
    });

    it('marks only overdue pending approvals expired, audits, and announces each expiry', () => {
      const soon = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'soon', expiresAt: k.clock.now() + 100 });
      const later = gov.approvals.request({ orgId: other.id, kind: 'publish', title: 'later', expiresAt: k.clock.now() + 10_000 });
      const never = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'never' });
      const decided = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'decided', expiresAt: k.clock.now() + 100 });
      gov.approvals.decide(org.id, decided.id, 'approved', SYSTEM);
      events.clear();

      expect(gov.expireApprovals()).toHaveLength(0);
      k.clock.advance(100);
      expect(gov.expireApprovals().map((a) => a.id)).toEqual([soon.id]);
      expect(gov.approvals.get(org.id, soon.id).status).toBe('expired');
      expect(gov.approvals.get(other.id, later.id).status).toBe('pending');
      expect(gov.approvals.get(org.id, never.id).status).toBe('pending');
      expect(gov.approvals.get(org.id, decided.id).status).toBe('approved');
      expect(k.audit.query({ action: 'approval.expired' }).map((r) => r.entityId)).toEqual([soon.id]);
      // The waiting agent is woken by this event (and nothing else is emitted).
      expect(events.all.map((e) => e.name)).toEqual(['approval.expired']);
      expect(events.of('approval.expired')).toEqual([{ orgId: org.id, approvalId: soon.id, requesterAgentId: null, phase: 'pending' }]);

      // explicit `now` and the standalone export
      expect(expireApprovals(k, k.clock.now() + 10_000).map((a) => a.id)).toEqual([later.id]);
      expect(gov.expireApprovals()).toHaveLength(0);
    });
  });
});
