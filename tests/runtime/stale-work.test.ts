import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { createGovernance, type GovernanceHandle } from '../../src/governance/index.js';
import { createOrgService } from '../../src/org/index.js';
import { createWorkService } from '../../src/work/index.js';
import { STALL_NUDGED, sweepStaleWork } from '../../src/runtime/stale-work.js';
import { blockedOnOwner } from '../../src/work/owner-blocks.js';
import type { RuntimeDeps } from '../../src/runtime/types.js';
import type { Wake } from '../../src/runtime/wakes.js';
import type { OrgService, WorkService } from '../../src/contracts/org-work.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { OWNER, SYSTEM } from '../../src/contracts/types.js';
import type { DomainEvents } from '../../src/shared/events.js';
import { issues } from '../../src/db/schema/index.js';

const HOUR = 3_600_000;

interface Rig {
  k: TestKernel;
  governance: GovernanceHandle;
  org: OrgService;
  work: WorkService;
  acme: Organization;
  /** Ada reports to Max; Max is at the top of the line. */
  max: Agent;
  ada: Agent;
  bea: Agent;
  wakes: Array<{ agentId: string; wake: Wake }>;
  notes: Array<DomainEvents['notification']>;
  sweep(): ReturnType<typeof sweepStaleWork>;
}

function rig(): Rig {
  const k = createTestKernel();
  const governance = createGovernance(k);
  const org = createOrgService(k, { approvals: governance.approvals });
  const work = createWorkService(k, { org });
  const acme = org.createOrg({ name: 'Acme', defaultProvider: { adapter: 'fake', model: 'fake-1' } }, OWNER);
  const dept = org.createDept(acme.id, { name: 'Engineering' }, OWNER);
  const hire = (name: string, reportsTo: string | null = null) =>
    org.hireAgent(acme.id, { deptId: dept.id, name, role: 'Engineer', autonomyLevel: 2, reportsTo }, OWNER).agent!;
  const max = hire('Max');
  const ada = hire('Ada', max.id);
  const bea = hire('Bea', max.id);
  const wakes: Rig['wakes'] = [];
  const notes: Rig['notes'] = [];
  k.bus.on('notification', (n) => void notes.push(n));
  const deps = { org, work, governance } as unknown as RuntimeDeps;
  return {
    k, governance, org, work, acme, max, ada, bea, wakes, notes,
    sweep: () => sweepStaleWork(k, deps, (_orgId, agentId, wake) => void wakes.push({ agentId, wake })),
  };
}

