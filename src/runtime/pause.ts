import type { Kernel } from '../contracts/kernel.js';
import { SYSTEM } from '../contracts/types.js';
import type { ActiveRun } from './executor.js';
import type { RunJournal } from './journal.js';
import type { RuntimeDeps } from './types.js';

/** A run token outlives its run's wall-time limit by this much (final report, cleanup). */
export const RUN_TOKEN_GRACE_MS = 10 * 60_000;
/** How far a paused run's token is pushed out at a time; re-applied every minute while the pause lasts. */
export const PAUSE_TOKEN_HORIZON_MS = 24 * 3_600_000;

type Tokens = RuntimeDeps['governance']['tokens'];

/**
 * Initial TTL for a run token. With `extendRunToken` the token is kept exactly
 * as long as the run may live and pushed out on pause. Without it, the token
 * carries a fixed pause allowance up front — it is revoked the moment the run
 * ends either way.
 */
export function runTokenTtl(tokens: Tokens, maxWallMs: number): number {
  return maxWallMs + RUN_TOKEN_GRACE_MS + (tokens.extendRunToken ? 0 : PAUSE_TOKEN_HORIZON_MS);
}

/** Wall time the run has actually used (paused time excluded). */
export function activeWallMs(a: ActiveRun, now = Date.now()): number {
  if (a.execStartedAt === null) return 0;
  const paused = a.pausedMs + (a.pausedAt !== null ? now - a.pausedAt : 0);
  return Math.max(0, now - a.execStartedAt - paused);
}

function extendToken(k: Kernel, d: RuntimeDeps, a: ActiveRun, extraMs: number): void {
  const tokens = d.governance.tokens;
  if (!tokens.extendRunToken) return;
  try {
    const left = Math.max(0, a.agent.maxWallMs - activeWallMs(a));
    tokens.extendRunToken(a.run.id, left + RUN_TOKEN_GRACE_MS + extraMs);
  } catch (err) {
    k.log.warn({ err, runId: a.run.id }, 'run token extension failed');
  }
}

/** Keep a paused run's token alive however long the human takes (called every minute). */
export function keepPausedTokensAlive(k: Kernel, d: RuntimeDeps, active: Iterable<ActiveRun>): void {
  for (const a of active) if (a.pausedAt !== null) extendToken(k, d, a, PAUSE_TOKEN_HORIZON_MS);
}

/**
 * Pause a live run for a human (browser takeover, approval). Besides marking
 * the run and its issue, this stops every clock the run is measured by: the
 * adapter's wall timer, the supervisor's hard-kill timer and the run token's
 * expiry. A run can sit paused for hours and still have its full remaining
 * wall time when it resumes.
 */
export function pauseActive(k: Kernel, d: RuntimeDeps, journal: RunJournal, a: ActiveRun, reason: string): void {
  if (a.pausedAt !== null) return;
  a.pausedAt = Date.now();
  a.paused = true;
  a.handle?.pause?.();
  extendToken(k, d, a, PAUSE_TOKEN_HORIZON_MS);
  journal.update(a.run.id, { status: 'paused' });
  if (a.issueId && a.checkedOut) {
    d.work.updateIssue(a.org.id, a.issueId, { status: 'blocked', blockedReason: reason }, SYSTEM);
  }
  k.audit.record({ orgId: a.org.id, actor: SYSTEM, action: 'run.paused', entityKind: 'run', entityId: a.run.id, runId: a.run.id, issueId: a.issueId ?? undefined, data: { reason } });
  k.bus.emit('run.paused', { orgId: a.org.id, runId: a.run.id, reason });
}

export function resumeActive(k: Kernel, d: RuntimeDeps, journal: RunJournal, a: ActiveRun): void {
  if (a.pausedAt === null) return;
  const pausedForMs = Date.now() - a.pausedAt;
  a.pausedMs += pausedForMs;
  a.pausedAt = null;
  a.paused = false;
  a.handle?.resume?.();
  extendToken(k, d, a, 0);
  journal.update(a.run.id, { status: 'running' });
  if (a.issueId && a.checkedOut) {
    const issue = d.work.findIssue(a.org.id, a.issueId);
    if (issue?.status === 'blocked') d.work.updateIssue(a.org.id, a.issueId, { status: 'in_progress', blockedReason: null }, SYSTEM);
  }
  k.audit.record({ orgId: a.org.id, actor: SYSTEM, action: 'run.resumed', entityKind: 'run', entityId: a.run.id, runId: a.run.id, issueId: a.issueId ?? undefined, data: { pausedForMs } });
  k.bus.emit('run.resumed', { orgId: a.org.id, runId: a.run.id });
}
