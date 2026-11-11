/**
 * Run worker — the supervised child process for ONE adapter run.
 *
 * Protocol (Node IPC):
 *   parent → { type: 'start', job: WorkerJob, pluginDir }   (secrets travel here, in memory only)
 *   parent → { type: 'cancel' }
 *   child  → { type: 'event', event: RunEvent }
 *   child  → { type: 'result', result: RunResult & { adapterId, model } }
 *   child  → { type: 'fatal', message }
 *
 * A crash here never touches the daemon: the supervisor converts a missing
 * result into a failed RunResult.
 */
import type { RunEvent, RunResult } from '../contracts/adapter.js';
import type { WorkerJob } from '../contracts/services.js';
import { createAdapterRegistry, runChain, cancelRun } from '../adapters/index.js';
import { errorMessage } from '../shared/errors.js';

export type ParentMessage = { type: 'start'; job: WorkerJob; pluginDir: string } | { type: 'cancel' };
export type ChildMessage =
  | { type: 'event'; event: RunEvent }
  | { type: 'result'; result: RunResult & { adapterId: string; model: string | null } }
  | { type: 'fatal'; message: string };

function send(msg: ChildMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) return resolve();
    process.send(msg, undefined, undefined, () => resolve());
  });
}

async function main(): Promise<void> {
  let runId: string | null = null;
  let registry: ReturnType<typeof createAdapterRegistry> | null = null;

  const cancel = async () => {
    if (registry && runId) await cancelRun(registry, runId).catch(() => {});
  };

  process.on('message', (raw) => {
    const msg = raw as ParentMessage;
    if (msg.type === 'cancel') {
      void cancel();
      return;
    }
    if (msg.type !== 'start' || runId) return;
    runId = msg.job.ctx.runId;
    void (async () => {
      try {
        registry = createAdapterRegistry({ pluginDir: msg.pluginDir });
        await registry.loadPlugins();
        const result = await runChain(registry, msg.job, (event) => void send({ type: 'event', event }));
        await send({ type: 'result', result });
        process.exit(0);
      } catch (err) {
        await send({ type: 'fatal', message: errorMessage(err) });
        process.exit(1);
      }
    })();
  });

  // The daemon died or asked us to stop: take the provider subprocess down with us.
  const shutdown = () => void cancel().finally(() => process.exit(143));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('disconnect', shutdown);
}

void main();
