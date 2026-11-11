import { isAbsolute, normalize, sep } from 'node:path';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { CreateGoalInput, GoalNode, WorkService } from '../contracts/org-work.js';
import type { Actor } from '../contracts/types.js';
import { AUTONOMY } from '../contracts/types.js';
import type { Agent, Goal, Project } from '../contracts/rows.js';
import { departments, goals, issues, projects } from '../db/schema/index.js';
import { forbidden, invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { parse, requireAgent, requireOrg, type WorkCtx } from './context.js';
import { actingAgent } from './permissions.js';
import { goalFilter, goalInput, goalPatch, projectInput } from './schemas.js';

type Level = Goal['level'];
const LEVEL_RANK: Record<Level, number> = { org: 0, dept: 1, agent: 2 };

export function getGoal(ctx: WorkCtx, orgId: string, goalId: string): Goal {
  const row = ctx.kernel.db
    .select()
    .from(goals)
    .where(and(eq(goals.orgId, orgId), eq(goals.id, goalId)))
    .get();
  if (!row) throw notFound('goal', goalId);
  return row;
}

function requireDept(ctx: WorkCtx, orgId: string, deptId: string): void {
  const row = ctx.kernel.db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.orgId, orgId), eq(departments.id, deptId)))
    .get();
  if (!row) throw notFound('department', deptId);
}

/** Tree shape: a goal's parent sits at the same level or above (org → dept → agent). */
function assertParentFits(parent: Goal, level: Level): void {
  if (LEVEL_RANK[parent.level] > LEVEL_RANK[level]) {
    throw invalid(`a ${level}-level goal cannot sit under a ${parent.level}-level goal`);
  }
}

/**
 * Agent actors: autonomy ≥ 2 sets its own (or its reports') agent goals;
 * autonomy 3 (lead) may also set department goals for its own department or a
 * department of its reports. Org-level goals belong to the owner.
 */
function assertAgentMaySetGoal(
  ctx: WorkCtx,
  orgId: string,
  agent: Agent,
  goal: { level: Level; deptId: string | null; ownerAgentId: string | null },
): void {
  if (agent.autonomyLevel < AUTONOMY.AUTONOMOUS) {
    throw forbidden(`agent ${agent.slug} needs autonomy 2 or higher to set goals`);
  }
  if (goal.level === 'org') throw forbidden('org-level goals are set by the owner');
  if (goal.level === 'dept') {
    if (agent.autonomyLevel < AUTONOMY.LEAD) throw forbidden('department goals require autonomy 3 (lead)');
    if (goal.deptId === agent.deptId) return;
    const reports = ctx.org.reportsOf(orgId, agent.id, { transitive: true });
    if (!reports.some((r) => r.deptId === goal.deptId)) {
      throw forbidden(`agent ${agent.slug} may set department goals only for its own department or its reports'`);
    }
    return;
  }
  if (goal.ownerAgentId !== agent.id && !(goal.ownerAgentId && ctx.org.canAssign(orgId, agent.id, goal.ownerAgentId))) {
    throw forbidden(`agent ${agent.slug} may set agent goals only for itself or agents it can assign to`);
  }
}

