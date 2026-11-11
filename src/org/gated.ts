import type { Actor } from '../contracts/types.js';
import type { Agent, Approval, Department } from '../contracts/rows.js';
import type { BudgetChangeInput, HireAgentInput } from '../contracts/org-work.js';
import { conflict, errorMessage, forbidden } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/util.js';
import type { Ctx } from './context.js';
import { insertAgent, persistAgent, requireLeadActor, terminateCore, validateHire } from './agents.js';
import { isAbove } from './chart.js';
import { persistDept } from './departments.js';
import { findAgentRow, requireActiveOrg, requireAgent, requireDept, requireOrg } from './repo.js';
import { budgetChangeSchema, hireAgentSchema, parse, reasonSchema, type BudgetChangeParsed } from './schemas.js';
import { applySkillGrant, skillGrantSchema } from './skill-grants.js';

/** Marks approvals filed by this context so we only ever execute our own. */
const CONTEXT = 'org';

type Gated = { agent?: Agent; approval?: Approval };

/**
 * Human/system actors hire directly. An agent actor must be a Lead
 * (autonomy 3); its hire becomes a `hire_agent` approval carrying the full
 * input, executed by `onApprovalDecided` once the board approves.
 */
export function hireAgent(ctx: Ctx, orgId: string, raw: HireAgentInput, actor: Actor): Gated {
  const k = ctx.kernel;
  const parsed = parse(hireAgentSchema, raw, 'agent');
  if (actor.kind !== 'agent') {
    return { agent: ctx.mutate(() => insertAgent(ctx, requireActiveOrg(k, orgId), parsed, actor)) };
  }

  const org = requireActiveOrg(k, orgId);
  const requester = requireLeadActor(ctx, orgId, actor, 'propose hires');
  // A lead's hire joins its own reporting line unless it says otherwise.
  const input = { ...parsed, reportsTo: parsed.reportsTo === undefined ? requester.id : parsed.reportsTo };
  const dept = validateHire(ctx, orgId, input);

  // A hire that comes with skills is also a skill grant: either gate sends it to the board.
  const grantsSkills = (input.skills?.length ?? 0) > 0 && ctx.deps.approvals.requiresApproval(orgId, 'grant_skill');
  if (!ctx.deps.approvals.requiresApproval(orgId, 'hire_agent') && !grantsSkills) {
    return { agent: ctx.mutate(() => insertAgent(ctx, org, input, actor)) };
  }
  const matchKey = `hire_agent:${sha256(stableStringify({ by: requester.id, input }))}`;
  const open = ctx.deps.approvals.findOpen(orgId, 'hire_agent', matchKey);
  if (open) return { approval: open };

  const approval = ctx.deps.approvals.request({
    orgId,
    kind: 'hire_agent',
    title: `Hire ${input.name} (${input.role}) into ${dept.name}`,
    payload: { matchKey, context: CONTEXT, input, requestedBy: requester.id },
    requesterAgentId: requester.id,
    runId: actor.runId ?? null,
  });
  k.audit.record({
    orgId,
    actor,
    action: 'agent.hire_requested',
    entityKind: 'approval',
    entityId: approval.id,
    data: { name: input.name, role: input.role, deptId: dept.id },
  });
  return { approval };
}

