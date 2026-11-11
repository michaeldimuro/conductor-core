import type { RunEvent, RunUsage } from '../contracts/adapter.js';

type UsageEvent = Extract<RunEvent, { type: 'usage' }>;

export interface SpendDelta {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

const zero = (): SpendDelta => ({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
const cents = (n: number): number => Number(n.toFixed(8));

/**
 * Records a run's metered spend WHILE it runs, so concurrent runs sharing a
 * cap see each other's spend instead of each believing the whole remainder is
 * theirs. Usage deltas are batched (per `flushUsd` dollars or `flushMs`) to
 * keep the ledger small; `remainder()` gives what is left to record at the end.
 */
export class SpendMeter {
  private pending = zero();
  private readonly recorded = zero();
  private lastFlush = Date.now();

  constructor(
    private readonly record: (delta: SpendDelta) => void,
    private readonly flushUsd = 0.05,
    private readonly flushMs = 10_000,
  ) {}

  /** Fold in one usage event. Returns true when spend was written to the ledger. */
  add(e: UsageEvent): boolean {
    this.pending.tokensIn += e.tokensIn;
    this.pending.tokensOut += e.tokensOut;
    this.pending.costUsd = cents(this.pending.costUsd + e.costUsd);
    // Only metered spend is recorded early: $0 usage belongs to subscription runs and is settled at the end.
    if (this.pending.costUsd <= 0) return false;
    if (this.pending.costUsd < this.flushUsd && Date.now() - this.lastFlush < this.flushMs) return false;
    return this.flush();
  }

  flush(): boolean {
    if (this.pending.costUsd <= 0) return false;
    const delta = this.pending;
    this.pending = zero();
    this.lastFlush = Date.now();
    this.record(delta);
    this.recorded.tokensIn += delta.tokensIn;
    this.recorded.tokensOut += delta.tokensOut;
    this.recorded.costUsd = cents(this.recorded.costUsd + delta.costUsd);
    return true;
  }

  get recordedUsd(): number {
    return this.recorded.costUsd;
  }

  /** The part of the run's authoritative total that has not been recorded yet. */
  remainder(total: RunUsage): SpendDelta {
    return {
      tokensIn: Math.max(0, total.tokensIn - this.recorded.tokensIn),
      tokensOut: Math.max(0, total.tokensOut - this.recorded.tokensOut),
      costUsd: Math.max(0, cents(total.costUsd - this.recorded.costUsd)),
    };
  }
}
