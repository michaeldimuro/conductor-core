/**
 * Issue tree: parent → sub-issue structure with a rollup of everything beneath
 * each node, so a top-level issue can say "4/9 done, 2 in review, 1 blocked"
 * without opening it. Pure, so the tree view and its tests share one source.
 */

export interface TreeIssue {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: number;
  parentIssueId: string | null;
  blockedBy: string[];
}

export interface Rollup {
  /** Descendants, not counting the node itself. */
  total: number;
  done: number;
  cancelled: number;
  inProgress: number;
  inReview: number;
  blocked: number;
}

export interface IssueNode<T extends TreeIssue = TreeIssue> {
  issue: T;
  children: IssueNode<T>[];
  rollup: Rollup;
  /** Issues this one waits on (its own `blockedBy`) that are not done or cancelled. */
  waitingOn: T[];
  /** True when this node or anything under it matched the filter. */
  matched: boolean;
}

const CLOSED = new Set(['done', 'cancelled']);
/** Sibling order: work that needs eyes first, finished work last. */
const STATUS_RANK: Record<string, number> = { blocked: 0, in_review: 1, in_progress: 2, todo: 3, backlog: 4, done: 5, cancelled: 6 };

export const isClosed = (status: string): boolean => CLOSED.has(status);

const emptyRollup = (): Rollup => ({ total: 0, done: 0, cancelled: 0, inProgress: 0, inReview: 0, blocked: 0 });

function add(r: Rollup, status: string): void {
  r.total += 1;
  if (status === 'done') r.done += 1;
  else if (status === 'cancelled') r.cancelled += 1;
  else if (status === 'in_progress') r.inProgress += 1;
  else if (status === 'in_review') r.inReview += 1;
  else if (status === 'blocked') r.blocked += 1;
}

function compare(a: TreeIssue, b: TreeIssue): number {
  return (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.priority - b.priority || a.number - b.number;
}

/** Share of the non-cancelled descendants that are done, 0–1; null when there are none. */
export function progress(r: Rollup): number | null {
  const counted = r.total - r.cancelled;
  return counted > 0 ? r.done / counted : null;
}

/**
 * Build the forest. An issue whose parent is missing (deleted, or beyond the
 * fetched page) becomes a root. `matches`, when given, keeps only nodes that
 * match or have a matching descendant, so filtered results keep their context.
 */
export function buildIssueTree<T extends TreeIssue>(issues: readonly T[], matches?: (issue: T) => boolean): IssueNode<T>[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const i of issues) {
    if (i.parentIssueId && i.parentIssueId !== i.id && byId.has(i.parentIssueId)) {
      const list = kids.get(i.parentIssueId) ?? [];
      list.push(i);
      kids.set(i.parentIssueId, list);
    } else {
      roots.push(i);
    }
  }

  const seen = new Set<string>();
  const grow = (issue: T): IssueNode<T> => {
    seen.add(issue.id);
    const children = (kids.get(issue.id) ?? []).filter((c) => !seen.has(c.id)).sort(compare).map(grow);
    const rollup = emptyRollup();
    for (const c of children) {
      add(rollup, c.issue.status);
      rollup.total += c.rollup.total;
      rollup.done += c.rollup.done;
      rollup.cancelled += c.rollup.cancelled;
      rollup.inProgress += c.rollup.inProgress;
      rollup.inReview += c.rollup.inReview;
      rollup.blocked += c.rollup.blocked;
    }
    const waitingOn = issue.blockedBy.map((id) => byId.get(id)).filter((b): b is T => !!b && !isClosed(b.status));
    const matched = !matches || matches(issue) || children.some((c) => c.matched);
    return { issue, children: matches ? children.filter((c) => c.matched) : children, rollup, waitingOn, matched };
  };

  const forest = roots.sort(compare).map(grow);
  // Issues caught in a parent cycle never hang off a root; surface them rather than drop them.
  for (const i of [...issues].sort(compare)) if (!seen.has(i.id)) forest.push(grow(i));
  return matches ? forest.filter((n) => n.matched) : forest;
}
