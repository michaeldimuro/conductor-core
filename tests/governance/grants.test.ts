import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createGovernance, gateSkillGrant, skillGrantMatchKey, SKILL_GRANT_SOURCE, type GovernanceHandle } from '../../src/governance/index.js';
import { approvalUseTtlMs, DEFAULT_APPROVAL_USE_WITHIN_HOURS } from '../../src/governance/policy.js';
import { OWNER, SYSTEM, type Actor } from '../../src/contracts/types.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { captureEvents, codeOf, setPolicies, type Captured } from './fixtures.js';

const HOUR = 3_600_000;

describe('governance / approved grants and the skill-grant gate', () => {
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

  const approved = (orgId: string, matchKey: string | null, title = 'Send the email') => {
    const a = gov.approvals.request({ orgId, kind: 'tool_call', title, payload: matchKey ? { matchKey } : {}, requesterAgentId: orgId === org.id ? agent.id : null, expiresAt: null });
    return gov.approvals.decide(orgId, a.id, 'approved', OWNER);
  };

  describe('use-by window of an approved grant', () => {
    it('reads the window from org policy (default 72h, 0 = never)', () => {
      expect(approvalUseTtlMs(undefined)).toBe(DEFAULT_APPROVAL_USE_WITHIN_HOURS * HOUR);
      expect(approvalUseTtlMs({ approvalUseWithinHours: 2 })).toBe(2 * HOUR);
      expect(approvalUseTtlMs({ approvalUseWithinHours: 0 })).toBeNull();
      expect(approvalUseTtlMs({ approvalUseWithinHours: -5 })).toBe(DEFAULT_APPROVAL_USE_WITHIN_HOURS * HOUR);
    });

    it('an approved grant can be consumed inside the window and not after it', () => {
      const fresh = approved(org.id, 'mk-fresh');
      k.clock.advance(71 * HOUR);
      expect(gov.approvals.consume(org.id, 'tool_call', 'mk-fresh')?.id).toBe(fresh.id);

      const stale = approved(org.id, 'mk-stale');
      k.clock.advance(72 * HOUR);
      expect(gov.approvals.findOpen(org.id, 'tool_call', 'mk-stale')).toBeNull(); // no longer counts as an open grant
      expect(gov.approvals.consume(org.id, 'tool_call', 'mk-stale')).toBeNull(); // and cannot be used
      expect(gov.approvals.get(org.id, stale.id).consumedAt).toBeNull();
    });

    it('the sweep expires unused grants (audited, announced) but leaves used, undated and matchKey-less approvals alone', () => {
      const unused = approved(org.id, 'mk-unused');
      const used = approved(org.id, 'mk-used');
      gov.approvals.consume(org.id, 'tool_call', 'mk-used');
      const advice = approved(org.id, null, 'May I proceed?'); // nothing ever consumes this one: it stays approved
      const elsewhere = approved(other.id, 'mk-unused');
      setPolicies(k, other.id, { approvalUseWithinHours: 0 });
      events.clear();

      k.clock.advance(71 * HOUR);
      expect(gov.expireApprovals()).toHaveLength(0);
      k.clock.advance(HOUR);
      expect(gov.expireApprovals().map((a) => a.id)).toEqual([unused.id]);

      expect(gov.approvals.get(org.id, unused.id).status).toBe('expired');
      expect(gov.approvals.get(org.id, used.id).status).toBe('approved');
      expect(gov.approvals.get(org.id, advice.id).status).toBe('approved');
      expect(gov.approvals.get(other.id, elsewhere.id).status).toBe('approved'); // that org switched the window off
      expect(events.of('approval.expired')).toEqual([{ orgId: org.id, approvalId: unused.id, requesterAgentId: agent.id, phase: 'unused' }]);
      const audit = k.audit.query({ orgId: org.id, action: 'approval.expired' });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ entityId: unused.id, data: { phase: 'unused', kind: 'tool_call' } });
      expect(gov.expireApprovals()).toHaveLength(0); // idempotent
      // The lapsed grant can be asked for again.
      expect(gov.approvals.findOpen(org.id, 'tool_call', 'mk-unused')).toBeNull();
    });

    it('honours a shorter org window', () => {
      setPolicies(k, org.id, { approvalUseWithinHours: 1 });
      approved(org.id, 'mk-short');
      k.clock.advance(HOUR);
      expect(gov.approvals.consume(org.id, 'tool_call', 'mk-short')).toBeNull();
      expect(gov.expireApprovals()).toHaveLength(1);
    });

    it('a pending approval that expires says so with phase "pending"', () => {
      const a = gov.approvals.request({ orgId: org.id, kind: 'publish', title: 'Post it', requesterAgentId: agent.id, expiresAt: k.clock.now() + 1000 });
      events.clear();
      k.clock.advance(1000);
      // Lazily, on a late decision…
      expect(codeOf(() => gov.approvals.decide(org.id, a.id, 'approved', OWNER))).toBe('conflict');
      expect(events.of('approval.expired')).toEqual([{ orgId: org.id, approvalId: a.id, requesterAgentId: agent.id, phase: 'pending' }]);
      // …and only once.
      expect(gov.expireApprovals()).toHaveLength(0);
      expect(events.of('approval.expired')).toHaveLength(1);
    });
  });

  describe('gateSkillGrant', () => {
    const lead = (): Actor => ({ kind: 'agent', id: agent.id, runId: 'run_1' });
    const req = (actor: Actor, orgId = org.id) => ({ orgId, agentId: 'agt_target', skillId: 'skl_1', skillName: 'Release notes', agentName: 'Ada', actor });

    it('lets the owner grant directly', () => {
      expect(gov.gateSkillGrant(req(OWNER))).toEqual({ allowed: true, approval: null });
      expect(gov.approvals.list(org.id)).toHaveLength(0);
    });

    it('files one grant_skill approval for an agent, and lets the grant through exactly once when approved', () => {
      const first = gov.gateSkillGrant(req(lead()));
      expect(first.allowed).toBe(false);
      expect(first.approval).toMatchObject({
        kind: 'grant_skill', status: 'pending', requesterAgentId: agent.id, runId: 'run_1', title: 'Grant skill "Release notes" to Ada',
        payload: { source: SKILL_GRANT_SOURCE, matchKey: skillGrantMatchKey('agt_target', 'skl_1'), skillId: 'skl_1', agentId: 'agt_target' },
      });
      // Asking again does not pile up requests.
      expect(gateSkillGrant(gov.approvals, req(lead())).approval?.id).toBe(first.approval!.id);
      expect(gov.approvals.list(org.id)).toHaveLength(1);

      gov.approvals.decide(org.id, first.approval!.id, 'approved', OWNER);
      const second = gov.gateSkillGrant(req(SYSTEM)); // the applying context, on `approval.decided`
      expect(second).toMatchObject({ allowed: true, approval: { id: first.approval!.id } });
      expect(gov.approvals.get(org.id, first.approval!.id).consumedAt).not.toBeNull();
      // Single use: the next grant of the same skill needs a new approval.
      const third = gov.gateSkillGrant(req(lead()));
      expect(third.allowed).toBe(false);
      expect(third.approval!.id).not.toBe(first.approval!.id);
    });

    it('a denied request does not grant', () => {
      const first = gov.gateSkillGrant(req(lead()));
      gov.approvals.decide(org.id, first.approval!.id, 'denied', OWNER, 'not needed');
      expect(gov.gateSkillGrant(req(SYSTEM)).allowed).toBe(false);
    });

    it('the grant_skill policy toggle switches the gate off for that org only', () => {
      setPolicies(k, org.id, { approvalOverrides: { grant_skill: false } });
      expect(gov.gateSkillGrant(req(lead()))).toEqual({ allowed: true, approval: null });
      expect(gov.gateSkillGrant(req(SYSTEM, other.id)).allowed).toBe(false);
      // An approval of one org never satisfies another.
      const pending = gov.approvals.list(other.id)[0]!;
      gov.approvals.decide(other.id, pending.id, 'approved', OWNER);
      setPolicies(k, org.id, {});
      expect(gov.gateSkillGrant(req(SYSTEM)).allowed).toBe(false);
    });

    it('validates its input and the org', () => {
      expect(codeOf(() => gov.gateSkillGrant({ ...req(lead()), skillId: '' }))).toBe('validation');
      expect(codeOf(() => gov.gateSkillGrant({ ...req(lead()), agentId: '' }))).toBe('validation');
      expect(codeOf(() => gov.gateSkillGrant(req(lead(), 'org_missing')))).toBe('not_found');
    });
  });
});
