import { parseWait } from './waits.js';

/**
 * Whether a blocked issue's next step is the owner's. Shared by the Needs-you
 * inbox and the morning digest so both leave out the same things. Pure: no
 * database or browser access.
 *
 * On the owner: an agent's `needs_owner` ask, the runtime's own parks that only the
 * owner can clear (budget, repeated failures, an escalation), and free-text blocks
 * from before waits were structured. Left out, because something else will move
 * it: waits on another agent, a date, approvals or the outside world (the stale-work
 * sweep reopens or chases those), a parent whose children are still open, an issue
 * whose `blockedBy` tasks are still open, and parks whose decision already has its
 * own card (a pending approval, an open sign-in).
 */
export interface BlockedIssue {
  id: string;
  blockedReason: string | null;
  blockedBy: string[];
}
export interface OpenIssueRef {
  id: string;
  parentIssueId: string | null;
}
export interface OwnerDecisions {
  /** Issues with a pending approval. */
  approvalIssues: ReadonlySet<string>;
  /** Issues with an open browser sign-in. */
  takeoverIssues: ReadonlySet<string>;
}

export function blockedOnOwner(issue: BlockedIssue, open: readonly OpenIssueRef[], decided: OwnerDecisions): boolean {
  if (issue.blockedBy.some((b) => open.some((o) => o.id === b))) return false;
  const wait = parseWait(issue.blockedReason);
  switch (wait.kind) {
    case 'owner':
    case 'legacy':
      return true;
    case 'system':
      if (wait.reason === 'waiting_on_children') return !open.some((o) => o.parentIssueId === issue.id);
      if (wait.reason === 'awaiting_approval') return !decided.approvalIssues.has(issue.id);
      if (wait.reason === 'needs_human') return !decided.takeoverIssues.has(issue.id);
      return true;
    default:
      return false;
  }
}
