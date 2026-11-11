import { and, asc, desc, eq, inArray, isNull, like, ne, notInArray, or } from 'drizzle-orm';
import type { Kernel } from '../contracts/kernel.js';
import type { Issue, Run } from '../contracts/rows.js';
import type { RunGrade } from '../contracts/types.js';
import { comments, runs } from '../db/schema/index.js';
import { NON_LOOP_TRIGGERS } from './scorecard.js';

type Verdict = 'accepted' | 'edited' | 'rejected';
const VERDICTS: readonly string[] = ['accepted', 'edited', 'rejected'];

interface VerdictAt {
  outcome: Verdict;
  ts: number;
}

/** Review verdicts on an issue, oldest first, from the audit trail (`issue.reviewed`). */
function verdicts(kernel: Kernel, issue: Issue): VerdictAt[] {
  return kernel.audit
    .query({ orgId: issue.orgId, issueId: issue.id, action: 'issue.reviewed', limit: 500 })
    .map((r) => ({ id: r.id, ts: r.ts, outcome: r.data?.outcome }))
    .filter((r): r is { id: number; ts: number; outcome: Verdict } => typeof r.outcome === 'string' && VERDICTS.includes(r.outcome))
    .sort((a, b) => a.ts - b.ts || a.id - b.id);
}

/** Real loop runs that worked on the issue, oldest first. */
function workRuns(kernel: Kernel, issue: Issue): Run[] {
  return kernel.db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.orgId, issue.orgId), eq(runs.issueId, issue.id), inArray(runs.status, ['succeeded', 'failed']),
        or(isNull(runs.outcome), ne(runs.outcome, 'no_work')), notInArray(runs.trigger, [...NON_LOOP_TRIGGERS]),
      ),
    )
    .orderBy(asc(runs.createdAt), asc(runs.id))
    .all();
}

/** A verdict judges the work of the latest run that started before it. */
function runJudgedBy(list: Run[], v: VerdictAt): Run | undefined {
  let hit: Run | undefined;
  for (const r of list) if (r.createdAt <= v.ts) hit = r;
  return hit;
}

/**
 * The reviewer's verdict on THIS run's work. `issues.review_outcome` only holds
 * the latest verdict of the issue, so a rework run would inherit the rejection
 * of the run before it; the audit trail says which run each verdict judged.
 * Issues without an audited review fall back to the column.
 */
export function reviewOutcomeFor(kernel: Kernel, run: Run, issue: Issue | null): RunGrade['reviewOutcome'] {
  if (!issue) return null;
  const all = verdicts(kernel, issue);
  if (all.length === 0) return issue.reviewOutcome ?? 'pending';
  const list = workRuns(kernel, issue);
  let outcome: RunGrade['reviewOutcome'] = 'pending';
  for (const v of all) if (runJudgedBy(list, v)?.id === run.id) outcome = v.outcome;
  return outcome;
}

/** The run the issue's latest review verdict judged (null when the issue has no verdict or no run). */
export function reviewedRun(kernel: Kernel, issue: Issue): Run | null {
  const all = verdicts(kernel, issue);
  const list = workRuns(kernel, issue);
  const last = all[all.length - 1];
  if (last) return runJudgedBy(list, last) ?? null;
  return issue.reviewOutcome ? (list[list.length - 1] ?? null) : null;
}

const REVIEW_COMMENT = /^Review (?:rejected — rework needed|accepted|edited):\s*/;

/** The note the reviewer left with the latest verdict (the work context posts it as a `Review …:` comment). */
export function reviewNote(kernel: Kernel, issue: Issue): { text: string; byHuman: boolean } | null {
  const row = kernel.db
    .select({ body: comments.body, authorKind: comments.authorKind })
    .from(comments)
    .where(and(eq(comments.orgId, issue.orgId), eq(comments.issueId, issue.id), like(comments.body, 'Review %')))
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(1)
    .get();
  if (!row || !REVIEW_COMMENT.test(row.body)) return null;
  const text = row.body.replace(REVIEW_COMMENT, '').trim();
  if (!text || text === 'no note given') return null;
  return { text: text.slice(0, 1500), byHuman: row.authorKind === 'human' };
}
