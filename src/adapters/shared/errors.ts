import type { AdapterErrorKind } from '../../contracts/adapter.js';

/** The kinds that make `runChain` move on to the next binding (PRD "Routing and fallback"). */
export const FALLBACK_KINDS: ReadonlySet<AdapterErrorKind> = new Set<AdapterErrorKind>(['rate_limit', 'auth', 'outage']);

/** A provider failure that has already been classified. Thrown inside adapters, never across `run()`. */
export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;

  constructor(kind: AdapterErrorKind, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.kind = kind;
  }

  get retryable(): boolean {
    return isRetryable(this.kind);
  }
}

export function isRetryable(kind: AdapterErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'outage';
}

/** Classify an HTTP status from a provider or webhook. */
export function kindFromStatus(status: number): AdapterErrorKind {
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status >= 500) return 'outage';
  if (status >= 400) return 'invalid_request';
  return 'other';
}

const MESSAGE_RULES: Array<[AdapterErrorKind, RegExp]> = [
  ['rate_limit', /rate.?limit|usage limit|quota|too many requests|\b429\b/i],
  ['auth', /invalid api key|api key|unauthori[sz]ed|authenticat|not logged in|please run \/login|login required|forbidden|\b401\b|\b403\b/i],
  ['outage', /overloaded|service unavailable|bad gateway|gateway timeout|internal server error|econnrefused|econnreset|enotfound|etimedout|network|connection (error|refused|reset)|stream disconnected|\b5\d\d\b/i],
  ['invalid_request', /invalid request|bad request|unsupported|unknown model|model not found|\b400\b|\b404\b/i],
];

/**
 * Best-effort classification of free-text CLI errors. The local agent CLIs only
 * report failures as prose, so this is a heuristic; anything unrecognised is
 * `other` and does not trigger fallback.
 */
export function kindFromMessage(text: string): AdapterErrorKind {
  for (const [kind, re] of MESSAGE_RULES) {
    if (re.test(text)) return kind;
  }
  return 'other';
}

export function toAdapterError(e: unknown, fallbackKind: AdapterErrorKind = 'other'): AdapterError {
  if (e instanceof AdapterError) return e;
  return new AdapterError(fallbackKind, e instanceof Error ? e.message : String(e));
}
