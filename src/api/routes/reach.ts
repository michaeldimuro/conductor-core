import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import type { Services } from '../../daemon/container.js';
import type { Gateway, Webhook } from '../../contracts/rows.js';
import { OWNER } from '../../contracts/types.js';
import { gateways, webhooks } from '../../db/schema/index.js';
import { invalid, notFound } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { body, orgOf, param, query, resolveOrg } from '../http.js';
import * as q from '../schemas/capabilities.js';
import { assertDeliverableUrl } from '../webhooks/outbound.js';
import type { Ok, WebhookDto } from '../types.js';

/**
 * Plain CRUD over the `gateways` and `webhooks` tables. Config only: secrets
 * are referenced (`authRef` / `secretRef`) and written through `/secrets`.
 * The messaging context watches the gateways table; nothing is emitted here.
 */
export interface GatewayControl {
  reload(): Promise<void>;
  mintPairingCode(gatewayId: string, ttlMs?: number): string;
  status(): Array<{ id: string; kind: string; status: string; lastError: string | null }>;
}

/** Keys the messaging context writes into a gateway's config at runtime; edits must not drop them. */
const RUNTIME_CONFIG_KEYS = ['state', 'pairingCodeHash', 'pairingExpiresAt', 'pairingAttempts', 'approverUserIds'];

