import { and, desc, eq, inArray } from 'drizzle-orm';
import { activityLog, issues } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Agent } from '../contracts/rows.js';
import { SYSTEM } from '../contracts/types.js';
import { parseWait } from '../work/waits.js';
import type { RuntimeDeps } from './types.js';
import type { Wake } from './wakes.js';

/**
 * Stale-work sweep: keeps work that is waiting on an agent moving.
 *
 * An issue is stale when nothing has happened on it (a status or field change, a
 * comment, a hand-off) for longer than its priority allows. Being checked out and
 * released by a run that changed nothing is not progress. Only work whose next step
 * belongs to an agent is swept: the assignee of `todo` / `in_progress` work, the
 * agent reviewer of `in_review` work, and blocked work waiting on another agent or the
 * outside world (see `sweepWait`; date and approval waits reopen on their own). Waits
 * on the owner, on children or on blocker tasks are left alone.
 *
 * The first time an issue goes stale its agent is woken on it. If it is still idle a
 * full window after that nudge, or the agent cannot act (paused or terminated), the
 * work moves up the reporting line: to the agent's manager, and from the top of the
 * line to the owner, where it shows in Needs you. A budget pause is left alone: the
 * owner already sees it as a budget block, and moving the work would spend someone
 * else's budget.
 */

const HOUR = 3_600_000;

/** How long work may sit idle, by priority (0 is the most urgent). */
export const STALL_AFTER_MS: Readonly<Record<number, number>> = { 0: 2 * HOUR, 1: 8 * HOUR, 2: 24 * HOUR, 3: 72 * HOUR };
const stallAfter = (priority: number): number => STALL_AFTER_MS[priority] ?? 24 * HOUR;

export const STALL_NUDGED = 'issue.stall_nudged';
/** Audit entries that are not progress on their own. */
const NOT_PROGRESS = new Set(['issue.checked_out', STALL_NUDGED]);
const LOCK_FIELDS = new Set(['checkoutLock', 'checkoutAt']);

export interface StaleSweepResult {
  nudged: string[];
  escalated: string[];
  /** Blocked issues whose wait ended (a date passed, the approvals were decided), back in todo. */
  reopened: string[];
}

type WakeFn = (orgId: string, agentId: string, wake: Wake) => unknown;

