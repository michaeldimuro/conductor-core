import type { Kernel } from '../contracts/kernel.js';
import type { Agent } from '../contracts/rows.js';
import { SYSTEM, type Actor } from '../contracts/types.js';
import { truncate } from '../shared/util.js';
import type { RunJournal } from './journal.js';
import { parkForApprovals, unresolvedApprovals } from './approval-wake.js';
import type { RuntimeDeps } from './types.js';

const RUNTIME: Actor = { kind: 'system', id: 'runtime' };

export interface SettleInput {
  orgId: string;
  issueId: string;
  runId: string;
  agent: Agent;
  outcome: string;
  finalText: string;
  errorMessage: string | null;
}

/**
 * Step 7 of the heartbeat loop — "Report". Always releases the checkout lock.
 * If the agent already reported through conductor-tasks (status moved off
 * in_progress) we only release. Otherwise the runtime posts the result and
 * picks the next status from the run outcome — except that a run which ended
 * with an approval it asked for still unresolved parks the issue instead.
 */
export function settleIssue(k: Kernel, d: RuntimeDeps, journal: RunJournal, s: SettleInput): void {
  const { work } = d;
  const issue = work.getIssue(s.orgId, s.issueId);
  const agentActor: Actor = { kind: 'agent', id: s.agent.id, runId: s.runId };
  const threshold = d.options?.failureEscalationThreshold ?? 3;

  // The agent reported for itself.
  if (issue.status !== 'in_progress') {
    work.release(s.orgId, s.issueId, s.runId);
    announceReview(k, d, s, issue.status);
    return;
  }

  if (s.outcome === 'completed') {
    const openChildren = work
      .listIssues(s.orgId, { parentIssueId: s.issueId })
      .filter((c) => c.status !== 'done' && c.status !== 'cancelled');
    if (s.finalText.trim()) {
      work.addComment(s.orgId, s.issueId, { body: truncate(s.finalText.trim(), 20_000), runId: s.runId }, agentActor);
    }
    if (openChildren.length > 0) {
      // Delegated: park until the children finish (the scheduler wakes the parent).
      work.release(s.orgId, s.issueId, s.runId, { status: 'blocked', blockedReason: 'waiting_on_children' });
      return;
    }
    // An action this work needs is still with the board: the issue is not finished, whatever the run said.
    const waiting = unresolvedApprovals(k, s.orgId, s.issueId, s.agent.id, s.runId);
    if (waiting.length > 0) {
      parkForApprovals(k, d, { orgId: s.orgId, issueId: s.issueId, runId: s.runId, agentId: s.agent.id }, waiting);
      return;
    }
    const needsReview = issue.reviewerAgentId !== null || s.agent.autonomyLevel < 2;
    const status = needsReview ? 'in_review' : 'done';
    work.release(s.orgId, s.issueId, s.runId, { status });
    announceReview(k, d, s, status);
    return;
  }

  if (s.outcome === 'cancelled') {
    work.addComment(s.orgId, s.issueId, { body: `Run ${s.runId} was cancelled${s.errorMessage ? `: ${s.errorMessage}` : ''}. Released back to todo.`, runId: s.runId }, RUNTIME);
    work.release(s.orgId, s.issueId, s.runId, { status: 'todo' });
    return;
  }

  // failed | timeout | max_steps | budget
  const why = {
    timeout: 'hit the wall-time limit',
    max_steps: 'hit the step limit',
    budget: 'hit the budget cap',
  }[s.outcome] ?? 'failed';
  const partial = s.finalText.trim() ? `\n\nPartial output:\n${truncate(s.finalText.trim(), 4000)}` : '';
  work.addComment(
    s.orgId, s.issueId,
    { body: `Run ${s.runId} ${why}${s.errorMessage ? `: ${truncate(s.errorMessage, 1000)}` : ''}.${partial}`, runId: s.runId },
    RUNTIME,
  );

  // The current run is not marked failed yet, so count prior failures + this one.
  const failures = journal.recentFailures(s.issueId, threshold) + 1;
  if (s.outcome === 'budget') {
    work.release(s.orgId, s.issueId, s.runId, { status: 'blocked', blockedReason: 'budget' });
  } else if (failures >= threshold) {
    work.release(s.orgId, s.issueId, s.runId, { status: 'blocked', blockedReason: 'repeated_failures' });
    try {
      work.escalate(s.orgId, s.issueId, `${failures} consecutive failed runs (${why}).`, SYSTEM);
    } catch (err) {
      k.log.warn({ err, issueId: s.issueId }, 'escalation failed');
    }
  } else {
    work.release(s.orgId, s.issueId, s.runId, { status: 'todo' });
  }
}

/** Tell the reviewer (agent or owner) that work is waiting for a verdict. */
function announceReview(k: Kernel, d: RuntimeDeps, s: SettleInput, status: string): void {
  if (status !== 'in_review') return;
  const issue = d.work.getIssue(s.orgId, s.issueId);
  if (issue.reviewerAgentId) {
    const reviewer = d.org.findAgent(s.orgId, issue.reviewerAgentId);
    if (reviewer && reviewer.status === 'active') {
      d.work.addComment(
        s.orgId, s.issueId,
        { body: `@${reviewer.slug} this is ready for your review. Use the review tool to accept, mark as edited, or reject with notes.`, runId: s.runId },
        RUNTIME,
      );
      return;
    }
  }
  k.bus.emit('notification', {
    orgId: s.orgId, kind: 'review', title: `Review needed: ${issue.title}`,
    body: `${s.agent.name} finished work on "${issue.title}" and it is waiting for your review.`,
    actions: [
      { label: 'Accept', action: `review:accepted:${issue.id}` },
      { label: 'Reject', action: `review:rejected:${issue.id}` },
    ],
    data: { issueId: issue.id },
  });
}
