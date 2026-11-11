import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Inbox } from '../contracts/org-work.js';
import type { Comment } from '../contracts/rows.js';
import { comments, goals, inboxCursors, issues, runs } from '../db/schema/index.js';
import { invalid } from '../shared/errors.js';
import { requireAgent, type WorkCtx } from './context.js';
import { BLOCKERS_DONE_SQL } from './issues.js';
import { WORKABLE_STATUSES } from './status.js';

const COMMENT_LIMIT = 500;

function cursorOf(ctx: WorkCtx, orgId: string, agentId: string): number {
  const row = ctx.kernel.db
    .select({ lastSeenAt: inboxCursors.lastSeenAt })
    .from(inboxCursors)
    .where(and(eq(inboxCursors.orgId, orgId), eq(inboxCursors.agentId, agentId)))
    .get();
  return row?.lastSeenAt ?? 0;
}

/**
 * PRD heartbeat step 3. Issues: assigned to the agent, workable, not locked
 * by another agent's run, every blocker done — by priority, then goal weight,
 * then age. Comments/mentions: since the agent's cursor, never its own.
 */
export function inbox(ctx: WorkCtx, orgId: string, agentId: string): Inbox {
  requireAgent(ctx, orgId, agentId);
  const db = ctx.kernel.db;

  const ownRuns = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.agentId, agentId)));
  const rows = db
    .select({ issue: issues })
    .from(issues)
    .leftJoin(goals, and(eq(goals.id, issues.goalId), eq(goals.orgId, issues.orgId)))
    .where(
      and(
        eq(issues.orgId, orgId),
        eq(issues.assigneeAgentId, agentId),
        inArray(issues.status, [...WORKABLE_STATUSES]),
        or(isNull(issues.checkoutLock), inArray(issues.checkoutLock, ownRuns)),
        sql.raw(BLOCKERS_DONE_SQL),
      ),
    )
    .orderBy(asc(issues.priority), sql`coalesce(${goals.weight}, 0) DESC`, asc(issues.createdAt), asc(issues.number))
    .all();

  const since = cursorOf(ctx, orgId, agentId);
  const fresh = and(
    eq(comments.orgId, orgId),
    gt(comments.createdAt, since),
    sql`NOT (${comments.authorKind} = 'agent' AND ${comments.authorId} IS ${agentId})`,
  );
  const order = [asc(comments.createdAt), sql`${comments}.rowid`] as const;

  const newComments: Comment[] = db
    .select({ comment: comments })
    .from(comments)
    .innerJoin(issues, and(eq(issues.id, comments.issueId), eq(issues.orgId, comments.orgId)))
    .where(
      and(
        fresh,
        or(
          eq(issues.assigneeAgentId, agentId),
          eq(issues.reviewerAgentId, agentId),
          and(eq(issues.creatorKind, 'agent'), eq(issues.creatorId, agentId)),
        ),
      ),
    )
    .orderBy(...order)
    .limit(COMMENT_LIMIT)
    .all()
    .map((r) => r.comment);

  const mentions: Comment[] = db
    .select()
    .from(comments)
    .where(and(fresh, sql`EXISTS (SELECT 1 FROM json_each(${comments.mentions}) WHERE value = ${agentId})`))
    .orderBy(...order)
    .limit(COMMENT_LIMIT)
    .all();

  return { issues: rows.map((r) => r.issue), newComments, mentions };
}

export function markInboxSeen(ctx: WorkCtx, orgId: string, agentId: string, at?: number): void {
  requireAgent(ctx, orgId, agentId);
  if (at !== undefined && (!Number.isSafeInteger(at) || at < 0)) throw invalid('at must be a non-negative timestamp');
  const lastSeenAt = at ?? ctx.now();
  ctx.kernel.db
    .insert(inboxCursors)
    .values({ agentId, orgId, lastSeenAt })
    .onConflictDoUpdate({ target: inboxCursors.agentId, set: { lastSeenAt, orgId } })
    .run();
}
