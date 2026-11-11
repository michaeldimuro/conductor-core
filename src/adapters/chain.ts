import type { AdapterErrorKind, AdapterRegistry, RunContext, RunEvent, RunResult, RunUsage } from '../contracts/adapter.js';
import type { WorkerJob } from '../contracts/services.js';
import { FALLBACK_KINDS, isRetryable, toAdapterError } from './shared/errors.js';
import { createScrubber, secretValuesOf } from './shared/events.js';

export type ChainResult = RunResult & { adapterId: string; model: string | null };

type Binding = WorkerJob['chain'][number];

/** runId -> adapter currently executing it (within this process). */
const inFlight = new Map<string, { adapterId: string | null; cancelled: boolean }>();

function addUsage(total: RunUsage, u: RunUsage): RunUsage {
  return {
    tokensIn: total.tokensIn + u.tokensIn,
    tokensOut: total.tokensOut + u.tokensOut,
    costUsd: Number((total.costUsd + u.costUsd).toFixed(8)),
    // The flag describes the attempt whose result is returned (the last one).
    subscription: u.subscription,
    seatSeconds: total.seatSeconds + u.seatSeconds,
  };
}

function failed(kind: AdapterErrorKind, message: string): RunResult {
  return {
    outcome: 'failed',
    finalText: '',
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 },
    steps: 0,
    error: { kind, message },
  };
}

/**
 * Run a job on its primary binding, moving down the fallback chain ONLY when
 * an attempt fails with a rate limit, an auth failure or an outage. Anything
 * else — success, `invalid_request`, cancel, `max_steps`, `timeout`, `budget`
 * — is final. Usage accumulates across attempts, and each later attempt gets
 * only the budget and wall time the earlier ones left.
 */
export async function runChain(registry: AdapterRegistry, job: WorkerJob, onEvent: (e: RunEvent) => void): Promise<ChainResult> {
  const base = job.ctx;
  const chain: Binding[] =
    job.chain.length > 0 ? job.chain : [{ adapterId: job.adapterId, model: base.model, config: base.config, secrets: base.secrets }];

  // Mask every credential of every binding, whichever adapter (built-in or plugin) emits.
  const allSecrets = [...Object.values(base.secrets), ...chain.flatMap((b) => Object.values(b.secrets))];
  const scrub = createScrubber(secretValuesOf({ ...base, secrets: Object.fromEntries(allSecrets.map((v, i) => [String(i), v])) }));
  const emit = (e: RunEvent): void => {
    try {
      onEvent(scrub.event(e));
    } catch {
      // listener errors never break a run
    }
  };

  const startedAt = Date.now();
  const state = { adapterId: null as string | null, cancelled: false };
  inFlight.set(base.runId, state);
  let usage: RunUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 };
  let steps = 0;
  let last: ChainResult = { ...failed('other', 'no adapter binding to run'), adapterId: job.adapterId, model: base.model };

  try {
    for (let i = 0; i < chain.length; i++) {
      const binding = chain[i] as Binding;
      const remainingMs = base.maxWallMs - (Date.now() - startedAt);
      const remainingBudget = base.budgetCapUsd === null ? null : Math.max(0, base.budgetCapUsd - usage.costUsd);
      let result: RunResult;

      if (state.cancelled) {
        result = { ...failed('other', 'cancelled'), outcome: 'cancelled' };
        delete result.error;
      } else if (i > 0 && remainingMs <= 0) {
        result = { ...failed('other', 'wall-clock limit reached'), outcome: 'timeout' };
        delete result.error;
      } else {
        const adapter = registry.get(binding.adapterId);
        if (!adapter) {
          // A binding that cannot run at all is treated like an outage of that provider.
          result = failed('outage', `adapter "${binding.adapterId}" is not installed`);
          emit({ type: 'error', kind: 'outage', message: result.error?.message ?? '', retryable: true });
        } else {
          const ctx: RunContext = {
            ...base,
            model: binding.model,
            config: binding.config,
            secrets: binding.secrets,
            budgetCapUsd: remainingBudget,
            maxWallMs: Math.max(1, remainingMs),
            maxSteps: Math.max(1, base.maxSteps - steps),
          };
          // A provider session id only means something to the adapter that issued it.
          if (binding.adapterId !== job.adapterId) delete ctx.resumeSessionId;
          state.adapterId = binding.adapterId;
          try {
            result = await adapter.run(ctx, emit);
          } catch (e) {
            // Contract says run() resolves; a throwing (plugin) adapter is still contained.
            const err = toAdapterError(e);
            result = failed(err.kind, scrub.text(err.message));
            emit({ type: 'error', kind: err.kind, message: err.message, retryable: isRetryable(err.kind) });
          } finally {
            state.adapterId = null;
          }
        }
      }

      usage = addUsage(usage, result.usage);
      steps += result.steps;
      last = { ...result, finalText: scrub.text(result.finalText), usage, steps, adapterId: binding.adapterId, model: binding.model };

      const kind = result.error?.kind;
      const next = chain[i + 1];
      const shouldFallback = result.outcome === 'failed' && kind !== undefined && FALLBACK_KINDS.has(kind) && !state.cancelled;
      if (!shouldFallback || !next) break;
      emit({
        type: 'status',
        status: `fallback: ${binding.adapterId}${binding.model ? ` (${binding.model})` : ''} failed with ${kind}; switching to ${next.adapterId}${next.model ? ` (${next.model})` : ''}`,
      });
    }
    if (state.cancelled && last.outcome === 'failed') {
      last = { ...last, outcome: 'cancelled' };
      delete last.error;
    }
    return last;
  } finally {
    if (inFlight.get(base.runId) === state) inFlight.delete(base.runId);
  }
}

/**
 * Cancel a run wherever it is executing. Marks the chain as cancelled (so no
 * fallback starts) and asks the adapters to stop; safe to call for unknown ids.
 */
export async function cancelRun(registry: AdapterRegistry, runId: string): Promise<void> {
  const state = inFlight.get(runId);
  if (state) state.cancelled = true;
  const ids = state?.adapterId ? [state.adapterId] : registry.list().map((a) => a.id);
  await Promise.all(
    ids.map(async (id) => {
      try {
        await registry.get(id)?.cancel(runId);
      } catch {
        // one adapter failing to cancel must not stop the others
      }
    }),
  );
}