export function createGoal(ctx: WorkCtx, orgId: string, raw: CreateGoalInput, actor: Actor): Goal {
  const input = parse(goalInput, raw);
  return ctx.tx(() => {
    requireOrg(ctx, orgId);
    const agent = actingAgent(ctx, orgId, actor);
    const parent = input.parentGoalId ? getGoal(ctx, orgId, input.parentGoalId) : null;

    let ownerAgentId = input.ownerAgentId ?? null;
    let deptId = input.deptId ?? null;
    const level: Level = input.level ?? (ownerAgentId ? 'agent' : deptId ? 'dept' : agent ? 'agent' : 'org');
    if (agent && level === 'agent' && !ownerAgentId) ownerAgentId = agent.id;
    if (agent && level === 'dept' && !deptId) deptId = agent.deptId;

    if (level === 'agent' && !ownerAgentId) throw invalid('an agent-level goal needs ownerAgentId');
    if (level === 'dept' && !deptId) throw invalid('a dept-level goal needs deptId');
    if (ownerAgentId) {
      const owner = requireAgent(ctx, orgId, ownerAgentId);
      if (level === 'agent' && !deptId) deptId = owner.deptId;
    }
    if (deptId) requireDept(ctx, orgId, deptId);
    if (parent) assertParentFits(parent, level);
    if (agent) assertAgentMaySetGoal(ctx, orgId, agent, { level, deptId, ownerAgentId });

    const now = ctx.now();
    const row = ctx.kernel.db
      .insert(goals)
      .values({
        id: newId('goal'),
        orgId,
        parentGoalId: parent?.id ?? null,
        level,
        deptId,
        ownerAgentId,
        title: input.title,
        description: input.description ?? '',
        successMetric: input.successMetric ?? '',
        target: input.target ?? '',
        weight: input.weight ?? 1,
        due: input.due ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'goal.created',
      entityKind: 'goal',
      entityId: row.id,
      data: { title: row.title, level, parentGoalId: row.parentGoalId, ownerAgentId, deptId },
    });
    ctx.emit('goal.created', { orgId, goalId: row.id });
    return row;
  });
}

function assertNoGoalCycle(ctx: WorkCtx, orgId: string, goalId: string, parentId: string): void {
  let cursor: string | null = parentId;
  for (let hops = 0; cursor && hops < 1000; hops++) {
    if (cursor === goalId) throw invalid('a goal cannot be its own ancestor');
    cursor = getGoal(ctx, orgId, cursor).parentGoalId;
  }
}

export function updateGoal(
  ctx: WorkCtx,
  orgId: string,
  goalId: string,
  raw: Parameters<WorkService['updateGoal']>[2],
  actor: Actor,
): Goal {
  const patch = parse(goalPatch, raw);
  return ctx.tx(() => {
    const current = getGoal(ctx, orgId, goalId);
    const agent = actingAgent(ctx, orgId, actor);
    const next = {
      level: patch.level ?? current.level,
      deptId: patch.deptId !== undefined ? patch.deptId : current.deptId,
      ownerAgentId: patch.ownerAgentId !== undefined ? patch.ownerAgentId : current.ownerAgentId,
      parentGoalId: patch.parentGoalId !== undefined ? patch.parentGoalId : current.parentGoalId,
    };
    if (next.level === 'agent' && !next.ownerAgentId) throw invalid('an agent-level goal needs ownerAgentId');
    if (next.level === 'dept' && !next.deptId) throw invalid('a dept-level goal needs deptId');
    if (patch.ownerAgentId) requireAgent(ctx, orgId, patch.ownerAgentId);
    if (patch.deptId) requireDept(ctx, orgId, patch.deptId);
    if (next.parentGoalId) {
      assertParentFits(getGoal(ctx, orgId, next.parentGoalId), next.level);
      assertNoGoalCycle(ctx, orgId, goalId, next.parentGoalId);
    }
    if (agent) {
      // Must be entitled to the goal as it is and as it would become.
      assertAgentMaySetGoal(ctx, orgId, agent, current);
      assertAgentMaySetGoal(ctx, orgId, agent, next);
    }

    const row = ctx.kernel.db
      .update(goals)
      .set({
        ...next,
        title: patch.title ?? current.title,
        description: patch.description ?? current.description,
        successMetric: patch.successMetric ?? current.successMetric,
        target: patch.target ?? current.target,
        weight: patch.weight ?? current.weight,
        due: patch.due !== undefined ? patch.due : current.due,
        status: patch.status ?? current.status,
        updatedAt: ctx.now(),
      })
      .where(and(eq(goals.orgId, orgId), eq(goals.id, goalId)))
      .returning()
      .get();
    if (!row) throw notFound('goal', goalId);
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'goal.updated',
      entityKind: 'goal',
      entityId: goalId,
      data: { fields: Object.keys(patch), status: row.status },
    });
    ctx.emit('goal.updated', { orgId, goalId });
    return row;
  });
}

