import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import pino, { type Logger } from 'pino';

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** Controllable clock for tests. */
export class FakeClock implements Clock {
  constructor(private t = 1_700_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(t: number): void {
    this.t = t;
  }
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable JSON (sorted keys) so hashes of schemas/args are deterministic. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** First day of the current calendar month (UTC) — budget windows are monthly. */
export function monthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // telegram bot token
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Redact anything that looks like a credential. Applied to logs and transcripts. */
export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const s of extraSecrets) {
    if (s && s.length >= 6) out = out.split(s).join('[REDACTED]');
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

export function createLogger(name: string, level?: string): Logger {
  return pino({
    name,
    level: level ?? process.env.CONDUCTOR_LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info'),
    redact: {
      paths: ['*.apiKey', '*.token', '*.password', '*.secret', '*.authorization', 'headers.authorization'],
      censor: '[REDACTED]',
    },
    hooks: {
      logMethod(args, method) {
        method.apply(
          this,
          args.map((a) => (typeof a === 'string' ? redact(a) : a)) as Parameters<typeof method>,
        );
      },
    },
  });
}

export type { Logger };

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Rough token estimate (4 chars/token) for context budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}
