import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { WorkService } from '../contracts/org-work.js';
import type { Actor } from '../contracts/types.js';
import { AUTONOMY } from '../contracts/types.js';
import type { Agent, Issue, Playbook } from '../contracts/rows.js';
import { issues, playbooks } from '../db/schema/index.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { parse, requireAgent, requireAssignable, requireOrg, type WorkCtx } from './context.js';
import { applyChanges, createIssue, getIssue } from './issues.js';
import { actingAgent, assertCanAssign, assertCanTouch, assertMayCreateIssues } from './permissions.js';
import { recordRevision } from './revisions.js';
import { playbookInput, playbookPatch } from './schemas.js';
import { isClosed } from './status.js';

type Step = Playbook['steps'][number];

export function getPlaybook(ctx: WorkCtx, orgId: string, playbookId: string): Playbook {
  const row = ctx.kernel.db
    .select()
    .from(playbooks)
    .where(and(eq(playbooks.orgId, orgId), eq(playbooks.id, playbookId)))
    .get();
  if (!row) throw notFound('playbook', playbookId);
  return row;
}

export function listPlaybooks(ctx: WorkCtx, orgId: string): Playbook[] {
  return ctx.kernel.db
    .select()
    .from(playbooks)
    .where(eq(playbooks.orgId, orgId))
    .orderBy(asc(playbooks.name), sql`${playbooks}.rowid`)
    .all();
}

export function createPlaybook(
  ctx: WorkCtx,
  orgId: string,
  raw: Parameters<WorkService['createPlaybook']>[1],
  actor: Actor,
): Playbook {
  const input = parse(playbookInput, raw);
  return ctx.tx(() => {
    requireOrg(ctx, orgId);
    const agent = actingAgent(ctx, orgId, actor);
    assertMayAuthor(agent);
    if (input.managerAgentId) requireAgent(ctx, orgId, input.managerAgentId);
    for (const step of input.steps) if (step.agentId) requireAgent(ctx, orgId, step.agentId);
    assertNameFree(ctx, orgId, input.name);

    const now = ctx.now();
    const row = ctx.kernel.db
      .insert(playbooks)
      .values({
        id: newId('playbook'),
        orgId,
        name: input.name,
        description: input.description ?? '',
        process: input.process ?? 'sequential',
        managerAgentId: input.managerAgentId ?? null,
        steps: input.steps,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const revision = recordRevision(ctx, orgId, 'playbook', row.id, row, actor, 'created');
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'playbook.created',
      entityKind: 'playbook',
      entityId: row.id,
      data: { name: row.name, process: row.process, steps: row.steps.length, revision },
    });
    return row;
  });
}

function assertMayAuthor(agent: Agent | null): void {
  if (agent && agent.autonomyLevel < AUTONOMY.AUTONOMOUS) {
    throw forbidden(`agent ${agent.slug} needs autonomy 2 or higher to author playbooks`);
  }
}

function assertNameFree(ctx: WorkCtx, orgId: string, name: string, exceptId?: string): void {
  const where = [eq(playbooks.orgId, orgId), eq(playbooks.name, name)];
  if (exceptId) where.push(ne(playbooks.id, exceptId));
  const clash = ctx.kernel.db.select({ id: playbooks.id }).from(playbooks).where(and(...where)).get();
  if (clash) throw conflict(`a playbook named "${name}" already exists`);
}

/** Edit a playbook. Issues already created by earlier runs are not touched. */
export function updatePlaybook(
  ctx: WorkCtx,
  orgId: string,
  playbookId: string,
  raw: Parameters<NonNullable<WorkService['updatePlaybook']>>[2],
  actor: Actor,
): Playbook {
  const patch = parse(playbookPatch, raw);
  return ctx.tx(() => {
    const current = getPlaybook(ctx, orgId, playbookId);
    assertMayAuthor(actingAgent(ctx, orgId, actor));
    if (patch.managerAgentId) requireAgent(ctx, orgId, patch.managerAgentId);
    for (const step of patch.steps ?? []) if (step.agentId) requireAgent(ctx, orgId, step.agentId);
    if (patch.name !== undefined && patch.name !== current.name) assertNameFree(ctx, orgId, patch.name, playbookId);

    const row = ctx.kernel.db
      .update(playbooks)
      .set({
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        process: patch.process ?? current.process,
        managerAgentId: patch.managerAgentId !== undefined ? patch.managerAgentId : current.managerAgentId,
        steps: patch.steps ?? current.steps,
        updatedAt: ctx.now(),
      })
      .where(and(eq(playbooks.orgId, orgId), eq(playbooks.id, playbookId)))
      .returning()
      .get();
    if (!row) throw notFound('playbook', playbookId);
    const revision = recordRevision(ctx, orgId, 'playbook', playbookId, row, actor, 'updated');
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'playbook.updated',
      entityKind: 'playbook',
      entityId: playbookId,
      data: { name: row.name, fields: Object.keys(patch), steps: row.steps.length, revision },
    });
    ctx.emit('playbook.changed', { orgId, playbookId, change: 'updated' });
    return row;
  });
}

