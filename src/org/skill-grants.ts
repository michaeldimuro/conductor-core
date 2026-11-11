import { and, eq, isNull, notInArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { skills } from '../db/schema/index.js';
import type { Actor } from '../contracts/types.js';
import type { Agent, Approval, Department, Organization } from '../contracts/rows.js';
import type { SkillGrantInput } from '../contracts/org-work.js';
import { conflict, forbidden, notFound } from '../shared/errors.js';
import type { Ctx } from './context.js';
import { persistAgent, requireLeadActor } from './agents.js';
import { isAbove } from './chart.js';
import { persistDept } from './departments.js';
import { persistOrg } from './orgs.js';
import { findAgentRow, requireActiveOrg, requireAgent, requireDept } from './repo.js';
import { parse, reasonSchema } from './schemas.js';

export const skillGrantSchema = z.strictObject({
  scope: z.enum(['agent', 'dept', 'org']),
  /** Agent id or department id; ignored for the org scope. */
  id: z.string().min(1).max(200).optional(),
  skill: z.string().trim().min(1).max(300),
  reason: reasonSchema.optional(),
});
export type SkillGrantParsed = z.infer<typeof skillGrantSchema>;

export type SkillGrantResult = { agent?: Agent; department?: Department; organization?: Organization; approval?: Approval };

type Target =
  | { scope: 'agent'; id: string; name: string; current: string[]; agent: Agent }
  | { scope: 'dept'; id: string; name: string; current: string[]; dept: Department }
  | { scope: 'org'; id: string; name: string; current: string[]; org: Organization };

function resolveTarget(ctx: Ctx, org: Organization, input: SkillGrantParsed): Target {
  const k = ctx.kernel;
  if (input.scope === 'org') return { scope: 'org', id: org.id, name: org.name, current: org.defaultSkills, org };
  if (!input.id) throw notFound(input.scope === 'agent' ? 'agent' : 'department');
  if (input.scope === 'dept') {
    const dept = requireDept(k, org.id, input.id);
    if (dept.status !== 'active') throw conflict(`department ${dept.slug} is archived`);
    return { scope: 'dept', id: dept.id, name: dept.name, current: dept.sharedSkills, dept };
  }
  const agent = requireAgent(k, org.id, input.id);
  if (agent.status === 'terminated') throw conflict(`agent ${agent.slug} is terminated`);
  return { scope: 'agent', id: agent.id, name: agent.name, current: agent.skills, agent };
}

/** The skill must exist for this org (its own or a global one) and still be usable. */
function assertSkillExists(ctx: Ctx, orgId: string, name: string): void {
  const row = ctx.kernel.db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.name, name), or(eq(skills.orgId, orgId), isNull(skills.orgId)), notInArray(skills.status, ['deprecated', 'quarantined'])))
    .get();
  if (!row) throw notFound('skill', name);
}

/** Add the skill to the target's list + revision + audit. Call inside `ctx.mutate`. */
export function applySkillGrant(ctx: Ctx, orgId: string, input: SkillGrantParsed, actor: Actor, audit: Record<string, unknown> = {}): SkillGrantResult {
  const target = resolveTarget(ctx, requireActiveOrg(ctx.kernel, orgId), input);
  const next = target.current.includes(input.skill) ? target.current : [...target.current, input.skill];
  const note = `skill ${input.skill} granted`;
  const data = { change: 'skill_grant', skill: input.skill, ...(input.reason ? { reason: input.reason } : {}), ...audit };
  if (target.scope === 'agent') {
    if (next === target.current) return { agent: target.agent };
    return { agent: persistAgent(ctx, target.agent, { skills: next }, actor, { action: 'config.changed', note, event: 'agent.updated', data }) };
  }
  if (target.scope === 'dept') {
    if (next === target.current) return { department: target.dept };
    return { department: persistDept(ctx, target.dept, { sharedSkills: next }, actor, note, data) };
  }
  if (next === target.current) return { organization: target.org };
  return { organization: persistOrg(ctx, target.org, { defaultSkills: next }, actor, { action: 'config.changed', note, data }) };
}

/**
 * Grant a skill to an agent, to a department's shared skills or to the org's
 * default skills (PRD "Approvals": granting a skill is board-gated). The owner
 * grants directly. A Lead (autonomy 3) may propose one for itself, an agent
 * below it, a department in its reporting line or the whole org; while the
 * org's `grant_skill` gate is on, the proposal is a `grant_skill` approval
 * that `onApprovalDecided` applies once the board approves.
 */
export function proposeSkillGrant(ctx: Ctx, orgId: string, raw: SkillGrantInput, actor: Actor): SkillGrantResult {
  const k = ctx.kernel;
  const input = parse(skillGrantSchema, raw, 'skill grant');
  const org = requireActiveOrg(k, orgId);
  const target = resolveTarget(ctx, org, input);
  assertSkillExists(ctx, orgId, input.skill);
  if (actor.kind !== 'agent') return ctx.mutate(() => applySkillGrant(ctx, orgId, input, actor));

  const requester = requireLeadActor(ctx, orgId, actor, 'propose skill grants');
  if (target.scope === 'agent' && target.id !== requester.id && !isAbove(k, orgId, requester.id, target.id)) {
    throw forbidden(`agent ${requester.slug} may only propose skills for itself or its own reports`);
  }
  if (target.scope === 'dept') {
    const lead = target.dept.leadAgentId ? findAgentRow(k, orgId, target.dept.leadAgentId) : undefined;
    const inLine = target.id === requester.deptId || lead?.id === requester.id || (lead !== undefined && isAbove(k, orgId, requester.id, lead.id));
    if (!inLine) throw forbidden(`agent ${requester.slug} may only propose skills for departments in its reporting line`);
  }
  if (target.current.includes(input.skill)) return applySkillGrant(ctx, orgId, input, actor);

  const normalized = { ...input, id: target.id };
  if (!ctx.deps.approvals.requiresApproval(orgId, 'grant_skill')) {
    return ctx.mutate(() => applySkillGrant(ctx, orgId, normalized, actor));
  }
  const matchKey = `grant_skill:${target.scope}:${target.id}:${input.skill}`;
  const open = ctx.deps.approvals.findOpen(orgId, 'grant_skill', matchKey);
  if (open) return { approval: open };

  const where = target.scope === 'agent' ? target.name : target.scope === 'dept' ? `department ${target.name} (shared)` : `${target.name} (every agent)`;
  const approval = ctx.deps.approvals.request({
    orgId,
    kind: 'grant_skill',
    title: `Grant skill "${input.skill}" to ${where}`,
    payload: { matchKey, context: 'org', input: normalized, targetName: target.name, requestedBy: requester.id },
    requesterAgentId: requester.id,
    runId: actor.runId ?? null,
  });
  k.audit.record({
    orgId, actor, action: 'skill.grant_requested', entityKind: 'approval', entityId: approval.id,
    data: { scope: target.scope, id: target.id, skill: input.skill },
  });
  return { approval };
}
