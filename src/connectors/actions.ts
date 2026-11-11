/**
 * What a tool call *does*, as far as the gateway can tell from its name and
 * arguments. Categories drive the default approval gates (payment, first send
 * to a new recipient, publish) and decide which calls are escalated after a
 * run has read untrusted content. Upstream tools only give us a name, so the
 * classification is deliberately conservative: a miss falls back to the
 * tool's configured policy, a false hit costs one approval.
 */
export type ActionCategory =
  /** Pay, purchase, charge, refund, place an order. */
  | 'payment'
  /** Send / reply / forward / DM to a recipient. */
  | 'send'
  /** Publish public content (post, tweet, broadcast). */
  | 'publish'
  /** Delete / remove / destroy. */
  | 'destructive'
  /** Run code or a shell. */
  | 'exec'
  /** Builtin browser: put a stored credential into a page. */
  | 'credential'
  /** Builtin browser: ordinary page interaction (click, type, select, upload). */
  | 'interaction'
  /** Any other change to the outside world (create, update, …). */
  | 'write'
  | 'other';

/** Split snake/kebab/dot/camelCase tool names into lowercase words. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const PAY_VERBS = new Set(['pay', 'purchase', 'buy', 'charge', 'refund', 'donate']);
const PAY_NOUNS = new Set(['payment', 'payout', 'checkout']);
const COMMIT_VERBS = new Set(['create', 'make', 'send', 'submit', 'confirm', 'capture', 'process', 'initiate', 'issue', 'place', 'complete']);
const EXEC_WORDS = new Set(['exec', 'execute', 'shell']);
const BUILTIN_EXEC_WORDS = new Set(['evaluate', 'eval']);
const DESTRUCTIVE_WORDS = new Set(['delete', 'remove', 'destroy']);
const SEND_VERBS = new Set(['send', 'reply', 'forward', 'dm', 'sms']);
const MESSAGE_NOUNS = new Set(['message', 'dm', 'chat', 'sms', 'email', 'mail']);
const PUBLISH_VERBS = new Set(['publish', 'tweet', 'retweet', 'broadcast']);
const PUBLISH_NOUNS = new Set(['tweet', 'article', 'blog']);
const AUTHOR_VERBS = new Set(['post', 'create', 'share', 'submit', 'add', 'new']);
const WRITE_WORDS = new Set(['post', 'create', 'update', 'write', 'edit', 'submit', 'upload', 'put', 'patch', 'insert']);
const INTERACTION_WORDS = new Set(['click', 'type', 'select', 'upload', 'hover', 'press', 'scroll', 'drag', 'fill']);
const CREDENTIAL_WORDS = new Set(['secret', 'credential', 'password']);

const any = (words: string[], set: Set<string>): boolean => words.some((w) => set.has(w));

/**
 * Category of a tool from its (unqualified) name. `builtin` tools are
 * Conductor's own servers, where page-interaction verbs are recognised; for an
 * upstream tool the same words are just a generic write.
 */
export function classifyAction(toolName: string, opts: { builtin?: boolean } = {}): ActionCategory {
  const words = nameWords(toolName);
  if (any(words, PAY_VERBS) || (any(words, PAY_NOUNS) && any(words, COMMIT_VERBS)) || (words.includes('order') && words.includes('place'))) return 'payment';
  if (any(words, EXEC_WORDS) || (opts.builtin && any(words, BUILTIN_EXEC_WORDS))) return 'exec';
  if (any(words, DESTRUCTIVE_WORDS)) return 'destructive';
  if (any(words, SEND_VERBS) || (words.includes('post') && any(words, MESSAGE_NOUNS))) return 'send';
  // "post" is a noun unless it leads the name (`post_users` is an HTTP verb, `create_post` is content).
  const postNoun = words.indexOf('post') > 0 || (words[0] === 'post' && (words.length === 1 || words[1] === 'to'));
  const authored = any(words, PUBLISH_NOUNS) && any(words, AUTHOR_VERBS);
  if (any(words, PUBLISH_VERBS) || postNoun || authored) return 'publish';
  if (opts.builtin && any(words, INTERACTION_WORDS)) return any(words, CREDENTIAL_WORDS) ? 'credential' : 'interaction';
  if (any(words, WRITE_WORDS)) return 'write';
  return 'other';
}

/** Categories that are escalated to Ask-first once a run has ingested untrusted content. */
export const isHighRiskCategory = (c: ActionCategory): boolean =>
  c === 'payment' || c === 'send' || c === 'publish' || c === 'destructive' || c === 'exec';

