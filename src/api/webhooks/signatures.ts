import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_TOLERANCE_MS = 5 * 60_000;
export const SIGNATURE_HEADER = 'x-conductor-signature';

export function hmacSha256Hex(secret: string, data: Buffer | string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time comparison of two hex digests (length mismatch → false, without early exit on content). */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** `sha256=<hex>` header formats (GitHub `X-Hub-Signature-256`, `X-Conductor-Signature`). */
export function verifySha256Header(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m?.[1]) return false;
  return safeEqualHex(hmacSha256Hex(secret, raw), m[1].toLowerCase());
}

export function signSha256Header(secret: string, raw: Buffer | string): string {
  return `sha256=${hmacSha256Hex(secret, raw)}`;
}

/**
 * Stripe: `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…]`, signed
 * payload is `<t>.<raw body>`. Timestamps outside the tolerance are rejected,
 * which is what stops a captured delivery from being replayed later.
 */
export function verifyStripe(secret: string, raw: Buffer, header: string | undefined, nowMs: number, toleranceMs = STRIPE_TOLERANCE_MS): { ok: boolean; reason?: string } {
  if (!header) return { ok: false, reason: 'missing signature' };
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') t = value;
    else if (key === 'v1') v1.push(value.toLowerCase());
  }
  if (!t || !/^\d{1,12}$/.test(t) || v1.length === 0) return { ok: false, reason: 'malformed signature' };
  const expected = hmacSha256Hex(secret, Buffer.concat([Buffer.from(`${t}.`, 'utf8'), raw]));
  let match = false;
  for (const candidate of v1) if (safeEqualHex(expected, candidate)) match = true;
  if (!match) return { ok: false, reason: 'signature mismatch' };
  if (Math.abs(nowMs - Number(t) * 1000) > toleranceMs) return { ok: false, reason: 'timestamp outside tolerance' };
  return { ok: true };
}

export function signStripe(secret: string, raw: Buffer | string, timestampSec: number): string {
  return `t=${timestampSec},v1=${hmacSha256Hex(secret, `${timestampSec}.${typeof raw === 'string' ? raw : raw.toString('utf8')}`)}`;
}
