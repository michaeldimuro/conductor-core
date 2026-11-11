import type { IssueStatus } from '../db/schema/work.js';
import { conflict } from '../shared/errors.js';

/**
 * Issue status machine: backlog → todo → in_progress → in_review → done, plus
 * blocked and cancelled. Closed issues only come back through an explicit
 * reopen (done → todo, cancelled → backlog/todo); a rejected review is
 * in_review → todo.
 */
const TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  backlog: ['todo', 'in_progress', 'blocked', 'cancelled'],
  todo: ['backlog', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'],
  in_progress: ['todo', 'in_review', 'done', 'blocked', 'cancelled'],
  in_review: ['todo', 'in_progress', 'done', 'blocked', 'cancelled'],
  blocked: ['backlog', 'todo', 'in_progress', 'cancelled'],
  done: ['todo'],
  cancelled: ['backlog', 'todo'],
};

/** Statuses an agent run may check out. */
export const WORKABLE_STATUSES = ['todo', 'in_progress'] as const satisfies readonly IssueStatus[];
/** Statuses an issue may be created in. */
export const CREATABLE_STATUSES = ['backlog', 'todo', 'in_progress', 'blocked'] as const satisfies readonly IssueStatus[];

export const isClosed = (s: IssueStatus): boolean => s === 'done' || s === 'cancelled';

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: IssueStatus, to: IssueStatus): void {
  if (!canTransition(from, to)) {
    throw conflict(`invalid status transition ${from} → ${to}`, { from, to, allowed: TRANSITIONS[from] });
  }
}