/**
 * Delete a playbook. Child issues it already created stay as they are; only
 * their link to the playbook is cleared. The last state is kept as a
 * revision, so `rollback` can restore it.
 */
export function deletePlaybook(ctx: WorkCtx, orgId: string, playbookId: string, actor: Actor): void {
  ctx.tx(() => {
    const current = getPlaybook(ctx, orgId, playbookId);
    assertMayAuthor(actingAgent(ctx, orgId, actor));
    const revision = recordRevision(ctx, orgId, 'playbook', playbookId, current, actor, 'deleted');
    const unlinked = ctx.kernel.db
      .update(issues)
      .set({ playbookId: null })
      .where(and(eq(issues.orgId, orgId), eq(issues.playbookId, playbookId)))
      .returning({ id: issues.id })
      .all();
    ctx.kernel.db.delete(playbooks).where(and(eq(playbooks.orgId, orgId), eq(playbooks.id, playbookId))).run();
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'playbook.deleted',
      entityKind: 'playbook',
      entityId: playbookId,
      data: { name: current.name, revision, issuesUnlinked: unlinked.length },
    });
    ctx.emit('playbook.changed', { orgId, playbookId, change: 'deleted' });
  });
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Step assignee: explicit `agentId`, else the first non-terminated agent whose role matches. */
function resolveStepAgent(ctx: WorkCtx, orgId: string, step: Step, roster: () => Agent[]): Agent | null {
  if (step.agentId) return requireAssignable(ctx, orgId, step.agentId);
  if (!step.agentRole) return null;
  const want = norm(step.agentRole);
  const candidates = roster();
  return (
    candidates.find((a) => norm(a.role) === want) ??
    candidates.find((a) => norm(a.role).includes(want) || want.includes(norm(a.role))) ??
    null
  );
}

/**
 * Run a playbook inside an issue (CrewAI processes): one child issue per step,
 * the step's `expectedOutput` becoming the child's.
 *  - sequential: each step is `blockedBy` the previous one, so the inbox
 *    releases them in order; unmatched steps fall to the issue's assignee.
 *  - hierarchical: the manager agent delegates every step (role match or
 *    `agentId`) and is the `reviewerAgentId` of each; unmatched steps fall to
 *    the manager itself.
 */
export function runPlaybook(ctx: WorkCtx, orgId: string, playbookId: string, issueId: string, actor: Actor): Issue[] {
  return ctx.tx(() => {
    const playbook = getPlaybook(ctx, orgId, playbookId);
    const parent = getIssue(ctx, orgId, issueId);
    if (isClosed(parent.status)) throw conflict(`issue #${parent.number} is ${parent.status}; reopen it to run a playbook`);
    const agent = actingAgent(ctx, orgId, actor);
    assertMayCreateIssues(agent, parent);
    assertCanTouch(ctx, orgId, agent, parent);

    const hierarchical = playbook.process === 'hierarchical';
    let manager: Agent | null = null;
    if (hierarchical) {
      const managerId = playbook.managerAgentId ?? parent.assigneeAgentId ?? agent?.id ?? null;
      if (!managerId) throw invalid('a hierarchical playbook needs a manager agent (set managerAgentId or assign the issue)');
      manager = requireAssignable(ctx, orgId, managerId);
      assertCanAssign(ctx, orgId, agent, manager.id);
    }

    let cached: Agent[] | null = null;
    const roster = (): Agent[] =>
      (cached ??= ctx.org.listAgents(orgId).filter((a) => a.orgId === orgId && a.status !== 'terminated'));

    const created: Issue[] = [];
    let previous: Issue | null = null;
    for (const step of playbook.steps) {
      const matched = resolveStepAgent(ctx, orgId, step, roster);
      const assigneeId = matched?.id ?? manager?.id ?? parent.assigneeAgentId ?? null;
      if (assigneeId) {
        assertCanAssign(ctx, orgId, agent, assigneeId);
        // In a hierarchical run the manager is the one delegating.
        if (agent && manager && assigneeId !== manager.id && !ctx.org.canAssign(orgId, manager.id, assigneeId)) {
          throw forbidden(`manager ${manager.slug} cannot delegate "${step.title}" outside its reporting line`);
        }
      }
      const child: Issue = createIssue(
        ctx,
        orgId,
        {
          title: step.title,
          body: step.description,
          expectedOutput: step.expectedOutput,
          assigneeAgentId: assigneeId,
          reviewerAgentId: manager && assigneeId !== manager.id ? manager.id : null,
          parentIssueId: parent.id,
          goalId: parent.goalId,
          projectId: parent.projectId,
          priority: parent.priority,
          playbookId: playbook.id,
          blockedBy: !hierarchical && previous ? [previous.id] : [],
        },
        actor,
        { preauthorized: true },
      );
      created.push(child);
      previous = child;
    }

    applyChanges(ctx, parent, { playbookId: playbook.id }, actor, { action: 'issue.updated' });
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'playbook.run',
      entityKind: 'playbook',
      entityId: playbook.id,
      issueId: parent.id,
      data: { name: playbook.name, process: playbook.process, children: created.map((c) => c.id) },
    });
    return created;
  });
}
