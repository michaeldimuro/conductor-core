import { and, eq } from 'drizzle-orm';
import type { Services } from '../../daemon/container.js';
import type { Job } from '../../contracts/rows.js';
import { SYSTEM } from '../../contracts/types.js';
import { webhooks } from '../../db/schema/index.js';
import type { DomainEvents, EventName } from '../../shared/events.js';
import { errorMessage, invalid } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import type { WebhookDelivery } from '../types.js';
import { SIGNATURE_HEADER, signSha256Header } from './signatures.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const DELIVERY_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 6;
/** Per-step transcript events are far too chatty to be webhook material. */
const NEVER_DELIVERED = new Set<EventName>(['run.event', 'webhook.received']);

/** Outbound destinations must be `https:`; plain `http:` is allowed for loopback only. */
export function assertDeliverableUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw invalid('webhook url is not a valid URL');
  }
  if (u.username || u.password) throw invalid('webhook url must not embed credentials');
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname.toLowerCase())) return u;
  throw invalid('webhook url must be https (http is allowed for loopback only)');
}

/**
 * Outbound webhooks: every bus event is matched against the org's active `out`
 * hooks; each match becomes a `webhook_out` job, so delivery is durable and
 * retried with the job queue's exponential backoff. Returns a disposer.
 */
export function startOutboundWebhooks(s: Services): () => void {
  const k = s.kernel;

  /** Attach the entity the event is about, so receivers need no second call. Best effort. */
  const enrich = (name: EventName, orgId: string, p: Record<string, unknown>): Record<string, unknown> => {
    try {
      if (name.startsWith('issue.') && typeof p.issueId === 'string') return { ...p, issue: s.work.findIssue(orgId, p.issueId) };
      if (name.startsWith('approval.') && typeof p.approvalId === 'string') return { ...p, approval: s.governance.approvals.get(orgId, p.approvalId) };
      if (name === 'run.finished' && typeof p.runId === 'string') {
        const { capabilitySnapshot: _snapshot, ...run } = s.runtime.getRun(orgId, p.runId);
        return { ...p, run };
      }
    } catch {
      // The bare event is still worth delivering.
    }
    return p;
  };

  const off = k.bus.onAny((name, payload) => {
    if (NEVER_DELIVERED.has(name)) return;
    const orgId = (payload as { orgId?: string | null }).orgId;
    if (typeof orgId !== 'string') return;
    const hooks = k.db.select().from(webhooks)
      .where(and(eq(webhooks.orgId, orgId), eq(webhooks.direction, 'out'), eq(webhooks.status, 'active'))).all()
      .filter((h) => h.events.includes(name) || h.events.includes('*'));
    if (hooks.length === 0) return;
    const data = enrich(name, orgId, payload as DomainEvents[EventName] as unknown as Record<string, unknown>);
    for (const hook of hooks) {
      const delivery: WebhookDelivery = { id: newId('activity'), event: name, orgId, ts: k.clock.now(), data };
      s.runtime.enqueue({ kind: 'webhook_out', orgId, payload: { webhookId: hook.id, delivery }, maxAttempts: MAX_ATTEMPTS });
    }
  });

  s.runtime.registerJobHandler('webhook_out', async (job: Job) => {
    const { webhookId, delivery } = job.payload as { webhookId?: string; delivery?: WebhookDelivery };
    if (!job.orgId || typeof webhookId !== 'string' || !delivery) return;
    const hook = k.db.select().from(webhooks).where(and(eq(webhooks.orgId, job.orgId), eq(webhooks.id, webhookId))).get();
    // Deleted or disabled since the event fired: drop silently rather than retry.
    if (!hook || hook.direction !== 'out' || hook.status !== 'active' || !hook.url) return;
    const url = assertDeliverableUrl(hook.url);

    const bodyText = JSON.stringify(delivery);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': `conductor/${s.version}`,
      'x-conductor-event': delivery.event,
      'x-conductor-delivery': delivery.id,
    };
    if (hook.secretRef) {
      const secret = await k.secrets.get(hook.secretRef);
      if (!secret) throw new Error(`webhook ${hook.id}: signing secret is not in the secret store`);
      headers[SIGNATURE_HEADER] = signSha256Header(secret, bodyText);
    }

    let status: number;
    try {
      const res = await fetch(url, { method: 'POST', headers, body: bodyText, redirect: 'manual', signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
      status = res.status;
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      throw new Error(`webhook ${hook.id}: delivery failed: ${errorMessage(e)}`, { cause: e });
    }
    if (status < 200 || status >= 300) throw new Error(`webhook ${hook.id}: destination answered ${status}`);
    k.audit.record({
      orgId: hook.orgId, actor: SYSTEM, action: 'webhook.delivered', entityKind: 'webhook', entityId: hook.id,
      data: { event: delivery.event, deliveryId: delivery.id, status, attempt: job.attempts },
    });
  });

  return off;
}
