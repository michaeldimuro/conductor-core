import { isAbsolute, normalize, sep } from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { WorkService } from '../contracts/org-work.js';
import type { Actor } from '../contracts/types.js';
import { AUTONOMY } from '../contracts/types.js';
import type { Agent, Organization, Project } from '../contracts/rows.js';
import { projects } from '../db/schema/index.js';
import { forbidden, invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { parse, requireOrg, type WorkCtx } from './context.js';
import { getGoal } from './goals.js';
import { actingAgent } from './permissions.js';
import { recordRevision } from './revisions.js';
import { projectInput, projectPatch } from './schemas.js';

export function getProject(ctx: WorkCtx, orgId: string, projectId: string): Project {
  const row = ctx.kernel.db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
    .get();
  if (!row) throw notFound('project', projectId);
  return row;
}

function assertAgentMayManageProjects(agent: Agent | null, what: string): void {
  if (agent && agent.autonomyLevel < AUTONOMY.AUTONOMOUS) {
    throw forbidden(`agent ${agent.slug} needs autonomy 2 or higher to ${what} projects`);
  }
}

/** The owner may point a project at any repo on the machine; agents stay inside their org's directory. */
function resolveWorkspace(ctx: WorkCtx, org: Organization, agent: Agent | null, raw: string): string {
  if (!isAbsolute(raw)) throw invalid('workspacePath must be an absolute path');
  const workspacePath = normalize(raw);
  if (agent) {
    const orgDir = ctx.kernel.paths.org(org.slug);
    if (workspacePath !== orgDir && !workspacePath.startsWith(orgDir + sep)) {
      throw forbidden('agents may only create projects inside their organization directory');
    }
  }
  return workspacePath;
}

export function createProject(
  ctx: WorkCtx,
  orgId: string,
  raw: Parameters<WorkService['createProject']>[1],
  actor: Actor,
): Project {
  const input = parse(projectInput, raw);
  return ctx.tx(() => {
    const org = requireOrg(ctx, orgId);
    const agent = actingAgent(ctx, orgId, actor);
    assertAgentMayManageProjects(agent, 'create');
    if (input.goalId) getGoal(ctx, orgId, input.goalId);
    const workspacePath = input.workspacePath ? resolveWorkspace(ctx, org, agent, input.workspacePath) : null;

    const now = ctx.now();
    const row = ctx.kernel.db
      .insert(projects)
      .values({
        id: newId('project'),
        orgId,
        goalId: input.goalId ?? null,
        name: input.name,
        workspacePath,
        budgetUsd: input.budgetUsd ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const revision = recordRevision(ctx, orgId, 'project', row.id, row, actor, 'created');
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'project.created',
      entityKind: 'project',
      entityId: row.id,
      data: { name: row.name, goalId: row.goalId, revision },
    });
    return row;
  });
}

/**
 * Edit or archive a project. Budgets are board-controlled ("raising a budget"
 * is approval-gated), so an agent actor may not change `budgetUsd` here.
 */
export function updateProject(
  ctx: WorkCtx,
  orgId: string,
  projectId: string,
  raw: Parameters<NonNullable<WorkService['updateProject']>>[2],
  actor: Actor,
): Project {
  const patch = parse(projectPatch, raw);
  return ctx.tx(() => {
    const org = requireOrg(ctx, orgId);
    const current = getProject(ctx, orgId, projectId);
    const agent = actingAgent(ctx, orgId, actor);
    assertAgentMayManageProjects(agent, 'change');
    if (agent && patch.budgetUsd !== undefined && patch.budgetUsd !== current.budgetUsd) {
      throw forbidden('project budgets are set by the owner; use request_approval (budget_raise) to ask for a change');
    }

    const set: Partial<typeof projects.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.goalId !== undefined) set.goalId = patch.goalId ? getGoal(ctx, orgId, patch.goalId).id : null;
    if (patch.workspacePath !== undefined) {
      set.workspacePath = patch.workspacePath ? resolveWorkspace(ctx, org, agent, patch.workspacePath) : null;
    }
    if (patch.budgetUsd !== undefined) set.budgetUsd = patch.budgetUsd;
    if (patch.status !== undefined) set.status = patch.status;
    const fields = (Object.keys(set) as Array<keyof typeof set>).filter((f) => set[f] !== current[f as keyof Project]);
    if (fields.length === 0) return current;

    const row = ctx.kernel.db
      .update(projects)
      .set({ ...set, updatedAt: ctx.now() })
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
      .returning()
      .get();
    if (!row) throw notFound('project', projectId);
    const revision = recordRevision(ctx, orgId, 'project', row.id, row, actor, row.status !== current.status ? row.status : 'updated');
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: row.status !== current.status && row.status === 'archived' ? 'project.archived' : 'project.updated',
      entityKind: 'project',
      entityId: row.id,
      data: { fields, revision, status: row.status },
    });
    ctx.emit('project.updated', { orgId, projectId: row.id });
    if (fields.includes('budgetUsd')) ctx.emit('budget.updated', { orgId, scope: 'project', scopeId: row.id });
    return row;
  });
}

export function listProjects(ctx: WorkCtx, orgId: string): Project[] {
  return ctx.kernel.db
    .select()
    .from(projects)
    .where(eq(projects.orgId, orgId))
    .orderBy(asc(projects.createdAt), sql`${projects}.rowid`)
    .all();
}
