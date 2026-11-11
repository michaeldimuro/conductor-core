import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ComposioWebhookHeaders {
  /** `webhook-id` */
  id?: string;
  /** `webhook-timestamp` (unix seconds) */
  timestamp?: string;
  /** `webhook-signature`: one or more space-separated `v1,<base64>` entries */
  signature?: string;
  /** Legacy `x-composio-signature`: hex HMAC-SHA256 of the raw body */
  legacySignature?: string;
}

export interface ComposioVerification {
  ok: boolean;
  reason?: 'missing headers' | 'stale timestamp' | 'bad signature';
}

const TOLERANCE_MS = 5 * 60_000;

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Composio hands out a plain secret; a Standard-Webhooks style `whsec_<base64>` secret is keyed by its decoded bytes. */
function keys(secret: string): Buffer[] {
  const out = [Buffer.from(secret, 'utf8')];
  if (secret.startsWith('whsec_')) out.push(Buffer.from(secret.slice('whsec_'.length), 'base64'));
  return out;
}

/**
 * Native verification of a Composio trigger webhook.
 *
 * Composio signs deliveries Standard-Webhooks style: the signed content is
 * `<webhook-id>.<webhook-timestamp>.<raw body>`, HMAC-SHA256 with the webhook
 * secret, base64, sent as `webhook-signature: v1,<sig>` (several entries during
 * secret rotation). The timestamp must be within five minutes of `nowMs`, so
 * a captured delivery cannot be replayed later. Older projects send only
 * `x-composio-signature` (hex HMAC of the raw body), accepted as a fallback.
 * Always pass the exact bytes received.
 */
export function verifyComposioSignature(secret: string, rawBody: Buffer, headers: ComposioWebhookHeaders, nowMs: number): ComposioVerification {
  if (!secret) return { ok: false, reason: 'missing headers' };
  const { id, timestamp, signature, legacySignature } = headers;

  if (id && timestamp && signature) {
    const seconds = Number(timestamp);
    if (!/^\d{1,12}$/.test(timestamp) || !Number.isFinite(seconds) || Math.abs(nowMs - seconds * 1000) > TOLERANCE_MS) {
      return { ok: false, reason: 'stale timestamp' };
    }
    const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), rawBody]);
    const expected = keys(secret).map((key) => createHmac('sha256', key).update(signed).digest());
    const offered = signature
      .split(/\s+/)
      .slice(0, 10)
      .map((entry) => /^v1,([A-Za-z0-9+/=_-]{20,200})$/.exec(entry)?.[1])
      .filter((s): s is string => s !== undefined)
      .map((s) => Buffer.from(s, 'base64'));
    return offered.some((o) => expected.some((e) => equal(o, e))) ? { ok: true } : { ok: false, reason: 'bad signature' };
  }

  if (legacySignature) {
    const hex = legacySignature.trim().replace(/^sha256=/i, '');
    if (!/^[0-9a-f]{64}$/i.test(hex)) return { ok: false, reason: 'bad signature' };
    const offered = Buffer.from(hex, 'hex');
    const ok = keys(secret).some((key) => equal(offered, createHmac('sha256', key).update(rawBody).digest()));
    return ok ? { ok: true } : { ok: false, reason: 'bad signature' };
  }
  return { ok: false, reason: 'missing headers' };
}

/** Sign a body the way Composio does (tests and local fakes). */
export function signComposioWebhook(secret: string, rawBody: Buffer, id: string, timestampSeconds: number): string {
  const signed = Buffer.concat([Buffer.from(`${id}.${timestampSeconds}.`, 'utf8'), rawBody]);
  return `v1,${createHmac('sha256', Buffer.from(secret, 'utf8')).update(signed).digest('base64')}`;
}
