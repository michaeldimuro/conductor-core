import { invalid } from '../shared/errors.js';

/** A hostname pattern: an exact host (`app.example.com`, `127.0.0.1`) or a wildcard (`*.example.com`). */
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const PATTERN = new RegExp(`^(?:\\*\\.)?(?:${LABEL}\\.)*${LABEL}$`);

/** Validate + normalize a list of hostname patterns (lowercase, de-duplicated). */
export function normalizePatterns(list: readonly string[], field: string): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const p = raw.trim().toLowerCase();
    if (p.length === 0 || p.length > 253 || !PATTERN.test(p)) {
      throw invalid(`${field}: "${raw}" is not a hostname pattern (use "host.example.com" or "*.example.com")`);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** `*.example.com` matches any subdomain of example.com (not the apex); anything else matches exactly. */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => (p.startsWith('*.') ? h.length > p.length - 1 && h.endsWith(p.slice(1)) : h === p));
}

/** Lowercased hostname of an http(s) URL, else null. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export type NavCheck = { ok: true; url: string; host: string } | { ok: false; reason: string };

/**
 * Whether an agent- or viewer-requested URL may be opened: http(s) only (no
 * file:, chrome:, javascript:, data: …) and, when the profile has an
 * allowlist, only hosts on it.
 */
export function checkNavigation(rawUrl: string, allowlist: readonly string[]): NavCheck {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `not an absolute URL: ${rawUrl.slice(0, 200)}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `navigation blocked: only http(s) URLs are allowed (got ${u.protocol})` };
  }
  const host = u.hostname.toLowerCase();
  if (allowlist.length > 0 && !hostMatches(host, allowlist)) {
    return { ok: false, reason: `navigation blocked: ${host} is not on this browser profile's domain allowlist` };
  }
  return { ok: true, url: u.toString(), host };
}

/**
 * Whether the URL a page ended up on is acceptable. Internal blank pages are
 * always fine; with an allowlist every http(s) document must be on it.
 */
export function isUrlAllowed(url: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const host = hostOf(url);
  if (host === null) return url === '' || url.startsWith('about:') || url.startsWith('chrome-error:');
  return hostMatches(host, allowlist);
}
