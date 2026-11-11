import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Goal } from '../contracts/rows.js';
import { SYSTEM } from '../contracts/types.js';
import type { RuntimeDeps } from './types.js';
import type { Wake } from './wakes.js';

export type WakeFn = (orgId: string, agentId: string, wake: Wake) => string;

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

    this.wake(orgId, owner.id, {
      trigger: 'assignment', goalId: goal.id,
      triggerNote: `You own the goal "${goal.title}". Break it down into issues.`,
    });
    return owner;
  }

  /** Heartbeat sweep: route every active goal of the org that still has no owner. */
  sweep(orgId: string): number {
    let routed = 0;
    for (const goal of this.d.work.listGoals(orgId, { status: 'active' })) {
      if (goal.ownerAgentId) continue;
      try {
        if (this.route(orgId, goal.id)) routed++;
      } catch (err) {
        this.k.log.warn({ err, orgId, goalId: goal.id }, 'goal routing failed');
      }
    }
    return routed;
  }
}
