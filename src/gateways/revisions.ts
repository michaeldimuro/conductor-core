import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Kernel } from '../contracts/kernel.js';
import type { ConfigRevision, Gateway } from '../contracts/rows.js';
import type { Actor } from '../contracts/types.js';
import { configRevisions } from '../db/schema/index.js';
import { GATEWAY_KINDS, gateways } from '../db/schema/reach.js';
import { forbidden, invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { redact } from '../shared/util.js';

/** `config_revisions.entity_kind` of a messaging gateway. */
export const GATEWAY_REVISION_KIND = 'gateway';

/**
 * Keys the gateway context writes into `config` while running: adapter state
 * and the pending pairing code (hash, expiry, attempts). They are not
 * configuration, are never part of a revision, and survive a rollback as they are.
 */
export const GATEWAY_RUNTIME_KEYS = ['state', 'pairingCodeHash', 'pairingExpiresAt', 'pairingAttempts'] as const;

/** Stands in for a credential-shaped value that was kept out of a revision. */
export const REDACTED = '[REDACTED]';

/** Append one row to the shared `config_revisions` history (monotonic per entity). Returns the revision number. */
export function appendRevision(
  k: Kernel,
  input: { orgId: string | null; entityKind: string; entityId: string; snapshot: Record<string, unknown>; actor: Actor; note: string },
): number {
  const last = k.db.select({ revision: configRevisions.revision }).from(configRevisions)
    .where(and(eq(configRevisions.entityKind, input.entityKind), eq(configRevisions.entityId, input.entityId)))
    .orderBy(desc(configRevisions.revision)).get();
  const revision = (last?.revision ?? 0) + 1;
  k.db.insert(configRevisions).values({
    id: newId('revision'), orgId: input.orgId, entityKind: input.entityKind, entityId: input.entityId, revision,
    snapshot: input.snapshot, author: `${input.actor.kind}:${input.actor.id ?? ''}`, note: input.note, ts: k.clock.now(),
  }).run();
  return revision;
}

/** One revision of an entity; `orgId` null selects install-wide entities (gateways serving every org). */
export function findRevision(k: Kernel, orgId: string | null, entityKind: string, entityId: string, revision: number): ConfigRevision {
  const row = k.db.select().from(configRevisions).where(and(
    orgId === null ? isNull(configRevisions.orgId) : eq(configRevisions.orgId, orgId),
    eq(configRevisions.entityKind, entityKind), eq(configRevisions.entityId, entityId), eq(configRevisions.revision, revision),
  )).get();
  if (!row) throw notFound(`${entityKind} revision`, `${entityId}@${revision}`);
  return row;
}

/** Deep copy with credential-shaped strings replaced by `REDACTED`: a revision holds refs, never secret values. */
export function withoutSecrets(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value) === value ? value : REDACTED;
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => withoutSecrets(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, withoutSecrets(v, depth + 1)]));
}

/** Where a snapshot says `REDACTED`, the value now in place is kept. */
export function restoreRedacted(snapshot: unknown, current: unknown): unknown {
  if (snapshot === REDACTED) return current;
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const cur = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(snapshot as Record<string, unknown>)) {
    const restored = restoreRedacted(v, cur[key]);
    if (restored !== undefined) out[key] = restored;
  }
  return out;
}

/** The owner-editable config of a gateway: everything in `config` except the runtime keys, with no secret values. */
export function gatewaySnapshot(row: Pick<Gateway, 'orgId' | 'kind' | 'name' | 'config' | 'authRef' | 'status'>): Record<string, unknown> {
  const config = Object.fromEntries(Object.entries(row.config ?? {}).filter(([key]) => !(GATEWAY_RUNTIME_KEYS as readonly string[]).includes(key)));
  return {
    orgId: row.orgId, kind: row.kind, name: row.name, config: withoutSecrets(config), authRef: row.authRef,
    // `error` is a runtime condition, not something the owner configured.
    status: row.status === 'disabled' ? 'disabled' : 'active',
  };
}

export function recordGatewayRevision(k: Kernel, row: Gateway, actor: Actor, note: string, extra: Record<string, unknown> = {}): number {
  return appendRevision(k, { orgId: row.orgId, entityKind: GATEWAY_REVISION_KIND, entityId: row.id, snapshot: { ...gatewaySnapshot(row), ...extra }, actor, note });
}

const snapshotSchema = z.object({
  orgId: z.string().min(1).nullish().transform((v) => v ?? null),
  kind: z.enum(GATEWAY_KINDS),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  authRef: z.string().min(1).nullish().transform((v) => v ?? null),
  status: z.enum(['active', 'disabled']).catch('active'),
  removed: z.boolean().optional(),
});

/**
 * Restore the gateway config captured by `rev` (allow-lists, notification
 * routing, platform settings, auth ref, enabled/disabled). A gateway deleted
 * since is re-created under its old id. Adapter state and a pending pairing
 * code are left as they are. The restore is recorded as a new revision and
 * audited; the caller reloads the running adapters.
 */
export function rollbackGateway(k: Kernel, rev: ConfigRevision, actor: Actor): Gateway {
  if (actor.kind === 'agent') throw forbidden('agents may not roll back configuration; this is a board action');
  if (rev.entityKind !== GATEWAY_REVISION_KIND) throw invalid(`revision ${rev.id} is not a gateway revision`);
  const parsed = snapshotSchema.safeParse(rev.snapshot);
  if (!parsed.success) throw invalid(`revision ${rev.revision} of gateway ${rev.entityId} cannot be restored: snapshot is malformed`);
  const snap = parsed.data;
  if (snap.removed) throw invalid(`revision ${rev.revision} records the removal of this gateway; roll back to an earlier revision to restore it`);

  return k.sqlite.transaction((): Gateway => {
    const current = k.db.select().from(gateways).where(eq(gateways.id, rev.entityId)).get();
    const live = (current?.config ?? {}) as Record<string, unknown>;
    const runtime = Object.fromEntries(GATEWAY_RUNTIME_KEYS.filter((key) => key in live).map((key) => [key, live[key]]));
    const config = { ...(restoreRedacted(snap.config, live) as Record<string, unknown>), ...runtime };
    const now = k.clock.now();
    const fields = { orgId: snap.orgId, name: snap.name, config, authRef: snap.authRef, status: snap.status, lastError: null, updatedAt: now };
    if (current) k.db.update(gateways).set(fields).where(eq(gateways.id, current.id)).run();
    else k.db.insert(gateways).values({ id: rev.entityId, kind: snap.kind, ...fields, createdAt: now }).run();
    const next = k.db.select().from(gateways).where(eq(gateways.id, rev.entityId)).get();
    if (!next) throw notFound('gateway', rev.entityId);
    const revision = recordGatewayRevision(k, next, actor, `rollback to revision ${rev.revision}`);
    k.audit.record({
      orgId: next.orgId, actor, action: 'config.changed', entityKind: GATEWAY_REVISION_KIND, entityId: next.id,
      data: { change: 'rollback', rollbackTo: rev.revision, revision, restored: !current },
    });
    return next;
  })();
}
