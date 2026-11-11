import { and, eq } from 'drizzle-orm';
import type { Actor } from '../contracts/types.js';
import { issues } from '../db/schema/index.js';
import type { IssueStatus } from '../db/schema/work.js';
import { ISSUE_STATUSES } from '../db/schema/work.js';
import { invalid } from '../shared/errors.js';
import { parse, type WorkCtx } from './context.js';
import { BLOCKERS_DONE_SQL, applyChanges, getIssue, type IssueChanges } from './issues.js';
import { runIdText } from './schemas.js';
import { WORKABLE_STATUSES, canTransition, isClosed } from './status.js';

const runActor = (runId: string): Actor => ({ kind: 'system', id: 'conductor', runId });

/**
 * Atomic checkout (PRD heartbeat step 4). One conditional UPDATE: SQLite
 * evaluates the WHERE and applies the SET under the write lock, so of any
 * number of racing runs — on this connection or any other — exactly one sees
 * `changes === 1`. The issue must be in the org, workable, and unblocked.
 */
const CHECKOUT_SQL = `
  UPDATE issues
     SET checkout_lock = @runId, checkout_at = @now, status = 'in_progress', updated_at = @now
   WHERE id = @issueId
     AND org_id = @orgId
     AND checkout_lock IS NULL
     AND status IN (${WORKABLE_STATUSES.map((s) => `'${s}'`).join(', ')})
     AND ${BLOCKERS_DONE_SQL}`;

export function checkout(ctx: WorkCtx, orgId: string, issueId: string, runId: string): boolean {
  parse(runIdText, runId);
  const now = ctx.now();
  const won = ctx.kernel.sqlite.prepare(CHECKOUT_SQL).run({ runId, now, issueId, orgId }).changes === 1;
  if (!won) return false;
  ctx.kernel.audit.record({
    orgId,
    actor: runActor(runId),
    action: 'issue.checked_out',
    entityKind: 'issue',
    entityId: issueId,
    issueId,
    runId,
  });
  ctx.emit('issue.updated', { orgId, issueId, status: 'in_progress' });
  return true;
}

/**
 * Release the lock held by `runId` (no-op when that run does not hold it).
 * A requested status is applied only when it is a legal move from where the
 * issue now stands, so releasing never reopens work the run already closed.
 */
export function release(
  ctx: WorkCtx,
  orgId: string,
  issueId: string,
  runId: string,
  to?: { status?: IssueStatus; blockedReason?: string | null },
): void {
  parse(runIdText, runId);
  if (to?.status !== undefined && !ISSUE_STATUSES.includes(to.status)) throw invalid(`unknown status ${to.status}`);
  ctx.tx(() => {
    const issue = getIssue(ctx, orgId, issueId);
    if (issue.checkoutLock !== runId) return;
    const changes: IssueChanges = { checkoutLock: null, checkoutAt: null };
    if (to?.status && to.status !== issue.status && !isClosed(issue.status) && canTransition(issue.status, to.status)) {
      changes.status = to.status;
    }
    const finalStatus = changes.status ?? issue.status;
    if (to?.blockedReason !== undefined && finalStatus === 'blocked') changes.blockedReason = to.blockedReason;
    applyChanges(ctx, issue, changes, runActor(runId), { action: 'issue.released', data: { runId } });
  });
}

/**
 * Crash recovery: drop every lock a run holds. Issues the run left
 * in_progress go back to `toStatus` (default todo); issues it had already
 * moved on (in_review, done, blocked…) keep their status.
 */
export function releaseAllForRun(ctx: WorkCtx, orgId: string, runId: string, toStatus: IssueStatus = 'todo'): string[] {
  parse(runIdText, runId);
  return ctx.tx(() => {
    const held = ctx.kernel.db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(eq(issues.orgId, orgId), eq(issues.checkoutLock, runId)))
      .all();
    for (const h of held) {
      release(ctx, orgId, h.id, runId, h.status === 'in_progress' ? { status: toStatus } : undefined);
    }
    return held.map((h) => h.id);
  });
}
