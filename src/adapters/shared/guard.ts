import type { AdapterErrorKind, RunContext, RunEvent, RunOutcome, RunResult } from '../../contracts/adapter.js';
import { findPrice, parsePricingOverrides, priceFor, type PricedUsage, type PricingOverrides } from '../pricing.js';
import { AdapterError, isRetryable, toAdapterError } from './errors.js';
import { createScrubber, secretValuesOf, type Scrubber } from './events.js';

export type StopReason = 'cancelled' | 'timeout' | 'budget' | 'max_steps';

const MAX_TIMER_MS = 2 ** 31 - 1;

/** Live guards by run id, so a pause/resume can reach every guard of a run without knowing its adapter. */
const LIVE_GUARDS = new Map<string, Set<RunGuard>>();
/** Runs whose clock is currently paused: a guard created meanwhile (fallback chain) starts paused. */
const PAUSED_RUNS = new Set<string>();

/**
 * Stop the wall clock of a run (human takeover): paused time does not count
 * against `maxWallMs` or seat time. Returns the number of guards reached.
 */
export function pauseRunClock(runId: string): number {
  PAUSED_RUNS.add(runId);
  const guards = LIVE_GUARDS.get(runId);
  for (const g of guards ?? []) g.pause();
  return guards?.size ?? 0;
}

/** Restart the wall clock of a run with the time it had left when it was paused. */
export function resumeRunClock(runId: string): number {
  PAUSED_RUNS.delete(runId);
  const guards = LIVE_GUARDS.get(runId);
  for (const g of guards ?? []) g.resume();
  return guards?.size ?? 0;
}

/**
 * Per-run stop switch: one AbortSignal that fires on cancel, wall-clock
 * timeout, budget exhaustion or the step limit, and remembers which it was.
 * The wall clock can be paused; paused time is excluded from every reading.
 */
export class RunGuard {
  readonly startedAt = Date.now();
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private stopReason: StopReason | null = null;
  private pausedAt: number | null = null;
  private pausedMs = 0;

  constructor(
    readonly runId: string,
    readonly maxWallMs: number,
  ) {
    let set = LIVE_GUARDS.get(runId);
    if (!set) {
      set = new Set();
      LIVE_GUARDS.set(runId, set);
    }
    set.add(this);
    if (PAUSED_RUNS.has(runId)) this.pausedAt = this.startedAt;
    else this.arm();
  }

