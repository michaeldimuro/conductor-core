import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { agents, organizations, projects, settings } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Organization, Project } from '../contracts/rows.js';
import { invalid, notFound } from '../shared/errors.js';

/** Validate boundary input; zod failures become `validation` ConductorErrors. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const msg = r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
  throw invalid(msg, { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
}

export function requireOrg(k: Kernel, orgId: string): Organization {
  const row = typeof orgId === 'string' ? k.db.select().from(organizations).where(eq(organizations.id, orgId)).get() : undefined;
  if (!row) throw notFound('organization', String(orgId));
  return row;
}

/** Org-scoped: an agent id from another org behaves as not found. */
export function requireAgent(k: Kernel, orgId: string, agentId: string): Agent {
  const row = k.db.select().from(agents).where(and(eq(agents.orgId, orgId), eq(agents.id, agentId))).get();
  if (!row) throw notFound('agent', agentId);
  return row;
}

export function requireProject(k: Kernel, orgId: string, projectId: string): Project {
  const row = k.db.select().from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, projectId))).get();
  if (!row) throw notFound('project', projectId);
  return row;
}

/** Install-level key/value store over the `settings` table. */
export class SettingsStore {
  constructor(private readonly k: Kernel) {}

  get<T>(key: string): T | undefined {
    const row = this.k.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? (row.value as T) : undefined;
  }

  set(key: string, value: unknown): void {
    const now = this.k.clock.now();
    this.k.db
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
  }

  /** Insert only when the key is absent. Returns true when this call created it. */
  putIfAbsent(key: string, value: unknown): boolean {
    const res = this.k.db
      .insert(settings)
      .values({ key, value, updatedAt: this.k.clock.now() })
      .onConflictDoNothing()
      .run();
    return res.changes === 1;
  }

  delete(key: string): void {
    this.k.db.delete(settings).where(eq(settings.key, key)).run();
  }
}
