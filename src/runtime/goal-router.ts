import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Goal } from '../contracts/rows.js';
import { SYSTEM } from '../contracts/types.js';
import type { RuntimeDeps } from './types.js';
import type { Wake } from './wakes.js';

export type WakeFn = (orgId: string, agentId: string, wake: Wake) => string;

/** Audit action recorded each time a goal's owner is woken to plan it (the retry counter). */
export const PLANNING_REQUESTED = 'goal.planning_requested';
/** Planning wakes per goal before the sweep stops retrying and tells the owner. */
export const MAX_PLANNING_ATTEMPTS = 5;
/** Wait before the first retry; doubles each attempt up to the cap. */
export const PLANNING_RETRY_BASE_MS = 15 * 60_000;
export const PLANNING_RETRY_CAP_MS = 6 * 3_600_000;

/** How long after planning attempt number `attempts` (1-based) the next one may start. */
export function planningBackoffMs(attempts: number): number {
  return Math.min(PLANNING_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), PLANNING_RETRY_CAP_MS);
}

/**
 * Goal cascade (PRD: "set a goal, the org breaks it down"). A new goal is
 * routed to the agent who should plan it — the top of the org chart for org
 * goals, the department lead for department goals — and that agent is woken
 * with a planning trigger to decompose it into issues.
 */
export class GoalRouter {
  constructor(
    private readonly k: Kernel,
    private readonly d: RuntimeDeps,
    private readonly wake: WakeFn,
  ) {}

