import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Services } from '../daemon/container.js';
import type { ConfigRevision, Webhook } from '../contracts/rows.js';
import { isRevisionedConfig, type RevisionedConfig } from '../contracts/revisions.js';
import { OWNER, type Actor } from '../contracts/types.js';
import { configRevisions, webhooks } from '../db/schema/index.js';
import { ConductorError, invalid, notFound } from '../shared/errors.js';
import { GATEWAY_REVISION_KIND, REDACTED, appendRevision, rollbackGateway, withoutSecrets } from '../gateways/revisions.js';
import { REVISION_KINDS, type RevisionKind } from './types.js';
import { assertDeliverableUrl } from './webhooks/outbound.js';

export const WEBHOOK_REVISION_KIND = 'webhook';
/** Kinds whose history and rollback live in the org context (`OrgService.listRevisions` / `rollback`). */
const ORG_KINDS: readonly string[] = ['org', 'dept', 'agent', 'goal', 'playbook', 'project'];

export function asRevisionKind(kind: string): RevisionKind {
  if ((REVISION_KINDS as readonly string[]).includes(kind)) return kind as RevisionKind;
  throw invalid(`unsupported entity kind "${kind}" (expected one of: ${REVISION_KINDS.join(', ')})`);
}

/* ── Webhooks ── */

const CREDENTIAL_PARAM = /(token|secret|key|sig|signature|password|passwd|auth|credential|code)/i;

/** A destination URL as a snapshot may keep it: one that carries a credential (userinfo, token-like query parameter) is not stored. */
export function snapshotUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some((name) => CREDENTIAL_PARAM.test(name))) return REDACTED;
  } catch {
    return REDACTED;
  }
  return withoutSecrets(url) as string;
}

export function webhookSnapshot(row: Webhook): Record<string, unknown> {
  return {
    direction: row.direction, name: row.name, source: row.source, agentId: row.agentId, url: snapshotUrl(row.url), events: row.events,
    secretRef: row.secretRef, status: row.status,
  };
}

export function recordWebhookRevision(s: Services, row: Webhook, actor: Actor, note: string, extra: Record<string, unknown> = {}): number {
  return appendRevision(s.kernel, {
    orgId: row.orgId, entityKind: WEBHOOK_REVISION_KIND, entityId: row.id, snapshot: { ...webhookSnapshot(row), ...extra }, actor, note,
  });
}

const webhookSnapshotSchema = z.object({
  direction: z.enum(['in', 'out']),
  name: z.string().min(1),
  source: z.string().min(1).default('generic'),
  agentId: z.string().min(1).nullish().transform((v) => v ?? null),
  url: z.string().min(1).nullish().transform((v) => v ?? null),
  events: z.array(z.string()).default([]),
  secretRef: z.string().min(1).nullish().transform((v) => v ?? null),
  status: z.enum(['active', 'disabled']).catch('active'),
  removed: z.boolean().optional(),
});

/** Restore a webhook's config; one deleted since comes back under its old id (so an inbound URL works again). */
function rollbackWebhook(s: Services, rev: ConfigRevision, actor: Actor): void {
  const { db, audit, clock } = s.kernel;
  const orgId = rev.orgId;
  if (!orgId) throw notFound('webhook revision', rev.id);
  const parsed = webhookSnapshotSchema.safeParse(rev.snapshot);
  if (!parsed.success) throw invalid(`revision ${rev.revision} of webhook ${rev.entityId} cannot be restored: snapshot is malformed`);
  const snap = parsed.data;
  if (snap.removed) throw invalid(`revision ${rev.revision} records the removal of this webhook; roll back to an earlier revision to restore it`);
  const where = and(eq(webhooks.orgId, orgId), eq(webhooks.id, rev.entityId));
  const current = db.select().from(webhooks).where(where).get();
  if (current && current.direction !== snap.direction) throw invalid('cannot roll back: the webhook direction differs from the revision');

  // A URL kept out of the snapshot as credential-shaped stays as it is now.
  const url = snap.url === REDACTED ? (current?.url ?? null) : snap.url;
  if (snap.direction === 'out') {
    if (!url) throw invalid('cannot roll back: the destination URL was not kept in this revision and the webhook no longer exists');
    assertDeliverableUrl(url);
  }
  // The agent an inbound hook woke may have left since: restore the rest and leave it unassigned.
  const agent = snap.agentId ? s.org.findAgent(orgId, snap.agentId) : null;
  const agentId = agent && agent.orgId === orgId && agent.status !== 'terminated' ? agent.id : null;
  const fields = { name: snap.name, source: snap.source, agentId, url: snap.direction === 'out' ? url : null, events: snap.events, secretRef: snap.secretRef, status: snap.status };
  if (current) db.update(webhooks).set(fields).where(where).run();
  else db.insert(webhooks).values({ id: rev.entityId, orgId, direction: snap.direction, ...fields, createdAt: clock.now() }).run();
  const next = db.select().from(webhooks).where(where).get();
  if (!next) throw notFound('webhook', rev.entityId);
  const revision = recordWebhookRevision(s, next, actor, `rollback to revision ${rev.revision}`);
  audit.record({
    orgId, actor, action: 'config.changed', entityKind: WEBHOOK_REVISION_KIND, entityId: next.id,
    data: { change: 'rollback', rollbackTo: rev.revision, revision, restored: !current },
  });
}

