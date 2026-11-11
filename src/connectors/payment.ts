/**
 * Does a tool call move money? Decided from three kinds of evidence, strongest
 * first:
 *
 * 1. the tool's name (`pay_invoice`, `create_order`, `payout`, `subscribe`, …),
 * 2. what the upstream says about the tool (MCP `annotations.title`, description),
 * 3. the shape of the arguments (an amount next to a currency or a payment method).
 *
 * Lookups (`list_payments`, `get_order`, `payment_status`) and non-spending
 * changes (`cancel_order`, `void_charge`) are never payments. Evidence 2 and 3
 * comes from the untrusted upstream / the model, so it can only *add* a gate,
 * with one exception: a tool the upstream declares read-only is not turned
 * into a payment by soft evidence alone (its name still can).
 */

/** Split snake/kebab/dot/camelCase tool names into lowercase words. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface PaymentEvidence {
  description?: string;
  /** MCP tool annotations as sent by the upstream (untrusted). */
  annotations?: { title?: string; readOnlyHint?: boolean };
  args?: unknown;
}

const singular = (w: string): string => (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
const has = (words: readonly string[], set: ReadonlySet<string>): boolean => words.some((w) => set.has(w));

/** Words that are only ever the act of spending. */
const SPEND_VERBS = new Set(['pay', 'purchase', 'buy', 'donate', 'repay', 'prepay']);
/** Money movements that read as a verb or a noun (`refund_charge` vs `list_refunds`). */
const MONEY_ACTS = new Set(['charge', 'refund', 'payout', 'withdraw', 'withdrawal', 'checkout', 'disburse', 'disbursement', 'remit', 'remittance', 'topup']);
/** Things that are a payment once something commits them. */
const MONEY_OBJECTS = new Set(['payment', 'order', 'purchase', 'subscription', 'donation', 'tip']);
const MONEY_NOUNS = new Set(['money', 'fund', 'funds', 'cash', 'wire', 'ach', 'sepa']);
const COMMIT_VERBS = new Set([
  'create', 'make', 'send', 'submit', 'confirm', 'capture', 'process', 'initiate', 'issue', 'place', 'complete', 'execute', 'new', 'authorize', 'finalize',
]);
const TRANSFER_VERBS = new Set(['create', 'make', 'initiate', 'submit', 'execute', 'new', 'send', 'confirm']);
/** Reads, previews and changes that do not spend: a name carrying one of these is not a payment by itself. */
const NON_SPENDING = new Set([
  'get', 'list', 'search', 'find', 'fetch', 'read', 'retrieve', 'show', 'view', 'describe', 'lookup', 'query', 'count', 'check', 'verify', 'validate', 'preview',
  'estimate', 'quote', 'calculate', 'simulate', 'export', 'download', 'status', 'history', 'report', 'summary', 'detail', 'details', 'track', 'watch',
  'cancel', 'void', 'update', 'edit', 'delete', 'remove', 'archive', 'reject', 'decline', 'pause', 'expire', 'close',
]);
/** `subscribe` to something that is not a paid plan. */
const FREE_SUBSCRIPTIONS = new Set([
  'channel', 'topic', 'webhook', 'event', 'notification', 'newsletter', 'feed', 'list', 'thread', 'issue', 'repo', 'repository', 'calendar', 'push', 'stream',
  'alert', 'mailing', 'resource', 'room', 'user', 'label', 'tag', 'board', 'page',
]);
/** Words that make a neutral-looking name a payment once the arguments carry an amount. */
const AMBIGUOUS_WITH_AMOUNT = new Set(['transfer', 'order', 'subscribe', 'subscription', 'send', 'deposit', 'wire', 'fund', 'bill', 'settle', 'trade', 'bid']);
/** Catalog and bookkeeping records carry prices without spending anything. */
const BOOKKEEPING = new Set([
  'product', 'price', 'plan', 'listing', 'item', 'quote', 'estimate', 'coupon', 'discount', 'budget', 'invoice', 'expense', 'deal', 'opportunity', 'record',
  'entry', 'forecast', 'goal', 'catalog', 'sku', 'variant', 'row', 'cell', 'sheet', 'note', 'contact', 'lead',
]);

/** Payment judged from the name alone. */
export function paymentByName(toolName: string): boolean {
  const raw = nameWords(toolName);
  const words = raw.map(singular);
  if (words.length === 0) return false;
  if (has(words, SPEND_VERBS)) return !has(words, NON_SPENDING) || has(words, COMMIT_VERBS);
  if (has(words, NON_SPENDING) && !has(words, COMMIT_VERBS)) return false;
  if (has(words, MONEY_ACTS)) return true;
  const commits = has(words, COMMIT_VERBS);
  if (has(words, MONEY_OBJECTS) && commits) return true;
  if (has(raw, MONEY_NOUNS) && (commits || words.includes('transfer') || words.includes('move'))) return true;
  // `transfer` / `create_transfer` move money; `transfer_file`, `transfer_ownership` do not.
  if (words.includes('transfer') && words.every((w) => w === 'transfer' || TRANSFER_VERBS.has(w))) return true;
  if (words.includes('subscribe') && !has(words, FREE_SUBSCRIPTIONS)) return true;
  return false;
}

const norm = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const AMOUNT_KEYS = new Set(['amount', 'total', 'price', 'cost', 'subtotal', 'grandtotal', 'sum', 'fee', 'value']);
const AMOUNT_SUFFIX = /(amount|total|price|cents|usd)$/;
const isAmountKey = (k: string): boolean => AMOUNT_KEYS.has(k) || AMOUNT_SUFFIX.test(k);
const CURRENCY_KEYS = new Set(['currency', 'currencycode', 'curr', 'iso4217', 'denomination']);
const PAYMENT_METHOD_KEY = /^(paymentmethod|paymentmethodid|paymentsource|card|cardid|cardtoken|cardnumber|sourceid|iban|routingnumber|accountnumber|walletid|destinationaccount|beneficiary|payee|payeeid)$/;

interface Shape {
  amount: boolean;
  currency: boolean;
  method: boolean;
}

function scan(value: unknown, shape: Shape, depth: number): void {
  if (depth > 4 || value === null || typeof value !== 'object') return;
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.slice(0, 50).map((v): [string, unknown] => ['', v])
    : Object.entries(value as Record<string, unknown>);
  for (const [key, v] of entries) {
    const k = norm(key);
    if (v !== null && typeof v === 'object') {
      if (PAYMENT_METHOD_KEY.test(k)) shape.method = true;
      scan(v, shape, depth + 1);
      continue;
    }
    if (v === undefined || v === null || v === '') continue;
    if (CURRENCY_KEYS.has(k) && typeof v === 'string') shape.currency = true;
    else if (PAYMENT_METHOD_KEY.test(k)) shape.method = true;
    else if (isAmountKey(k) && (typeof v === 'number' || (typeof v === 'string' && /\d/.test(v) && v.length <= 40))) shape.amount = true;
  }
}

/** What the arguments look like: an amount, a currency, a payment method (nested objects and line items included). */
export function moneyShape(args: unknown): Shape {
  const shape: Shape = { amount: false, currency: false, method: false };
  scan(args, shape, 0);
  return shape;
}

const LEADING_SPEND = /^(pays?|purchases?|buys?|charges?|refunds?|donates?|withdraws?|transfers? (funds|money)|sends? (money|funds|a payment)|places? an? order|makes? a payment)\b/i;
const SPEND_PHRASE = /\b(will be charged|charges? (the|a|your) (card|customer|account|payment method)|real money|(transfers?|moves?|sends?) (funds|money)|places? an? (real )?order|makes? a payment|initiates? a (payment|transfer|payout|refund)|irreversibl[ey] (payment|transfer))\b/i;

/** The upstream's own description says the tool spends money. */
export function paymentByDescription(description: string | undefined): boolean {
  if (!description) return false;
  const text = description.slice(0, 2000).trim();
  return LEADING_SPEND.test(text) || SPEND_PHRASE.test(text);
}

/** Payment judged from every piece of evidence available for an upstream tool (see the file comment). */
export function isPayment(toolName: string, evidence: PaymentEvidence = {}): boolean {
  if (paymentByName(toolName)) return true;
  const words = nameWords(toolName).map(singular);
  // A lookup stays a lookup whatever its description or arguments mention.
  if (has(words, NON_SPENDING) && !has(words, COMMIT_VERBS)) return false;
  const title = evidence.annotations?.title;
  if (typeof title === 'string' && title.length <= 200 && paymentByName(title)) return true;
  if (evidence.annotations?.readOnlyHint === true) return false;
  if (paymentByDescription(evidence.description)) return true;
  if (evidence.args === undefined) return false;
  const shape = moneyShape(evidence.args);
  if (!shape.amount) return false;
  if (has(words, BOOKKEEPING)) return false;
  if (has(words, AMBIGUOUS_WITH_AMOUNT)) return true;
  return shape.currency || shape.method;
}
