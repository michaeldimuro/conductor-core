import { DEFAULT_GATED_ACTIONS, type OrgPolicies } from '../contracts/types.js';
import { redact, truncate } from '../shared/util.js';

const DEFAULT_GATED = new Set<string>(DEFAULT_GATED_ACTIONS);

/**
 * Kinds whose gate is decided by the caller's own policy (tool policy "Ask
 * first", sensitive-domain browser actions, connector OAuth). Callers only ask
 * when that policy already says ask, so the answer here is always yes.
 */
const ALWAYS_ASK = new Set<string>(['tool_call', 'browser_action', 'connector_auth']);

/** PRD persona default: "ping me only for approvals over $50". Applies when the org sets no threshold. */
export const DEFAULT_SPEND_THRESHOLD_USD = 50;
/** Pending approvals expire after this long unless the org or the requester says otherwise. */
export const DEFAULT_APPROVAL_EXPIRY_HOURS = 72;
const MAX_APPROVAL_EXPIRY_HOURS = 24 * 365;

/** The org's effective single-action spend threshold (USD). */
export function spendThresholdUsd(policies: OrgPolicies | null | undefined): number {
  const t = policies?.approvalSpendThresholdUsd;
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : DEFAULT_SPEND_THRESHOLD_USD;
}

/** Default lifetime of a pending approval from org policy; null = never expires (`approvalExpiryHours: 0`). */
export function approvalTtlMs(policies: OrgPolicies | null | undefined): number | null {
  const h = policies?.approvalExpiryHours;
  const hours = typeof h === 'number' && Number.isFinite(h) && h >= 0 ? Math.min(h, MAX_APPROVAL_EXPIRY_HOURS) : DEFAULT_APPROVAL_EXPIRY_HOURS;
  return hours === 0 ? null : Math.round(hours * 3_600_000);
}

/** An approved single-use grant must be used within this long, unless the org says otherwise. */
export const DEFAULT_APPROVAL_USE_WITHIN_HOURS = 72;

/** Use-by window of an approved, not yet consumed grant; null = never lapses (`approvalUseWithinHours: 0`). */
export function approvalUseTtlMs(policies: OrgPolicies | null | undefined): number | null {
  const h = policies?.approvalUseWithinHours;
  const hours = typeof h === 'number' && Number.isFinite(h) && h >= 0 ? Math.min(h, MAX_APPROVAL_EXPIRY_HOURS) : DEFAULT_APPROVAL_USE_WITHIN_HOURS;
  return hours === 0 ? null : Math.round(hours * 3_600_000);
}

/**
 * Defaults + org policy. Orgs can tighten freely (`extraGated`, spend
 * threshold); loosening a default gate needs the explicit per-action owner
 * toggle `approvalOverrides[kind] === false`. Spend above the threshold
 * (org policy, default $50) is gated no matter what was loosened.
 */
export function evaluateGate(policies: OrgPolicies | null | undefined, kind: string, ctx?: { amountUsd?: number }): boolean {
  const p = policies ?? {};
  if (ALWAYS_ASK.has(kind)) return true;

  const amount = ctx?.amountUsd;
  if (typeof amount === 'number' && Number.isFinite(amount) && amount > spendThresholdUsd(p)) return true;

  if (Array.isArray(p.extraGated) && p.extraGated.includes(kind)) return true;

  if (DEFAULT_GATED.has(kind)) {
    const overrides = (p.approvalOverrides ?? {}) as Record<string, unknown>;
    return overrides[kind] !== false;
  }
  return false;
}

const SENSITIVE_KEY = /(secret|password|passwd|passphrase|api[-_]?key|authorization|credential|cookie|private[-_]?key|access[-_]?token|refresh[-_]?token|bearer|^token$|^key$)/i;

/** Deep copy with anything that looks like a credential replaced (pattern-based). */
export function scrubSecrets<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubSecrets(v);
    return out as T;
  }
  return value;
}

function hideSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hideSensitiveKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : hideSensitiveKeys(v);
    }
    return out;
  }
  return typeof value === 'string' ? redact(value) : value;
}

/**
 * Human-readable one-line-per-field summary of an approval payload for
 * notifications. Sensitive-looking keys and credential-shaped values are
 * redacted; `matchKey` (an opaque hash) is omitted.
 */
export function summarizePayload(payload: Record<string, unknown>, maxFields = 12): string {
  const safe = hideSensitiveKeys(payload) as Record<string, unknown>;
  const entries = Object.entries(safe).filter(([k, v]) => k !== 'matchKey' && v !== undefined && v !== null);
  const lines = entries.slice(0, maxFields).map(([k, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}: ${truncate(text ?? '', 160)}`;
  });
  if (entries.length > maxFields) lines.push(`… ${entries.length - maxFields} more field(s)`);
  return lines.join('\n');
}
