import { and, eq } from 'drizzle-orm';
import { agents, browserProfiles, departments } from '../db/schema/index.js';
import type { Actor } from '../contracts/types.js';
import type { Agent, Department, Organization } from '../contracts/rows.js';
import type { OrgService } from '../contracts/org-work.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { assertBoard, type Ctx } from './context.js';
import { assertNoCycle, isAbove } from './chart.js';
import { persistDept } from './departments.js';
import {
  agentSlugTaken, allocateSlug, assertSlugUnchanged, findAgentRow, findDept, listAgentRows, recordRevision, requireAgent, requireDept, requireOrg,
} from './repo.js';
import {
  definedOnly, parse, pauseReasonSchema, updateAgentSchema, type AgentExtras, type HireAgentParsed,
} from './schemas.js';

/** `deptId` must be a live department of this org (foreign ids are a validation failure on input). */
export function resolveHireDept(ctx: Ctx, orgId: string, deptId: string): Department {
  const dept = findDept(ctx.kernel, orgId, deptId);
  if (!dept) throw invalid(`department ${deptId} does not belong to this organization`);
  if (dept.status !== 'active') throw conflict(`department ${dept.slug} is archived`);
  return dept;
}

/** `reportsTo` must be a live agent of this org. */
export function resolveManager(ctx: Ctx, orgId: string, managerId: string): Agent {
  const manager = findAgentRow(ctx.kernel, orgId, managerId);
  if (!manager) throw invalid(`manager ${managerId} does not belong to this organization`);
  if (manager.status === 'terminated') throw invalid(`manager ${manager.slug} is terminated`);
  return manager;
}

/** Everything `insertAgent` would reject, without writing — used before filing a hire approval. */
export function validateHire(ctx: Ctx, orgId: string, input: HireAgentParsed): Department {
  const dept = resolveHireDept(ctx, orgId, input.deptId);
  if (input.reportsTo) resolveManager(ctx, orgId, input.reportsTo);
  if (input.slug !== undefined && agentSlugTaken(ctx.kernel, orgId)(input.slug)) {
    throw conflict(`agent slug "${input.slug}" is already in use`, { slug: input.slug });
  }
  return dept;
}

