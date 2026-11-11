import { asc, eq, sql } from 'drizzle-orm';
import { organizations } from '../db/schema/index.js';
import type { Actor } from '../contracts/types.js';
import type { Organization } from '../contracts/rows.js';
import type { CreateOrgInput, OrgService } from '../contracts/org-work.js';
import { newId } from '../shared/ids.js';
import { assertBoard, type Ctx } from './context.js';
import { allocateSlug, assertSlugUnchanged, orgSlugTaken, recordRevision, requireOrg } from './repo.js';
import { createOrgSchema, definedOnly, parse, updateOrgSchema, type CreateOrgParsed } from './schemas.js';

/** Insert an org + revision + audit. Call inside `ctx.mutate`. */
export function createOrgCore(
  ctx: Ctx,
  input: CreateOrgParsed,
  actor: Actor,
  extras: { defaultSkills?: string[]; maxConcurrentRuns?: number; note?: string; audit?: Record<string, unknown> } = {},
): Organization {
  const k = ctx.kernel;
  const now = k.clock.now();
  const id = newId('org');
  const slug = allocateSlug({ explicit: input.slug, name: input.name, taken: orgSlugTaken(k), what: 'organization' });
  k.db
    .insert(organizations)
    .values({
      id,
      slug,
      name: input.name,
      mission: input.mission ?? '',
      owner: 'owner',
      budgetMonthlyUsd: input.budgetMonthlyUsd ?? null,
      seatSecondsMonthly: input.seatSecondsMonthly ?? null,
      defaultProvider: input.defaultProvider ?? null,
      utilityModel: input.utilityModel ?? null,
      policies: input.policies ?? {},
      defaultSkills: extras.defaultSkills ?? [],
      defaultConnectors: [],
      ...(extras.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: extras.maxConcurrentRuns } : {}),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const org = requireOrg(k, id);
  const revision = recordRevision(k, id, 'org', id, org, actor, extras.note ?? 'created');
  k.audit.record({
    orgId: id,
    actor,
    action: 'org.created',
    entityKind: 'org',
    entityId: id,
    data: { slug, name: org.name, revision, ...extras.audit },
  });
  ctx.after(() => {
    k.paths.ensure(k.paths.org(slug));
    k.paths.ensure(k.paths.orgSkills(slug));
    k.bus.emit('org.created', { orgId: id });
  });
  return org;
}

/** Persist a patch to an org + revision + audit + `org.updated`. Call inside `ctx.mutate`. */
export function persistOrg(
  ctx: Ctx,
  org: Organization,
  set: Partial<typeof organizations.$inferInsert>,
  actor: Actor,
  audit: { action: string; note: string; data?: Record<string, unknown> },
): Organization {
  const k = ctx.kernel;
  k.db
    .update(organizations)
    .set({ ...set, updatedAt: k.clock.now() })
    .where(eq(organizations.id, org.id))
    .run();
  const next = requireOrg(k, org.id);
  const revision = recordRevision(k, org.id, 'org', org.id, next, actor, audit.note);
  k.audit.record({
    orgId: org.id,
    actor,
    action: audit.action,
    entityKind: 'org',
    entityId: org.id,
    data: { revision, fields: Object.keys(set), ...audit.data },
  });
  ctx.after(() => {
    k.bus.emit('org.updated', { orgId: org.id });
    if ('budgetMonthlyUsd' in set || 'seatSecondsMonthly' in set) {
      k.bus.emit('budget.updated', { orgId: org.id, scope: 'org', scopeId: org.id });
    }
  });
  return next;
}

export function createOrg(ctx: Ctx, raw: CreateOrgInput, actor: Actor): Organization {
  assertBoard(actor, 'create organizations');
  const input = parse(createOrgSchema, raw, 'organization');
  return ctx.mutate(() => createOrgCore(ctx, input, actor));
}

export function updateOrg(
  ctx: Ctx,
  orgId: string,
  raw: Parameters<OrgService['updateOrg']>[1],
  actor: Actor,
): Organization {
  assertBoard(actor, 'change organization settings');
  const patch = parse(updateOrgSchema, raw, 'organization patch');
  return ctx.mutate(() => {
    const org = requireOrg(ctx.kernel, orgId);
    assertSlugUnchanged(org.slug, patch.slug, 'organization');
    const set = definedOnly({
      name: patch.name,
      mission: patch.mission,
      budgetMonthlyUsd: patch.budgetMonthlyUsd,
      seatSecondsMonthly: patch.seatSecondsMonthly,
      defaultProvider: patch.defaultProvider,
      utilityModel: patch.utilityModel,
      policies: patch.policies,
      defaultSkills: patch.defaultSkills,
      defaultConnectors: patch.defaultConnectors,
      maxConcurrentRuns: patch.maxConcurrentRuns,
    });
    return persistOrg(ctx, org, set, actor, { action: 'config.changed', note: 'updated', data: { change: 'org.updated' } });
  });
}

export function archiveOrg(ctx: Ctx, orgId: string, actor: Actor): Organization {
  assertBoard(actor, 'archive organizations');
  return ctx.mutate(() => {
    const org = requireOrg(ctx.kernel, orgId);
    if (org.status === 'archived') return org;
    const next = persistOrg(ctx, org, { status: 'archived' }, actor, { action: 'org.archived', note: 'archived' });
    // The runtime cancels the org's in-flight runs and stops scheduling on this event.
    ctx.after(() => ctx.kernel.bus.emit('org.archived', { orgId }));
    return next;
  });
}

export function unarchiveOrg(ctx: Ctx, orgId: string, actor: Actor): Organization {
  assertBoard(actor, 'unarchive organizations');
  return ctx.mutate(() => {
    const org = requireOrg(ctx.kernel, orgId);
    if (org.status === 'active') return org;
    const next = persistOrg(ctx, org, { status: 'active' }, actor, { action: 'org.unarchived', note: 'unarchived' });
    ctx.after(() => ctx.kernel.bus.emit('org.unarchived', { orgId }));
    return next;
  });
}

export function getOrgBySlug(ctx: Ctx, slug: string): Organization | null {
  return ctx.kernel.db.select().from(organizations).where(eq(organizations.slug, slug)).get() ?? null;
}

export function listOrgs(ctx: Ctx, opts: { includeArchived?: boolean } = {}): Organization[] {
  const q = ctx.kernel.db.select().from(organizations);
  const rows = opts.includeArchived
    ? q.orderBy(asc(organizations.createdAt), sql`rowid`).all()
    : q.where(eq(organizations.status, 'active')).orderBy(asc(organizations.createdAt), sql`rowid`).all();
  return rows;
}
