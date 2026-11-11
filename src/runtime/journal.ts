import { and, asc, desc, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runs, runEvents, type RunStatus, type RunTrigger } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Run } from '../contracts/rows.js';
import type { RunEvent } from '../contracts/adapter.js';
import type { CapabilitySnapshot } from '../contracts/types.js';
import { newId } from '../shared/ids.js';
import { notFound } from '../shared/errors.js';
import { redact, truncate } from '../shared/util.js';

const MAX_EVENT_CHARS = 20_000;

/**
 * The run journal. Every status transition is a durable write, so a daemon
 * restart can tell exactly which runs were in flight. Events are indexed in
 * `run_events` and appended (redacted) to a JSONL transcript on disk.
 */
export class RunJournal {
  private seq = new Map<string, number>();
  private transcriptFile = new Map<string, string>();

  constructor(private readonly k: Kernel) {}

  /** Reserve a run id (checkout needs one before the run row is worth creating). */
  newRunId(): string {
    return newId('run');
  }

  create(input: {
    id?: string; orgId: string; orgSlug: string; agentId: string; issueId: string | null; trigger: RunTrigger;
  }): Run {
    const id = input.id ?? newId('run');
    const now = this.k.clock.now();
    const transcriptRef = this.k.paths.transcript(input.orgSlug, id);
    this.k.db
      .insert(runs)
      .values({
        id, orgId: input.orgId, agentId: input.agentId, issueId: input.issueId, trigger: input.trigger,
        status: 'running', phase: 'resolve', startedAt: now, createdAt: now, transcriptRef,
      })
      .run();
    mkdirSync(dirname(transcriptRef), { recursive: true });
    this.transcriptFile.set(id, transcriptRef);
    this.seq.set(id, 0);
    return this.get(input.orgId, id);
  }

  get(orgId: string, runId: string): Run {
    const r = this.k.db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.orgId, orgId))).get();
    if (!r) throw notFound('run', runId);
    return r;
  }

  find(runId: string): Run | undefined {
    return this.k.db.select().from(runs).where(eq(runs.id, runId)).get();
  }

  list(orgId: string, f: { agentId?: string; issueId?: string; status?: RunStatus; limit?: number } = {}): Run[] {
    const where = [eq(runs.orgId, orgId)];
    if (f.agentId) where.push(eq(runs.agentId, f.agentId));
    if (f.issueId) where.push(eq(runs.issueId, f.issueId));
    if (f.status) where.push(eq(runs.status, f.status));
    return this.k.db.select().from(runs).where(and(...where)).orderBy(desc(runs.createdAt)).limit(Math.min(f.limit ?? 100, 1000)).all();
  }

  update(runId: string, patch: Partial<typeof runs.$inferInsert>): void {
    this.k.db.update(runs).set(patch).where(eq(runs.id, runId)).run();
  }

  setPhase(runId: string, phase: string): void {
    this.update(runId, { phase });
  }

  snapshot(runId: string, snap: CapabilitySnapshot): void {
    this.update(runId, { capabilitySnapshot: snap });
  }

  /** Append a normalized event. `secrets` are scrubbed along with credential-shaped strings. */
  append(run: { id: string; orgId: string }, event: RunEvent, secrets: string[] = []): number {
    const seq = (this.seq.get(run.id) ?? this.lastSeq(run.id)) + 1;
    this.seq.set(run.id, seq);
    const ts = this.k.clock.now();
    const clean = JSON.parse(redact(JSON.stringify(event), secrets)) as RunEvent;
    const indexed = shrink(clean);
    this.k.db.insert(runEvents).values({ runId: run.id, orgId: run.orgId, seq, type: clean.type, payload: indexed, ts }).run();
    const file = this.transcriptFile.get(run.id) ?? this.find(run.id)?.transcriptRef ?? null;
    if (file) {
      try {
        appendFileSync(file, `${JSON.stringify({ seq, ts, event: clean })}\n`);
      } catch (err) {
        this.k.log.warn({ err, runId: run.id }, 'transcript append failed');
      }
    }
    this.k.bus.emit('run.event', { orgId: run.orgId, runId: run.id, seq, event: indexed });
    return seq;
  }

  events(orgId: string, runId: string, afterSeq = 0): Array<{ seq: number; ts: number; event: RunEvent }> {
    this.get(orgId, runId);
    return this.k.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.orgId, orgId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq))
      .all()
      .map((r) => ({ seq: r.seq, ts: r.ts, event: r.payload as RunEvent }));
  }

  finish(runId: string, patch: Partial<typeof runs.$inferInsert> & { status: RunStatus; outcome: string }): void {
    this.update(runId, { ...patch, endedAt: this.k.clock.now(), pid: null });
    this.seq.delete(runId);
    this.transcriptFile.delete(runId);
  }

  /** Runs the journal says were in flight (used at daemon start for crash recovery). */
  inFlight(): Run[] {
    return this.k.db.select().from(runs).where(inArray(runs.status, ['queued', 'running', 'paused'])).all();
  }

  /**
   * Runs started by an agent within the trailing window (runaway-loop guard),
   * per bucket: chat turns (`chat` trigger), skill evals (`system` trigger) and
   * the heartbeat loop (everything else) each have their own hourly allowance.
   */
  countSince(agentId: string, since: number, bucket: 'loop' | 'chat' | 'eval' = 'loop'): number {
    const inBucket =
      bucket === 'chat' ? sql`${runs.trigger} = 'chat'` : bucket === 'eval' ? sql`${runs.trigger} = 'system'` : sql`${runs.trigger} not in ('chat', 'system')`;
    const r = this.k.db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(and(eq(runs.agentId, agentId), gte(runs.createdAt, since), sql`${runs.outcome} is not 'no_work'`, inBucket))
      .get();
    return r?.n ?? 0;
  }

  /** True when this provider session was journaled by a run of this agent on this issue. */
  sessionBelongsTo(orgId: string, agentId: string, issueId: string, sessionId: string): boolean {
    const r = this.k.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.agentId, agentId), eq(runs.issueId, issueId), eq(runs.sessionId, sessionId)))
      .get();
    return !!r;
  }

  /** Consecutive failed runs on an issue (drives escalation after repeated failures). */
  recentFailures(issueId: string, limit = 3): number {
    const rows = this.k.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.issueId, issueId))
      .orderBy(desc(runs.createdAt))
      .limit(limit)
      .all();
    let n = 0;
    for (const r of rows) {
      if (r.status === 'failed') n++;
      else break;
    }
    return n;
  }

  private lastSeq(runId: string): number {
    const r = this.k.db.select({ m: sql<number>`coalesce(max(${runEvents.seq}), 0)` }).from(runEvents).where(eq(runEvents.runId, runId)).get();
    return r?.m ?? 0;
  }
}

/** Keep the DB index small; the JSONL transcript holds the full event. */
function shrink(e: RunEvent): RunEvent {
  switch (e.type) {
    case 'text':
    case 'thinking':
      return { ...e, text: truncate(e.text, MAX_EVENT_CHARS) };
    case 'tool_result':
      return { ...e, output: truncate(e.output, MAX_EVENT_CHARS) };
    case 'tool_call': {
      const s = JSON.stringify(e.input ?? null);
      return s.length > MAX_EVENT_CHARS ? { ...e, input: { _truncated: truncate(s, MAX_EVENT_CHARS) } } : e;
    }
    default:
      return e;
  }
}
