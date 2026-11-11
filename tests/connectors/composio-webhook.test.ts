import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signComposioWebhook, verifyComposioSignature } from '../../src/connectors/index.js';

describe('Composio webhook signature verification', () => {
  const secret = 'composio-webhook-secret-1';
  const body = Buffer.from(JSON.stringify({ type: 'composio.trigger.message', data: { trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' } }));
  const now = 1_800_000_000_000;
  const ts = Math.floor(now / 1000);
  const id = 'msg_2abc';

  it('accepts a correctly signed delivery (webhook-id.webhook-timestamp.body, HMAC-SHA256, base64, v1)', () => {
    const signature = signComposioWebhook(secret, body, id, ts);
    expect(signature).toBe(`v1,${createHmac('sha256', secret).update(`${id}.${ts}.${body.toString('utf8')}`).digest('base64')}`);
    expect(verifyComposioSignature(secret, body, { id, timestamp: String(ts), signature }, now)).toEqual({ ok: true });
    // Rotation: any one of several signatures may match.
    expect(verifyComposioSignature(secret, body, { id, timestamp: String(ts), signature: `v1,${'A'.repeat(44)} ${signature}` }, now).ok).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, a different id and a replayed (stale) delivery', () => {
    const signature = signComposioWebhook(secret, body, id, ts);
    const headers = { id, timestamp: String(ts), signature };
    expect(verifyComposioSignature(secret, Buffer.from(`${body.toString()} `), headers, now)).toEqual({ ok: false, reason: 'bad signature' });
    expect(verifyComposioSignature('other-secret', body, headers, now)).toEqual({ ok: false, reason: 'bad signature' });
    expect(verifyComposioSignature(secret, body, { ...headers, id: 'msg_other' }, now)).toEqual({ ok: false, reason: 'bad signature' });
    expect(verifyComposioSignature(secret, body, headers, now + 5 * 60_000 + 1000)).toEqual({ ok: false, reason: 'stale timestamp' });
    expect(verifyComposioSignature(secret, body, { ...headers, timestamp: 'yesterday' }, now)).toEqual({ ok: false, reason: 'stale timestamp' });
    expect(verifyComposioSignature(secret, body, { ...headers, signature: 'v2,abc' }, now)).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('rejects unsigned requests and an empty secret; accepts the legacy hex header as a fallback', () => {
    expect(verifyComposioSignature(secret, body, {}, now)).toEqual({ ok: false, reason: 'missing headers' });
    expect(verifyComposioSignature('', body, { id, timestamp: String(ts), signature: signComposioWebhook('', body, id, ts) }, now).ok).toBe(false);
    const legacy = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyComposioSignature(secret, body, { legacySignature: legacy }, now)).toEqual({ ok: true });
    expect(verifyComposioSignature(secret, body, { legacySignature: legacy.replace(/.$/, legacy.endsWith('0') ? '1' : '0') }, now).ok).toBe(false);
  });
});
