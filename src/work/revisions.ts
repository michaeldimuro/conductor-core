import { and, eq, sql } from 'drizzle-orm';
import type { Actor } from '../contracts/types.js';
import { configRevisions } from '../db/schema/index.js';
import { newId } from '../shared/ids.js';
import type { WorkCtx } from './context.js';

/** Owner-editable Work config that is revisioned with rollback (PRD "Governance": config changes are revisioned). */
export type WorkEntityKind = 'goal' | 'playbook' | 'project';

/**
 * Append a full-snapshot revision (monotonic per entity) to the shared
 * `config_revisions` history. The Org context's `listRevisions` / `rollback`
 * read the same rows. A deletion is recorded as one more revision holding the
 * last state, so the entity can be restored. Returns the new revision number.
 */
export function recordRevision(
  ctx: WorkCtx,
  orgId: string,
  entityKind: WorkEntityKind,
  entityId: string,
  snapshot: object,
  actor: Actor,
  note: string,
): number {
  const db = ctx.kernel.db;
  const row = db
    .select({ max: sql<number>`coalesce(max(${configRevisions.revision}), 0)` })
    .from(configRevisions)
    .where(and(eq(configRevisions.entityKind, entityKind), eq(configRevisions.entityId, entityId)))
    .get();
  const revision = (row?.max ?? 0) + 1;
  db.insert(configRevisions)
    .values({
      id: newId('revision'),
      orgId,
      entityKind,
      entityId,
      revision,
      snapshot: { ...snapshot } as Record<string, unknown>,
      author: `${actor.kind}:${actor.id ?? ''}`,
      note,
      ts: ctx.now(),
    })
    .run();
  return revision;
}
