import type { GatewayAdapter, OutboundMessage } from './types.js';

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
export const APPROVAL_ID_RE = new RegExp(`^apr_${ULID}$`);
export const ISSUE_ID_RE = new RegExp(`^iss_${ULID}$`);
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Canonical form of an entity id typed by a human (`APR_01h…` → `apr_01H…`). */
export function normalizeId(raw: string): string {
  const i = raw.indexOf('_');
  if (i < 0) return raw;
  return `${raw.slice(0, i).toLowerCase()}_${raw.slice(i + 1).toUpperCase()}`;
}

/**
 * Split text to a platform's message limit, preferring paragraph, line and
 * word boundaries, and never splitting a surrogate pair.
 */
export function chunkText(text: string, limit: number): string[] {
  const max = Math.max(1, Math.floor(limit));
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const floor = Math.floor(max / 2);
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < floor) cut = rest.lastIndexOf('\n', max);
    if (cut < floor) cut = rest.lastIndexOf(' ', max);
    if (cut < floor) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff && cut > 1) cut -= 1;
    }
    const head = rest.slice(0, cut).trimEnd();
    if (head) out.push(head);
    rest = rest.slice(cut).replace(/^[\n ]+/, '');
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Chunk and send; buttons ride on the last chunk. */
export async function deliver(adapter: GatewayAdapter, chatId: string, message: OutboundMessage): Promise<void> {
  const chunks = chunkText(message.text.trim() || '(empty message)', adapter.maxLength);
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    await adapter.send(chatId, {
      text: chunks[i]!,
      subject: message.subject,
      buttons: last ? message.buttons : undefined,
    });
  }
}

/** Serializes async work per key (one chat is handled in order; different chats run concurrently). */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  run(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
  }
}

export function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface HttpJsonResult {
  status: number;
  json: unknown;
}

/** JSON-over-HTTP with a timeout. Error messages never include the URL (it may embed a token). */
export async function httpJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal; timeoutMs?: number },
): Promise<HttpJsonResult> {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'POST',
      headers: { ...(init.body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal,
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') throw new Error(init.signal?.aborted ? 'request aborted' : 'request timed out');
    throw new Error('network request failed');
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Sleep that resolves early when the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Small bounded "seen" set for de-duplicating retried deliveries. */
export class SeenSet {
  private seen = new Set<string>();
  constructor(private readonly max = 1000) {}

  /** True the first time a key is offered. */
  add(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.max) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    return true;
  }
}
