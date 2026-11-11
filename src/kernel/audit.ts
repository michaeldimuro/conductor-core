import { and, desc, eq, gte, isNull, type SQL } from 'drizzle-orm';
import { activityLog } from '../db/schema/index.js';
import type { AuditEntry, AuditLog, AuditRecord, Db } from '../contracts/kernel.js';
import type { Clock } from '../shared/util.js';
import { redact } from '../shared/util.js';

/** Append-only activity log over `activity_log` (UPDATE/DELETE blocked by triggers). */
export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  record(entry: AuditEntry): void {
    const data = entry.data ? (JSON.parse(redact(JSON.stringify(entry.data))) as Record<string, unknown>) : {};
    this.db
      .insert(activityLog)
      .values({
        orgId: entry.orgId,
        actorKind: entry.actor.kind,
        actorId: entry.actor.id ?? null,
        action: entry.action,
        entityKind: entry.entityKind ?? null,
        entityId: entry.entityId ?? null,
        runId: entry.runId ?? entry.actor.runId ?? null,
        issueId: entry.issueId ?? null,
        data,
        ts: this.clock.now(),
      })
      .run();
  }

  query(filter: Parameters<AuditLog['query']>[0]): AuditRecord[] {
    const where: SQL[] = [];
    if (filter.orgId === null) where.push(isNull(activityLog.orgId));
    else if (filter.orgId !== undefined) where.push(eq(activityLog.orgId, filter.orgId));
    if (filter.issueId) where.push(eq(activityLog.issueId, filter.issueId));
    if (filter.runId) where.push(eq(activityLog.runId, filter.runId));
    if (filter.entityKind) where.push(eq(activityLog.entityKind, filter.entityKind));
    if (filter.entityId) where.push(eq(activityLog.entityId, filter.entityId));
    if (filter.action) where.push(eq(activityLog.action, filter.action));
    if (filter.since !== undefined) where.push(gte(activityLog.ts, filter.since));

    const rows = this.db
      .select()
      .from(activityLog)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(activityLog.id))
      .limit(Math.min(filter.limit ?? 200, 5000))
      .all();

    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      orgId: r.orgId,
      actor: { kind: r.actorKind, id: r.actorId ?? undefined },
      action: r.action,
      entityKind: r.entityKind ?? undefined,
      entityId: r.entityId ?? undefined,
      runId: r.runId ?? undefined,
      issueId: r.issueId ?? undefined,
      data: r.data,
    }));
  }
}
