import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from '../../daemon/container.js';
import { ConductorError } from '../../shared/errors.js';
import { LoginCodes, OriginGuard, SESSION_COOKIE, appendCookie, requirePrincipal, serializeCookie } from '../auth.js';
import { RateLimiter, body, tooMany } from '../http.js';
import { optionalBody } from '../schemas/common.js';
import { loginCode, sessionBody } from '../schemas/capabilities.js';
import type { LoginCodeResponse, MeResponse, Ok } from '../types.js';

const DEFAULT_SESSION_TTL_MS = 30 * 86_400_000;
const COOKIE_MAX_AGE_SEC = 90 * 86_400;

/**
 * Browser sessions. A browser never sees the owner token: the CLI mints a
 * single-use login code (owner bearer) and opens `/auth/local?code=…`, which
 * swaps it for a device token held in an HttpOnly, SameSite=Strict cookie.
 * Remote devices pair the same way, typically with a longer-lived token.
 */
export function authRoutes(api: FastifyInstance, root: FastifyInstance, s: Services, guard: OriginGuard): void {
  const codes = new LoginCodes(s.kernel.clock);
  const attempts = new RateLimiter(20, 60_000);
  const tokens = s.governance.tokens;

  const setSession = (req: FastifyRequest, reply: FastifyReply, token: string): void => {
    appendCookie(reply, serializeCookie(SESSION_COOKIE, token, { path: '/', maxAgeSec: COOKIE_MAX_AGE_SEC, secure: guard.isSecure(req) }));
    reply.header('cache-control', 'no-store');
  };

  api.post('/auth/login-codes', async (req): Promise<LoginCodeResponse> => {
    const input = body(req, optionalBody(loginCode));
    const { code, expiresAt } = codes.mint(input.label?.trim() || 'browser', input.ttlMs ?? DEFAULT_SESSION_TTL_MS);
    const path = `/auth/local?code=${encodeURIComponent(code)}`;
    return { code, url: `${s.baseUrl().replace(/\/+$/, '')}${path}`, remoteUrl: `${s.publicUrl()}${path}`, expiresAt };
  });

  root.get('/auth/local', async (req, reply) => {
    if (!attempts.take(req.ip)) throw tooMany('login attempts');
    guard.assertHost(req);
    const code = (req.query as Record<string, unknown> | undefined)?.code;
    const grant = typeof code === 'string' && code.length <= 200 ? codes.redeem(code) : null;
    reply.header('cache-control', 'no-store');
    if (!grant) {
      return reply.code(401).type('text/plain; charset=utf-8').send('This login link is invalid, already used, or expired. Request a new one from the Conductor CLI.');
    }
    setSession(req, reply, tokens.issueDeviceToken(grant.label, grant.ttlMs));
    return reply.redirect('/', 302);
  });

  // Manual paste of a token. An owner token is never stored in the browser: it is exchanged for a device token.
  api.post('/auth/session', { config: { auth: 'public' } }, async (req, reply): Promise<MeResponse> => {
    if (!attempts.take(req.ip)) throw tooMany('login attempts');
    guard.assertHost(req);
    if (req.headers.origin !== undefined) guard.assertSameOrigin(req);
    const { token } = body(req, sessionBody);
    const presented = tokens.verify(token);
    if (!presented || presented.kind === 'run') throw new ConductorError('unauthorized', 'invalid token');
    const sessionToken = presented.kind === 'owner' ? tokens.issueDeviceToken('browser session', DEFAULT_SESSION_TTL_MS) : token;
    const principal = tokens.verify(sessionToken);
    if (!principal) throw new ConductorError('unauthorized', 'invalid token');
    setSession(req, reply, sessionToken);
    return { principal };
  });

  api.delete('/auth/session', { config: { auth: 'any' } }, async (req, reply): Promise<Ok> => {
    const p = requirePrincipal(req);
    // Logging out of a browser ends that device's token; a bearer caller only clears the cookie.
    if (req.viaCookie && p.kind === 'device') tokens.revoke(p.tokenId);
    appendCookie(reply, serializeCookie(SESSION_COOKIE, '', { path: '/', maxAgeSec: 0, secure: guard.isSecure(req) }));
    return { ok: true };
  });

  api.get('/auth/me', { config: { auth: 'any' } }, async (req): Promise<MeResponse> => ({ principal: requirePrincipal(req) }));
}
