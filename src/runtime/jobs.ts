import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { jobs, type JobKind } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Job } from '../contracts/rows.js';
import { newId } from '../shared/ids.js';

export interface EnqueueInput {
  kind: JobKind;
  orgId?: string | null;
  agentId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: number;
  /** At most one PENDING job per key. A second enqueue is a no-op (collapses bursts and missed heartbeats). */
  dedupeKey?: string | null;
  maxAttempts?: number;
}

/**
 * DB-backed job table: cron heartbeats + event queue. Jobs survive daemon
 * restarts; `recover()` returns in-flight jobs to pending.
 */
export class JobQueue {
  constructor(private readonly k: Kernel, private readonly workerId: string) {}

  enqueue(input: EnqueueInput): { id: string; created: boolean } {
    const now = this.k.clock.now();
    return this.k.sqlite.transaction(() => {
      if (input.dedupeKey) {
        const existing = this.k.db
          .select({ id: jobs.id, runAt: jobs.runAt })
          .from(jobs)
          .where(and(eq(jobs.dedupeKey, input.dedupeKey), eq(jobs.status, 'pending')))
          .get();
        if (existing) {
          // Pull an existing job earlier if the new request is more urgent.
          const runAt = input.runAt ?? now;
          if (runAt < existing.runAt) {
            this.k.db.update(jobs).set({ runAt, payload: input.payload ?? {} }).where(eq(jobs.id, existing.id)).run();
          }
          return { id: existing.id, created: false };
        }
      }
      const id = newId('job');
      this.k.db
        .insert(jobs)
        .values({
          id,
          orgId: input.orgId ?? null,
          kind: input.kind,
          agentId: input.agentId ?? null,
          payload: input.payload ?? {},
          runAt: input.runAt ?? now,
          dedupeKey: input.dedupeKey ?? null,
          maxAttempts: input.maxAttempts ?? 3,
          createdAt: now,
        })
        .run();
      return { id, created: true };
    })();
  }

  /** Pending jobs that are due, oldest first. Does not claim them. */
  due(limit = 50): Job[] {
    return this.k.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, this.k.clock.now())))
      .orderBy(asc(jobs.runAt), asc(jobs.createdAt))
      .limit(limit)
      .all();
  }

  /** Atomically claim one pending job. False if someone else took it. */
  claim(jobId: string): boolean {
    const res = this.k.db
      .update(jobs)
      .set({ status: 'running', lockedBy: this.workerId, lockedAt: this.k.clock.now(), attempts: sql`${jobs.attempts} + 1` })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'pending')))
      .run();
    return res.changes === 1;
  }

  complete(jobId: string): void {
    this.k.db.update(jobs).set({ status: 'done', finishedAt: this.k.clock.now(), lockedBy: null }).where(eq(jobs.id, jobId)).run();
  }

  /** Return a claimed job to pending without counting an attempt (e.g. no capacity). */
  defer(jobId: string, runAt: number): void {
    this.k.db
      .update(jobs)
      .set({ status: 'pending', runAt, lockedBy: null, lockedAt: null, attempts: sql`max(${jobs.attempts} - 1, 0)` })
      .where(eq(jobs.id, jobId))
      .run();
  }

  /** Retry with exponential backoff until maxAttempts, then mark failed. */
  fail(jobId: string, error: string): void {
    const job = this.k.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job) return;
    const now = this.k.clock.now();
    if (job.attempts >= job.maxAttempts) {
      this.k.db.update(jobs).set({ status: 'failed', lastError: error, finishedAt: now, lockedBy: null }).where(eq(jobs.id, jobId)).run();
    } else {
      const backoff = Math.min(60_000 * 2 ** (job.attempts - 1), 15 * 60_000);
      this.k.db
        .update(jobs)
        .set({ status: 'pending', lastError: error, runAt: now + backoff, lockedBy: null, lockedAt: null })
        .where(eq(jobs.id, jobId))
        .run();
    }
  }

  cancelPending(filter: { dedupeKey?: string; agentId?: string; kind?: JobKind }): number {
    const where = [eq(jobs.status, 'pending')];
    if (filter.dedupeKey) where.push(eq(jobs.dedupeKey, filter.dedupeKey));
    if (filter.agentId) where.push(eq(jobs.agentId, filter.agentId));
    if (filter.kind) where.push(eq(jobs.kind, filter.kind));
    return this.k.db.update(jobs).set({ status: 'cancelled', finishedAt: this.k.clock.now() }).where(and(...where)).run().changes;
  }

  pendingByKey(dedupeKey: string): Job | undefined {
    return this.k.db.select().from(jobs).where(and(eq(jobs.dedupeKey, dedupeKey), eq(jobs.status, 'pending'))).get();
  }

  /** Daemon restart: jobs left `running` by a dead process go back to pending. */
  recover(): number {
    return this.k.db
      .update(jobs)
      .set({ status: 'pending', lockedBy: null, lockedAt: null })
      .where(eq(jobs.status, 'running'))
      .run().changes;
  }

  counts(): { pending: number; running: number } {
    const rows = this.k.db
      .select({ status: jobs.status, n: sql<number>`count(*)` })
      .from(jobs)
      .where(inArray(jobs.status, ['pending', 'running']))
      .groupBy(jobs.status)
      .all();
    return {
      pending: rows.find((r) => r.status === 'pending')?.n ?? 0,
      running: rows.find((r) => r.status === 'running')?.n ?? 0,
    };
  }

  /** Keep the table small: drop finished jobs older than `olderThanMs`. */
  prune(olderThanMs = 7 * 86_400_000): number {
    const cutoff = this.k.clock.now() - olderThanMs;
    return this.k.db
      .delete(jobs)
      .where(and(inArray(jobs.status, ['done', 'failed', 'cancelled']), lte(jobs.createdAt, cutoff)))
      .run().changes;
  }
}
