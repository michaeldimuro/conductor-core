import { redact } from '../shared/util.js';

const REDACTED = '[REDACTED]';

/** Secret-store references (authRef, auth_ref, secretRef, cookieVaultRef, …) never leave the machine. */
const REF_KEY = /(auth|secret|vault|credential)s?[-_]?ref$/i;

/** Keys whose string values are credentials by convention, whatever they look like. */
const SECRET_KEY = /(api[-_]?key|passw(or)?d|secret|token|bearer|authorization|private[-_]?key|credential|cookie)s?$/i;

/**
 * Fields holding identifiers (ids, slugs, skill names, connector ids). The
 * shared credential patterns are unanchored — `task-prioritisation-and-planning`
 * contains `sk-…` — so identifiers are only redacted when the value itself
 * starts like a credential, instead of being mangled mid-word.
 */
const IDENTIFIER_KEYS = new Set([
  'id', 'slug', 'deptId', 'reportsTo', 'leadAgentId', 'parentGoalId', 'ownerAgentId', 'managerAgentId', 'agentId',
  'scopeId', 'scopeSlug', 'templateId', 'skills', 'denySkills', 'sharedSkills', 'defaultSkills', 'connectors',
  'denyConnectors', 'sharedConnectors', 'defaultConnectors', 'connectorId', 'goalId', 'tool', 'toolAllowlist',
]);
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Redact a free-text string. */
export function redactText(value: string): string {
  return redact(value);
}

/** Redact an identifier only if it begins with credential-shaped material. */
export function redactIdentifier(value: string): string {
  if (!IDENTIFIER_RE.test(value)) return redact(value);
  return redact(value).startsWith(REDACTED) ? REDACTED : value;
}

/**
 * Deep-copy `value` for export/import: drop every secret reference, blank
 * values under credential-named keys, and run every remaining string through
 * the credential redactor. Never mutates the input.
 */
export function sanitize<T>(value: T, key?: string): T {
  if (typeof value === 'string') {
    return (key !== undefined && IDENTIFIER_KEYS.has(key) ? redactIdentifier(value) : redact(value)) as T;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, key)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REF_KEY.test(k)) continue;
      if (SECRET_KEY.test(k) && typeof v === 'string') {
        out[k] = REDACTED;
        continue;
      }
      out[redact(k)] = sanitize(v, k);
    }
    return out as T;
  }
  return value;
}
