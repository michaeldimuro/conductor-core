import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { goals, playbooks, projects } from '../db/schema/index.js';
import type { Actor } from '../contracts/types.js';
import type { ConfigRevision } from '../contracts/rows.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import type { Ctx } from './context.js';
import { findAgentRow, findDept, recordRevision } from './repo.js';

/**
 * Rollback for the Work context's owner-editable config: goals, playbooks and
 * projects. Their revisions are written by the Work context on every change
 * (and on delete), into the same `config_revisions` history as the org chart.
 *
 * A rollback restores the captured config fields and is itself a new revision.
 * References that no longer resolve (a terminated owner, a deleted parent
 * goal) are dropped rather than restored dangling. Rolling back a goal or
 * playbook that has since been deleted re-creates it under its old id.
 */

export type WorkKind = 'goal' | 'playbook' | 'project';
type Meta = { note: string; data: Record<string, unknown> };

const nullableId = z.string().min(1).nullish().transform((v) => v ?? null);

const goalSnapshot = z.object({
  parentGoalId: nullableId,
  level: z.enum(['org', 'dept', 'agent']),
  deptId: nullableId,
  ownerAgentId: nullableId,
  title: z.string().min(1),
  description: z.string().default(''),
  successMetric: z.string().default(''),
  target: z.string().default(''),
  weight: z.number().finite().nonnegative().default(1),
  due: z.number().int().nullish().transform((v) => v ?? null),
  status: z.enum(['proposed', 'active', 'achieved', 'abandoned']).default('active'),
  createdAt: z.number().int().optional(),
});

const playbookSnapshot = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  process: z.enum(['sequential', 'hierarchical']).default('sequential'),
  managerAgentId: nullableId,
  steps: z.array(z.object({
    title: z.string(),
    description: z.string().default(''),
    expectedOutput: z.string().default(''),
    agentRole: z.string().optional(),
    agentId: z.string().optional(),
  })).default([]),
  createdAt: z.number().int().optional(),
});

const projectSnapshot = z.object({
  name: z.string().min(1),
  goalId: nullableId,
  workspacePath: z.string().nullish().transform((v) => v ?? null),
  budgetUsd: z.number().finite().nonnegative().nullish().transform((v) => v ?? null),
  status: z.enum(['active', 'archived']).default('active'),
});

function read<S extends z.ZodType>(schema: S, rev: ConfigRevision): z.output<S> {
  const r = schema.safeParse(rev.snapshot);
  if (!r.success) throw invalid(`revision ${rev.revision} of ${rev.entityKind} ${rev.entityId} cannot be restored: snapshot is malformed`);
  return r.data;
}

const liveAgent = (ctx: Ctx, orgId: string, id: string | null): string | null => {
  const agent = id ? findAgentRow(ctx.kernel, orgId, id) : undefined;
  return agent && agent.status !== 'terminated' ? agent.id : null;
};

function rollbackGoal(ctx: Ctx, orgId: string, goalId: string, rev: ConfigRevision, actor: Actor, meta: Meta): void {
  const k = ctx.kernel;
  const snap = read(goalSnapshot, rev);
  const goalRow = (id: string) => k.db.select().from(goals).where(and(eq(goals.orgId, orgId), eq(goals.id, id))).get();

  // The former parent must still exist and must not sit below this goal now.
  let parentGoalId = snap.parentGoalId && goalRow(snap.parentGoalId) ? snap.parentGoalId : null;
  for (let cursor = parentGoalId, hops = 0; cursor && hops < 1000; hops++) {
    if (cursor === goalId) {
      parentGoalId = null;
      break;
    }
    cursor = goalRow(cursor)?.parentGoalId ?? null;
  }
  const deptId = snap.deptId && findDept(k, orgId, snap.deptId) ? snap.deptId : null;
  const ownerAgentId = liveAgent(ctx, orgId, snap.ownerAgentId);
  if (snap.level === 'dept' && !deptId) throw conflict('cannot roll back: the goal\'s department no longer exists');
  if (snap.level === 'agent' && !ownerAgentId) throw conflict('cannot roll back: the goal\'s owner agent is no longer available');

  const { createdAt, ...fields } = snap;
  const set = { ...fields, parentGoalId, deptId, ownerAgentId };
  const now = k.clock.now();
  const existing = goalRow(goalId);
  if (existing) {
    k.db.update(goals).set({ ...set, updatedAt: now }).where(and(eq(goals.orgId, orgId), eq(goals.id, goalId))).run();
  } else {
    k.db.insert(goals).values({ ...set, id: goalId, orgId, createdAt: createdAt ?? now, updatedAt: now }).run();
  }
  const next = goalRow(goalId);
  if (!next) throw notFound('goal', goalId);
  const revision = recordRevision(k, orgId, 'goal', goalId, next, actor, meta.note);
  k.audit.record({
    orgId, actor, action: 'config.changed', entityKind: 'goal', entityId: goalId,
    data: { ...meta.data, revision, restored: !existing },
  });
  ctx.after(() => k.bus.emit(existing ? 'goal.updated' : 'goal.created', { orgId, goalId }));
}

