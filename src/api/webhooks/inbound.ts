import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Services } from '../../daemon/container.js';
import type { Webhook } from '../../contracts/rows.js';
import { SYSTEM } from '../../contracts/types.js';
import { webhooks } from '../../db/schema/index.js';
import { ConductorError, notFound } from '../../shared/errors.js';
import { RateLimiter, param, tooMany } from '../http.js';
import { SIGNATURE_HEADER, verifySha256Header, verifyStripe } from './signatures.js';

const MAX_BODY = 1024 * 1024;
const SEEN_PER_HOOK = 500;

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
};

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 300 ? v : undefined);

/** Event name + delivery id, per source convention. */
function describe(source: string, req: FastifyRequest, json: unknown): { event: string | null; deliveryId: string | null } {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (source === 'github') return { event: header(req, 'x-github-event') ?? null, deliveryId: header(req, 'x-github-delivery') ?? null };
  if (source === 'stripe') return { event: str(o.type) ?? null, deliveryId: str(o.id) ?? null };
  return {
    event: header(req, 'x-conductor-event') ?? str(o.type) ?? str(o.event) ?? str(o.trigger_name) ?? null,
    deliveryId: header(req, 'x-conductor-delivery') ?? str(o.id) ?? null,
  };
}

/**
 * `POST /hooks/:webhookId` — inbound triggers (GitHub, Stripe, Composio, generic).
 * Authenticated by an HMAC over the RAW body with the hook's secret; a hook
 * without a configured secret rejects everything. A verified delivery emits
 * `webhook.received`, on which the scheduler wakes the hook's agent.
 */
export function inboundWebhookRoutes(app: FastifyInstance, s: Services, opts: { ratePerMinute: number }): void {
  const k = s.kernel;
  const limiter = new RateLimiter(opts.ratePerMinute, 60_000);
  const seen = new Map<string, Set<string>>();

  // Signatures are computed over the exact bytes received: keep every body as a Buffer in this scope.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_req, payload, done) => done(null, payload));

  const reject = (hook: Webhook, reason: string): never => {
    k.audit.record({ orgId: hook.orgId, actor: SYSTEM, action: 'webhook.rejected', entityKind: 'webhook', entityId: hook.id, data: { reason, source: hook.source } });
    // One generic answer for every failure: the caller learns nothing about why.
    throw new ConductorError('unauthorized', 'webhook signature verification failed');
  };

  /** True the first time a delivery id is seen for this hook (bounded memory). */
  const firstDelivery = (hookId: string, deliveryId: string): boolean => {
    let set = seen.get(hookId);
    if (!set) {
      set = new Set();
      seen.set(hookId, set);
    }
    if (set.has(deliveryId)) return false;
    set.add(deliveryId);
    if (set.size > SEEN_PER_HOOK) set.delete(set.values().next().value as string);
    return true;
  };

  app.post('/hooks/:webhookId', { bodyLimit: MAX_BODY }, async (req, reply) => {
    const id = param(req, 'webhookId');
    const hook = k.db.select().from(webhooks).where(eq(webhooks.id, id)).get();
    if (!hook || hook.direction !== 'in' || hook.status !== 'active') throw notFound('webhook');
    if (!limiter.take(hook.id)) throw tooMany('this webhook');

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const secret = hook.secretRef ? await k.secrets.get(hook.secretRef).catch(() => null) : null;
    if (!secret) return reject(hook, 'no signing secret configured');

    if (hook.source === 'github') {
      if (!verifySha256Header(secret, raw, header(req, 'x-hub-signature-256'))) reject(hook, 'bad signature');
    } else if (hook.source === 'stripe') {
      const res = verifyStripe(secret, raw, header(req, 'stripe-signature'), k.clock.now());
      if (!res.ok) reject(hook, res.reason ?? 'bad signature');
    } else if (!verifySha256Header(secret, raw, header(req, SIGNATURE_HEADER))) {
      reject(hook, 'bad signature');
    }

    const json = parseJson(raw);
    const { event, deliveryId } = describe(hook.source, req, json);
    if (hook.events.length > 0 && !(event && hook.events.includes(event))) {
      return reply.code(202).send({ accepted: false, reason: 'event filtered' });
    }
    if (deliveryId && !firstDelivery(hook.id, deliveryId)) {
      return reply.code(200).send({ accepted: false, reason: 'duplicate delivery' });
    }

    k.audit.record({
      orgId: hook.orgId, actor: SYSTEM, action: 'webhook.received', entityKind: 'webhook', entityId: hook.id,
      data: { source: hook.source, event, deliveryId, bytes: raw.length, agentId: hook.agentId },
    });
    k.bus.emit('webhook.received', {
      orgId: hook.orgId,
      webhookId: hook.id,
      agentId: hook.agentId,
      payload: { source: hook.source, event, deliveryId, body: json ?? raw.toString('utf8') },
    });
    return reply.code(202).send({ accepted: true });
  });
}
