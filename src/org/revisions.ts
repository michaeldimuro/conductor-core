import { and, desc, eq } from 'drizzle-orm';
import { configRevisions } from '../db/schema/index.js';
import type { agents, departments, organizations } from '../db/schema/index.js';
import type { Actor } from '../contracts/types.js';
import type { ConfigRevision } from '../contracts/rows.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import { assertBoard, type Ctx } from './context.js';
import { persistAgent } from './agents.js';
import { assertNoCycle } from './chart.js';
import { persistDept } from './departments.js';
import { persistOrg } from './orgs.js';
import { findAgentRow, findDept, requireAgent, requireDept, requireOrg, type EntityKind } from './repo.js';
import { rollbackWorkEntity } from './revisions-work.js';

/** Config fields a rollback restores. Identity, slug, status and timestamps are never rolled back. */
const ORG_FIELDS = [
  'name', 'mission', 'budgetMonthlyUsd', 'seatSecondsMonthly', 'defaultProvider', 'utilityModel', 'policies',
  'defaultSkills', 'defaultConnectors', 'maxConcurrentRuns',
] as const;
const DEPT_FIELDS = ['name', 'charter', 'leadAgentId', 'budgetUsd', 'sharedSkills', 'sharedConnectors'] as const;
const AGENT_FIELDS = [
  'name', 'role', 'goal', 'backstory', 'deptId', 'reportsTo', 'providerBinding', 'model', 'skills', 'connectors',
  'denySkills', 'denyConnectors', 'browserProfileId', 'heartbeatCron', 'budgetUsd', 'autonomyLevel', 'maxSteps',
  'maxWallMs', 'maxRunsPerHour',
] as const;

function pick<T extends object>(snapshot: Record<string, unknown>, fields: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in snapshot) out[f] = snapshot[f];
  return out as Partial<T>;
}

const KINDS: readonly EntityKind[] = ['org', 'dept', 'agent', 'goal', 'playbook', 'project'];

function asKind(entityKind: string): EntityKind {
  if (KINDS.includes(entityKind as EntityKind)) return entityKind as EntityKind;
  throw invalid(`unsupported entity kind "${entityKind}" (expected ${KINDS.join(', ')})`);
}

/** Newest first. Rows of other orgs are never returned. */
export function listRevisions(ctx: Ctx, orgId: string, entityKind: string, entityId: string): ConfigRevision[] {
  requireOrg(ctx.kernel, orgId);
  return ctx.kernel.db
    .select()
    .from(configRevisions)
    .where(and(
      eq(configRevisions.orgId, orgId),
      eq(configRevisions.entityKind, entityKind),
      eq(configRevisions.entityId, entityId),
    ))
    .orderBy(desc(configRevisions.revision))
    .all();
}

/**
 * Restore the config captured by `revision`. The restore is itself a new
 * revision (history is never rewritten) and is audited as `config.changed`.
 */
export function rollback(ctx: Ctx, orgId: string, entityKind: string, entityId: string, revision: number, actor: Actor): void {
  assertBoard(actor, 'roll back configuration');
  const kind = asKind(entityKind);
  const k = ctx.kernel;
  ctx.mutate(() => {
    requireOrg(k, orgId);
    const rev = k.db
      .select()
      .from(configRevisions)
      .where(and(
        eq(configRevisions.orgId, orgId),
        eq(configRevisions.entityKind, kind),
        eq(configRevisions.entityId, entityId),
        eq(configRevisions.revision, revision),
      ))
      .get();
    if (!rev) throw notFound(`${kind} revision`, `${entityId}@${revision}`);
    const note = `rollback to revision ${revision}`;
    const data = { change: 'rollback', rollbackTo: revision };

    if (kind === 'goal' || kind === 'playbook' || kind === 'project') {
      rollbackWorkEntity(ctx, orgId, kind, entityId, rev, actor, { note, data });
      return;
    }

    if (kind === 'org') {
      const org = requireOrg(k, orgId);
      if (entityId !== org.id) throw notFound('organization', entityId);
      persistOrg(ctx, org, pick<typeof organizations.$inferInsert>(rev.snapshot, ORG_FIELDS), actor, {
        action: 'config.changed', note, data,
      });
      return;
    }

    if (kind === 'dept') {
      const dept = requireDept(k, orgId, entityId);
      const set = pick<typeof departments.$inferInsert>(rev.snapshot, DEPT_FIELDS);
      if (set.leadAgentId) {
        // The former lead may have left since; restore the rest and leave the seat empty.
        const lead = findAgentRow(k, orgId, set.leadAgentId);
        if (!lead || lead.status === 'terminated') set.leadAgentId = null;
      }
      persistDept(ctx, dept, set, actor, note, data);
      return;
    }

    const agent = requireAgent(k, orgId, entityId);
    if (agent.status === 'terminated') throw conflict(`agent ${agent.slug} is terminated`);
    const set = pick<typeof agents.$inferInsert>(rev.snapshot, AGENT_FIELDS);
    if (set.deptId && !findDept(k, orgId, set.deptId)) {
      throw conflict(`cannot roll back: department ${set.deptId} no longer exists`);
    }
    if (set.reportsTo) {
      const manager = findAgentRow(k, orgId, set.reportsTo);
      if (!manager || manager.status === 'terminated') {
        throw conflict(`cannot roll back: former manager ${set.reportsTo} is no longer available`);
      }
      try {
        assertNoCycle(k, orgId, agent.id, set.reportsTo);
      } catch {
        throw conflict('cannot roll back: restoring the former manager would create a reporting cycle');
      }
    }
    persistAgent(ctx, agent, set, actor, { action: 'config.changed', note, event: 'agent.updated', data });
  });
}