/** Ordinary page interaction: never escalated for what the page said, only for autonomy level 0. */
export const isInteraction = (c: ActionCategory): boolean => c === 'interaction' || c === 'credential';

const norm = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const AMOUNT_KEYS = new Set(['amount', 'amountusd', 'usd', 'total', 'totalusd', 'price', 'priceusd', 'cost', 'costusd', 'value', 'sum', 'subtotal', 'grandtotal']);
const MINOR_UNIT = /(cents?|minor|minorunits?)$/;
const isAmountKey = (k: string): boolean => AMOUNT_KEYS.has(k) || /(amount|amountusd|price|total)$/.test(k);

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.length > 40) return null;
  const m = /^\s*(?:usd|us\$|\$)?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(?:usd|dollars?)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]!.replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * The amount a payment-type call would spend, from its arguments: the largest
 * amount-looking field (nested objects and line items included). `*_cents` /
 * `*_minor` fields are converted; anything else is read as whole currency
 * units and — with no FX table — as USD, which over-estimates rather than
 * under-estimates for minor-unit APIs. Null when no amount is present.
 */
export function extractAmountUsd(args: unknown, depth = 0): number | null {
  if (depth > 4 || args === null || typeof args !== 'object') return null;
  let best: number | null = null;
  const consider = (n: number | null): void => {
    if (n !== null && n >= 0 && (best === null || n > best)) best = n;
  };
  const entries: Array<[string, unknown]> = Array.isArray(args)
    ? args.slice(0, 50).map((v): [string, unknown] => ['', v])
    : Object.entries(args as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (value !== null && typeof value === 'object') {
      consider(extractAmountUsd(value, depth + 1));
      continue;
    }
    const k = norm(key);
    const minor = MINOR_UNIT.test(k);
    const base = minor ? k.replace(MINOR_UNIT, '') : k;
    if (!isAmountKey(base) && !(minor && base === '')) continue;
    const n = toNumber(value);
    consider(n === null ? null : minor ? n / 100 : n);
  }
  return best;
}

const RECIPIENT_KEYS = new Set([
  'to', 'cc', 'bcc', 'recipient', 'recipients', 'recipientemail', 'toemail', 'toaddress', 'email', 'emails', 'emailaddress',
  'phone', 'phonenumber', 'tonumber', 'channel', 'channelid', 'chatid', 'userid', 'user', 'username', 'handle',
]);
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i;
const MAX_RECIPIENTS = 50;

function recipientStrings(value: unknown, depth = 0): string[] {
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  if (typeof value === 'string') return value.split(/[,;\n]/).map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 320);
  if (depth > 2 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.slice(0, MAX_RECIPIENTS).flatMap((v) => recipientStrings(v, depth + 1));
  // { email: … } / { address: … } / { id: … } entries of a recipient list.
  const o = value as Record<string, unknown>;
  for (const k of ['email', 'address', 'phone', 'number', 'id']) if (o[k] !== undefined) return recipientStrings(o[k], depth + 1);
  return [];
}

/**
 * Who a send-type call addresses, as stable keys for the known-recipient
 * list: a bare lowercase address for email (shared across connectors), and
 * `<server>:<id>` for everything else (channels, phone numbers, handles).
 * Empty when the arguments name nobody.
 */
export function extractRecipients(args: Record<string, unknown>, serverName: string): string[] {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(args)) {
    if (!RECIPIENT_KEYS.has(norm(key))) continue;
    for (const raw of recipientStrings(value)) {
      const email = EMAIL_RE.exec(raw)?.[0];
      out.add(email ? email.toLowerCase() : `${serverName}:${raw.toLowerCase()}`.slice(0, 500));
      if (out.size >= MAX_RECIPIENTS) return [...out];
    }
  }
  return [...out];
}

/** Origin of a URL argument (`https://host[:port]`), or null. */
export function originOf(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 4000) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Known-recipient key for "this credential has been used on this origin before". */
export const credentialUseKey = (secretRef: string, origin: string): string => `credential:${secretRef}@${origin}`.toLowerCase().slice(0, 500);

/** A per-call cost reported by a tool (`_meta` of an MCP result, or a builtin's `costUsd`). */
export function costFromMeta(meta: unknown): number | undefined {
  if (meta === null || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  const usage = m.usage !== null && typeof m.usage === 'object' ? (m.usage as Record<string, unknown>) : {};
  for (const v of [m.costUsd, m.cost_usd, m['conductor/costUsd'], usage.costUsd, usage.cost_usd]) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}
