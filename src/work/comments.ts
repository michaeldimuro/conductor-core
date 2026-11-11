import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import type { TimelineEntry, WorkService } from '../contracts/org-work.js';
import type { Actor } from '../contracts/types.js';
import { AUTONOMY } from '../contracts/types.js';
import type { Comment } from '../contracts/rows.js';
import { comments } from '../db/schema/index.js';
import { invalid } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { parse, type WorkCtx } from './context.js';
import { getIssue } from './issues.js';
import { actingAgent, assertCanTouch } from './permissions.js';
import { commentInput } from './schemas.js';

/** `@agent-slug`, not preceded by a word character (so e-mail addresses do not match). */
const MENTION_RE = /(?<![\w@])@([a-z0-9][a-z0-9-]*)/gi;

/** Resolve `@slug` mentions to agent ids — agents of this org only. */
export function parseMentions(ctx: WorkCtx, orgId: string, body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    // Trailing punctuation ("thanks @ada.") is not part of the slug.
    const slug = (m[1] ?? '').toLowerCase().replace(/-+$/, '');
    if (!slug) continue;
    const agent = ctx.org.findAgent(orgId, slug);
    if (agent && agent.orgId === orgId) ids.add(agent.id);
  }
  return [...ids];
}

export function addComment(
  ctx: WorkCtx,
  orgId: string,
  issueId: string,
  raw: Parameters<WorkService['addComment']>[2],
  actor: Actor,
): Comment {
  const input = parse(commentInput, raw);
  return ctx.tx(() => {
    const issue = getIssue(ctx, orgId, issueId);
    const agent = actingAgent(ctx, orgId, actor);
    // Comments are the channel between agents, so any agent may join a thread —
    // except autonomy 0, which only acts on its own assignments.
    if (agent && agent.autonomyLevel <= AUTONOMY.ASSIST) assertCanTouch(ctx, orgId, agent, issue);

    if (input.parentCommentId) {
      const parent = ctx.kernel.db
        .select({ issueId: comments.issueId })
        .from(comments)
        .where(and(eq(comments.orgId, orgId), eq(comments.id, input.parentCommentId)))
        .get();
      if (!parent || parent.issueId !== issueId) throw invalid('parentCommentId is not a comment on this issue');
    }

    const mentions = parseMentions(ctx, orgId, input.body);
    const row = ctx.kernel.db
      .insert(comments)
      .values({
        id: newId('comment'),
        orgId,
        issueId,
        parentCommentId: input.parentCommentId ?? null,
        authorKind: actor.kind,
        authorId: actor.id ?? null,
        runId: input.runId ?? actor.runId ?? null,
        body: input.body,
        mentions,
        attachments: input.attachments ?? [],
        createdAt: ctx.now(),
      })
      .returning()
      .get();
    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'comment.created',
      entityKind: 'comment',
      entityId: row.id,
      issueId,
      runId: row.runId ?? undefined,
      data: { mentions, attachments: row.attachments.length, parentCommentId: row.parentCommentId },
    });
    ctx.emit('comment.created', { orgId, issueId, commentId: row.id, mentions });
    return row;
  });
}

export function listComments(ctx: WorkCtx, orgId: string, issueId: string, opts?: { since?: number }): Comment[] {
  getIssue(ctx, orgId, issueId);
  const where: SQL[] = [eq(comments.orgId, orgId), eq(comments.issueId, issueId)];
  if (opts?.since !== undefined) where.push(gt(comments.createdAt, opts.since));
  return ctx.kernel.db
    .select()
    .from(comments)
    .where(and(...where))
    .orderBy(asc(comments.createdAt), sql`${comments}.rowid`)
    .all();
}

/** Comments and audit records for the issue, oldest first. */
export function timeline(ctx: WorkCtx, orgId: string, issueId: string): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const activity = ctx.kernel.audit.query({ orgId, issueId, limit: 5000 });
  for (const record of activity.reverse()) {
    // The comment itself is on the timeline; its audit echo would be a duplicate.
    if (record.action === 'comment.created') continue;
    entries.push({ kind: 'activity', ts: record.ts, activity: record });
  }
  for (const comment of listComments(ctx, orgId, issueId)) {
    entries.push({ kind: 'comment', ts: comment.createdAt, comment });
  }
  // Stable sort: on equal timestamps activity precedes comments, each in insertion order.
  return entries.sort((a, b) => a.ts - b.ts);
}
