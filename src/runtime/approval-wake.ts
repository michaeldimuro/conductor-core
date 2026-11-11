import { and, eq, inArray } from 'drizzle-orm';
import { approvals } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Approval, Issue } from '../contracts/rows.js';
import { SYSTEM, type Actor } from '../contracts/types.js';
import { truncate } from '../shared/util.js';
import type { RuntimeDeps } from './types.js';

const RUNTIME: Actor = { kind: 'system', id: 'runtime' };

/** `blockedReason` of an issue parked until the board decides an approval its agent asked for. */
export const AWAITING_APPROVAL = 'awaiting_approval';

/**
 * Kinds the filing context carries out by itself the moment they are approved
 * (hire, termination, budget, grants, promotion). The agent has nothing to
 * retry, so they never park an issue.
 */
const SELF_EXECUTING = new Set<string>(['hire_agent', 'terminate_agent', 'budget_raise', 'grant_connector', 'grant_skill', 'promote_skill']);

const hasMatchKey = (a: Approval): boolean => typeof a.payload?.matchKey === 'string';

/**
 * Approvals this agent asked for on this issue whose outcome it has not acted
 * on yet: still pending, or requested by `runId` and decided/expired while
 * that run was still going (the wake telling the agent is queued behind it).
 */
export function unresolvedApprovals(k: Kernel, orgId: string, issueId: string, agentId: string, runId: string): Approval[] {
  const rows = k.db
    .select()
    .from(approvals)
    .where(and(
      eq(approvals.orgId, orgId), eq(approvals.issueId, issueId), eq(approvals.requesterAgentId, agentId),
      inArray(approvals.status, ['pending', 'approved', 'denied', 'expired']),
    ))
    .all();
  return rows.filter((a) => {
    if (SELF_EXECUTING.has(a.kind)) return false;
    if (a.status === 'pending') return true;
    if (a.runId !== runId) return false;
    // Approved and already used inside this run: handled. A grant without a matchKey is never "used", only read.
    if (a.status === 'approved') return a.consumedAt === null && hasMatchKey(a);
    return true;
  });
}

/**
 * Park an issue whose run ended while an approval it asked for is unresolved:
 * blocked (`awaiting_approval`), lock released. The agent is woken on this
 * issue when the board decides (or the request expires) and retries then.
 */
export function parkForApprovals(
  k: Kernel, d: RuntimeDeps,
  s: { orgId: string; issueId: string; runId: string; agentId: string },
  waiting: Approval[],
): void {
  const list = waiting.map((a) => `- ${a.title} (${a.kind}, approval ${a.id}, ${a.status})`).join('\n');
  d.work.addComment(
    s.orgId, s.issueId,
    { body: `Parked: waiting for the board to decide ${waiting.length === 1 ? 'an approval' : `${waiting.length} approvals`} this work needs.\n${list}`, runId: s.runId },
    RUNTIME,
  );
  d.work.release(s.orgId, s.issueId, s.runId, { status: 'blocked', blockedReason: AWAITING_APPROVAL });
  k.audit.record({
    orgId: s.orgId, actor: SYSTEM, action: 'issue.parked', entityKind: 'issue', entityId: s.issueId, runId: s.runId, issueId: s.issueId,
    data: { reason: AWAITING_APPROVAL, agentId: s.agentId, approvalIds: waiting.map((a) => a.id) },
  });
}

function describe(a: Approval, d: RuntimeDeps): string | null {
  const note = a.decisionNote ? ` Board note: "${truncate(a.decisionNote, 600)}".` : '';
  const tool = typeof a.payload?.tool === 'string' ? ` (tool \`${a.payload.tool}\`)` : '';
  let where = '';
  // Always named: the run may end up on other work (the issue was closed, reassigned or lost a checkout race).
  if (a.issueId) {
    const issue = d.work.findIssue(a.orgId, a.issueId);
    if (issue) where = ` It was requested while working on issue "${truncate(issue.title, 120)}" (id ${issue.id}).`;
  }
  const head = `- Approval ${a.id} — "${truncate(a.title, 200)}" [${a.kind}]${tool}`;
  switch (a.status) {
    case 'approved':
      if (SELF_EXECUTING.has(a.kind)) return `${head} was APPROVED.${note} It has been carried out for you; do not repeat the request.${where}`;
      if (a.consumedAt !== null) return `${head} was APPROVED and the action has already run.${note}${where}`;
      return `${head} was APPROVED.${note} Now repeat the exact action that was waiting on it — the same tool with the same arguments — and it will go through.${where}`;
    case 'denied':
      return `${head} was DENIED.${note} The action has NOT run and must not be attempted again. Change course: reach the goal another way, or report what you need and why.${where}`;
    case 'expired':
      return `${head} EXPIRED without a decision. The action has NOT run. If it is still needed, make the same call again to file a fresh request; otherwise carry on without it.${where}`;
    default:
      return null;
  }
}

/**
 * What to tell an agent woken because approvals it requested were decided or
 * expired: which, how, the board's note, and what to do next. Read at run
 * time, so it reflects the approvals as they stand now. Null when none of the
 * ids is a settled approval of this agent.
 */
export function approvalBrief(k: Kernel, d: RuntimeDeps, orgId: string, agentId: string, approvalIds: string[], pinned: Issue | null): string | null {
  const lines: string[] = [];
  for (const id of new Set(approvalIds)) {
    let a: Approval;
    try {
      a = d.governance.approvals.get(orgId, id);
    } catch {
      continue; // unknown here (another org, or gone)
    }
    if (a.requesterAgentId !== agentId) continue;
    const line = describe(a, d);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return null;

  if (pinned) {
    const still = k.db
      .select({ id: approvals.id, title: approvals.title })
      .from(approvals)
      .where(and(eq(approvals.orgId, orgId), eq(approvals.issueId, pinned.id), eq(approvals.requesterAgentId, agentId), eq(approvals.status, 'pending')))
      .all();
    if (still.length) {
      lines.push(
        `Still awaiting a decision (do not retry these yet; you are woken again when they are decided): ${still.map((p) => `"${truncate(p.title, 120)}" (${p.id})`).join('; ')}.`,
      );
    }
  }
  return ['The board has acted on approval request(s) you made:', ...lines].join('\n');
}

/** Blocks the runtime or the work context set for their own reasons; an approval decision does not lift them. */
const OTHER_BLOCKS = new Set<string>(['waiting_on_children', 'budget', 'repeated_failures', 'needs_human', 'escalated_to_owner']);

/**
 * Put an issue parked for an approval back in play so the woken agent can
 * check it out — whether the runtime parked it or the agent reported it
 * blocked itself while waiting. Returns true when it was unparked.
 */
export function unparkForApproval(d: RuntimeDeps, orgId: string, agentId: string, issue: Issue): boolean {
  if (issue.status !== 'blocked' || issue.assigneeAgentId !== agentId) return false;
  if (issue.blockedReason !== null && OTHER_BLOCKS.has(issue.blockedReason)) return false;
  d.work.updateIssue(orgId, issue.id, { status: 'todo', blockedReason: null }, SYSTEM);
  return true;
}
