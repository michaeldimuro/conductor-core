import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Services } from '../daemon/container.js';
import type { Principal } from '../contracts/services.js';
import type { Clock } from '../shared/util.js';
import { randomToken, sha256 } from '../shared/util.js';
import { ConductorError, forbidden } from '../shared/errors.js';
import { settings } from '../db/schema/index.js';

export const SESSION_COOKIE = 'conductor_session';
export const VIEWER_COOKIE = 'conductor_viewer';
export const TAKEOVER_COOKIE_PATH = '/api/v1/takeover';

/** Who may call a route. Default for `/api/v1/*` is `owner` (owner + device tokens). */
export type AuthMode = 'public' | 'owner' | 'run' | 'any';

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: AuthMode;
  }
  interface FastifyRequest {
    principal: Principal | null;
    /** True when the principal came from the session cookie (browser) rather than a bearer token. */
    viaCookie: boolean;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, opts: { path: string; maxAgeSec: number; secure: boolean }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function appendCookie(reply: FastifyReply, cookie: string): void {
  const prev = reply.getHeader('set-cookie');
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev.map(String) : [String(prev)];
  reply.header('set-cookie', [...list, cookie]);
}

function hostOf(value: string | undefined): { host: string; hostname: string } | null {
  if (!value) return null;
  try {
    const u = new URL(value.includes('://') ? value : `http://${value}`);
    return { host: u.host.toLowerCase(), hostname: u.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Host / Origin validation for browser (cookie) requests. There is no loopback
 * auto-trust anywhere: a request is only ever authorised by a token, and a
 * cookie-borne token is additionally bound to a known Host (DNS rebinding) and,
 * for anything that mutates or upgrades, a same-origin `Origin` (CSRF / CSWSH).
 */
export class OriginGuard {
  constructor(private readonly s: Services) {}

  private publicHosts(): Array<{ host: string; hostname: string; https: boolean }> {
    const urls: string[] = [this.s.publicUrl()];
    const stored = this.s.kernel.db.select().from(settings).where(eq(settings.key, 'daemon.public_url')).get()?.value;
    if (typeof stored === 'string' && stored) urls.push(stored);
    const out: Array<{ host: string; hostname: string; https: boolean }> = [];
    for (const u of urls) {
      const h = hostOf(u);
      if (h) out.push({ ...h, https: u.toLowerCase().startsWith('https://') });
    }
    return out;
  }

  isAllowedHostname(hostname: string): boolean {
    return LOOPBACK_HOSTS.has(hostname) || this.publicHosts().some((p) => p.hostname === hostname);
  }

  assertHost(req: FastifyRequest): void {
    const h = hostOf(req.headers.host);
    if (!h || !this.isAllowedHostname(h.hostname)) throw forbidden('request host is not allowed');
  }

  /** `Origin` (or `Referer`) must be present, allow-listed, and match this server. */
  assertSameOrigin(req: FastifyRequest): void {
    this.assertHost(req);
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;
    const o = origin && origin !== 'null' ? hostOf(origin) : origin ? null : hostOf(referer);
    if (!o || !this.isAllowedHostname(o.hostname)) throw forbidden('cross-origin request rejected');
    const self = hostOf(req.headers.host);
    const viaTunnel = this.publicHosts().some((p) => p.host === o.host);
    if (o.host !== self?.host && !viaTunnel) throw forbidden('cross-origin request rejected');
  }

  /** Mark cookies `Secure` when the browser reached us over the https public URL. */
  isSecure(req: FastifyRequest): boolean {
    if (req.headers['x-forwarded-proto'] === 'https') return true;
    const h = hostOf(req.headers.host);
    return !!h && this.publicHosts().some((p) => p.https && p.hostname === h.hostname);
  }

  needsOriginCheck(req: FastifyRequest): boolean {
    return !SAFE_METHODS.has(req.method) || req.headers.upgrade !== undefined;
  }
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m?.[1] ?? null;
}

/** Resolve the caller from `Authorization: Bearer` (preferred) or the session cookie. */
export function identify(s: Services, req: FastifyRequest): { principal: Principal | null; viaCookie: boolean } {
  const bearer = bearerToken(req);
  if (bearer) return { principal: s.governance.tokens.verify(bearer), viaCookie: false };
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (cookie) return { principal: s.governance.tokens.verify(cookie), viaCookie: true };
  return { principal: null, viaCookie: false };
}

/** The `onRequest` gate for every `/api/v1/*` route. */
export function authenticate(s: Services, guard: OriginGuard, req: FastifyRequest): void {
  const mode: AuthMode = req.routeOptions.config.auth ?? 'owner';
  if (mode === 'public' || req.is404) return;
  const { principal, viaCookie } = identify(s, req);
  if (!principal) throw new ConductorError('unauthorized', 'authentication required');
  if (viaCookie) {
    guard.assertHost(req);
    if (guard.needsOriginCheck(req)) guard.assertSameOrigin(req);
  }
  if (mode === 'owner' && principal.kind === 'run') throw forbidden('run tokens may only call the agent API');
  if (mode === 'run' && principal.kind !== 'run') throw forbidden('this endpoint requires a run token');
  req.principal = principal;
  req.viaCookie = viaCookie;
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw new ConductorError('unauthorized', 'authentication required');
  return req.principal;
}

/**
 * Single-use browser login codes. The CLI (owner token) mints one and opens
 * `/auth/local?code=…`; the exchange yields a device-token cookie. Codes live
 * only in memory, hashed, for two minutes.
 */
export class LoginCodes {
  static readonly TTL_MS = 2 * 60_000;
  private readonly codes = new Map<string, { expiresAt: number; label: string; ttlMs: number }>();

  constructor(private readonly clock: Clock) {}

  mint(label: string, ttlMs: number): { code: string; expiresAt: number } {
    const now = this.clock.now();
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
    if (this.codes.size >= 200) throw new ConductorError('unavailable', 'too many outstanding login codes');
    const code = randomToken(32);
    const expiresAt = now + LoginCodes.TTL_MS;
    this.codes.set(sha256(code), { expiresAt, label, ttlMs });
    return { code, expiresAt };
  }

  /** Consumes the code. Null when unknown, already used, or expired. */
  redeem(code: string): { label: string; ttlMs: number } | null {
    const key = sha256(code);
    const entry = this.codes.get(key);
    if (!entry) return null;
    this.codes.delete(key);
    return entry.expiresAt > this.clock.now() ? { label: entry.label, ttlMs: entry.ttlMs } : null;
  }
}