describe('stale-work sweep', () => {
  let r: Rig;
  afterEach(() => {
    r.governance.dispose();
    r.k.dispose();
  });

  it('nudges the assignee once, then moves the work to its manager, then to the owner', () => {
    r = rig();
    const issue = r.work.createIssue(r.acme.id, { title: 'Write the launch post', assigneeAgentId: r.ada.id, status: 'todo' }, OWNER);

    r.k.clock.advance(23 * HOUR);
    expect(r.sweep()).toEqual({ nudged: [], escalated: [] });

    r.k.clock.advance(2 * HOUR);
    expect(r.sweep().nudged).toEqual([issue.id]);
    expect(r.wakes).toEqual([{ agentId: r.ada.id, wake: expect.objectContaining({ issueId: issue.id, trigger: 'assignment' }) }]);
    expect(r.k.audit.query({ issueId: issue.id, action: STALL_NUDGED })).toHaveLength(1);

    // Nudged: nothing more until a full window has passed since the nudge.
    r.k.clock.advance(12 * HOUR);
    expect(r.sweep()).toEqual({ nudged: [], escalated: [] });

    r.k.clock.advance(13 * HOUR);
    expect(r.sweep().escalated).toEqual([issue.id]);
    const withMax = r.work.getIssue(r.acme.id, issue.id);
    expect(withMax).toMatchObject({ assigneeAgentId: r.max.id, status: 'todo' });
    expect(r.wakes.at(-1)).toEqual({ agentId: r.max.id, wake: expect.objectContaining({ issueId: issue.id }) });

    // The escalation is progress: Max gets a fresh window, a nudge, then the owner.
    r.k.clock.advance(25 * HOUR);
    expect(r.sweep().nudged).toEqual([issue.id]);
    r.k.clock.advance(25 * HOUR);
    expect(r.sweep().escalated).toEqual([issue.id]);
    const withOwner = r.work.getIssue(r.acme.id, issue.id);
    expect(withOwner).toMatchObject({ status: 'blocked', blockedReason: 'escalated_to_owner' });
    expect(blockedOnOwner(withOwner, [], { approvalIssues: new Set(), takeoverIssues: new Set() })).toBe(true);
    expect(r.notes.some((n) => n.kind === 'issue.escalated')).toBe(true);

    // Owner's court now: the sweep leaves it alone.
    r.k.clock.advance(100 * HOUR);
    expect(r.sweep()).toEqual({ nudged: [], escalated: [] });
  });

  it('allows less idle time for urgent work', () => {
    r = rig();
    const urgent = r.work.createIssue(r.acme.id, { title: 'Site is down', assigneeAgentId: r.ada.id, priority: 0 }, OWNER);
    r.work.createIssue(r.acme.id, { title: 'Tidy the wiki', assigneeAgentId: r.ada.id, priority: 3 }, OWNER);
    r.k.clock.advance(3 * HOUR);
    expect(r.sweep().nudged).toEqual([urgent.id]);
  });

  it('counts comments and changes as progress, but not a run that changed nothing', () => {
    r = rig();
    const issue = r.work.createIssue(r.acme.id, { title: 'Research pricing', assigneeAgentId: r.ada.id }, OWNER);
    r.k.clock.advance(20 * HOUR);
    r.work.addComment(r.acme.id, issue.id, { body: 'Halfway through the competitor list.' }, { kind: 'agent', id: r.ada.id });
    r.k.clock.advance(20 * HOUR);
    expect(r.sweep().nudged).toEqual([]);

    const actor = { kind: 'agent' as const, id: r.ada.id };
    r.k.audit.record({ orgId: r.acme.id, actor, action: 'issue.checked_out', entityKind: 'issue', entityId: issue.id, issueId: issue.id });
    r.k.audit.record({ orgId: r.acme.id, actor, action: 'issue.released', entityKind: 'issue', entityId: issue.id, issueId: issue.id, data: { changes: { checkoutLock: { from: 'run_1', to: null } } } });
    r.k.clock.advance(5 * HOUR);
    expect(r.sweep().nudged).toEqual([issue.id]);
  });

  it('skips work a run holds, blocked work, the owner\'s reviews and orgs behind the kill switch', () => {
    r = rig();
    const held = r.work.createIssue(r.acme.id, { title: 'Held', assigneeAgentId: r.ada.id }, OWNER);
    r.k.db.update(issues).set({ checkoutLock: 'run_live' }).where(eq(issues.id, held.id)).run();
    const blocked = r.work.createIssue(r.acme.id, { title: 'Blocked', assigneeAgentId: r.ada.id }, OWNER);
    r.work.updateIssue(r.acme.id, blocked.id, { status: 'blocked', blockedReason: 'waiting_on_children' }, OWNER);
    const ownerReview = r.work.createIssue(r.acme.id, { title: 'Owner review', assigneeAgentId: r.ada.id }, OWNER);
    r.work.updateIssue(r.acme.id, ownerReview.id, { status: 'in_review' }, OWNER);
    r.k.clock.advance(100 * HOUR);
    expect(r.sweep()).toEqual({ nudged: [], escalated: [] });

    const other = r.work.createIssue(r.acme.id, { title: 'Normal', assigneeAgentId: r.ada.id }, OWNER);
    r.governance.killSwitch.engage(r.acme.id, OWNER);
    r.k.clock.advance(100 * HOUR);
    expect(r.sweep().nudged).not.toContain(other.id);
  });

  it('moves work of a paused agent up without a nudge, but leaves a budget pause to the owner', () => {
    r = rig();
    const issue = r.work.createIssue(r.acme.id, { title: 'Ship the fix', assigneeAgentId: r.ada.id }, OWNER);
    const budget = r.work.createIssue(r.acme.id, { title: 'Expensive task', assigneeAgentId: r.bea.id }, OWNER);
    r.org.pauseAgent(r.acme.id, r.ada.id, 'on leave', OWNER);
    r.org.pauseAgent(r.acme.id, r.bea.id, 'budget', OWNER);
    r.k.clock.advance(25 * HOUR);
    const res = r.sweep();
    expect(res).toEqual({ nudged: [], escalated: [issue.id] });
    expect(r.work.getIssue(r.acme.id, issue.id).assigneeAgentId).toBe(r.max.id);
    expect(r.work.getIssue(r.acme.id, budget.id).assigneeAgentId).toBe(r.bea.id);
  });

  it('sends unassigned work that nobody picks up to the owner', () => {
    r = rig();
    const issue = r.work.createIssue(r.acme.id, { title: 'Nobody owns this', status: 'todo' }, OWNER);
    r.k.clock.advance(25 * HOUR);
    expect(r.sweep().escalated).toEqual([issue.id]);
    expect(r.work.getIssue(r.acme.id, issue.id)).toMatchObject({ status: 'blocked', blockedReason: 'escalated_to_owner' });
  });

  it('nudges a stalled agent reviewer, then moves the review to its manager, then to the owner', () => {
    r = rig();
    const issue = r.work.createIssue(r.acme.id, { title: 'Landing page copy', assigneeAgentId: r.ada.id, reviewerAgentId: r.bea.id }, OWNER);
    r.work.updateIssue(r.acme.id, issue.id, { status: 'in_review' }, SYSTEM);

    r.k.clock.advance(25 * HOUR);
    expect(r.sweep().nudged).toEqual([issue.id]);
    expect(r.wakes.at(-1)!.agentId).toBe(r.bea.id);

    r.k.clock.advance(25 * HOUR);
    expect(r.sweep().escalated).toEqual([issue.id]);
    expect(r.work.getIssue(r.acme.id, issue.id)).toMatchObject({ status: 'in_review', reviewerAgentId: r.max.id, assigneeAgentId: r.ada.id });
    expect(r.wakes.at(-1)!.agentId).toBe(r.max.id);

    r.k.clock.advance(25 * HOUR);
    r.sweep(); // Max is nudged
    r.k.clock.advance(25 * HOUR);
    expect(r.sweep().escalated).toEqual([issue.id]);
    expect(r.work.getIssue(r.acme.id, issue.id)).toMatchObject({ status: 'in_review', reviewerAgentId: null });
    expect(r.notes.at(-1)).toMatchObject({ kind: 'issue.escalated', data: { issueId: issue.id } });
  });
});