export function listGoals(ctx: WorkCtx, orgId: string, rawFilter?: Parameters<WorkService['listGoals']>[1]): Goal[] {
  const filter = parse(goalFilter, rawFilter);
  const where: SQL[] = [eq(goals.orgId, orgId)];
  if (filter.ownerAgentId) where.push(eq(goals.ownerAgentId, filter.ownerAgentId));
  if (filter.deptId) where.push(eq(goals.deptId, filter.deptId));
  if (filter.status) where.push(eq(goals.status, filter.status));
  return ctx.kernel.db
    .select()
    .from(goals)
    .where(and(...where))
    .orderBy(asc(goals.createdAt), sql`${goals}.rowid`)
    .all();
}

/**
 * Goal tree for an org. `issueCounts` are rolled up: each node counts the
 * issues linked to it and to every goal beneath it (open = not done/cancelled).
 */
export function goalTree(ctx: WorkCtx, orgId: string): GoalNode[] {
  const all = listGoals(ctx, orgId);
  const counts = ctx.kernel.db
    .select({
      goalId: issues.goalId,
      open: sql<number>`sum(case when ${issues.status} not in ('done', 'cancelled') then 1 else 0 end)`,
      done: sql<number>`sum(case when ${issues.status} = 'done' then 1 else 0 end)`,
    })
    .from(issues)
    .where(and(eq(issues.orgId, orgId), sql`${issues.goalId} is not null`))
    .groupBy(issues.goalId)
    .all();
  const direct = new Map(counts.map((c) => [c.goalId, { open: Number(c.open), done: Number(c.done) }]));

  const nodes = new Map<string, GoalNode>();
  for (const goal of all) {
    const c = direct.get(goal.id);
    nodes.set(goal.id, { goal, children: [], issueCounts: { open: c?.open ?? 0, done: c?.done ?? 0 } });
  }
  const roots: GoalNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.goal.parentGoalId ? nodes.get(node.goal.parentGoalId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const rollUp = (node: GoalNode): void => {
    for (const child of node.children) {
      rollUp(child);
      node.issueCounts.open += child.issueCounts.open;
      node.issueCounts.done += child.issueCounts.done;
    }
  };
  roots.forEach(rollUp);
  return roots;
}

/** Highest-weight active goal owned by an agent, if any. */
export function activeGoalOfAgent(ctx: WorkCtx, orgId: string, agentId: string): Goal | null {
  return (
    ctx.kernel.db
      .select()
      .from(goals)
      .where(and(eq(goals.orgId, orgId), eq(goals.ownerAgentId, agentId), eq(goals.status, 'active')))
      .orderBy(desc(goals.weight), asc(goals.createdAt), sql`${goals}.rowid`)
      .limit(1)
      .get() ?? null
  );
}

export function firstActiveOrgGoal(ctx: WorkCtx, orgId: string): Goal | null {
  return (
    ctx.kernel.db
      .select()
      .from(goals)
      .where(and(eq(goals.orgId, orgId), eq(goals.level, 'org'), eq(goals.status, 'active')))
      .orderBy(asc(goals.createdAt), sql`${goals}.rowid`)
      .limit(1)
      .get() ?? null
  );
}

/* ───────────────────────── Projects ───────────────────────── */

export function getProject(ctx: WorkCtx, orgId: string, projectId: string): Project {
  const row = ctx.kernel.db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
    .get();
  if (!row) throw notFound('project', projectId);
  return row;
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
    if (agent && agent.autonomyLevel < AUTONOMY.AUTONOMOUS) {
      throw forbidden(`agent ${agent.slug} needs autonomy 2 or higher to create projects`);
    }
    if (input.goalId) getGoal(ctx, orgId, input.goalId);

    let workspacePath: string | null = null;
    if (input.workspacePath) {
      if (!isAbsolute(input.workspacePath)) throw invalid('workspacePath must be an absolute path');
      workspacePath = normalize(input.workspacePath);
      // The owner may point a project at any repo on the machine; agents stay inside their org's directory.
      if (agent) {
        const orgDir = ctx.kernel.paths.org(org.slug);
        if (workspacePath !== orgDir && !workspacePath.startsWith(orgDir + sep)) {
          throw forbidden('agents may only create projects inside their organization directory');
        }
      }
    }

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
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'project.created',
      entityKind: 'project',
      entityId: row.id,
      data: { name: row.name, goalId: row.goalId },
    });
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
