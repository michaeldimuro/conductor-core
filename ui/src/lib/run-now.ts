import { api } from './api.js';
import { live } from './live.js';
import { toast } from './toast.js';

const WAIT_MS = 10_000;

export type RunNowResult =
  | { kind: 'started'; runId: string }
  | { kind: 'skipped'; reason: string; temporary: boolean }
  | { kind: 'queued' };

/**
 * Wake an agent and report what actually happened. The daemon accepts the
 * wake before it knows whether there is anything to do, so this waits briefly
 * for the run to start or for the daemon to say why it did not.
 */
export async function runNow(orgId: string, agentId: string, agentName: string, opts: { issueId?: string } = {}): Promise<RunNowResult> {
  let settle: (r: RunNowResult) => void = () => {};
  const outcome = new Promise<RunNowResult>((resolve) => {
    settle = resolve;
  });
  let jobId: string | null = null;
  const early: Array<{ jobId: string | null; reason: string; temporary: boolean }> = [];
  // Listen before asking: the daemon may decide faster than the HTTP response returns.
  const off = live.on((msg) => {
    if (msg.name === 'run.started' && msg.payload.agentId === agentId) settle({ kind: 'started', runId: msg.payload.runId });
    else if (msg.name === 'run.skipped' && msg.payload.agentId === agentId) {
      const skip = { jobId: msg.payload.jobId, reason: msg.payload.reason, temporary: msg.payload.deferredUntil !== null };
      if (jobId === null) early.push(skip);
      else if (skip.jobId === null || skip.jobId === jobId) settle({ kind: 'skipped', reason: skip.reason, temporary: skip.temporary });
    }
  });
  const timer = window.setTimeout(() => settle({ kind: 'queued' }), WAIT_MS);
  try {
    const r = await api.runAgent(orgId, agentId, opts);
    jobId = r.jobId;
    if (r.skipped) settle({ kind: 'skipped', reason: r.skipped.reason, temporary: r.skipped.temporary });
    const seen = early.find((s) => s.jobId === null || s.jobId === jobId);
    if (seen) settle({ kind: 'skipped', reason: seen.reason, temporary: seen.temporary });
    const result = await outcome;
    if (result.kind === 'started') toast(`${agentName} started a run`, 'ok');
    else if (result.kind === 'skipped') toast(`No run started for ${agentName}: ${result.reason}${result.temporary ? ' It will run when that clears.' : ''}`, 'info');
    else toast(`${agentName} is queued and has not started yet. It runs when a slot is free.`, 'info');
    return result;
  } finally {
    window.clearTimeout(timer);
    off();
  }
}