  /** The agent at the top of the org chart: active, reports to nobody (or to nobody active). */
  topOfChart(orgId: string): Agent | null {
    const active = this.d.org.listAgents(orgId, { status: 'active' });
    if (active.length === 0) return null;
    const ids = new Set(active.map((a) => a.id));
    const roots = active.filter((a) => !a.reportsTo || !ids.has(a.reportsTo));
    const leads = new Set(this.d.org.listDepts(orgId).map((dept) => dept.leadAgentId).filter((id): id is string => !!id));
    const rank = (a: Agent) => [leads.has(a.id) ? 0 : 1, -a.autonomyLevel, a.createdAt] as const;
    const sorted = (roots.length > 0 ? roots : active).slice().sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
    });
    return sorted[0] ?? null;
  }

  private deptLead(orgId: string, deptId: string): Agent | null {
    try {
      const lead = this.d.org.leadOf(orgId, deptId);
      return lead && lead.status === 'active' ? lead : null;
    } catch {
      return null;
    }
  }

  /** Who should plan this goal. Department goals fall back to the top of the chart when the department has no lead. */
  pickOwner(goal: Goal): Agent | null {
    if (goal.deptId && goal.level !== 'org') {
      const lead = this.deptLead(goal.orgId, goal.deptId);
      if (lead) return lead;
    }
    return this.topOfChart(goal.orgId);
  }

  /**
   * The org's automatic default goal ("every issue traces to a goal") is a
   * bucket, not something the owner asked for: it is never routed or planned.
   */
  private isDefaultGoal(goal: Goal): boolean {
    return this.k.audit
      .query({ orgId: goal.orgId, entityKind: 'goal', entityId: goal.id, action: 'goal.created', limit: 5 })
      .some((r) => (r.data as Record<string, unknown> | null | undefined)?.default === true);
  }

  /**
   * Give the goal an owner if it has none and wake that owner to plan it.
   * Returns the agent woken, or null (inactive goal, nobody to route to, or
   * the goal already has issues under it).
   */
  route(orgId: string, goalId: string): Agent | null {
    let goal: Goal;
    try {
      goal = this.d.work.getGoal(orgId, goalId);
    } catch {
      return null;
    }
    if (goal.status !== 'active' || this.isDefaultGoal(goal)) return null;
    const org = this.d.org.listOrgs().find((o) => o.id === orgId);
    if (!org) return null; // archived or unknown

    let owner = goal.ownerAgentId ? this.d.org.findAgent(orgId, goal.ownerAgentId) : null;
    if (!owner || owner.status === 'terminated') {
      owner = this.pickOwner(goal);
      if (!owner) {
        this.k.log.info({ orgId, goalId }, 'goal has no agent to route to yet; will retry at the next heartbeat');
        return null;
      }
      this.d.work.updateGoal(orgId, goal.id, { ownerAgentId: owner.id }, SYSTEM);
      this.k.audit.record({
        orgId, actor: SYSTEM, action: 'goal.routed', entityKind: 'goal', entityId: goal.id,
        data: { ownerAgentId: owner.id, level: goal.level, deptId: goal.deptId },
      });
    }
    if (owner.status !== 'active') return null;
    // Already broken down (template seeded issues, or an earlier planning run): nothing to plan.
    if (this.d.work.listIssues(orgId, { goalId: goal.id, limit: 1 }).length > 0) return null;

    const attempt = this.attempts(goal).length + 1;
    this.wake(orgId, owner.id, {
      trigger: 'assignment', goalId: goal.id,
      triggerNote: `You own the goal "${goal.title}". Break it down into issues.`,
    });
    this.k.audit.record({
      orgId, actor: SYSTEM, action: PLANNING_REQUESTED, entityKind: 'goal', entityId: goal.id,
      data: { ownerAgentId: owner.id, attempt },
    });
    return owner;
  }

  /** Planning wakes already sent for this goal, newest first. */
  private attempts(goal: Goal): Array<{ ts: number }> {
    return this.k.audit
      .query({ orgId: goal.orgId, entityKind: 'goal', entityId: goal.id, action: PLANNING_REQUESTED, limit: MAX_PLANNING_ATTEMPTS + 1 })
      .slice()
      .sort((a, b) => b.ts - a.ts);
  }

  /**
   * An owned goal that still has no issues: its planning run failed, was
   * cancelled, or produced nothing. Plan it again — with backoff, and at most
   * `MAX_PLANNING_ATTEMPTS` times, after which the owner (the board) is told once.
   */
  private retryPlanning(goal: Goal): boolean {
    if (goal.status !== 'active' || this.isDefaultGoal(goal)) return false;
    if (this.d.work.listIssues(goal.orgId, { goalId: goal.id, limit: 1 }).length > 0) return false;
    const attempts = this.attempts(goal);
    const last = attempts[0];
    // Never asked (e.g. owner assigned by hand, or it was inactive at the time): route it now.
    if (!last) return this.route(goal.orgId, goal.id) !== null;
    if (attempts.length >= MAX_PLANNING_ATTEMPTS) {
      this.giveUp(goal, attempts.length);
      return false;
    }
    if (this.k.clock.now() - last.ts < planningBackoffMs(attempts.length)) return false;
    return this.route(goal.orgId, goal.id) !== null;
  }

  private giveUp(goal: Goal, attempts: number): void {
    const action = 'goal.planning_abandoned';
    if (this.k.audit.query({ orgId: goal.orgId, entityKind: 'goal', entityId: goal.id, action, limit: 1 }).length > 0) return;
    this.k.audit.record({ orgId: goal.orgId, actor: SYSTEM, action, entityKind: 'goal', entityId: goal.id, data: { attempts, ownerAgentId: goal.ownerAgentId } });
    this.k.bus.emit('notification', {
      orgId: goal.orgId, kind: 'goal', title: `Goal not broken down: ${goal.title}`,
      body: `The goal "${goal.title}" still has no issues after ${attempts} planning attempts, so Conductor stopped retrying. Check its owner's recent runs, or create the first issues yourself.`,
      data: { goalId: goal.id },
    });
  }

  /**
   * Heartbeat sweep: route every active goal of the org that still has no
   * owner, and retry planning for owned goals that still have no issues.
   * Returns the number of planning wakes sent.
   */
  sweep(orgId: string): number {
    let routed = 0;
    for (const goal of this.d.work.listGoals(orgId, { status: 'active' })) {
      try {
        if (goal.ownerAgentId ? this.retryPlanning(goal) : this.route(orgId, goal.id)) routed++;
      } catch (err) {
        this.k.log.warn({ err, orgId, goalId: goal.id }, 'goal routing failed');
      }
    }
    return routed;
  }
}
