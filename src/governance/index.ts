import type { Kernel } from '../contracts/kernel.js';
import type { Approval } from '../contracts/rows.js';
import type { Governance } from '../contracts/services.js';
import { SYSTEM } from '../contracts/types.js';
import { Approvals, expireApprovals } from './approvals.js';
import { BudgetEnforcer } from './budget-enforcer.js';
import { SpendReader } from './budget-lines.js';
import { BudgetRaiseHandler } from './budget-raise.js';
import { Budgets } from './budgets.js';
import { KillSwitchService } from './kill-switch.js';
import { gateSkillGrant, type SkillGrantDecision, type SkillGrantRequest } from './skill-grant.js';
import { requireOrg, SettingsStore } from './store.js';
import { Tokens } from './tokens.js';

export interface GovernanceHandle extends Governance {
  /**
   * Scheduler hook: expire pending approvals past `expiresAt` and approved single-use grants left
   * unused past the org's use-by window (audited, announced with `approval.expired`). Returns them.
   */
  expireApprovals(now?: number): Approval[];
  /**
   * Resume agents paused with reason `budget` that are under every cap again
   * (e.g. after the monthly window rolls over). Returns resumed agent ids.
   */
  resumeBudgetPaused(orgId: string): string[];
  /** The `grant_skill` approval gate for whoever assigns skills to agents (see `gateSkillGrant`). */
  gateSkillGrant(req: SkillGrantRequest): SkillGrantDecision;
  /** Detach bus subscriptions (the `budget_raise` approval handler). */
  dispose(): void;
}

/** Governance context: approvals, budgets, kill switches, API tokens. */
export function createGovernance(kernel: Kernel): GovernanceHandle {
  const settings = new SettingsStore(kernel);
  const spend = new SpendReader(kernel);
  const enforcer = new BudgetEnforcer(kernel, spend, settings);
  const detach = new BudgetRaiseHandler(kernel, enforcer).attach();

  const approvals = new Approvals(kernel);
  return {
    approvals,
    budgets: new Budgets(kernel, spend, enforcer),
    killSwitch: new KillSwitchService(kernel, settings),
    tokens: new Tokens(kernel),
    expireApprovals: (now) => expireApprovals(kernel, now),
    resumeBudgetPaused: (orgId) => enforcer.resumeUnderCap(requireOrg(kernel, orgId), SYSTEM),
    gateSkillGrant: (req) => gateSkillGrant(approvals, req),
    dispose: detach,
  };
}

export { expireApprovals } from './approvals.js';
export { gateSkillGrant, skillGrantMatchKey, SKILL_GRANT_SOURCE, type SkillGrantDecision, type SkillGrantRequest } from './skill-grant.js';
export { GLOBAL_KILL_SWITCH_KEY } from './kill-switch.js';