export function reachRoutes(app: FastifyInstance, s: Services, control?: GatewayControl): void {
  const { db, clock, audit } = s.kernel;
  const reload = () => void control?.reload().catch((err) => s.kernel.log.warn({ err }, 'gateway reload failed'));

  /* ── Gateways (org_id NULL = serves every org) ── */
  const gatewayOf = (req: FastifyRequest): Gateway => {
    const id = param(req, 'gatewayId');
    const row = db.select().from(gateways).where(eq(gateways.id, id)).get();
    if (!row) throw notFound('gateway', id);
    return row;
  };

  app.get('/gateways', async (req) => {
    const { orgId } = query(req, q.listGatewaysQ);
    const where = orgId ? eq(gateways.orgId, resolveOrg(s, orgId).id) : undefined;
    return db.select().from(gateways).where(where).orderBy(asc(gateways.createdAt)).all();
  });
  app.post('/gateways', async (req) => {
    const input = body(req, q.createGateway);
    const orgId = input.orgId ? resolveOrg(s, input.orgId).id : null;
    const now = clock.now();
    const id = newId('gateway');
    db.insert(gateways).values({
      id, orgId, kind: input.kind, name: input.name, config: input.config ?? {}, authRef: input.authRef ?? null,
      status: input.status ?? 'active', createdAt: now, updatedAt: now,
    }).run();
    audit.record({ orgId, actor: OWNER, action: 'config.changed', entityKind: 'gateway', entityId: id, data: { op: 'create', kind: input.kind, name: input.name } });
    reload();
    return db.select().from(gateways).where(eq(gateways.id, id)).get();
  });
  app.get('/gateways/:gatewayId', async (req) => gatewayOf(req));
  app.patch('/gateways/:gatewayId', async (req) => {
    const row = gatewayOf(req);
    const patch = body(req, q.updateGateway);
    const set: Partial<typeof gateways.$inferInsert> = { updatedAt: clock.now() };
    if (patch.orgId !== undefined) set.orgId = patch.orgId ? resolveOrg(s, patch.orgId).id : null;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.config !== undefined) {
      const kept = Object.fromEntries(RUNTIME_CONFIG_KEYS.filter((k) => k in (row.config ?? {}) && !(k in patch.config!)).map((k) => [k, (row.config as Record<string, unknown>)[k]]));
      set.config = { ...patch.config, ...kept };
    }
    if (patch.authRef !== undefined) set.authRef = patch.authRef;
    if (patch.status !== undefined) {
      set.status = patch.status;
      set.lastError = null;
    }
    db.update(gateways).set(set).where(eq(gateways.id, row.id)).run();
    audit.record({ orgId: row.orgId, actor: OWNER, action: 'config.changed', entityKind: 'gateway', entityId: row.id, data: { op: 'update', fields: Object.keys(patch) } });
    reload();
    return db.select().from(gateways).where(eq(gateways.id, row.id)).get();
  });
  /** One-time code the owner sends to the bot from the chat they want to pair. */
  app.post('/gateways/:gatewayId/pairing-code', async (req): Promise<{ code: string }> => {
    const row = gatewayOf(req);
    if (!control) throw invalid('messaging gateways are not running in this process');
    return { code: control.mintPairingCode(row.id) };
  });
  app.get('/gateways-status', async () => control?.status() ?? []);
  app.delete('/gateways/:gatewayId', async (req): Promise<Ok> => {
    const row = gatewayOf(req);
    db.delete(gateways).where(eq(gateways.id, row.id)).run();
    audit.record({ orgId: row.orgId, actor: OWNER, action: 'config.changed', entityKind: 'gateway', entityId: row.id, data: { op: 'delete' } });
    reload();
    return { ok: true };
  });

  /* ── Webhooks (always org-scoped) ── */
  const dto = (row: Webhook): WebhookDto => ({ ...row, inboundUrl: row.direction === 'in' ? `${s.publicUrl()}/hooks/${row.id}` : null });
  const webhookOf = (req: FastifyRequest): Webhook => {
    const orgId = orgOf(s, req).id;
    const id = param(req, 'webhookId');
    const row = db.select().from(webhooks).where(and(eq(webhooks.orgId, orgId), eq(webhooks.id, id))).get();
    if (!row) throw notFound('webhook', id);
    return row;
  };
  /** Cross-field rules shared by create and update, checked on the resulting row. */
  const check = (orgId: string, w: Pick<Webhook, 'direction' | 'url' | 'agentId'>): void => {
    if (w.direction === 'out') {
      if (!w.url) throw invalid('url is required for outbound webhooks');
      assertDeliverableUrl(w.url);
    } else if (w.url) {
      throw invalid('url applies to outbound webhooks only');
    }
    if (w.agentId) s.org.getAgent(orgId, w.agentId);
  };

  app.get('/orgs/:orgId/webhooks', async (req) => {
    const orgId = orgOf(s, req).id;
    const { direction } = query(req, q.listWebhooksQ);
    const where = direction ? and(eq(webhooks.orgId, orgId), eq(webhooks.direction, direction)) : eq(webhooks.orgId, orgId);
    return db.select().from(webhooks).where(where).orderBy(asc(webhooks.createdAt)).all().map(dto);
  });
  app.post('/orgs/:orgId/webhooks', async (req) => {
    const orgId = orgOf(s, req).id;
    const input = body(req, q.createWebhook);
    const row = {
      id: newId('webhook'), orgId, direction: input.direction, name: input.name, source: input.source ?? 'generic',
      agentId: input.agentId ?? null, url: input.url ?? null, events: input.events ?? [], secretRef: input.secretRef ?? null,
      status: input.status ?? ('active' as const), createdAt: clock.now(),
    };
    check(orgId, row);
    db.insert(webhooks).values(row).run();
    audit.record({ orgId, actor: OWNER, action: 'config.changed', entityKind: 'webhook', entityId: row.id, data: { op: 'create', direction: row.direction, name: row.name } });
    return dto(row);
  });
  app.get('/orgs/:orgId/webhooks/:webhookId', async (req) => dto(webhookOf(req)));
  app.patch('/orgs/:orgId/webhooks/:webhookId', async (req) => {
    const row = webhookOf(req);
    const patch = body(req, q.updateWebhook);
    const next: Webhook = {
      ...row,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.events !== undefined ? { events: patch.events } : {}),
      ...(patch.secretRef !== undefined ? { secretRef: patch.secretRef } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    };
    check(row.orgId, next);
    const { id: _id, orgId: _orgId, createdAt: _createdAt, direction: _direction, ...set } = next;
    db.update(webhooks).set(set).where(and(eq(webhooks.orgId, row.orgId), eq(webhooks.id, row.id))).run();
    audit.record({ orgId: row.orgId, actor: OWNER, action: 'config.changed', entityKind: 'webhook', entityId: row.id, data: { op: 'update', fields: Object.keys(patch) } });
    return dto(next);
  });
  app.delete('/orgs/:orgId/webhooks/:webhookId', async (req): Promise<Ok> => {
    const row = webhookOf(req);
    db.delete(webhooks).where(and(eq(webhooks.orgId, row.orgId), eq(webhooks.id, row.id))).run();
    audit.record({ orgId: row.orgId, actor: OWNER, action: 'config.changed', entityKind: 'webhook', entityId: row.id, data: { op: 'delete' } });
    return { ok: true };
  });
}
