import type { Actor } from '../contracts/types.js';
import { AUTONOMY } from '../contracts/types.js';
import type { Agent, Issue } from '../contracts/rows.js';
import { forbidden, invalid } from '../shared/errors.js';
import { requireAgent, type WorkCtx } from './context.js';

/**
 * Actor rules. Human and system actors may do anything; every check below
 * applies to agent actors only (callers pass the row from `actingAgent`).
 */

/** The agent row behind an agent actor (org-scoped); null for human/system actors. */
export function actingAgent(ctx: WorkCtx, orgId: string, actor: Actor): Agent | null {
  if (actor.kind !== 'agent') return null;
  if (!actor.id) throw invalid('agent actor requires an id');
  return requireAgent(ctx, orgId, actor.id);
}

/**
 * An agent may act on issues assigned to it, created by it, or assigned to
 * one of its (transitive) reports. Autonomy 0 only acts on its own assignments.
 */
export function canTouch(ctx: WorkCtx, orgId: string, agent: Agent, issue: Issue): boolean {
  if (issue.assigneeAgentId === agent.id) return true;
  if (agent.autonomyLevel <= AUTONOMY.ASSIST) return false;
  if (issue.creatorKind === 'agent' && issue.creatorId === agent.id) return true;
  if (!issue.assigneeAgentId) return false;
  const assignee = issue.assigneeAgentId;
  return ctx.org.reportsOf(orgId, agent.id, { transitive: true }).some((r) => r.id === assignee);
}

export function assertCanTouch(ctx: WorkCtx, orgId: string, agent: Agent | null, issue: Issue): void {
  if (!agent || canTouch(ctx, orgId, agent, issue)) return;
  throw forbidden(
    agent.autonomyLevel <= AUTONOMY.ASSIST
      ? `agent ${agent.slug} (autonomy 0) may only act on issues assigned to it`
      : `agent ${agent.slug} may only act on issues it is assigned, created, or that are assigned to its reports`,
    { issueId: issue.id },
  );
}

/** Reporting-line rule for assignment/delegation. */
export function assertCanAssign(ctx: WorkCtx, orgId: string, agent: Agent | null, toAgentId: string): void {
  if (!agent) return;
  if (!ctx.org.canAssign(orgId, agent.id, toAgentId)) {
    throw forbidden(`agent ${agent.slug} may assign only to itself, its reports, or a peer through its lead`, {
      fromAgentId: agent.id,
      toAgentId,
    });
  }
}

/** An agent's own work: an issue assigned to it, or one it created itself (its own sub-issue). */
const isOwnWork = (agent: Agent, issue: Issue): boolean =>
  issue.assigneeAgentId === agent.id || (issue.creatorKind === 'agent' && issue.creatorId === agent.id);

/**
 * PRD autonomy levels. 0 (Assist) creates nothing. 1 (Supervised) "creates its
 * own sub-issues": only children of an issue that is its own work. 2+ creates
 * any issue (the reporting-line rule still governs who it may assign to).
 */
export function assertMayCreateIssues(agent: Agent | null, parent?: Issue | null): void {
  if (!agent) return;
  if (agent.autonomyLevel <= AUTONOMY.ASSIST) {
    throw forbidden(`agent ${agent.slug} (autonomy 0) may not create issues`);
  }
  if (agent.autonomyLevel === AUTONOMY.SUPERVISED && !(parent && isOwnWork(agent, parent))) {
    throw forbidden(
      `agent ${agent.slug} (autonomy 1) may only create sub-issues of its own work; pass a parent issue that is assigned to it`,
      { parentIssueId: parent?.id ?? null },
    );
  }
}
