/**
 * Whether a blocked issue's next step is the owner's. Shared by the Needs-you
 * inbox and the morning digest so both leave out the same things. Pure: no
 * database or browser access.
 *
 * Left out, because something else will move it: a parent whose children are
 * still open (other agents are on them), an issue whose `blockedBy` tasks are
 * still open, and parks whose decision already has its own card (a pending
 * approval, an open sign-in). Every other block (budget, repeated failures, an
 * escalation to the owner, an agent giving up with a reason) waits on the
 * owner, since nothing resumes it on its own.
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
  const reason = issue.blockedReason ?? '';
  if (reason === 'waiting_on_children' && open.some((o) => o.parentIssueId === issue.id)) return false;
  if (issue.blockedBy.some((b) => open.some((o) => o.id === b))) return false;
  if (reason === 'awaiting_approval' && decided.approvalIssues.has(issue.id)) return false;
  if (reason === 'needs_human' && decided.takeoverIssues.has(issue.id)) return false;
  return true;
}
