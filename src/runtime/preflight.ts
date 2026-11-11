import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Department, Organization } from '../contracts/rows.js';
import type { BudgetStatus, RunSkip, RunSkipCode } from '../contracts/services.js';
import { SYSTEM } from '../contracts/types.js';
import type { RunMode } from './admission.js';
import { effectiveBinding, NATIVE_SKILL_ADAPTERS } from './binding.js';
import type { RunJournal } from './journal.js';
import type { RuntimeDeps } from './types.js';

export const skipOf = (code: RunSkipCode, reason: string, temporary: boolean): RunSkip => ({ code, reason, temporary });

/** True when any dollar cap on the status is already spent. */
export const overCap = (b: BudgetStatus): boolean => b.lines.some((l) => l.capUsd !== null && l.spentUsd >= l.capUsd);

/** Why this agent may not spend right now, or null. Dollar caps stop everyone; the seat-time quota only applies to subscription (local CLI) runs. */
export function budgetBlock(b: BudgetStatus, agent: Agent, org: Organization): RunSkip | null {
  const capped = overCap(b);
  const seatBlocked = !b.seat.allowed && NATIVE_SKILL_ADAPTERS.has(effectiveBinding(agent, org).adapter);
  if (!capped && !seatBlocked) return null;
  return skipOf('over_budget', `over budget: ${b.reason ?? (capped ? 'cap reached' : 'seat-time quota exhausted')}`, true);
}

/** Hourly run allowance for an agent in a mode. Chat and eval have their own (bounded) allowances. */
export function hourlyLimit(agent: Agent, mode: RunMode, options: RuntimeDeps['options'] = {}): number {
  if (mode === 'chat') return options.chatRunsPerHour ?? Math.max(30, agent.maxRunsPerHour * 3);
  if (mode === 'eval') return options.evalRunsPerHour ?? Math.max(20, agent.maxRunsPerHour * 2);
  return agent.maxRunsPerHour;
}

export type Preflight =
  | { ok: true; org: Organization; agent: Agent; dept: Department; budget: BudgetStatus }
  | { ok: false; skip: RunSkip };

/**
 * Step 1 of the loop — "Wake and resolve": everything that can stop a run
 * before any work is looked at. Shared by the executor and by `runNow`, so a
 * manual wake can be told up front that (and why) it will not run.
 */
export function preflight(
  k: Kernel,
  d: RuntimeDeps,
  journal: RunJournal,
  req: { orgId: string; agentId: string; mode: RunMode; projectId?: string | null },
): Preflight {
  const org = d.org.getOrg(req.orgId);
  const agent = d.org.getAgent(req.orgId, req.agentId);
  const dept = d.org.getDept(req.orgId, agent.deptId);
  if (org.status !== 'active') return { ok: false, skip: skipOf('org_archived', 'organization archived', false) };
  if (d.governance.killSwitch.isEngaged(org.id)) return { ok: false, skip: skipOf('kill_switch', 'kill switch engaged', true) };
  if (agent.status !== 'active') {
    const paused = agent.status === 'paused';
    return { ok: false, skip: skipOf(paused ? 'agent_paused' : 'agent_terminated', `agent ${agent.status}${agent.pausedReason ? ` (${agent.pausedReason})` : ''}`, paused) };
  }

  const budget = d.governance.budgets.check(org.id, agent.id, req.projectId ?? null);
  const blocked = budgetBlock(budget, agent, org);
  if (blocked) return { ok: false, skip: blocked };

  const limit = hourlyLimit(agent, req.mode, d.options);
  const lastHour = journal.countSince(agent.id, k.clock.now() - 3_600_000, req.mode);
  if (lastHour >= limit) {
    k.audit.record({ orgId: org.id, actor: SYSTEM, action: 'run.rate_limited', entityKind: 'agent', entityId: agent.id, data: { lastHour, limit, mode: req.mode } });
    const what = req.mode === 'loop' ? 'max runs per hour' : `max ${req.mode} runs per hour`;
    return { ok: false, skip: skipOf('rate_limited', `${what} reached (${limit})`, true) };
  }
  return { ok: true, org, agent, dept, budget };
}
