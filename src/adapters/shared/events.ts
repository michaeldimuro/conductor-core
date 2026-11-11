import { z } from 'zod';
import type { RunContext, RunEvent } from '../../contracts/adapter.js';

const kind = z.enum(['rate_limit', 'auth', 'outage', 'invalid_request', 'other']);
const count = z.number().finite().nonnegative();

/** Runtime validation for RunEvents arriving from outside the process (process / http adapters, plugins). */
export const runEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), id: z.string(), name: z.string(), output: z.string(), isError: z.boolean() }),
  z.object({
    type: z.literal('usage'),
    tokensIn: count,
    tokensOut: count,
    costUsd: count,
    cacheReadTokens: count.optional(),
    cacheWriteTokens: count.optional(),
  }),
  z.object({ type: z.literal('session'), sessionId: z.string() }),
  z.object({ type: z.literal('status'), status: z.string() }),
  z.object({ type: z.literal('error'), kind, message: z.string(), retryable: z.boolean() }),
]);

export function parseRunEvent(value: unknown): RunEvent | null {
  const r = runEventSchema.safeParse(value);
  return r.success ? (r.data as RunEvent) : null;
}

export interface Scrubber {
  text(s: string): string;
  value<T>(v: T): T;
  event(e: RunEvent): RunEvent;
}

const MASK = '[REDACTED]';

/** Every credential an adapter holds for a run: provider secrets, the run token, gateway header values. */
export function secretValuesOf(ctx: Pick<RunContext, 'secrets' | 'runToken' | 'mcpEndpoints'>): string[] {
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    if (s && s.length >= 6) out.add(s);
  };
  for (const v of Object.values(ctx.secrets ?? {})) add(v);
  add(ctx.runToken);
  for (const ep of ctx.mcpEndpoints ?? []) {
    for (const v of Object.values(ep.headers ?? {})) {
      add(v);
      add(v.replace(/^(Bearer|Basic|Token)\s+/i, ''));
    }
  }
  // Longest first so a secret that contains another is masked whole.
  return [...out].sort((a, b) => b.length - a.length);
}

/** Masks known secret values in anything an adapter emits (events, final text, error messages). */
export function createScrubber(secrets: string[]): Scrubber {
  const text = (s: string): string => {
    let out = s;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(MASK);
    }
    return out;
  };
  const value = <T>(v: T): T => {
    if (typeof v === 'string') return text(v) as T;
    if (Array.isArray(v)) return v.map((x) => value(x)) as T;
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[text(k)] = value(x);
      return o as T;
    }
    return v;
  };
  return { text, value, event: (e) => (secrets.length === 0 ? e : value(e)) };
}
