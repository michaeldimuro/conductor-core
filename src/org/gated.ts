import type { Actor } from '../contracts/types.js';
import type { Agent, Approval } from '../contracts/rows.js';
import type { HireAgentInput } from '../contracts/org-work.js';
import { errorMessage } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/util.js';
import type { Ctx } from './context.js';
import { insertAgent, requireLeadActor, terminateCore, validateHire } from './agents.js';
import { requireActiveOrg, requireAgent, requireOrg } from './repo.js';
import { hireAgentSchema, parse } from './schemas.js';

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

  if (!ctx.deps.approvals.requiresApproval(orgId, 'hire_agent')) {
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
export function terminateAgent(ctx: Ctx, orgId: string, agentId: string, actor: Actor): Gated {
  const k = ctx.kernel;
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
    payload: { matchKey, context: CONTEXT, agentId, requestedBy: requester.id },
    requesterAgentId: requester.id,
    runId: actor.runId ?? null,
  });
  k.audit.record({
    orgId,
    actor,
    action: 'agent.termination_requested',
    entityKind: 'approval',
    entityId: approval.id,
    data: { agentId },
  });
  return { approval };
}

/**
 * Bus handler for `approval.decided`. Executes an approved hire/termination
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
  if (decided.kind !== 'hire_agent' && decided.kind !== 'terminate_agent') return;
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
