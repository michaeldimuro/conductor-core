import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayKind } from '../db/schema/reach.js';
import type { GatewayAdapter, WebhookRoute } from './types.js';

type Lookup = (gatewayId: string) => { kind: GatewayKind; adapter: GatewayAdapter } | null;

const GATEWAY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Inbound platform webhooks only. They are unauthenticated at the HTTP layer
 * (the platforms cannot carry an owner token) and authenticated by signature
 * inside each adapter, which is why the raw body is captured untouched.
 * Gateway CRUD lives in the API context.
 */
export function createGatewayRoutes(lookup: Lookup): FastifyPluginAsync {
  return async (app) => {
    // Scoped to this plugin: every body arrives as the exact bytes that were signed.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

    const handler = (kind: GatewayKind, route: WebhookRoute) => async (req: FastifyRequest<{ Params: { gatewayId: string } }>, reply: FastifyReply) => {
      const { gatewayId } = req.params;
      const entry = GATEWAY_ID_RE.test(gatewayId) ? lookup(gatewayId) : null;
      if (!entry || entry.kind !== kind || !entry.adapter.handleWebhook) return reply.code(404).send({ error: 'not_found' });
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const res = await entry.adapter.handleWebhook(route, { headers: req.headers, rawBody });
      reply.code(res.status);
      if (typeof res.body === 'string') return reply.type(res.contentType ?? 'text/plain; charset=utf-8').send(res.body);
      return reply.type('application/json; charset=utf-8').send(JSON.stringify(res.body ?? {}));
    };

    app.post('/gateways/slack/:gatewayId/events', handler('slack', 'events'));
    app.post('/gateways/slack/:gatewayId/interactions', handler('slack', 'interactions'));
    app.post('/gateways/discord/:gatewayId/interactions', handler('discord', 'interactions'));
  };
}