function rollbackPlaybook(ctx: Ctx, orgId: string, playbookId: string, rev: ConfigRevision, actor: Actor, meta: Meta): void {
  const k = ctx.kernel;
  const snap = read(playbookSnapshot, rev);
  const where = and(eq(playbooks.orgId, orgId), eq(playbooks.id, playbookId));
  const clash = k.db
    .select({ id: playbooks.id })
    .from(playbooks)
    .where(and(eq(playbooks.orgId, orgId), eq(playbooks.name, snap.name), ne(playbooks.id, playbookId)))
    .get();
  if (clash) throw conflict(`cannot roll back: another playbook is now named "${snap.name}"`);

  const { createdAt, ...fields } = snap;
  const set = {
    ...fields,
    managerAgentId: liveAgent(ctx, orgId, snap.managerAgentId),
    steps: snap.steps.map(({ agentId, agentRole, ...step }) => ({
      ...step,
      ...(agentRole ? { agentRole } : {}),
      ...(agentId && liveAgent(ctx, orgId, agentId) ? { agentId } : {}),
    })),
  };
  const now = k.clock.now();
  const existing = k.db.select({ id: playbooks.id }).from(playbooks).where(where).get();
  if (existing) k.db.update(playbooks).set({ ...set, updatedAt: now }).where(where).run();
  else k.db.insert(playbooks).values({ ...set, id: playbookId, orgId, createdAt: createdAt ?? now, updatedAt: now }).run();

  const next = k.db.select().from(playbooks).where(where).get();
  if (!next) throw notFound('playbook', playbookId);
  const revision = recordRevision(k, orgId, 'playbook', playbookId, next, actor, meta.note);
  k.audit.record({
    orgId, actor, action: 'config.changed', entityKind: 'playbook', entityId: playbookId,
    data: { ...meta.data, revision, restored: !existing },
  });
  ctx.after(() => k.bus.emit('playbook.changed', { orgId, playbookId, change: existing ? 'updated' : 'restored' }));
}

function rollbackProject(ctx: Ctx, orgId: string, projectId: string, rev: ConfigRevision, actor: Actor, meta: Meta): void {
  const k = ctx.kernel;
  const snap = read(projectSnapshot, rev);
  const where = and(eq(projects.orgId, orgId), eq(projects.id, projectId));
  const current = k.db.select().from(projects).where(where).get();
  if (!current) throw notFound('project', projectId);
  const goal = snap.goalId
    ? k.db.select({ id: goals.id }).from(goals).where(and(eq(goals.orgId, orgId), eq(goals.id, snap.goalId))).get()
    : undefined;
  k.db.update(projects).set({ ...snap, goalId: goal?.id ?? null, updatedAt: k.clock.now() }).where(where).run();

  const next = k.db.select().from(projects).where(where).get();
  if (!next) throw notFound('project', projectId);
  const revision = recordRevision(k, orgId, 'project', projectId, next, actor, meta.note);
  k.audit.record({
    orgId, actor, action: 'config.changed', entityKind: 'project', entityId: projectId,
    data: { ...meta.data, revision },
  });
  ctx.after(() => {
    k.bus.emit('project.updated', { orgId, projectId });
    if (next.budgetUsd !== current.budgetUsd) k.bus.emit('budget.updated', { orgId, scope: 'project', scopeId: projectId });
  });
}

/** Dispatch a rollback of Work config. Call inside `ctx.mutate`. */
export function rollbackWorkEntity(ctx: Ctx, orgId: string, kind: WorkKind, entityId: string, rev: ConfigRevision, actor: Actor, meta: Meta): void {
  if (kind === 'goal') rollbackGoal(ctx, orgId, entityId, rev, actor, meta);
  else if (kind === 'playbook') rollbackPlaybook(ctx, orgId, entityId, rev, actor, meta);
  else rollbackProject(ctx, orgId, entityId, rev, actor, meta);
}
