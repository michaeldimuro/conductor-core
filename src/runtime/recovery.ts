import { execFileSync } from 'node:child_process';
import type { Kernel } from '../contracts/kernel.js';
import { SYSTEM } from '../contracts/types.js';
import type { RunJournal } from './journal.js';
import type { Scheduler } from './scheduler.js';
import type { RuntimeDeps } from './types.js';

/**
 * Crash safety (PRD): on daemon start, every run the journal says was in
 * flight is either RESUMED (adapter supports session resume and a session id
 * was journaled) or RELEASED back to `todo` with a comment. No issue state is lost.
 */
export function recoverInFlight(k: Kernel, d: RuntimeDeps, journal: RunJournal, scheduler: Scheduler): { resumed: number; released: number } {
  let resumed = 0;
  let released = 0;

  for (const run of journal.inFlight()) {
    killStrayWorker(k, run.pid);

    const adapter = run.provider ? d.registry.get(run.provider) : undefined;
    const canResume = !!adapter?.capabilities().resume && !!run.sessionId && !!run.issueId;
    const agent = d.org.findAgent(run.orgId, run.agentId);

    journal.finish(run.id, { status: 'failed', outcome: 'crashed', error: 'interrupted by daemon restart' });
    d.governance.tokens.revokeRunTokens(run.id);

    if (run.issueId) {
      const issue = d.work.findIssue(run.orgId, run.issueId);
      const heldLock = issue?.checkoutLock === run.id;
      // A paused run parked its issue as blocked (needs_human); put it back in play either way.
      const wasParked = issue?.status === 'blocked' && issue.blockedReason === 'needs_human';
      if (heldLock) d.work.releaseAllForRun(run.orgId, run.id, 'todo');
      if (wasParked && issue) d.work.updateIssue(run.orgId, issue.id, { status: 'todo', blockedReason: null }, SYSTEM);

      if (issue && (heldLock || wasParked)) {
        if (canResume && agent?.status === 'active') {
          d.work.addComment(run.orgId, issue.id, { body: `Run ${run.id} was interrupted by a daemon restart. Resuming the provider session.` }, SYSTEM);
          scheduler.wake(run.orgId, run.agentId, {
            trigger: 'resume', issueId: issue.id, resumeSessionId: run.sessionId!,
            triggerNote: 'Your previous run on this issue was interrupted by a restart. Continue from where you left off.',
          });
          resumed++;
        } else {
          d.work.addComment(run.orgId, issue.id, { body: `Run ${run.id} was interrupted by a daemon restart. Released back to todo.` }, SYSTEM);
          released++;
        }
      }
    }

    k.audit.record({
      orgId: run.orgId, actor: SYSTEM, action: 'run.recovered', entityKind: 'run', entityId: run.id, runId: run.id,
      issueId: run.issueId ?? undefined, data: { resumed: canResume, phase: run.phase },
    });
  }

  // Locks whose run is not in flight any more (e.g. the process died between checkout and journaling).
  const orphans = k.sqlite
    .prepare("select org_id as orgId, checkout_lock as lock from issues where checkout_lock is not null and checkout_lock not in (select id from runs where status in ('queued','running','paused'))")
    .all() as Array<{ orgId: string; lock: string }>;
  for (const o of orphans) {
    d.work.releaseAllForRun(o.orgId, o.lock, 'todo');
    released++;
  }

  d.browser?.recoverLeases([]);
  const requeued = scheduler.queue.recover();
  if (resumed || released || requeued) k.log.info({ resumed, released, requeued }, 'crash recovery complete');
  return { resumed, released };
}

/**
 * A worker can outlive a SIGKILLed daemon. Only kill the journaled pid if it
 * is still OUR worker — pids are recycled across reboots.
 */
function killStrayWorker(k: Kernel, pid: number | null): void {
  if (!pid || pid === process.pid) return;
  try {
    const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 }).trim();
    if (/runtime[/\\]worker\.(js|ts)/.test(cmd)) {
      process.kill(pid, 'SIGTERM');
      k.log.warn({ pid }, 'terminated orphaned run worker');
    }
  } catch {
    /* not running */
  }
}