/* ── Every revisioned kind ── */

/** Newest first. `orgId` scopes the lookup; gateways are listed by id alone (they may serve every org). */
export function listRevisions(s: Services, orgId: string | null, entityKind: string, entityId: string): ConfigRevision[] {
  const kind = asRevisionKind(entityKind);
  if (orgId && ORG_KINDS.includes(kind)) return s.org.listRevisions(orgId, kind, entityId);
  const where = [eq(configRevisions.entityKind, kind), eq(configRevisions.entityId, entityId)];
  if (orgId) where.push(eq(configRevisions.orgId, orgId));
  else if (kind !== GATEWAY_REVISION_KIND) throw invalid('an organization is required to list revisions of this kind');
  return s.kernel.db.select().from(configRevisions).where(and(...where)).orderBy(desc(configRevisions.revision)).all();
}

export function revisionById(s: Services, revisionId: string): ConfigRevision {
  const row = s.kernel.db.select().from(configRevisions).where(eq(configRevisions.id, revisionId)).get();
  if (!row) throw notFound('revision', revisionId);
  return row;
}

/** One revision by (kind, entity, number) inside an org; another org's entity behaves as not found. */
export function revisionOf(s: Services, orgId: string, entityKind: string, entityId: string, revision: number): ConfigRevision {
  const kind = asRevisionKind(entityKind);
  const row = s.kernel.db.select().from(configRevisions).where(and(
    eq(configRevisions.orgId, orgId), eq(configRevisions.entityKind, kind), eq(configRevisions.entityId, entityId), eq(configRevisions.revision, revision),
  )).get();
  if (!row) throw notFound(`${kind} revision`, `${entityId}@${revision}`);
  return row;
}

function owning(s: Services, kind: string): RevisionedConfig {
  for (const service of [s.connectors, s.browser] as unknown[]) {
    if (isRevisionedConfig(service) && service.revisionKinds.includes(kind)) return service;
  }
  throw new ConductorError('unavailable', `rolling back ${kind} configuration is not supported by this daemon build`);
}

/**
 * Roll back to `rev`, whichever context owns the entity. Human callers act as
 * OWNER. `reloadGateways` restarts messaging adapters after a gateway changed.
 */
export async function rollbackRevision(s: Services, rev: ConfigRevision, hooks: { reloadGateways?: () => void } = {}): Promise<void> {
  const kind = asRevisionKind(rev.entityKind);
  if (ORG_KINDS.includes(kind)) {
    if (!rev.orgId) throw notFound('revision', rev.id);
    s.org.rollback(rev.orgId, kind, rev.entityId, rev.revision, OWNER);
    // Heartbeats, budgets and reporting lines may have changed with the restored config.
    s.runtime.syncSchedules();
    return;
  }
  if (kind === GATEWAY_REVISION_KIND) {
    rollbackGateway(s.kernel, rev, OWNER);
    hooks.reloadGateways?.();
    return;
  }
  if (kind === WEBHOOK_REVISION_KIND) {
    rollbackWebhook(s, rev, OWNER);
    return;
  }
  if (!rev.orgId) throw notFound('revision', rev.id);
  await owning(s, kind).rollbackRevision(rev.orgId, kind, rev.entityId, rev.revision, OWNER);
}