  private arm(): void {
    this.timer = setTimeout(() => this.stop('timeout'), Math.min(Math.max(1, this.remainingMs()), MAX_TIMER_MS));
    this.timer.unref();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get reason(): StopReason | null {
    return this.stopReason;
  }
  get paused(): boolean {
    return this.pausedAt !== null;
  }
  stop(reason: StopReason): void {
    if (this.stopReason) return;
    this.stopReason = reason;
    this.controller.abort();
  }
  /** Suspend the wall-clock timer. Cancel, budget and step limits still apply. */
  pause(): void {
    if (this.pausedAt !== null) return;
    this.pausedAt = Date.now();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** Re-arm the wall-clock timer with whatever was left at `pause()`. */
  resume(): void {
    if (this.pausedAt === null) return;
    this.pausedMs += Date.now() - this.pausedAt;
    this.pausedAt = null;
    if (!this.stopReason) this.arm();
  }
  /** Wall time spent running (paused time excluded). */
  private activeMs(): number {
    const paused = this.pausedMs + (this.pausedAt !== null ? Date.now() - this.pausedAt : 0);
    return Math.max(0, Date.now() - this.startedAt - paused);
  }
  remainingMs(): number {
    return Math.max(0, this.maxWallMs - this.activeMs());
  }
  elapsedSeconds(): number {
    return this.activeMs() / 1000;
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const set = LIVE_GUARDS.get(this.runId);
    if (set) {
      set.delete(this);
      if (set.size === 0) LIVE_GUARDS.delete(this.runId);
    }
  }
}

/** Tracks an adapter's in-flight runs so `cancel(runId)` can reach them. */
export class ActiveRuns {
  private readonly runs = new Map<string, RunGuard>();

  begin(runId: string, maxWallMs: number): RunGuard {
    if (this.runs.has(runId)) throw new AdapterError('invalid_request', `run ${runId} is already in progress on this adapter`);
    const guard = new RunGuard(runId, maxWallMs);
    this.runs.set(runId, guard);
    return guard;
  }
  end(guard: RunGuard): void {
    guard.dispose();
    if (this.runs.get(guard.runId) === guard) this.runs.delete(guard.runId);
  }
  cancel(runId: string): void {
    this.runs.get(runId)?.stop('cancelled');
  }
  get size(): number {
    return this.runs.size;
  }
}

/**
 * Accumulates token usage and metered cost for a run and emits `usage` events.
 * Each emitted `usage` event is a DELTA (one model request / one CLI report);
 * the authoritative total is `RunResult.usage`.
 */
export class UsageMeter {
  tokensIn = 0;
  tokensOut = 0;
  costUsd = 0;
  private readonly warned = new Set<string>();

  constructor(
    private readonly emit: (e: RunEvent) => void,
    private readonly capUsd: number | null,
    readonly pricing: PricingOverrides | undefined,
  ) {}

  /** Price without recording (used for live budget estimates). */
  estimate(model: string | null, usage: PricedUsage): number {
    return priceFor(model, usage, this.pricing);
  }

  /**
   * Record one usage report. `costUsd` overrides the price table (CLI-reported
   * cost, or 0 for subscription runs).
   */
  add(model: string | null, usage: PricedUsage, opts: { costUsd?: number } = {}): void {
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    const tokensIn = usage.inputTokens + cacheRead + cacheWrite;
    let cost = opts.costUsd;
    if (cost === undefined) {
      cost = priceFor(model, usage, this.pricing);
      const key = model ?? '(default model)';
      if (!findPrice(model, this.pricing) && !this.warned.has(key)) {
        this.warned.add(key);
        this.emit({ type: 'status', status: `no price for model ${key}; cost recorded as $0 — set config.pricing on the binding` });
      }
    }
    this.tokensIn += tokensIn;
    this.tokensOut += usage.outputTokens;
    this.costUsd = Number((this.costUsd + cost).toFixed(8));
    this.emit({
      type: 'usage',
      tokensIn,
      tokensOut: usage.outputTokens,
      costUsd: cost,
      ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
    });
  }

  /** Fold in usage reported as already-normalized RunEvent numbers (process / http adapters). */
  addReported(tokensIn: number, tokensOut: number, costUsd: number): void {
    this.tokensIn += tokensIn;
    this.tokensOut += tokensOut;
    this.costUsd = Number((this.costUsd + costUsd).toFixed(8));
  }

  /** True once metered cost (plus an optional not-yet-recorded estimate) exceeds the cap. */
  overBudget(pendingUsd = 0): boolean {
    return this.capUsd !== null && this.costUsd + pendingUsd > this.capUsd;
  }
}

export interface FinishInput {
  outcome: RunOutcome;
  finalText?: string;
  steps: number;
  sessionId?: string;
  error?: { kind: AdapterErrorKind; message: string };
  subscription?: boolean;
  seatSeconds?: number;
}

/** What an adapter body gets for one run. */
export interface RunEnv {
  ctx: RunContext;
  guard: RunGuard;
  meter: UsageMeter;
  scrub: Scrubber;
  /** Emit a RunEvent (secrets are masked on the way out). */
  emit(e: RunEvent): void;
  /** Build the RunResult; a stop reason set on the guard wins over `failed`. */
  finish(input: FinishInput): RunResult;
  /** Emit an `error` event and build a failed result. */
  fail(error: unknown, steps: number, extra?: Partial<FinishInput>): RunResult;
}

const STOP_OUTCOME: Record<StopReason, RunOutcome> = {
  cancelled: 'cancelled',
  timeout: 'timeout',
  budget: 'budget',
  max_steps: 'max_steps',
};

export interface WithRunOptions {
  /**
   * Metered adapters refuse to start when the remaining budget is already
   * spent. Subscription/unmetered adapters pass false.
   */
  metered: boolean;
}

/**
 * Shared run scaffolding for the built-in adapters: registers the run for
 * cancel, arms the wall-clock timer, masks secrets in everything emitted and
 * guarantees `run()` resolves with a RunResult instead of throwing.
 */
export async function withRun(
  active: ActiveRuns,
  ctx: RunContext,
  onEvent: (e: RunEvent) => void,
  opts: WithRunOptions,
  body: (env: RunEnv) => Promise<RunResult>,
): Promise<RunResult> {
  const scrub = createScrubber(secretValuesOf(ctx));
  const emit = (e: RunEvent): void => {
    try {
      onEvent(scrub.event(e));
    } catch {
      // A broken listener must not take the run down.
    }
  };
  const zeroUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 };
  const early = (kind: AdapterErrorKind, message: string): RunResult => {
    emit({ type: 'error', kind, message, retryable: isRetryable(kind) });
    return { outcome: 'failed', finalText: '', usage: zeroUsage, steps: 0, error: { kind, message } };
  };

  let pricing: PricingOverrides | undefined;
  let guard: RunGuard;
  try {
    pricing = parsePricingOverrides(ctx.config.pricing);
    guard = active.begin(ctx.runId, ctx.maxWallMs);
  } catch (e) {
    const err = toAdapterError(e, 'invalid_request');
    return early(err.kind, scrub.text(err.message));
  }

  const meter = new UsageMeter(emit, ctx.budgetCapUsd, pricing);
  const finish = (input: FinishInput): RunResult => {
    const stopped = guard.reason && input.outcome !== 'completed' ? STOP_OUTCOME[guard.reason] : null;
    const outcome = stopped ?? input.outcome;
    const result: RunResult = {
      outcome,
      finalText: scrub.text(input.finalText ?? ''),
      usage: {
        tokensIn: meter.tokensIn,
        tokensOut: meter.tokensOut,
        costUsd: meter.costUsd,
        subscription: input.subscription ?? false,
        seatSeconds: input.seatSeconds ?? 0,
      },
      steps: input.steps,
    };
    if (input.sessionId) result.sessionId = input.sessionId;
    if (outcome === 'failed' && input.error) {
      result.error = { kind: input.error.kind, message: scrub.text(input.error.message) };
    }
    return result;
  };
  const fail = (error: unknown, steps: number, extra: Partial<FinishInput> = {}): RunResult => {
    const err = toAdapterError(error);
    if (!guard.reason) emit({ type: 'error', kind: err.kind, message: err.message, retryable: err.retryable });
    return finish({ ...extra, outcome: 'failed', steps, error: { kind: err.kind, message: err.message } });
  };

  try {
    if (opts.metered && ctx.budgetCapUsd !== null && ctx.budgetCapUsd <= 0) {
      guard.stop('budget');
      emit({ type: 'status', status: 'budget exhausted before the run started' });
      return finish({ outcome: 'budget', steps: 0 });
    }
    return await body({ ctx, guard, meter, scrub, emit, finish, fail });
  } catch (e) {
    return fail(e, 0);
  } finally {
    active.end(guard);
  }
}
