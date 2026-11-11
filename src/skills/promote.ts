import { z } from 'zod';
import type { Scope } from '../db/schema/index.js';
import type { Approval, Skill } from '../contracts/rows.js';
import type { Actor } from '../contracts/types.js';
import { SYSTEM } from '../contracts/types.js';
import type { DomainEvents } from '../shared/events.js';
import { conflict, errorMessage, forbidden, invalid, notFound } from '../shared/errors.js';
import { copySkillDir } from './format.js';
import { driftOf } from './lifecycle.js';
import { authorAgentId, type SkillCtx } from './store.js';

const WIDTH: Record<Scope, number> = { agent: 0, dept: 1, org: 2, global: 3 };
const COPY_LIMITS = { maxFiles: 500, maxBytes: 20 * 1024 * 1024 };

const approvalPayload = z.object({
  matchKey: z.string(),
  skillId: z.string(),
  toScope: z.enum(['org', 'global']),
  contentHash: z.string(),
});

interface Destination {
  orgId: string | null;
  scope: Scope;
  scopeId: string | null;
}

function destinationOf(ctx: SkillCtx, skill: Skill, toScope: Scope): Destination {
  if (!(toScope in WIDTH)) throw invalid(`unknown scope: ${String(toScope)}`);
  if (WIDTH[toScope] <= WIDTH[skill.scope]) throw invalid(`a ${skill.scope}-scoped skill can only be promoted to a wider scope`);
  if (!skill.orgId) throw invalid('global skills cannot be promoted');
  if (toScope === 'global') return { orgId: null, scope: 'global', scopeId: null };
  if (toScope === 'org') return { orgId: skill.orgId, scope: 'org', scopeId: skill.orgId };
  // dept: only from an agent's own scope, into that agent's department
  const owner = ctx.deps.org.getAgent(skill.orgId, skill.scopeId as string);
  return { orgId: skill.orgId, scope: 'dept', scopeId: owner.deptId };
}

const evalPassed = (ctx: SkillCtx, skill: Skill): boolean => ctx.store.version(skill.id, skill.version)?.eval?.passed === true;

/** Copy the skill into the wider scope as its own row (or a new version of the row already there). Holds no lock itself. */
async function copyToScope(ctx: SkillCtx, source: Skill, dest: Destination, actor: Actor, extraAudit: Record<string, unknown> = {}): Promise<Skill> {
  const drift = driftOf(source);
  if (drift) {
    ctx.writer.changeStatus(source, 'quarantined', SYSTEM, drift.reason, { actual: drift.actual });
    throw conflict('skill folder does not match its recorded hash; quarantined instead of promoted', { skillId: source.id });
  }
  const target = ctx.store.target(dest.orgId, dest.scope, dest.scopeId, source.name);
  const existing = ctx.store.findInScope(target.scope, target.scopeId, target.name);
  const ev = ctx.store.version(source.id, source.version)?.eval ?? null;
  const agentWritten = authorAgentId(source.author) !== null;
  const promoted = await ctx.writer.commit({
    existing,
    target,
    mutate: (dir) => copySkillDir(source.path, dir, COPY_LIMITS),
    actor,
    change: 'promote',
    message: `promote ${source.name} from ${source.scope} to ${dest.scope} scope`,
    decideStatus: ({ blocked }) => (blocked ? (agentWritten ? 'quarantined' : 'draft') : 'active'),
    create: { author: source.author, source: `promoted:${source.id}`, evalScore: source.evalScore },
    versionEval: ev,
    extraAudit: { fromSkillId: source.id, fromScope: source.scope, fromVersion: source.version, ...extraAudit },
  });
  ctx.kernel.audit.record({
    orgId: source.orgId,
    actor,
    action: 'skill.promoted',
    entityKind: 'skill',
    entityId: source.id,
    runId: actor.runId,
    data: { name: source.name, fromScope: source.scope, toScope: dest.scope, toSkillId: promoted.id, toVersion: promoted.version, ...extraAudit },
  });
  return promoted;
}

/**
 * Promote to a wider scope.
 *  - department: humans, the department's lead agent, or the owning agent when
 *    the org policy is `deptSkillPromotion: 'auto'` and the eval passed;
 *  - org / global: humans directly; agents get a `promote_skill` Approval that
 *    is executed on `approval.decided`. Agents can only ever *propose* into global.
 */
