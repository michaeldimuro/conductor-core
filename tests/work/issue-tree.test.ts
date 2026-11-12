import { describe, expect, it } from 'vitest';
import { buildIssueTree, progress, type TreeIssue } from '../../ui/src/lib/issue-tree.js';

let n = 0;
const issue = (id: string, status: string, parentIssueId: string | null = null, extra: Partial<TreeIssue> = {}): TreeIssue => ({
  id, number: ++n, title: id, status, priority: 2, parentIssueId, blockedBy: [], ...extra,
});

describe('buildIssueTree', () => {
  it('nests sub-issues and rolls up every descendant', () => {
    const tree = buildIssueTree([
      issue('epic', 'in_progress'),
      issue('a', 'done', 'epic'),
      issue('b', 'in_review', 'epic'),
      issue('c', 'in_progress', 'epic'),
      issue('c1', 'blocked', 'c'),
      issue('c2', 'cancelled', 'c'),
      issue('solo', 'todo'),
    ]);
    expect(tree.map((t) => t.issue.id)).toEqual(['epic', 'solo']);
    const epic = tree[0]!;
    expect(epic.rollup).toEqual({ total: 5, done: 1, cancelled: 1, inProgress: 1, inReview: 1, blocked: 1 });
    expect(progress(epic.rollup)).toBe(0.25);
    // Needs-attention first: in review before in progress before done.
    expect(epic.children.map((c) => c.issue.id)).toEqual(['b', 'c', 'a']);
    expect(epic.children[1]!.rollup.total).toBe(2);
    expect(progress(tree[1]!.rollup)).toBeNull();
  });

  it('lists only open blockers as waiting on', () => {
    const tree = buildIssueTree([
      issue('x', 'done'),
      issue('y', 'todo'),
      issue('z', 'todo', null, { blockedBy: ['x', 'y', 'gone'] }),
    ]);
    expect(tree.find((t) => t.issue.id === 'z')!.waitingOn.map((w) => w.id)).toEqual(['y']);
  });

  it('treats an orphan as a root and survives a parent cycle', () => {
    const tree = buildIssueTree([issue('orphan', 'todo', 'missing'), issue('p', 'todo', 'q'), issue('q', 'todo', 'p')]);
    const ids = tree.flatMap(function walk(t): string[] { return [t.issue.id, ...t.children.flatMap(walk)]; });
    expect(ids.sort()).toEqual(['orphan', 'p', 'q']);
  });

  it('keeps ancestors of filter matches and prunes the rest', () => {
    const tree = buildIssueTree(
      [issue('epic', 'todo'), issue('hit', 'todo', 'epic'), issue('miss', 'todo', 'epic'), issue('other', 'todo')],
      (i) => i.id === 'hit',
    );
    expect(tree.map((t) => t.issue.id)).toEqual(['epic']);
    expect(tree[0]!.children.map((c) => c.issue.id)).toEqual(['hit']);
    // The rollup still describes the whole subtree, not only the matches.
    expect(tree[0]!.rollup.total).toBe(2);
  });
});
