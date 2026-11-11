import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AdapterRegistry, RunEvent, RunResult } from '../contracts/adapter.js';
import type { WorkerJob } from '../contracts/services.js';
import type { Logger } from '../shared/util.js';
import { errorMessage } from '../shared/errors.js';
import type { ChildMessage, ParentMessage } from './worker.js';

export type SupervisedResult = RunResult & { adapterId: string; model: string | null };

export interface RunHandle {
  pid: number | null;
  done: Promise<SupervisedResult>;
  cancel(reason?: string): Promise<void>;
}

export interface Supervisor {
  start(job: WorkerJob, onEvent: (e: RunEvent) => void): RunHandle;
}

const CANCEL_GRACE_MS = 5_000;
const HARD_KILL_GRACE_MS = 60_000;

function failed(job: WorkerJob, message: string, outcome: RunResult['outcome'] = 'failed'): SupervisedResult {
  return {
    outcome,
    finalText: '',
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 },
    steps: 0,
    error: { kind: 'other', message },
    adapterId: job.adapterId,
    model: job.ctx.model,
  };
}

/**
 * Production supervisor: one forked Node child per run. The child owns the
 * adapter (and any provider CLI it spawns), so a crashing agent can never take
 * the daemon down. Secrets are passed over the IPC channel, never argv/env.
 */
export class ProcessSupervisor implements Supervisor {
  private readonly workerPath: string;
  private readonly execArgv: string[];

  constructor(private readonly opts: { pluginDir: string; log: Logger }) {
    const self = fileURLToPath(import.meta.url);
    const isTs = self.endsWith('.ts');
    this.workerPath = self.replace(/supervisor\.(ts|js)$/, isTs ? 'worker.ts' : 'worker.js');
    // Under tsx/vitest the worker is TypeScript and needs the tsx loader.
    this.execArgv = isTs ? ['--import', 'tsx'] : [];
  }

  start(job: WorkerJob, onEvent: (e: RunEvent) => void): RunHandle {
    let child: ChildProcess;
    try {
      child = fork(this.workerPath, [], {
        execArgv: this.execArgv,
        cwd: job.ctx.workspacePath,
        // Minimal env: the worker gets what it needs over IPC.
        env: pickEnv(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'NODE_OPTIONS', 'CONDUCTOR_LOG_LEVEL']),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        serialization: 'advanced',
      });
    } catch (err) {
      return { pid: null, done: Promise.resolve(failed(job, `worker spawn failed: ${errorMessage(err)}`)), cancel: async () => {} };
    }

    let settled = false;
    let cancelled = false;
    let stderrTail = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString('utf8')).slice(-2000);
    });

    const done = new Promise<SupervisedResult>((resolve) => {
      const finish = (r: SupervisedResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        resolve(r);
      };

      // Backstop in case the adapter ignores its own wall-time limit.
      const hardTimer = setTimeout(() => {
        this.opts.log.warn({ runId: job.ctx.runId }, 'run exceeded hard wall limit; killing worker');
        child.kill('SIGKILL');
        finish(failed(job, 'run exceeded wall-time limit', 'timeout'));
      }, job.ctx.maxWallMs + HARD_KILL_GRACE_MS);
      hardTimer.unref();

      child.on('message', (raw) => {
        const msg = raw as ChildMessage;
        if (msg.type === 'event') {
          try {
            onEvent(msg.event);
          } catch (err) {
            this.opts.log.error({ err }, 'run event handler failed');
          }
        } else if (msg.type === 'result') {
          finish(msg.result);
        } else if (msg.type === 'fatal') {
          finish(failed(job, msg.message));
        }
      });
      child.on('error', (err) => finish(failed(job, `worker error: ${err.message}`)));
      child.on('exit', (code, signal) => {
        // Give a just-sent result message a tick to arrive before declaring a crash.
        setImmediate(() =>
          finish(
            cancelled
              ? failed(job, 'cancelled', 'cancelled')
              : failed(job, `worker crashed (code ${code ?? 'null'}, signal ${signal ?? 'none'})${stderrTail ? `: ${stderrTail.trim().slice(-500)}` : ''}`),
          ),
        );
      });
    });

    child.send({ type: 'start', job, pluginDir: this.opts.pluginDir } satisfies ParentMessage);

    const cancel = async () => {
      if (settled) return;
      cancelled = true;
      if (child.connected) child.send({ type: 'cancel' } satisfies ParentMessage);
      const t1 = setTimeout(() => !settled && child.kill('SIGTERM'), CANCEL_GRACE_MS);
      const t2 = setTimeout(() => !settled && child.kill('SIGKILL'), CANCEL_GRACE_MS + 2_000);
      await done;
      clearTimeout(t1);
      clearTimeout(t2);
    };

    return { pid: child.pid ?? null, done, cancel };
  }
}

/**
 * In-process supervisor for tests and for embedding: runs the adapter chain
 * in the daemon process via an injected registry.
 */
export class InProcessSupervisor implements Supervisor {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly chain: (registry: AdapterRegistry, job: WorkerJob, onEvent: (e: RunEvent) => void) => Promise<SupervisedResult>,
    private readonly cancelFn: (registry: AdapterRegistry, runId: string) => Promise<void>,
  ) {}

  start(job: WorkerJob, onEvent: (e: RunEvent) => void): RunHandle {
    let cancelled = false;
    const done = this.chain(this.registry, job, onEvent).then(
      (r) => (cancelled && r.outcome !== 'cancelled' ? { ...r, outcome: 'cancelled' as const } : r),
      (err) => failed(job, errorMessage(err)),
    );
    return {
      pid: null,
      done,
      cancel: async () => {
        cancelled = true;
        await this.cancelFn(this.registry, job.ctx.runId).catch(() => {});
        await done;
      },
    };
  }
}

function pickEnv(keys: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of keys) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}
