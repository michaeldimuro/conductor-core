import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Kernel } from '../contracts/kernel.js';
import type { OrgService } from '../contracts/org-work.js';
import type { Agent, Organization } from '../contracts/rows.js';
import { agents, organizations } from '../db/schema/index.js';
import type { DomainEvents, EventName } from '../shared/events.js';
import { invalid, notFound } from '../shared/errors.js';

/**
 * Shared plumbing for the Work context: the kernel, the Org collaborator, and
 * a unit of work that wraps writes in one IMMEDIATE transaction and holds
 * domain events back until that transaction has committed.
 */
export interface WorkCtx {
  readonly kernel: Kernel;
  readonly org: OrgService;
  /** Run `fn` atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T;
  /** Emit on the bus after the current transaction commits (immediately when outside one). */
  emit<K extends EventName>(name: K, payload: DomainEvents[K]): void;
  now(): number;
}

export function createWorkCtx(kernel: Kernel, org: OrgService): WorkCtx {
  let depth = 0;
  let pending: Array<() => void> = [];

  const flush = (): void => {
    const batch = pending;
    pending = [];
    for (const fire of batch) fire();
  };

  return {
    kernel,
    org,
    now: () => kernel.clock.now(),
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth = 1;
      let result: T;
      try {
        // IMMEDIATE takes the write lock up front, so read-then-write sequences
        // (issue number allocation) are serialized across connections too.
        // If the caller already opened a transaction, better-sqlite3 nests via a savepoint.
        result = kernel.sqlite.transaction(fn).immediate();
      } catch (e) {
        pending = [];
        throw e;
      } finally {
        depth = 0;
      }
      flush();
      return result;
    },
    emit(name, payload) {
      const fire = (): void => kernel.bus.emit(name, payload);
      if (depth > 0) pending.push(fire);
      else fire();
    },
  };
}

/** Validate external input; zod failures become `validation` ConductorErrors. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
  throw invalid(`invalid input: ${summary}`, { issues });
}

export function requireOrg(ctx: WorkCtx, orgId: string): Organization {
  const row = ctx.kernel.db.select().from(organizations).where(eq(organizations.id, orgId)).get();
  if (!row) throw notFound('organization', orgId);
  return row;
}

/** Agent by id, org-scoped: an id from another org behaves as not found. */
export function findAgentRow(ctx: WorkCtx, orgId: string, agentId: string): Agent | null {
  return (
    ctx.kernel.db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)))
      .get() ?? null
  );
}

export function requireAgent(ctx: WorkCtx, orgId: string, agentId: string): Agent {
  const row = findAgentRow(ctx, orgId, agentId);
  if (!row) throw notFound('agent', agentId);
  return row;
}

/** An agent that can receive work: exists in the org and is not terminated. */
export function requireAssignable(ctx: WorkCtx, orgId: string, agentId: string): Agent {
  const row = requireAgent(ctx, orgId, agentId);
  if (row.status === 'terminated') throw invalid(`agent ${row.slug} is terminated and cannot be assigned work`);
  return row;
}
