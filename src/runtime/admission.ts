import type { Agent, Organization } from '../contracts/rows.js';
import { effectiveBinding } from './binding.js';
import { DEFAULT_PROVIDER_LIMITS, type RuntimeOptions } from './types.js';

export type RunMode = 'loop' | 'chat' | 'eval';

export interface Reservation {
  orgId: string;
  agentId: string;
  provider: string;
  mode: RunMode;
}

export interface Counts {
  running: number;
  perOrg: Record<string, number>;
  perProvider: Record<string, number>;
}

/**
 * The single ledger of concurrency slots. Heartbeat/event runs reserve through
 * the scheduler; chat turns and skill-eval runs reserve here directly. They
 * all count against the same global / org / provider limits — direct runs get
 * a small fixed headroom on top, never an unlimited pass.
 */
export class Admission {
  private readonly reserved = new Map<string, Reservation>();
  private readonly waiters = new Set<() => void>();
  private seq = 0;

  constructor(private readonly options: RuntimeOptions = {}) {}

  counts(): Counts {
    const perOrg: Record<string, number> = {};
    const perProvider: Record<string, number> = {};
    for (const r of this.reserved.values()) {
      perOrg[r.orgId] = (perOrg[r.orgId] ?? 0) + 1;
      perProvider[r.provider] = (perProvider[r.provider] ?? 0) + 1;
    }
    return { running: this.reserved.size, perOrg, perProvider };
  }

  private modeCount(mode: RunMode, agentId?: string): number {
    let n = 0;
    for (const r of this.reserved.values()) if (r.mode === mode && (!agentId || r.agentId === agentId)) n++;
    return n;
  }

  private providerLimit(provider: string): number {
    return this.options.providerLimits?.[provider] ?? DEFAULT_PROVIDER_LIMITS[provider] ?? 4;
  }

  /** May a heartbeat-loop run for this agent start now? */
  loopSlot(org: Organization, agent: Agent): Reservation | null {
    const provider = effectiveBinding(agent, org).adapter;
    const c = this.counts();
    if (this.modeCount('loop', agent.id) > 0) return null;
    if (c.running >= (this.options.maxGlobalRuns ?? 8)) return null;
    if ((c.perOrg[org.id] ?? 0) >= org.maxConcurrentRuns) return null;
    if ((c.perProvider[provider] ?? 0) >= this.providerLimit(provider)) return null;
    return { orgId: org.id, agentId: agent.id, provider, mode: 'loop' };
  }

  /** Why a chat / eval run cannot start now, or null when it can. */
  private directBlock(org: Organization, agent: Agent, provider: string, mode: 'chat' | 'eval'): string | null {
    const headroom = Math.max(0, this.options.directHeadroom ?? 1);
    const c = this.counts();
    if (this.modeCount(mode, agent.id) > 0) return `${agent.name} is already in ${mode === 'chat' ? 'a chat turn' : 'a skill eval'}`;
    const modeLimit = mode === 'chat' ? (this.options.chatConcurrency ?? 4) : (this.options.evalConcurrency ?? 2);
    if (this.modeCount(mode) >= modeLimit) return `${mode} concurrency limit reached (${modeLimit})`;
    if (c.running >= (this.options.maxGlobalRuns ?? 8) + headroom) return 'global concurrency limit reached';
    if ((c.perOrg[org.id] ?? 0) >= org.maxConcurrentRuns + headroom) return 'organization concurrency limit reached';
    if ((c.perProvider[provider] ?? 0) >= this.providerLimit(provider) + headroom) return `provider ${provider} concurrency limit reached`;
    return null;
  }

  /** Record a reservation under an id (job id or a generated one). */
  hold(id: string, r: Reservation): void {
    this.reserved.set(id, r);
  }

  release(id: string): void {
    if (!this.reserved.delete(id)) return;
    for (const wake of [...this.waiters]) wake();
  }

  holds(agentId: string, mode: RunMode): boolean {
    return this.modeCount(mode, agentId) > 0;
  }

  /**
   * Reserve a slot for a chat turn or an eval run, waiting up to `waitMs` for
   * one to free up. Resolves with a release function, or with the reason no
   * slot could be had.
   */
  async acquireDirect(org: Organization, agent: Agent, mode: 'chat' | 'eval', waitMs: number): Promise<{ release: () => void } | { blocked: string }> {
    const provider = effectiveBinding(agent, org).adapter;
    const deadline = Date.now() + Math.max(0, waitMs);
    for (;;) {
      const blocked = this.directBlock(org, agent, provider, mode);
      if (!blocked) {
        const id = `direct-${mode}-${++this.seq}`;
        this.hold(id, { orgId: org.id, agentId: agent.id, provider, mode });
        return { release: () => this.release(id) };
      }
      const left = deadline - Date.now();
      if (left <= 0) return { blocked };
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        timer.unref?.();
        this.waiters.add(done);
      });
    }
  }
}
