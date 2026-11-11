import type { CreateIssueInput } from '../contracts/org-work.js';
import type { Actor } from '../contracts/types.js';
import type { Issue } from '../contracts/rows.js';
import { conflict, forbidden, invalid } from '../shared/errors.js';
import { parse, type WorkCtx } from './context.js';
import { addComment } from './comments.js';
import { applyChanges, createIssue, getIssue, type IssueChanges } from './issues.js';
import { actingAgent, assertCanTouch, assertMayCreateIssues, canTouch } from './permissions.js';
import { reasonText, reviewOutcome } from './schemas.js';
import { isClosed } from './status.js';

const actorLabel = (actor: Actor): string => (actor.kind === 'human' ? 'the owner' : `${actor.kind} ${actor.id ?? ''}`.trim());

/**
 * PRD heartbeat step 5: split an issue into child issues and delegate down
 * the reporting line. Children inherit the parent's goal and project; the
 * parent stays open. Atomic — one refused child refuses the whole split.
 */
export function delegate(
  ctx: WorkCtx,
  orgId: string,
  parentIssueId: string,
  children: CreateIssueInput[],
  actor: Actor,
): Issue[] {
  if (!Array.isArray(children) || children.length === 0) throw invalid('delegate needs at least one child issue');
  if (children.length > 50) throw invalid('delegate accepts at most 50 child issues');
  return ctx.tx(() => {
    const parent = getIssue(ctx, orgId, parentIssueId);
    if (isClosed(parent.status)) throw conflict(`issue #${parent.number} is ${parent.status} and cannot be split`);
    const agent = actingAgent(ctx, orgId, actor);
    assertMayCreateIssues(agent, parent);
    assertCanTouch(ctx, orgId, agent, parent);

    // createIssue applies the reporting-line rule to each assignee.
    const created = children.map((child) =>
      createIssue(
        ctx,
        orgId,
        {
          ...child,
          parentIssueId: parent.id,
          goalId: child.goalId ?? parent.goalId,
          projectId: child.projectId ?? parent.projectId,
        },
        actor,
      ),
    );
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'issue.delegated',
      entityKind: 'issue',
      entityId: parent.id,
      issueId: parent.id,
      data: { children: created.map((c) => ({ id: c.id, number: c.number, assigneeAgentId: c.assigneeAgentId })) },
    });
    return created;
  });
}

/**
 * Escalation flows up the reporting line: the issue is reassigned to the
 * assignee's manager and returned to todo. At the root the Owner is next, so
 * the issue is blocked with reason `escalated_to_owner` and the owner notified.
 */
export function escalate(ctx: WorkCtx, orgId: string, issueId: string, rawReason: string, actor: Actor): Issue {
  const reason = parse(reasonText, rawReason);
  return ctx.tx(() => {
    const issue = getIssue(ctx, orgId, issueId);
    if (isClosed(issue.status)) throw conflict(`issue #${issue.number} is ${issue.status} and cannot be escalated`);
    const agent = actingAgent(ctx, orgId, actor);
    assertCanTouch(ctx, orgId, agent, issue);

    const from = issue.assigneeAgentId ?? agent?.id ?? null;
    const manager = from ? ctx.org.managerOf(orgId, from) : null;
    if (manager && manager.orgId !== orgId) throw invalid('manager is outside this organization');

    // The escalating run gives up its claim so the next owner can pick the issue up.
    const changes: IssueChanges =
      actor.runId && issue.checkoutLock === actor.runId ? { checkoutLock: null, checkoutAt: null } : {};
    if (manager) {
      changes.assigneeAgentId = manager.id;
      changes.status = 'todo';
    } else {
      changes.status = 'blocked';
      changes.blockedReason = 'escalated_to_owner';
    }
    const updated = applyChanges(ctx, issue, changes, actor, {
      action: 'issue.escalated',
      data: { reason, fromAgentId: from, toAgentId: manager?.id ?? null, toOwner: !manager },
    });
    addComment(
      ctx,
      orgId,
      issueId,
      { body: `Escalated to ${manager ? `@${manager.slug}` : 'the owner'} by ${actorLabel(actor)}: ${reason}` },
      actor,
    );
    if (!manager) {
      ctx.emit('notification', {
        orgId,
        kind: 'issue.escalated',
        title: `Issue #${issue.number} escalated to you: ${issue.title}`,
        body: reason,
        link: `/orgs/${orgId}/issues/${issue.id}`,
        data: { issueId: issue.id, number: issue.number, fromAgentId: from, reason },
      });
    }
    return updated;
  });
}

/**
 * Reviewer verdict on an in_review issue. accepted → done; edited → done with
 * `reviewOutcome = 'edited'`; rejected → todo, `reworkCount + 1`, and the note
 * posted as a comment. Agent reviewers must be the named reviewer or manage
 * the assignee; nobody reviews their own work.
 */
export function review(
  ctx: WorkCtx,
  orgId: string,
  issueId: string,
  rawOutcome: 'accepted' | 'edited' | 'rejected',
  note: string | undefined,
  actor: Actor,
): Issue {
  const outcome = parse(reviewOutcome, rawOutcome);
  if (note !== undefined && typeof note !== 'string') throw invalid('note must be a string');
  return ctx.tx(() => {
    const issue = getIssue(ctx, orgId, issueId);
    if (issue.status !== 'in_review') {
      throw conflict(`issue #${issue.number} is ${issue.status}, not in_review`, { status: issue.status });
    }
    const agent = actingAgent(ctx, orgId, actor);
    if (agent) {
      if (issue.assigneeAgentId === agent.id) throw forbidden('an agent cannot review its own work');
      if (issue.reviewerAgentId !== agent.id && !canTouch(ctx, orgId, agent, issue)) {
        throw forbidden(`agent ${agent.slug} is not the reviewer of issue #${issue.number}`);
      }
    }

    const changes: IssueChanges =
      outcome === 'rejected'
        ? { status: 'todo', reviewOutcome: 'rejected', reworkCount: issue.reworkCount + 1 }
        : { status: 'done', reviewOutcome: outcome };
    const updated = applyChanges(ctx, issue, changes, actor, { action: 'issue.reviewed', data: { outcome } });
    ctx.emit('issue.reviewed', { orgId, issueId, outcome });

    const text = note?.trim();
    if (outcome === 'rejected') {
      addComment(ctx, orgId, issueId, { body: `Review rejected — rework needed: ${text || 'no note given'}` }, actor);
    } else if (text) {
      addComment(ctx, orgId, issueId, { body: `Review ${outcome}: ${text}` }, actor);
    }
    return updated;
  });
}
