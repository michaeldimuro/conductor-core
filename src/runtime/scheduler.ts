import { Cron } from 'croner';
import type { Kernel } from '../contracts/kernel.js';
import type { Job } from '../contracts/rows.js';
import type { JobKind } from '../db/schema/index.js';
import { errorMessage } from '../shared/errors.js';
import { JobQueue } from './jobs.js';
import type { RunExecutor } from './executor.js';
import { Admission, type Counts, type Reservation } from './admission.js';
import { GoalRouter } from './goal-router.js';
import { wireTriggers } from './triggers.js';
import { deferBackoffMs, deferralsOf, foldWakes, mergeWakePayloads, wakePayload, wakesOf, type Wake } from './wakes.js';
import type { RunSummary, RuntimeDeps } from './types.js';

export type JobHandler = (job: Job) => Promise<void>;

/** Longest a deferred wake waits between retries, by cause. Clearing the cause pulls it forward at once. */
const RATE_LIMIT_BACKOFF_CAP_MS = 15 * 60_000;
const BLOCKED_BACKOFF_CAP_MS = 60 * 60_000;

const WAKE_GAP_MS = 60_000;
const WAKE_STAGGER_MS = 1_500;

/** Next fire time of a cron expression strictly after `from`, or null if invalid. */
export function nextCron(expr: string, from: number): number | null {
  try {
    const next = new Cron(expr).nextRun(new Date(from));
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

/**
 * In-process scheduler over the DB-backed job table: per-agent cron
 * heartbeats, event wake-ups, and pluggable system jobs. Enforces concurrency
 * per agent (1), per org, per provider and globally.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private ticking = false;
  readonly admission: Admission;
  readonly goals: GoalRouter;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly handlers = new Map<JobKind, JobHandler>();
  private readonly unsubs: Array<() => void> = [];
  private syncQueued = false;

  constructor(
    private readonly k: Kernel,
    private readonly d: RuntimeDeps,
    readonly queue: JobQueue,
    private readonly executor: RunExecutor,
  ) {
    this.admission = new Admission(d.options);
    this.goals = new GoalRouter(k, d, (orgId, agentId, wake) => this.wake(orgId, agentId, wake));
    this.handlers.set('heartbeat', (j) => this.runJob(j));
    this.handlers.set('event', (j) => this.runJob(j));
  }

  registerHandler(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  start(): void {
    this.unsubs.push(...wireTriggers(this.k, this.d, this, this.executor, this.goals));
    this.syncSchedules();
    this.lastTick = this.k.clock.now();
    // tickMs 0 = manual ticking (tests drive `tick()` themselves).
    const tickMs = this.d.options?.tickMs ?? 1000;
    if (tickMs > 0) {
      this.timer = setInterval(() => void this.tick(), tickMs);
      this.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.unsubs.splice(0)) off();
    await Promise.allSettled([...this.inFlight]);
  }

  /** Wait for everything currently dispatched (tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  counts(): Counts {
    return this.admission.counts();
  }

  /** One scheduling pass: dispatch every due job there is capacity for. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.k.clock.now();
      const woke = this.lastTick > 0 && now - this.lastTick > WAKE_GAP_MS;
      this.lastTick = now;

      const due = this.queue.due(100);
      if (woke) {
        // Wake from sleep: each agent has at most ONE overdue heartbeat (dedupe key),
        // so missed beats fire once. Stagger them to avoid a thundering herd.
        this.k.log.info({ overdue: due.length }, 'scheduler: wake detected, firing missed heartbeats once');
        let n = 0;
        for (const job of due) {
          if (job.kind === 'heartbeat' && n++ > 0) this.queue.defer(job.id, now + n * WAKE_STAGGER_MS);
        }
      }

      for (const job of woke ? this.queue.due(100) : due) {
        const handler = this.handlers.get(job.kind);
        if (!handler) continue;
        const isRun = job.kind === 'heartbeat' || job.kind === 'event';
        let reservation: Reservation | null = null;
        if (isRun) {
          const verdict = this.capacity(job);
          if (verdict === 'drop') {
            if (this.queue.claim(job.id)) this.queue.complete(job.id);
            if (job.kind === 'heartbeat' && job.agentId) this.scheduleHeartbeat(job.agentId);
            continue;
          }
          if (verdict === 'wait') continue;
          reservation = verdict;
        }
        if (!this.queue.claim(job.id)) continue;
        if (reservation) this.admission.hold(job.id, reservation);
        const p = handler(job)
          .then(() => this.queue.complete(job.id))
          .catch((err) => {
            this.k.log.error({ err, jobId: job.id, kind: job.kind }, 'job failed');
            this.queue.fail(job.id, errorMessage(err));
          })
          .finally(() => {
            this.admission.release(job.id);
            this.inFlight.delete(p);
          });
        this.inFlight.add(p);
      }
    } catch (err) {
      this.k.log.error({ err }, 'scheduler tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Reservation when the job may start now; 'wait' to retry next tick; 'drop' if its agent or org is gone. */
  private capacity(job: Job): Reservation | 'wait' | 'drop' {
    if (!job.orgId || !job.agentId) return 'drop';
    const agent = this.d.org.findAgent(job.orgId, job.agentId);
    if (!agent || agent.status === 'terminated') return 'drop';
    let org;
    try {
      org = this.d.org.getOrg(job.orgId);
    } catch {
      return 'drop';
    }
    if (org.status !== 'active') return 'drop';
    if (this.executor.busyAgents().has(agent.id)) return 'wait';
    return this.admission.loopSlot(org, agent) ?? 'wait';
  }

  private async runJob(job: Job): Promise<void> {
    if (!job.orgId || !job.agentId) return;
    const { orgId, agentId } = job;
    const heartbeat = job.kind === 'heartbeat';
    // One run handles one request; whatever else was queued on this wake goes back on the queue.
    const { request, rest } = heartbeat ? { request: { trigger: 'heartbeat' } satisfies Wake as Wake, rest: [] } : foldWakes(wakesOf(job.payload));
    // When the run is deferred for a temporary cause, the wakes queued behind it wait for the same cause.
    let leftover = rest;
    let leftoverAt: number | null = null;
    let deferrals = 0;
    try {
      if (heartbeat) {
        try {
          this.goals.sweep(orgId);
        } catch (err) {
          this.k.log.warn({ err, orgId }, 'goal sweep failed');
        }
      }
      if (!request) return;
      const summary = await this.executor.execute({
        orgId, agentId, trigger: request.trigger,
        issueId: request.issueId ?? null, prompt: request.prompt, triggerNote: request.triggerNote,
        resumeSessionId: request.resumeSessionId, goalId: request.goalId ?? null, approvalIds: request.approvalIds,
      });
      if (summary.skipped) {
        leftoverAt = this.onSkipped(job, request, summary);
        if (leftoverAt !== null) {
          leftover = [request, ...rest];
          deferrals = deferralsOf(job.payload) + 1;
        }
      }
    } finally {
      if (leftover.length > 0) this.requeue(orgId, agentId, leftover, leftoverAt ?? this.k.clock.now(), deferrals);
      if (heartbeat) this.scheduleHeartbeat(agentId);
    }
  }

  /**
   * A wake that produced no run. A temporary cause (agent paused, rate limit,
   * budget, kill switch) defers the wake with backoff instead of losing it —
   * agents without a cron heartbeat have nothing else to retry them. Returns
   * the time the wake is deferred to, or null when it is finished with.
   */
  private onSkipped(job: Job, request: Wake, summary: RunSummary): number | null {
    const skip = summary.skip ?? { code: 'no_work' as const, reason: summary.skipped ?? 'skipped', temporary: false };
    let deferredUntil: number | null = null;
    if (job.kind === 'event' && skip.temporary && job.orgId && job.agentId) {
      const n = deferralsOf(job.payload);
      const cap = skip.code === 'rate_limited' ? RATE_LIMIT_BACKOFF_CAP_MS : BLOCKED_BACKOFF_CAP_MS;
      deferredUntil = this.k.clock.now() + deferBackoffMs(n, cap);
    }
    this.k.log.debug({ agentId: job.agentId, reason: skip.reason, deferredUntil }, 'run skipped');
    // Idle heartbeats are the normal case, not news.
    if (job.kind === 'heartbeat' && skip.code === 'no_work') return deferredUntil;
    this.k.bus.emit('run.skipped', {
      orgId: job.orgId!, agentId: job.agentId!, jobId: job.id, trigger: request.trigger, code: skip.code, reason: skip.reason, deferredUntil,
    });
    return deferredUntil;
  }

  /** Put wakes back at the FRONT of the agent's pending wake job (creating it if needed). */
  private requeue(orgId: string, agentId: string, wakes: Wake[], runAt: number, deferrals: number): void {
    this.queue.enqueue({
      kind: 'event', orgId, agentId, runAt, dedupeKey: `wake:${agentId}`,
      payload: wakePayload(wakes, deferrals),
      merge: (existing, incoming) => mergeWakePayloads(existing, incoming, { front: true }),
    });
  }

  /**
   * Wake an agent now (events, manual run). There is one pending wake job per
   * agent; a second wake is merged into it, so its payload (webhook prompt,
   * approval note, pinned issue, goal) is queued rather than dropped.
   */
  wake(orgId: string, agentId: string, wake: Wake): string {
    return this.queue.enqueue({
      kind: 'event', orgId, agentId, dedupeKey: `wake:${agentId}`,
      payload: wakePayload([wake]),
      merge: (existing, incoming) => mergeWakePayloads(existing, incoming),
    }).id;
  }

  private scheduleHeartbeat(agentId: string): void {
    const agent = this.findAgentAnyOrg(agentId);
    if (!agent || agent.status !== 'active' || !agent.heartbeatCron) return;
    // Archived orgs are not scheduled.
    try {
      if (this.d.org.getOrg(agent.orgId).status !== 'active') return;
    } catch {
      return;
    }
    const runAt = nextCron(agent.heartbeatCron, this.k.clock.now());
    if (runAt === null) {
      this.k.log.warn({ agentId, cron: agent.heartbeatCron }, 'invalid heartbeat cron; agent will only wake on events');
      return;
    }
    this.queue.enqueue({ kind: 'heartbeat', orgId: agent.orgId, agentId, runAt, dedupeKey: `hb:${agentId}`, payload: { cron: agent.heartbeatCron } });
  }

  private findAgentAnyOrg(agentId: string) {
    return this.k.db.query.agents.findFirst({ where: (a, { eq: e }) => e(a.id, agentId) }).sync();
  }

  /** Reconcile pending heartbeat jobs with agent config (cron changed, paused, terminated, hired). */
  syncSchedules(): void {
    const orgs = this.d.org.listOrgs();
    for (const org of orgs) {
      for (const agent of this.d.org.listAgents(org.id)) {
        const key = `hb:${agent.id}`;
        const pending = this.queue.pendingByKey(key);
        const wants = agent.status === 'active' && !!agent.heartbeatCron;
        if (!wants) {
          if (pending) this.queue.cancelPending({ dedupeKey: key });
          continue;
        }
        if (pending && pending.payload.cron !== agent.heartbeatCron) this.queue.cancelPending({ dedupeKey: key });
        if (!pending || pending.payload.cron !== agent.heartbeatCron) this.scheduleHeartbeat(agent.id);
      }
    }
  }

  queueSync(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    setImmediate(() => {
      this.syncQueued = false;
      try {
        this.syncSchedules();
      } catch (err) {
        this.k.log.error({ err }, 'schedule sync failed');
      }
    });
  }
}
