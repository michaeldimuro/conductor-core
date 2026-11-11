import { and, eq } from 'drizzle-orm';
import { departments } from '../db/schema/index.js';
import type { Actor } from '../contracts/types.js';
import type { Department, Organization } from '../contracts/rows.js';
import type { CreateDeptInput, OrgService } from '../contracts/org-work.js';
import { conflict, invalid } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { assertBoard, type Ctx } from './context.js';
import {
  allocateSlug, assertSlugUnchanged, deptSlugTaken, findAgentRow, listAgentRows, recordRevision, requireActiveOrg, requireDept, requireOrg,
} from './repo.js';
import { createDeptSchema, definedOnly, parse, updateDeptSchema, type CreateDeptParsed } from './schemas.js';

/** Insert a department + revision + audit. Call inside `ctx.mutate`. */
export function createDeptCore(ctx: Ctx, org: Organization, input: CreateDeptParsed, actor: Actor, opts: { id?: string } = {}): Department {
  const k = ctx.kernel;
  const now = k.clock.now();
  const id = opts.id ?? newId('dept');
  const slug = allocateSlug({ explicit: input.slug, name: input.name, taken: deptSlugTaken(k, org.id), what: 'department' });
  k.db
    .insert(departments)
    .values({
      id,
      orgId: org.id,
      slug,
      name: input.name,
      charter: input.charter ?? '',
      budgetUsd: input.budgetUsd ?? null,
      sharedSkills: input.sharedSkills ?? [],
      sharedConnectors: input.sharedConnectors ?? [],
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const dept = requireDept(k, org.id, id);
  const revision = recordRevision(k, org.id, 'dept', id, dept, actor, 'created');
  k.audit.record({
    orgId: org.id,
    actor,
    action: 'dept.created',
    entityKind: 'dept',
    entityId: id,
    data: { slug, name: dept.name, revision },
  });
  ctx.after(() => {
    k.paths.ensure(k.paths.deptSkills(org.slug, slug));
    k.bus.emit('org.updated', { orgId: org.id });
  });
  return dept;
}

/** Persist a department patch + revision + audit. Call inside `ctx.mutate`. */
export function persistDept(
  ctx: Ctx,
  dept: Department,
  set: Partial<typeof departments.$inferInsert>,
  actor: Actor,
  note: string,
  data: Record<string, unknown> = {},
): Department {
  const k = ctx.kernel;
  k.db
    .update(departments)
    .set({ ...set, updatedAt: k.clock.now() })
    .where(and(eq(departments.orgId, dept.orgId), eq(departments.id, dept.id)))
    .run();
  const next = requireDept(k, dept.orgId, dept.id);
  const revision = recordRevision(k, dept.orgId, 'dept', dept.id, next, actor, note);
  k.audit.record({
    orgId: dept.orgId,
    actor,
    action: 'config.changed',
    entityKind: 'dept',
    entityId: dept.id,
    data: { change: 'dept.updated', revision, fields: Object.keys(set), ...data },
  });
  ctx.after(() => {
    k.bus.emit('org.updated', { orgId: dept.orgId });
    if ('budgetUsd' in set) k.bus.emit('budget.updated', { orgId: dept.orgId, scope: 'dept', scopeId: dept.id });
  });
  return next;
}

/** The lead must be a live agent of the same org. */
export function assertValidLead(ctx: Ctx, orgId: string, agentId: string): void {
  const agent = findAgentRow(ctx.kernel, orgId, agentId);
  if (!agent) throw invalid(`lead agent ${agentId} does not belong to this organization`);
  if (agent.status === 'terminated') throw invalid(`lead agent ${agent.slug} is terminated`);
}

export function createDept(ctx: Ctx, orgId: string, raw: CreateDeptInput, actor: Actor): Department {
  assertBoard(actor, 'create departments');
  const input = parse(createDeptSchema, raw, 'department');
  return ctx.mutate(() => createDeptCore(ctx, requireActiveOrg(ctx.kernel, orgId), input, actor));
}

export function updateDept(
  ctx: Ctx,
  orgId: string,
  deptId: string,
  raw: Parameters<OrgService['updateDept']>[2],
  actor: Actor,
): Department {
  assertBoard(actor, 'change departments');
  const patch = parse(updateDeptSchema, raw, 'department patch');
  return ctx.mutate(() => {
    requireOrg(ctx.kernel, orgId);
    const dept = requireDept(ctx.kernel, orgId, deptId);
    assertSlugUnchanged(dept.slug, patch.slug, 'department');
    if (patch.leadAgentId) assertValidLead(ctx, orgId, patch.leadAgentId);
    const set = definedOnly({
      name: patch.name,
      charter: patch.charter,
      budgetUsd: patch.budgetUsd,
      sharedSkills: patch.sharedSkills,
      sharedConnectors: patch.sharedConnectors,
      leadAgentId: patch.leadAgentId,
    });
    return persistDept(ctx, dept, set, actor, 'updated');
  });
}

/**
 * Archive a department (never delete: issues, goals and history still point at
 * it). Refused while it has non-terminated agents — move or terminate them
 * first — so no agent is left working in a department that no longer exists.
 */
export function archiveDept(ctx: Ctx, orgId: string, deptId: string, actor: Actor): Department {
  assertBoard(actor, 'archive departments');
  return ctx.mutate(() => {
    requireOrg(ctx.kernel, orgId);
    const dept = requireDept(ctx.kernel, orgId, deptId);
    if (dept.status === 'archived') return dept;
    const staff = listAgentRows(ctx.kernel, orgId, { deptId, excludeTerminated: true });
    if (staff.length > 0) {
      throw conflict(`department ${dept.slug} still has ${staff.length} agent(s); move or terminate them before archiving`, {
        agents: staff.map((a) => a.slug),
      });
    }
    return persistDept(ctx, dept, { status: 'archived', leadAgentId: null }, actor, 'archived', { change: 'dept.archived' });
  });
}

export function unarchiveDept(ctx: Ctx, orgId: string, deptId: string, actor: Actor): Department {
  assertBoard(actor, 'unarchive departments');
  return ctx.mutate(() => {
    requireActiveOrg(ctx.kernel, orgId);
    const dept = requireDept(ctx.kernel, orgId, deptId);
    if (dept.status === 'active') return dept;
    return persistDept(ctx, dept, { status: 'active' }, actor, 'unarchived', { change: 'dept.unarchived' });
  });
}
