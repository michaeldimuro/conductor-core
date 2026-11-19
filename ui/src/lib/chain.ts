import type { Issue } from './api.js';

/** Pure helpers for how work depends on work. No browser or network access, so they test in isolation. */

/** Open issues that cannot move until `issue` does: explicit blockers, plus the parent waiting on its children. */
type Node = Pick<Issue, 'id' | 'parentIssueId' | 'blockedBy'>;

export function holdingUp<T extends Node>(issue: Pick<Issue, 'id' | 'parentIssueId'>, open: T[]): T[] {
  const out = open.filter((o) => o.id !== issue.id && o.blockedBy.includes(issue.id));
  const parent = issue.parentIssueId ? open.find((o) => o.id === issue.parentIssueId) : undefined;
  if (parent && !out.includes(parent)) out.push(parent);
  return out;
}

/** Everything transitively waiting on `id` (a chain of blockers), counted once. */
export function chainSize(id: string, parentId: string | null, open: Node[]): number {
  const seen = new Set<string>();
  const stack = [{ id, parentIssueId: parentId }];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of holdingUp(cur, open)) {
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      stack.push(next);
    }
  }
  return seen.size;
}

/** Whether a blocked issue's next step is the owner's (shared with the morning digest). */
export { blockedOnOwner } from '../../../src/work/owner-blocks.js';

/** Markdown to one readable line: no fences, links, emphasis or headings. */
export function plain(md: string, max = 200): string {
  const text = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
