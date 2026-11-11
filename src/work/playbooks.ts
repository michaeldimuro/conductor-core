import { and, asc, eq, sql } from 'drizzle-orm';
import type { WorkService } from '../contracts/org-work.js';
import type { Actor } from '../contracts/types.js';
import { AUTONOMY } from '../contracts/types.js';
import type { Agent, Issue, Playbook } from '../contracts/rows.js';
import { playbooks } from '../db/schema/index.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { parse, requireAgent, requireAssignable, requireOrg, type WorkCtx } from './context.js';
import { applyChanges, createIssue, getIssue } from './issues.js';
import { actingAgent, assertCanAssign, assertCanTouch, assertMayCreateIssues } from './permissions.js';
import { playbookInput } from './schemas.js';
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
    if (agent && agent.autonomyLevel < AUTONOMY.AUTONOMOUS) {
      throw forbidden(`agent ${agent.slug} needs autonomy 2 or higher to author playbooks`);
    }
    if (input.managerAgentId) requireAgent(ctx, orgId, input.managerAgentId);
    for (const step of input.steps) if (step.agentId) requireAgent(ctx, orgId, step.agentId);

    const clash = ctx.kernel.db
      .select({ id: playbooks.id })
      .from(playbooks)
      .where(and(eq(playbooks.orgId, orgId), eq(playbooks.name, input.name)))
      .get();
    if (clash) throw conflict(`a playbook named "${input.name}" already exists`);

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
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'playbook.created',
      entityKind: 'playbook',
      entityId: row.id,
      data: { name: row.name, process: row.process, steps: row.steps.length },
    });
    return row;
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
    assertMayCreateIssues(agent);
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
