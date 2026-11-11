import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { agents, configRevisions, departments, organizations } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Actor } from '../contracts/types.js';
import type { Agent, Department, Organization } from '../contracts/rows.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import { newId, slugify } from '../shared/ids.js';
import { actorLabel } from './context.js';

/** Config that is revisioned with rollback: the org chart plus the Work context's goals, playbooks and projects. */
export type EntityKind = 'org' | 'dept' | 'agent' | 'goal' | 'playbook' | 'project';

export function findOrg(k: Kernel, orgId: string): Organization | undefined {
  return k.db.select().from(organizations).where(eq(organizations.id, orgId)).get();
}

export function requireOrg(k: Kernel, orgId: string): Organization {
  const org = findOrg(k, orgId);
  if (!org) throw notFound('organization', orgId);
  return org;
}

/** For mutations that add structure: the org must exist and not be archived. */
export function requireActiveOrg(k: Kernel, orgId: string): Organization {
  const org = requireOrg(k, orgId);
  if (org.status !== 'active') throw conflict(`organization ${org.slug} is archived`);
  return org;
}

export function findDept(k: Kernel, orgId: string, deptId: string): Department | undefined {
  return k.db
    .select()
    .from(departments)
    .where(and(eq(departments.orgId, orgId), eq(departments.id, deptId)))
    .get();
}

export function requireDept(k: Kernel, orgId: string, deptId: string): Department {
  const dept = findDept(k, orgId, deptId);
  if (!dept) throw notFound('department', deptId);
  return dept;
}

export function listDeptRows(k: Kernel, orgId: string): Department[] {
  return k.db
    .select()
    .from(departments)
    .where(eq(departments.orgId, orgId))
    .orderBy(asc(departments.createdAt), sql`rowid`)
    .all();
}

export function findAgentRow(k: Kernel, orgId: string, agentId: string): Agent | undefined {
  return k.db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)))
    .get();
}

export function requireAgent(k: Kernel, orgId: string, agentId: string): Agent {
  const agent = findAgentRow(k, orgId, agentId);
  if (!agent) throw notFound('agent', agentId);
  return agent;
}

export function listAgentRows(
  k: Kernel,
  orgId: string,
  filter: { deptId?: string; status?: Agent['status']; excludeTerminated?: boolean } = {},
): Agent[] {
  const where = [eq(agents.orgId, orgId)];
  if (filter.deptId) where.push(eq(agents.deptId, filter.deptId));
  if (filter.status) where.push(eq(agents.status, filter.status));
  if (filter.excludeTerminated) where.push(ne(agents.status, 'terminated'));
  return k.db
    .select()
    .from(agents)
    .where(and(...where))
    .orderBy(asc(agents.createdAt), sql`rowid`)
    .all();
}

/**
 * Pick a slug. An explicit slug that collides is a `conflict`; a derived one
 * is auto-suffixed (`ada`, `ada-2`, `ada-3`…).
 */
export function allocateSlug(opts: {
  explicit?: string;
  name: string;
  taken: (slug: string) => boolean;
  what: string;
}): string {
  if (opts.explicit !== undefined) {
    if (opts.taken(opts.explicit)) {
      throw conflict(`${opts.what} slug "${opts.explicit}" is already in use`, { slug: opts.explicit });
    }
    return opts.explicit;
  }
  const base = slugify(opts.name);
  if (!opts.taken(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!opts.taken(candidate)) return candidate;
  }
  throw conflict(`could not allocate a unique ${opts.what} slug for "${opts.name}"`);
}

export const orgSlugTaken = (k: Kernel) => (slug: string): boolean =>
  k.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).get() !== undefined;

export const deptSlugTaken = (k: Kernel, orgId: string) => (slug: string): boolean =>
  k.db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.orgId, orgId), eq(departments.slug, slug)))
    .get() !== undefined;

export const agentSlugTaken = (k: Kernel, orgId: string) => (slug: string): boolean =>
  k.db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.slug, slug)))
    .get() !== undefined;

/** A patch may repeat the current slug but never change it: on-disk dirs and skill paths hang off it. */
export function assertSlugUnchanged(current: string, next: string | undefined, what: string): void {
  if (next !== undefined && next !== current) {
    throw invalid(`${what} slug is immutable (on-disk paths depend on it)`, { current, requested: next });
  }
}

/** Append a full-snapshot revision (monotonic per entity). Returns the new revision number. */
export function recordRevision(
  k: Kernel,
  orgId: string,
  entityKind: EntityKind,
  entityId: string,
  snapshot: object,
  actor: Actor,
  note?: string,
): number {
  const row = k.db
    .select({ max: sql<number>`coalesce(max(${configRevisions.revision}), 0)` })
    .from(configRevisions)
    .where(and(eq(configRevisions.entityKind, entityKind), eq(configRevisions.entityId, entityId)))
    .get();
  const revision = (row?.max ?? 0) + 1;
  k.db
    .insert(configRevisions)
    .values({
      id: newId('revision'),
      orgId,
      entityKind,
      entityId,
      revision,
      snapshot: { ...snapshot } as Record<string, unknown>,
      author: actorLabel(actor),
      note: note ?? null,
      ts: k.clock.now(),
    })
    .run();
  return revision;
}