export async function promote(ctx: SkillCtx, skillId: string, toScope: Scope, actor: Actor): Promise<{ skill?: Skill; approval?: Approval }> {
  const skill = ctx.store.get(skillId);
  const acting = actor.kind === 'agent' ? ctx.store.actorAgent(skill.orgId, actor) : null;
  if (actor.kind === 'agent' && !acting) throw notFound('skill', skillId);
  const dest = destinationOf(ctx, skill, toScope);
  if (skill.status !== 'active') throw conflict(`only an active skill can be promoted (status: ${skill.status})`);
  const orgId = skill.orgId as string;
  const policies = ctx.deps.org.getOrg(orgId).policies ?? {};

  if (acting) {
    const ownerDeptId = skill.scope === 'agent' ? ctx.deps.org.getAgent(orgId, skill.scopeId as string).deptId : skill.scope === 'dept' ? skill.scopeId : null;
    const isOwner = skill.scope === 'agent' && skill.scopeId === acting.id;
    const isLead = ownerDeptId !== null && ctx.deps.org.leadOf(orgId, ownerDeptId)?.id === acting.id;

    if (dest.scope === 'dept') {
      const auto = policies.deptSkillPromotion === 'auto' && isOwner && evalPassed(ctx, skill);
      if (!isLead && !auto) throw forbidden('department promotion is reviewed by the department lead');
    } else {
      if (!isOwner && !isLead) throw forbidden('only the owning agent or its department lead may propose this promotion');
      const gated = dest.scope === 'global' || (policies.ownerApprovesOrgSkillPromotion !== false && ctx.deps.approvals.requiresApproval(orgId, 'promote_skill'));
      if (gated) {
        const matchKey = `promote_skill:${skill.id}:${dest.scope}:${skill.contentHash}`;
        const open = ctx.deps.approvals.findOpen(orgId, 'promote_skill', matchKey);
        if (open) return { approval: open };
        const approval = ctx.deps.approvals.request({
          orgId,
          kind: 'promote_skill',
          title: `Promote skill "${skill.name}" to ${dest.scope} scope`,
          payload: { matchKey, skillId: skill.id, toScope: dest.scope, contentHash: skill.contentHash, name: skill.name, fromScope: skill.scope, version: skill.version, evalScore: skill.evalScore },
          requesterAgentId: acting.id,
          runId: actor.runId ?? null,
        });
        ctx.kernel.audit.record({
          orgId,
          actor,
          action: 'skill.promotion_requested',
          entityKind: 'skill',
          entityId: skill.id,
          runId: actor.runId,
          data: { name: skill.name, toScope: dest.scope, approvalId: approval.id },
        });
        return { approval };
      }
    }
  }

  const promoted = await ctx.git.exclusive(async () => {
    const fresh = ctx.store.get(skillId);
    if (fresh.status !== 'active') throw conflict(`only an active skill can be promoted (status: ${fresh.status})`);
    return copyToScope(ctx, fresh, dest, actor);
  });
  return { skill: promoted };
}

/** Execute an approved `promote_skill` approval (single use, bound to the content that was reviewed). */
export async function onApprovalDecided(ctx: SkillCtx, event: DomainEvents['approval.decided']): Promise<void> {
  if (event.status !== 'approved') return;
  let approval: Approval;
  try {
    approval = ctx.deps.approvals.get(event.orgId, event.approvalId);
  } catch {
    return;
  }
  if (approval.kind !== 'promote_skill' || approval.orgId !== event.orgId) return;
  const parsed = approvalPayload.safeParse(approval.payload);
  if (!parsed.success) return;
  const { matchKey, skillId, toScope, contentHash } = parsed.data;
  const skip = (reason: string): void => {
    ctx.kernel.audit.record({ orgId: event.orgId, actor: SYSTEM, action: 'skill.promotion_skipped', entityKind: 'skill', entityId: skillId, data: { approvalId: approval.id, toScope, reason } });
  };

  await ctx.git.exclusive(async () => {
    let skill: Skill;
    try {
      skill = ctx.store.get(skillId);
    } catch {
      return skip('skill no longer exists');
    }
    if (skill.orgId !== event.orgId) return skip('skill belongs to another org');
    if (skill.status !== 'active') return skip(`skill is ${skill.status}`);
    if (skill.contentHash !== contentHash) return skip('skill changed after the approval was requested');
    const consumed = ctx.deps.approvals.consume(event.orgId, 'promote_skill', matchKey);
    if (!consumed) return;
    const actor: Actor = approval.requesterAgentId ? { kind: 'agent', id: approval.requesterAgentId, runId: approval.runId ?? undefined } : SYSTEM;
    try {
      await copyToScope(ctx, skill, destinationOf(ctx, skill, toScope), actor, { approvalId: approval.id, approvedBy: approval.decidedBy ?? null });
    } catch (e) {
      skip(`promotion failed: ${errorMessage(e)}`);
      throw e;
    }
  });
}

/**
 * `deptSkillPromotion: 'auto'`: an agent-authored skill that just became
 * active on an eval win is copied to its department without lead review.
 * Never overwrites a department skill that did not originate from it.
 */
export async function autoPromoteToDept(ctx: SkillCtx, skill: Skill): Promise<void> {
  if (skill.scope !== 'agent' || !skill.orgId || skill.status !== 'active' || authorAgentId(skill.author) === null) return;
  try {
    if ((ctx.deps.org.getOrg(skill.orgId).policies ?? {}).deptSkillPromotion !== 'auto' || !evalPassed(ctx, skill)) return;
    const dest = destinationOf(ctx, skill, 'dept');
    await ctx.git.exclusive(async () => {
      const fresh = ctx.store.get(skill.id);
      if (fresh.status !== 'active') return;
      const existing = ctx.store.findInScope('dept', dest.scopeId, fresh.name);
      if (existing && existing.source !== `promoted:${fresh.id}`) return;
      await copyToScope(ctx, fresh, dest, SYSTEM, { auto: true });
    });
  } catch (e) {
    ctx.kernel.log.warn({ skillId: skill.id, err: errorMessage(e) }, 'automatic department promotion failed');
  }
}