/** Same gate as hiring: direct for the owner, approval-gated for Lead agents. */
export function terminateAgent(ctx: Ctx, orgId: string, agentId: string, actor: Actor, opts: { reason?: string } = {}): Gated {
  const k = ctx.kernel;
  const reason = opts.reason === undefined ? undefined : parse(reasonSchema, opts.reason, 'termination reason');
  requireOrg(k, orgId);
  if (actor.kind !== 'agent') {
    return { agent: ctx.mutate(() => terminateCore(ctx, orgId, agentId, actor)) };
  }

  const requester = requireLeadActor(ctx, orgId, actor, 'propose terminations');
  const target = requireAgent(k, orgId, agentId);
  if (target.status === 'terminated') return { agent: target };

  if (!ctx.deps.approvals.requiresApproval(orgId, 'terminate_agent')) {
    return { agent: ctx.mutate(() => terminateCore(ctx, orgId, agentId, actor)) };
  }
  const matchKey = `terminate_agent:${agentId}`;
  const open = ctx.deps.approvals.findOpen(orgId, 'terminate_agent', matchKey);
  if (open) return { approval: open };

  const approval = ctx.deps.approvals.request({
    orgId,
    kind: 'terminate_agent',
    title: `Terminate ${target.name} (${target.role})`,
    payload: { matchKey, context: CONTEXT, agentId, requestedBy: requester.id, ...(reason ? { reason } : {}) },
    requesterAgentId: requester.id,
    runId: actor.runId ?? null,
  });
  k.audit.record({
    orgId,
    actor,
    action: 'agent.termination_requested',
    entityKind: 'approval',
    entityId: approval.id,
    data: { agentId, ...(reason ? { reason } : {}) },
  });
  return { approval };
}

type BudgetResult = { agent?: Agent; department?: Department; approval?: Approval };

const usdLabel = (v: number | null): string => (v === null ? 'no cap' : `$${v}/month`);

/** Write the new cap + revision + audit + `budget.updated`. Call inside `ctx.mutate`. */
function applyBudget(ctx: Ctx, orgId: string, input: BudgetChangeParsed, actor: Actor, audit: Record<string, unknown> = {}): BudgetResult {
  const k = ctx.kernel;
  const data = { change: 'budget', budgetUsd: input.budgetUsd, ...(input.reason ? { reason: input.reason } : {}), ...audit };
  if (input.scope === 'dept') {
    const dept = requireDept(k, orgId, input.id);
    return { department: persistDept(ctx, dept, { budgetUsd: input.budgetUsd }, actor, `budget set to ${usdLabel(input.budgetUsd)}`, data) };
  }
  const agent = requireAgent(k, orgId, input.id);
  if (agent.status === 'terminated') throw conflict(`agent ${agent.slug} is terminated`);
  return {
    agent: persistAgent(ctx, agent, { budgetUsd: input.budgetUsd }, actor, {
      action: 'config.changed', note: `budget set to ${usdLabel(input.budgetUsd)}`, event: 'agent.updated', data,
    }),
  };
}

/**
 * Budget changes (PRD "Approvals": raising a budget is board-gated). The owner
 * changes a budget directly. A Lead (autonomy 3) may propose one for itself,
 * an agent below it, or a department in its reporting line; the proposal is a
 * `budget_raise` approval and is applied by `onApprovalDecided`.
 */
export function proposeBudgetChange(ctx: Ctx, orgId: string, raw: BudgetChangeInput, actor: Actor): BudgetResult {
  const k = ctx.kernel;
  const input = parse(budgetChangeSchema, raw, 'budget change');
  requireActiveOrg(k, orgId);
  if (actor.kind !== 'agent') return ctx.mutate(() => applyBudget(ctx, orgId, input, actor));

  const requester = requireLeadActor(ctx, orgId, actor, 'propose budget changes');
  let name: string;
  let current: number | null;
  if (input.scope === 'agent') {
    const target = requireAgent(k, orgId, input.id);
    if (target.status === 'terminated') throw conflict(`agent ${target.slug} is terminated`);
    if (target.id !== requester.id && !isAbove(k, orgId, requester.id, target.id)) {
      throw forbidden(`agent ${requester.slug} may only propose budgets for itself or its own reports`);
    }
    name = target.name;
    current = target.budgetUsd;
    if (current === input.budgetUsd) return { agent: target };
  } else {
    const dept = requireDept(k, orgId, input.id);
    const lead = dept.leadAgentId ? findAgentRow(k, orgId, dept.leadAgentId) : undefined;
    const inLine = dept.id === requester.deptId || lead?.id === requester.id || (lead !== undefined && isAbove(k, orgId, requester.id, lead.id));
    if (!inLine) throw forbidden(`agent ${requester.slug} may only propose budgets for departments in its reporting line`);
    name = dept.name;
    current = dept.budgetUsd;
    if (current === input.budgetUsd) return { department: dept };
  }

  if (!ctx.deps.approvals.requiresApproval(orgId, 'budget_raise', { amountUsd: input.budgetUsd ?? undefined })) {
    return ctx.mutate(() => applyBudget(ctx, orgId, input, actor));
  }
  const matchKey = `budget_raise:${input.scope}:${input.id}:${input.budgetUsd ?? 'none'}`;
  const open = ctx.deps.approvals.findOpen(orgId, 'budget_raise', matchKey);
  if (open) return { approval: open };

  const approval = ctx.deps.approvals.request({
    orgId,
    kind: 'budget_raise',
    title: `Set ${name} budget to ${usdLabel(input.budgetUsd)} (now ${usdLabel(current)})`,
    payload: { matchKey, context: CONTEXT, input, previousUsd: current, requestedBy: requester.id },
    requesterAgentId: requester.id,
    runId: actor.runId ?? null,
  });
  k.audit.record({
    orgId,
    actor,
    action: 'budget.change_requested',
    entityKind: 'approval',
    entityId: approval.id,
    data: { scope: input.scope, id: input.id, budgetUsd: input.budgetUsd, previousUsd: current },
  });
  return { approval };
}

