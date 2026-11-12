import { basename } from 'node:path';
import type { CreateIssueInput } from '../../contracts/org-work.js';
import { AUTONOMY } from '../../contracts/types.js';
import type { IssueStatus } from '../../db/schema/work.js';
import { truncate } from '../../shared/util.js';
import { publishRunArtifact } from '../artifacts.js';
import {
  actorOf, commentView, issueBrief, issueFull, resolveAgent, resolveIssue, sanitizeArtifacts,
  type Handlers,
} from './support.js';

type IssueTools =
  | 'inbox' | 'get_issue' | 'search_issues' | 'create_issue' | 'update_issue' | 'comment'
  | 'delegate' | 'escalate' | 'report_progress' | 'save_artifact' | 'review_issue' | 'reassign';

export const issueHandlers: Handlers<IssueTools> = {
  inbox(env, ctx) {
    const box = env.work.inbox(ctx.orgId, ctx.agentId);
    return {
      issues: box.issues.map((i) => ({ ...issueBrief(i), expectedOutput: i.expectedOutput })),
      newComments: box.newComments.map(commentView),
      mentions: box.mentions.map(commentView),
    };
  },

  get_issue(env, ctx, args) {
    const issue = resolveIssue(env, ctx, args.issue);
    const blockers = issue.blockedBy.flatMap((id) => {
      const b = env.work.findIssue(ctx.orgId, id);
      return b ? [{ id: b.id, number: b.number, title: b.title, status: b.status }] : [];
    });
    return {
      issue: issueFull(issue),
      blockers,
      children: env.work.listIssues(ctx.orgId, { parentIssueId: issue.id, limit: 200 }).map(issueBrief),
      files: (env.work.listIssueFiles?.(ctx.orgId, issue.id) ?? []).map((f) => ({ name: f.name, path: f.file, bytes: f.bytes })),
      comments: env.work.listComments(ctx.orgId, issue.id).map(commentView),
    };
  },

  search_issues(env, ctx, args) {
    const matches = env.work.listIssues(ctx.orgId, {
      search: args.query,
      status: args.status,
      limit: args.limit ?? 20,
    });
    return { count: matches.length, issues: matches.map(issueBrief) };
  },

  create_issue(env, ctx, args) {
    // Autonomy 1 "creates its own sub-issues": without an explicit parent the new issue hangs off the current one.
    const parentRef = args.parentIssue ?? (ctx.autonomyLevel === AUTONOMY.SUPERVISED ? (ctx.issueId ?? undefined) : undefined);
    const input: CreateIssueInput = {
      title: args.title,
      body: args.body,
      expectedOutput: args.expectedOutput,
      taskType: args.taskType,
      goalId: args.goalId,
      projectId: args.projectId,
      priority: args.priority,
      labels: args.labels,
      assigneeAgentId: args.assignee ? resolveAgent(env, ctx, args.assignee).id : undefined,
      reviewerAgentId: args.reviewer ? resolveAgent(env, ctx, args.reviewer).id : undefined,
      parentIssueId: parentRef !== undefined ? resolveIssue(env, ctx, parentRef).id : undefined,
      blockedBy: args.blockedBy?.map((ref) => resolveIssue(env, ctx, ref).id),
    };
    return { issue: issueFull(env.work.createIssue(ctx.orgId, input, actorOf(ctx))) };
  },

  update_issue(env, ctx, args) {
    const issue = resolveIssue(env, ctx, args.issue);
    const updated = env.work.updateIssue(
      ctx.orgId,
      issue.id,
      {
        title: args.title,
        body: args.body,
        expectedOutput: args.expectedOutput,
        priority: args.priority,
        labels: args.labels,
        goalId: args.goalId,
        status: args.status,
        blockedReason: args.blockedReason,
        blockedBy: args.blockedBy?.map((ref) => resolveIssue(env, ctx, ref).id),
      },
      actorOf(ctx),
    );
    return { issue: issueFull(updated) };
  },

  comment(env, ctx, args) {
    const issue = resolveIssue(env, ctx, args.issue);
    const comment = env.work.addComment(
      ctx.orgId,
      issue.id,
      {
        body: args.body,
        parentCommentId: args.parentCommentId,
        attachments: sanitizeArtifacts(env, ctx, args.attachments),
        runId: ctx.runId,
      },
      actorOf(ctx),
    );
    return { comment: commentView(comment) };
  },

  delegate(env, ctx, args) {
    const parent = resolveIssue(env, ctx, args.issue);
    const children: CreateIssueInput[] = args.children.map((c) => ({
      title: c.title,
      body: c.body,
      expectedOutput: c.expectedOutput,
      taskType: c.taskType,
      priority: c.priority,
      labels: c.labels,
      assigneeAgentId: resolveAgent(env, ctx, c.assignee).id,
      reviewerAgentId: c.reviewer ? resolveAgent(env, ctx, c.reviewer).id : undefined,
    }));
    const created = env.work.delegate(ctx.orgId, parent.id, children, actorOf(ctx));
    return { parent: issueBrief(parent), children: created.map(issueBrief) };
  },

  escalate(env, ctx, args) {
    const issue = resolveIssue(env, ctx, args.issue);
    const updated = env.work.escalate(ctx.orgId, issue.id, args.reason, actorOf(ctx));
    return {
      issue: issueBrief(updated),
      escalatedTo: updated.blockedReason === 'escalated_to_owner' ? 'owner' : updated.assigneeAgentId,
    };
  },

  /** PRD heartbeat step 7: comment with results and artifacts, then done / in_review / blocked. */
  report_progress(env, ctx, args) {
    const issue = resolveIssue(env, ctx, args.issue);
    const attachments = sanitizeArtifacts(env, ctx, args.artifacts);

    let status: IssueStatus = args.status;
    let note: string | undefined;
    if (status === 'done' && (issue.reviewerAgentId !== null || ctx.autonomyLevel < AUTONOMY.AUTONOMOUS)) {
      status = 'in_review';
      note = issue.reviewerAgentId
        ? 'The issue has a reviewer, so it was moved to in_review instead of done.'
        : 'Closing work directly needs autonomy 2+, so it was moved to in_review for the owner.';
    }

    let body = args.summary;
    if (status === 'blocked') body = `Blocked: ${args.blockedReason ?? args.summary}\n\n${args.summary}`;
    if (status === 'in_review' && issue.reviewerAgentId && issue.reviewerAgentId !== ctx.agentId) {
      const reviewer = env.org.findAgent(ctx.orgId, issue.reviewerAgentId);
      if (reviewer && reviewer.orgId === ctx.orgId) body += `\n\nReview requested: @${reviewer.slug}`;
    }

    // Status first: an illegal transition or a permission failure must not leave a stray comment.
    const actor = actorOf(ctx);
    const updated = env.work.updateIssue(
      ctx.orgId,
      issue.id,
      status === 'blocked'
        ? { status, blockedReason: truncate(args.blockedReason ?? args.summary, 1900) }
        : { status },
      actor,
    );
    const comment = env.work.addComment(ctx.orgId, issue.id, { body, attachments, runId: ctx.runId }, actor);
    return { issue: issueBrief(updated), status: updated.status, commentId: comment.id, ...(note ? { note } : {}) };
  },

  /** Put a workspace file in the org's artifact store, where the dashboard can show it. */
  save_artifact(env, ctx, args) {
    const [checked] = sanitizeArtifacts(env, ctx, [{ name: args.name ?? basename(args.path), path: args.path }]);
    const org = env.org.getOrg(ctx.orgId);
    const issueId = ctx.issueId ?? null;
    const saved = publishRunArtifact(env.kernel.paths, org.slug, { issueId, runId: ctx.runId }, checked!.path, checked!.name);
    env.kernel.audit.record({
      orgId: ctx.orgId, actor: actorOf(ctx), action: 'artifact.saved', entityKind: 'issue', entityId: issueId ?? ctx.runId,
      runId: ctx.runId, issueId: issueId ?? undefined, data: { name: saved.name, bytes: saved.bytes, source: 'save_artifact' },
    });
    env.kernel.bus.emit('artifact.saved', { orgId: ctx.orgId, path: saved.path, issueId, runId: ctx.runId });
    return {
      saved: saved.name, path: saved.file, bytes: saved.bytes,
      note: issueId ? 'Visible on the issue and in the dashboard\'s Artifacts. Attach it to your report with this path.' : 'The operator can open it from this chat and the dashboard\'s Artifacts page.',
    };
  },

  review_issue(env, ctx, args) {
    const issue = resolveIssue(env, ctx, args.issue);
    const updated = env.work.review(ctx.orgId, issue.id, args.outcome, args.note || undefined, actorOf(ctx));
    return { issue: issueBrief(updated), reviewOutcome: updated.reviewOutcome, reworkCount: updated.reworkCount };
  },

  reassign(env, ctx, args) {
    const issue = resolveIssue(env, ctx, args.issue);
    const assigneeId = args.assignee === null ? null : resolveAgent(env, ctx, args.assignee).id;
    return { issue: issueBrief(env.work.assign(ctx.orgId, issue.id, assigneeId, actorOf(ctx))) };
  },
};