/** Insert an agent + revision + audit + `agent.hired`. Call inside `ctx.mutate`. */
export function insertAgent(
  ctx: Ctx,
  org: Organization,
  input: HireAgentParsed,
  actor: Actor,
  opts: { id?: string; extras?: AgentExtras; audit?: Record<string, unknown> } = {},
): Agent {
  const k = ctx.kernel;
  const dept = resolveHireDept(ctx, org.id, input.deptId);
  if (input.reportsTo) resolveManager(ctx, org.id, input.reportsTo);
  const now = k.clock.now();
  const id = opts.id ?? newId('agent');
  const slug = allocateSlug({ explicit: input.slug, name: input.name, taken: agentSlugTaken(k, org.id), what: 'agent' });
  k.db
    .insert(agents)
    .values({
      id,
      orgId: org.id,
      deptId: dept.id,
      slug,
      name: input.name,
      role: input.role,
      goal: input.goal ?? '',
      backstory: input.backstory ?? '',
      reportsTo: input.reportsTo ?? null,
      providerBinding: input.providerBinding ?? null,
      model: input.model ?? null,
      skills: input.skills ?? [],
      connectors: input.connectors ?? [],
      heartbeatCron: input.heartbeatCron ?? null,
      budgetUsd: input.budgetUsd ?? null,
      ...definedOnly({ autonomyLevel: input.autonomyLevel, ...opts.extras }),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const agent = requireAgent(k, org.id, id);
  const revision = recordRevision(k, org.id, 'agent', id, agent, actor, 'hired');
  k.audit.record({
    orgId: org.id,
    actor,
    action: 'agent.hired',
    entityKind: 'agent',
    entityId: id,
    data: { slug, role: agent.role, deptId: dept.id, reportsTo: agent.reportsTo, revision, ...opts.audit },
  });
  if (input.isLead) persistDept(ctx, dept, { leadAgentId: id }, actor, `lead set to ${slug}`);
  ctx.after(() => {
    k.paths.ensure(k.paths.agentDir(org.slug, slug));
    k.paths.ensure(k.paths.agentWorkspace(org.slug, slug));
    k.paths.ensure(k.paths.agentSkills(org.slug, slug));
    k.bus.emit('agent.hired', { orgId: org.id, agentId: id });
  });
  return agent;
}

type AgentEvent = 'agent.updated' | 'agent.paused' | 'agent.resumed';

/** Persist an agent patch + revision + audit + event. Call inside `ctx.mutate`. */
export function persistAgent(
  ctx: Ctx,
  agent: Agent,
  set: Partial<typeof agents.$inferInsert>,
  actor: Actor,
  meta: { action: string; note: string; event: AgentEvent; data?: Record<string, unknown> },
): Agent {
  const k = ctx.kernel;
  k.db
    .update(agents)
    .set({ ...set, updatedAt: k.clock.now() })
    .where(and(eq(agents.orgId, agent.orgId), eq(agents.id, agent.id)))
    .run();
  const next = requireAgent(k, agent.orgId, agent.id);
  const revision = recordRevision(k, agent.orgId, 'agent', agent.id, next, actor, meta.note);
  k.audit.record({
    orgId: agent.orgId,
    actor,
    action: meta.action,
    entityKind: 'agent',
    entityId: agent.id,
    data: { revision, fields: Object.keys(set), ...meta.data },
  });
  ctx.after(() => {
    const base = { orgId: agent.orgId, agentId: agent.id };
    if (meta.event === 'agent.paused') k.bus.emit('agent.paused', { ...base, reason: next.pausedReason ?? '' });
    else k.bus.emit(meta.event, base);
    if ('budgetUsd' in set) k.bus.emit('budget.updated', { orgId: agent.orgId, scope: 'agent', scopeId: agent.id });
  });
  return next;
}

export function updateAgent(
  ctx: Ctx,
  orgId: string,
  agentId: string,
  raw: Parameters<OrgService['updateAgent']>[2],
  actor: Actor,
): Agent {
  assertBoard(actor, 'change agent configuration');
  const patch = parse(updateAgentSchema, raw, 'agent patch');
  const k = ctx.kernel;
  return ctx.mutate(() => {
    requireOrg(k, orgId);
    const current = requireAgent(k, orgId, agentId);
    if (current.status === 'terminated') throw conflict(`agent ${current.slug} is terminated`);
    assertSlugUnchanged(current.slug, patch.slug, 'agent');

    const targetDept = patch.deptId !== undefined && patch.deptId !== current.deptId
      ? resolveHireDept(ctx, orgId, patch.deptId)
      : requireDept(k, orgId, current.deptId);
    if (patch.reportsTo) {
      resolveManager(ctx, orgId, patch.reportsTo);
      assertNoCycle(k, orgId, agentId, patch.reportsTo);
    }
    if (patch.browserProfileId) {
      const profile = k.db
        .select({ id: browserProfiles.id })
        .from(browserProfiles)
        .where(and(eq(browserProfiles.orgId, orgId), eq(browserProfiles.id, patch.browserProfileId)))
        .get();
      if (!profile) throw notFound('browser profile', patch.browserProfileId);
    }

    const set = definedOnly({
      name: patch.name,
      role: patch.role,
      goal: patch.goal,
      backstory: patch.backstory,
      deptId: patch.deptId,
      reportsTo: patch.reportsTo,
      providerBinding: patch.providerBinding,
      model: patch.model,
      skills: patch.skills,
      connectors: patch.connectors,
      denySkills: patch.denySkills,
      denyConnectors: patch.denyConnectors,
      heartbeatCron: patch.heartbeatCron,
      budgetUsd: patch.budgetUsd,
      autonomyLevel: patch.autonomyLevel,
      maxSteps: patch.maxSteps,
      maxWallMs: patch.maxWallMs,
      maxRunsPerHour: patch.maxRunsPerHour,
      browserProfileId: patch.browserProfileId,
    });
    const next = persistAgent(ctx, current, set, actor, {
      action: 'config.changed', note: 'updated', event: 'agent.updated', data: { change: 'agent.updated' },
    });

    // Lead bookkeeping: leaving a department vacates its lead seat; isLead sets/clears it.
    if (targetDept.id !== current.deptId) {
      const oldDept = findDept(k, orgId, current.deptId);
      if (oldDept?.leadAgentId === agentId) persistDept(ctx, oldDept, { leadAgentId: null }, actor, `lead ${current.slug} moved department`);
    }
    if (patch.isLead === true && targetDept.leadAgentId !== agentId) {
      persistDept(ctx, targetDept, { leadAgentId: agentId }, actor, `lead set to ${current.slug}`);
    } else if (patch.isLead === false && targetDept.leadAgentId === agentId) {
      persistDept(ctx, targetDept, { leadAgentId: null }, actor, `lead ${current.slug} stepped down`);
    }
    return next;
  });
}

/**
 * Pause/resume: the board, or a Lead (autonomy 3) acting on someone in its
 * own reporting line.
 */
function assertCanManage(ctx: Ctx, orgId: string, actor: Actor, target: Agent, what: string): void {
  if (actor.kind !== 'agent') return;
  const lead = requireLeadActor(ctx, orgId, actor, what);
  if (!isAbove(ctx.kernel, orgId, lead.id, target.id)) {
    throw forbidden(`agent ${lead.slug} may only ${what} its own reports`);
  }
}

/** Resolve an agent actor and require it to be an active Lead (autonomy level 3) of this org. */
export function requireLeadActor(ctx: Ctx, orgId: string, actor: Actor, what: string): Agent {
  const self = actor.id ? findAgentRow(ctx.kernel, orgId, actor.id) : undefined;
  if (!self) throw forbidden(`unknown agent actor may not ${what}`);
  if (self.status !== 'active') throw forbidden(`agent ${self.slug} is ${self.status} and may not ${what}`);
  if (self.autonomyLevel < 3) {
    throw forbidden(`only Lead agents (autonomy level 3) may ${what}`, { agentId: self.id, autonomyLevel: self.autonomyLevel });
  }
  return self;
}

export function pauseAgent(ctx: Ctx, orgId: string, agentId: string, rawReason: string, actor: Actor): Agent {
  const reason = parse(pauseReasonSchema, rawReason, 'pause reason');
  return ctx.mutate(() => {
    requireOrg(ctx.kernel, orgId);
    const agent = requireAgent(ctx.kernel, orgId, agentId);
    assertCanManage(ctx, orgId, actor, agent, 'pause agents');
    if (agent.status === 'terminated') throw conflict(`agent ${agent.slug} is terminated`);
    return persistAgent(ctx, agent, { status: 'paused', pausedReason: reason }, actor, {
      action: 'agent.paused', note: `paused: ${reason}`, event: 'agent.paused', data: { reason },
    });
  });
}

export function resumeAgent(ctx: Ctx, orgId: string, agentId: string, actor: Actor): Agent {
  return ctx.mutate(() => {
    requireOrg(ctx.kernel, orgId);
    const agent = requireAgent(ctx.kernel, orgId, agentId);
    assertCanManage(ctx, orgId, actor, agent, 'resume agents');
    if (agent.status === 'terminated') throw conflict(`agent ${agent.slug} is terminated`);
    if (agent.status === 'active') return agent;
    return persistAgent(ctx, agent, { status: 'active', pausedReason: null }, actor, {
      action: 'agent.resumed', note: 'resumed', event: 'agent.resumed',
    });
  });
}

/**
 * Terminate (never delete). The agent's direct reports move up to its
 * manager and any lead seat it held is vacated, so the chart stays connected.
 * Idempotent. Call inside `ctx.mutate`.
 */
export function terminateCore(ctx: Ctx, orgId: string, agentId: string, actor: Actor, audit: Record<string, unknown> = {}): Agent {
  const k = ctx.kernel;
  const agent = requireAgent(k, orgId, agentId);
  if (agent.status === 'terminated') return agent;
  const next = persistAgent(ctx, agent, { status: 'terminated', pausedReason: null }, actor, {
    action: 'agent.terminated', note: 'terminated', event: 'agent.updated', data: audit,
  });
  for (const report of listAgentRows(k, orgId).filter((a) => a.reportsTo === agentId)) {
    persistAgent(ctx, report, { reportsTo: agent.reportsTo }, actor, {
      action: 'config.changed', note: `manager ${agent.slug} terminated`, event: 'agent.updated', data: { change: 'agent.updated' },
    });
  }
  const led = k.db
    .select()
    .from(departments)
    .where(and(eq(departments.orgId, orgId), eq(departments.leadAgentId, agentId)))
    .all();
  for (const dept of led) persistDept(ctx, dept, { leadAgentId: null }, actor, `lead ${agent.slug} terminated`);
  return next;
}

export function findAgent(ctx: Ctx, orgId: string, idOrSlug: string): Agent | null {
  const byId = findAgentRow(ctx.kernel, orgId, idOrSlug);
  if (byId) return byId;
  return (
    ctx.kernel.db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.slug, idOrSlug)))
      .get() ?? null
  );
}