export function idleFor(ms: number): string {
  const hours = Math.round(ms / HOUR);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${Math.round(hours / 24)} days`;
}

export function sweepStaleWork(k: Kernel, d: RuntimeDeps, wake: WakeFn, now = k.clock.now()): StaleSweepResult {
  const result: StaleSweepResult = { nudged: [], escalated: [], reopened: [] };
  for (const org of d.org.listOrgs()) {
    if (d.governance.killSwitch.isEngaged(org.id)) continue;
    const open = k.db.select().from(issues)
      .where(and(eq(issues.orgId, org.id), inArray(issues.status, ['todo', 'in_progress', 'in_review', 'blocked']))).all();
    for (const issue of open) {
      try {
        sweepIssue(issue);
      } catch (err) {
        k.log.warn({ err, orgId: org.id, issueId: issue.id }, 'stale-work sweep step failed');
      }
    }
  }
  if (result.nudged.length || result.escalated.length || result.reopened.length) k.log.info(result, 'stale-work sweep');
  return result;

  function sweepIssue(issue: typeof issues.$inferSelect): void {
    if (issue.checkoutLock) return; // a run is on it right now
    if (issue.status === 'blocked') return sweepWait(issue);
    const review = issue.status === 'in_review';
    if (review && !issue.reviewerAgentId) return; // the owner's review: Needs you
    chase(issue, review ? issue.reviewerAgentId : issue.assigneeAgentId, review
      ? 'It is waiting for your review: give the verdict, or hand it off or escalate it if you cannot.'
      : 'Move it forward, or hand it off or escalate it if you cannot. If it cannot start yet, block it with waitingOn "date" and the time it can.');
  }

  /**
   * A blocked issue. A date wait reopens once the date passes, an approval wait once every approval is
   * decided. A wait on another agent or the outside world is chased like idle work: the agent who acts
   * next (the one waited on, else the assignee) is nudged, then the issue moves up. Waits on the owner,
   * children or blocker tasks are left alone (Needs you shows the first; the others are swept themselves).
   */
  function sweepWait(issue: typeof issues.$inferSelect): void {
    const wait = parseWait(issue.blockedReason);
    if (wait.kind === 'until') {
      if (now >= wait.until) reopen(issue, `The wait until ${new Date(wait.until).toISOString().replace(':00.000Z', 'Z')} is over.`);
      return;
    }
    if (wait.kind === 'approval') {
      const states = wait.approvalIds.map((id) => {
        try {
          return { id, status: d.governance.approvals.get(issue.orgId, id).status as string };
        } catch {
          return { id, status: 'missing' };
        }
      });
      if (states.every((a) => a.status !== 'pending')) reopen(issue, `Approvals decided: ${states.map((a) => `${a.id} ${a.status}`).join(', ')}.`);
      return;
    }
    if (wait.kind === 'agent') {
      const waitedOn = d.org.findAgent(issue.orgId, wait.agent);
      chase(issue, waitedOn?.id ?? issue.assigneeAgentId,
        `It is waiting on you${waitedOn && waitedOn.id !== issue.assigneeAgentId ? ` (for its assignee)` : ''}: ${clipNote(wait.note)} Do your part, or comment on the issue when it will happen.`);
      return;
    }
    if (wait.kind === 'external') {
      chase(issue, issue.assigneeAgentId, `It is waiting on something outside the company: ${clipNote(wait.note)} Check whether it has happened. If it has, carry on; if not, comment what you are still waiting for and when you will check again.`);
    }
  }

  /** Back to todo with a note on the thread, and the assignee woken on it. */
  function reopen(issue: typeof issues.$inferSelect, why: string): void {
    d.work.updateIssue(issue.orgId, issue.id, { status: 'todo', blockedReason: null }, SYSTEM);
    d.work.addComment(issue.orgId, issue.id, { body: `${why} Back in the queue.` }, SYSTEM);
    const assignee = issue.assigneeAgentId ? d.org.findAgent(issue.orgId, issue.assigneeAgentId) : null;
    if (assignee?.status === 'active') {
      wake(issue.orgId, assignee.id, { trigger: 'assignment', issueId: issue.id, triggerNote: `Issue #${issue.number} was waiting and can move again. ${why}` });
    }
    result.reopened.push(issue.id);
  }

  /** Idle work: nudge whoever acts next once, then move it up the reporting line. */
  function chase(issue: typeof issues.$inferSelect, actorId: string | null, ask: string): void {
    const review = issue.status === 'in_review';

    const history = k.db.select({ action: activityLog.action, data: activityLog.data, ts: activityLog.ts }).from(activityLog)
      .where(and(eq(activityLog.orgId, issue.orgId), eq(activityLog.issueId, issue.id)))
      .orderBy(desc(activityLog.ts)).limit(100).all();
    const lastProgress = Math.max(issue.createdAt, ...history.filter(isProgress).map((h) => h.ts));
    const window = stallAfter(issue.priority);
    const idle = now - lastProgress;
    if (idle < window) return;

    const agent = actorId ? d.org.findAgent(issue.orgId, actorId) : null;
    if (agent?.status === 'paused' && agent.pausedReason === 'budget') return;
    const canAct = agent?.status === 'active';
    const nudgedAt = history.find((h) => h.action === STALL_NUDGED && h.ts > lastProgress)?.ts ?? null;

    if (canAct && nudgedAt === null) {
      wake(issue.orgId, agent.id, {
        trigger: 'assignment', issueId: issue.id,
        triggerNote: `Issue #${issue.number} has had no progress for ${idleFor(idle)}. ${ask}`,
      });
      k.audit.record({ orgId: issue.orgId, actor: SYSTEM, action: STALL_NUDGED, entityKind: 'issue', entityId: issue.id, issueId: issue.id, data: { agentId: agent.id, idleMs: idle } });
      result.nudged.push(issue.id);
      return;
    }
    if (canAct && nudgedAt !== null && now - nudgedAt < window) return; // nudged, give it a full window

    const why = !actorId
      ? `No one is assigned and nothing has moved for ${idleFor(idle)}.`
      : !canAct
        ? `${agent ? `${agent.name} is ${agent.status}` : 'Its agent is gone'} and nothing has moved for ${idleFor(idle)}.`
        : `No progress for ${idleFor(idle)}, including a full window after a reminder.`;
    if (review) moveReviewUp(issue, agent, why);
    else moveWorkUp(issue, why);
    result.escalated.push(issue.id);
  }

  /** Work goes to the assignee's manager (back to todo), or to the owner from the top of the line. */
  function moveWorkUp(issue: typeof issues.$inferSelect, why: string): void {
    const updated = d.work.escalate(issue.orgId, issue.id, `Stalled. ${why}`, SYSTEM);
    if (updated.assigneeAgentId && updated.assigneeAgentId !== issue.assigneeAgentId) {
      wake(issue.orgId, updated.assigneeAgentId, {
        trigger: 'assignment', issueId: issue.id,
        triggerNote: `Issue #${issue.number} stalled with its last assignee and was escalated to you. Do it, reassign it, or escalate it.`,
      });
    }
  }

  /** A review goes to the reviewer's manager, or to the owner from the top of the line (it then shows in Needs you). */
  function moveReviewUp(issue: typeof issues.$inferSelect, reviewer: Agent | null, why: string): void {
    const manager = reviewer ? d.org.managerOf(issue.orgId, reviewer.id) : null;
    const next = manager && manager.status === 'active' && manager.id !== issue.assigneeAgentId ? manager : null;
    d.work.updateIssue(issue.orgId, issue.id, { reviewerAgentId: next?.id ?? null }, SYSTEM);
    d.work.addComment(issue.orgId, issue.id, { body: `Review stalled. ${why} The review moved to ${next ? `@${next.slug}` : 'the owner'}.` }, SYSTEM);
    if (next) {
      wake(issue.orgId, next.id, { trigger: 'assignment', issueId: issue.id, triggerNote: `Issue #${issue.number} is waiting for your review (its reviewer stalled). Give the verdict.` });
      return;
    }
    k.bus.emit('notification', {
      orgId: issue.orgId, kind: 'issue.escalated', title: `Review of #${issue.number} needs you: ${issue.title}`, body: why,
      link: `/orgs/${issue.orgId}/issues/${issue.id}`, data: { issueId: issue.id, number: issue.number },
    });
  }
}

const clipNote = (note: string): string => {
  const one = note.replace(/\s+/g, ' ').trim();
  return one.length > 400 ? `${one.slice(0, 399)}…` : one || '(no details)';
};

/** Progress is anything recorded on the issue except a run merely checking it out and releasing it unchanged. */
function isProgress(h: { action: string; data: unknown }): boolean {
  if (NOT_PROGRESS.has(h.action)) return false;
  if (h.action !== 'issue.released') return true;
  const changes = (h.data as { changes?: Record<string, unknown> } | null)?.changes ?? {};
  return Object.keys(changes).some((key) => !LOCK_FIELDS.has(key));
}