/**
 * Bus handler for `approval.decided`. Executes an approved hire/termination/budget change/skill grant
 * that this context filed, exactly once: `approvals.consume` is the single-use
 * guard, so replays and duplicate events are no-ops.
 */
export function onApprovalDecided(
  ctx: Ctx,
  event: { orgId: string; approvalId: string; status: 'approved' | 'denied' },
): void {
  if (event.status !== 'approved') return;
  const k = ctx.kernel;
  let decided: Approval;
  try {
    decided = ctx.deps.approvals.get(event.orgId, event.approvalId);
  } catch {
    return;
  }
  if (decided.orgId !== event.orgId) return;
  if (decided.kind !== 'hire_agent' && decided.kind !== 'terminate_agent' && decided.kind !== 'budget_raise' && decided.kind !== 'grant_skill') return;
  const matchKey = decided.payload.matchKey;
  if (decided.payload.context !== CONTEXT || typeof matchKey !== 'string') return;

  const approval = ctx.deps.approvals.consume(event.orgId, decided.kind, matchKey);
  if (!approval) return;

  const requestedBy = typeof approval.payload.requestedBy === 'string' ? approval.payload.requestedBy : approval.requesterAgentId;
  const actor: Actor = requestedBy ? { kind: 'agent', id: requestedBy } : { kind: 'system', id: 'conductor' };
  const audit = { approvalId: approval.id, decidedBy: approval.decidedBy };
  try {
    if (approval.kind === 'hire_agent') {
      const input = parse(hireAgentSchema, approval.payload.input, 'approved hire');
      ctx.mutate(() => insertAgent(ctx, requireActiveOrg(k, event.orgId), input, actor, { audit }));
    } else if (approval.kind === 'grant_skill') {
      const input = parse(skillGrantSchema, approval.payload.input, 'approved skill grant');
      ctx.mutate(() => applySkillGrant(ctx, event.orgId, input, actor, audit));
    } else if (approval.kind === 'budget_raise') {
      const input = parse(budgetChangeSchema, approval.payload.input, 'approved budget change');
      ctx.mutate(() => applyBudget(ctx, event.orgId, input, actor, audit));
    } else {
      const agentId = approval.payload.agentId;
      if (typeof agentId !== 'string') throw new Error('approval payload has no agentId');
      ctx.mutate(() => terminateCore(ctx, event.orgId, agentId, actor, audit));
    }
  } catch (err) {
    const reason = errorMessage(err);
    k.log.error({ err, approvalId: approval.id }, 'approved org action failed');
    k.audit.record({
      orgId: event.orgId,
      actor,
      action: 'approval.execution_failed',
      entityKind: 'approval',
      entityId: approval.id,
      data: { kind: approval.kind, reason },
    });
    k.bus.emit('notification', {
      orgId: event.orgId,
      kind: 'approval.execution_failed',
      title: `Approved action could not be completed: ${approval.title}`,
      body: reason,
      data: { approvalId: approval.id },
    });
  }
}
