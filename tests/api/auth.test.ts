import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './fake-services.js';
import { SESSION_COOKIE } from '../../src/api/index.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const setCookies = (res: { headers: Record<string, unknown> }): string[] => {
  const v = res.headers['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
};
const sessionCookie = (res: { headers: Record<string, unknown> }): string => {
  const c = setCookies(res).find((x) => x.startsWith(`${SESSION_COOKIE}=`));
  if (!c) throw new Error('no session cookie set');
  return c.split(';')[0]!;
};

async function loginViaCode(): Promise<string> {
  const minted = await h.api.app.inject({ method: 'POST', url: '/api/v1/auth/login-codes', headers: h.owner, payload: {} });
  expect(minted.statusCode).toBe(200);
  const res = await h.api.app.inject({ method: 'GET', url: `/auth/local?code=${minted.json().code}` });
  expect(res.statusCode).toBe(302);
  return sessionCookie(res);
}

describe('authentication', () => {
  it('rejects requests without a token, or with a bogus one', async () => {
    const none = await h.api.app.inject({ method: 'GET', url: '/api/v1/orgs' });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: { code: 'unauthorized', message: 'authentication required' } });

    const bogus = await h.api.app.inject({ method: 'GET', url: '/api/v1/orgs', headers: { authorization: 'Bearer cnd_owner_notarealtokennotarealtoken' } });
    expect(bogus.statusCode).toBe(401);
  });

  it('does not trust loopback: an unauthenticated local request gets nothing', async () => {
    const res = await h.api.app.inject({ method: 'GET', url: '/api/v1/status', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:7420' } });
    expect(res.statusCode).toBe(401);
  });

  it('gives the owner token the full API', async () => {
    const res = await h.api.app.inject({ method: 'GET', url: '/api/v1/orgs', headers: h.owner });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((o: { slug: string }) => o.slug).sort()).toEqual(['acme', 'globex']);
    const me = await h.api.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: h.owner });
    expect(me.json().principal.kind).toBe('owner');
  });

  it('confines run tokens to the agent API', async () => {
    const run = h.startRun();
    const auth = { authorization: `Bearer ${run.token}` };
    for (const [method, url] of [['GET', '/api/v1/orgs'], ['GET', '/api/v1/status'], ['POST', '/api/v1/kill-switch'], ['GET', `/api/v1/orgs/${h.orgA.id}/issues`], ['PUT', '/api/v1/secrets/x'], ['POST', '/api/v1/auth/login-codes']] as const) {
      const res = await h.api.app.inject({ method, url, headers: auth });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
    const me = await h.api.app.inject({ method: 'GET', url: '/api/v1/agent/me', headers: auth });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ orgId: h.orgA.id, runId: run.runId, agent: { id: h.agent.id }, issue: null });
    const whoami = await h.api.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth });
    expect(whoami.json().principal).toMatchObject({ kind: 'run', runId: run.runId });
  });

  it('keeps the agent API away from owner tokens (identity comes from a run token only)', async () => {
    const res = await h.api.app.inject({ method: 'GET', url: '/api/v1/agent/tools', headers: h.owner });
    expect(res.statusCode).toBe(403);
  });

  it('serves /healthz without auth and without sensitive data', async () => {
    const res = await h.api.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['status', 'uptimeMs', 'version']);
  });
});

describe('browser login', () => {
  it('requires the owner to mint a login code', async () => {
    const res = await h.api.app.inject({ method: 'POST', url: '/api/v1/auth/login-codes', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('exchanges a login code for an HttpOnly SameSite=Strict device cookie, once', async () => {
    const minted = await h.api.app.inject({ method: 'POST', url: '/api/v1/auth/login-codes', headers: h.owner, payload: { label: 'laptop' } });
    const { code, url, expiresAt } = minted.json();
    expect(url).toContain(`/auth/local?code=${code}`);
    expect(expiresAt - h.kernel.clock.now()).toBe(120_000);

    const first = await h.api.app.inject({ method: 'GET', url: `/auth/local?code=${code}` });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe('/');
    const raw = setCookies(first).find((c) => c.startsWith(SESSION_COOKIE))!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Strict/);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toContain(h.ownerToken);

    const cookie = sessionCookie(first);
    const authed = await h.api.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(authed.json().principal.kind).toBe('device');

    const second = await h.api.app.inject({ method: 'GET', url: `/auth/local?code=${code}` });
    expect(second.statusCode).toBe(401);
    expect(setCookies(second)).toEqual([]);
  });

  it('rejects an expired or unknown login code', async () => {
    const minted = await h.api.app.inject({ method: 'POST', url: '/api/v1/auth/login-codes', headers: h.owner });
    h.kernel.clock.advance(120_001);
    const expired = await h.api.app.inject({ method: 'GET', url: `/auth/local?code=${minted.json().code}` });
    expect(expired.statusCode).toBe(401);
    const unknown = await h.api.app.inject({ method: 'GET', url: '/auth/local?code=nope' });
    expect(unknown.statusCode).toBe(401);
    const missing = await h.api.app.inject({ method: 'GET', url: '/auth/local' });
    expect(missing.statusCode).toBe(401);
  });

  it('pairs a remote device with a longer-lived device token', async () => {
    const minted = await h.api.app.inject({ method: 'POST', url: '/api/v1/auth/login-codes', headers: h.owner, payload: { label: 'phone', ttlMs: 60 * 86_400_000 } });
    const res = await h.api.app.inject({ method: 'GET', url: `/auth/local?code=${minted.json().code}` });
    const cookie = sessionCookie(res);
    h.kernel.clock.advance(45 * 86_400_000);
    expect((await h.api.app.inject({ method: 'GET', url: '/api/v1/orgs', headers: { cookie } })).statusCode).toBe(200);
    h.kernel.clock.advance(16 * 86_400_000);
    expect((await h.api.app.inject({ method: 'GET', url: '/api/v1/orgs', headers: { cookie } })).statusCode).toBe(401);
  });

  it('accepts a pasted owner token, stores only a device token, and revokes it on logout', async () => {
    const bad = await h.api.app.inject({ method: 'POST', url: '/api/v1/auth/session', payload: { token: 'cnd_owner_wrongwrongwrongwrongwrong' } });
    expect(bad.statusCode).toBe(401);
    const run = h.startRun();
    const asRun = await h.api.app.inject({ method: 'POST', url: '/api/v1/auth/session', payload: { token: run.token } });
    expect(asRun.statusCode).toBe(401);

    const res = await h.api.app.inject({ method: 'POST', url: '/api/v1/auth/session', payload: { token: h.ownerToken } });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal.kind).toBe('device');
    const cookie = sessionCookie(res);
    expect(cookie).not.toContain(h.ownerToken);

    const out = await h.api.app.inject({ method: 'DELETE', url: '/api/v1/auth/session', headers: { cookie, origin: 'http://localhost' } });
    expect(out.statusCode).toBe(200);
    expect(setCookies(out)[0]).toMatch(/Max-Age=0/);
    expect((await h.api.app.inject({ method: 'GET', url: '/api/v1/orgs', headers: { cookie } })).statusCode).toBe(401);
    // The CLI's owner token is untouched.
    expect((await h.api.app.inject({ method: 'GET', url: '/api/v1/orgs', headers: h.owner })).statusCode).toBe(200);
  });
});

describe('CSRF / DNS-rebinding protection for cookie sessions', () => {
  const post = (headers: Record<string, string>) =>
    h.api.app.inject({ method: 'POST', url: `/api/v1/orgs/${h.orgA.id}/issues`, headers, payload: { title: 'From the browser' } });

  it('requires a same-origin Origin on cookie-authenticated mutations', async () => {
    const cookie = await loginViaCode();
    expect((await post({ cookie })).statusCode).toBe(403);
    expect((await post({ cookie, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post({ cookie, origin: 'null' })).statusCode).toBe(403);
    // Same site, different port (another local app) is still cross-origin.
    expect((await post({ cookie, origin: 'http://localhost:3000' })).statusCode).toBe(403);
    expect(h.issues).toHaveLength(0);

    const ok = await post({ cookie, origin: 'http://localhost' });
    expect(ok.statusCode).toBe(200);
    const viaReferer = await post({ cookie, referer: 'http://localhost/issues' });
    expect(viaReferer.statusCode).toBe(200);
    expect(h.issues).toHaveLength(2);
  });

  it('rejects cookie requests addressed to an unknown Host, even reads', async () => {
    const cookie = await loginViaCode();
    const res = await h.api.app.inject({ method: 'GET', url: '/api/v1/orgs', headers: { cookie, host: 'attacker.example:7420' } });
    expect(res.statusCode).toBe(403);
    const rebind = await post({ cookie, host: 'attacker.example:7420', origin: 'http://attacker.example:7420' });
    expect(rebind.statusCode).toBe(403);
    const local = await h.api.app.inject({ method: 'GET', url: '/api/v1/orgs', headers: { cookie, host: '127.0.0.1:7420' } });
    expect(local.statusCode).toBe(200);
  });

  it('accepts the configured public URL host (tunnel) and marks its cookies Secure', async () => {
    h.config.publicUrl = 'https://mac.tailnet.example';
    const minted = await h.api.app.inject({ method: 'POST', url: '/api/v1/auth/login-codes', headers: h.owner });
    expect(minted.json().remoteUrl).toMatch(/^https:\/\/mac\.tailnet\.example\/auth\/local\?code=/);
    const login = await h.api.app.inject({ method: 'GET', url: `/auth/local?code=${minted.json().code}`, headers: { host: 'mac.tailnet.example' } });
    expect(login.statusCode).toBe(302);
    expect(setCookies(login)[0]).toMatch(/; Secure/);
    const cookie = sessionCookie(login);
    const ok = await post({ cookie, host: 'mac.tailnet.example', origin: 'https://mac.tailnet.example' });
    expect(ok.statusCode).toBe(200);
    // A tunnel that rewrites Host to the loopback address still presents the public Origin.
    const proxied = await post({ cookie, host: '127.0.0.1:7420', origin: 'https://mac.tailnet.example' });
    expect(proxied.statusCode).toBe(200);
  });

  it('does not apply the Origin check to bearer-token callers (CLI, gateways)', async () => {
    const res = await post({ ...h.owner, origin: 'https://anything.example' });
    expect(res.statusCode).toBe(200);
  });
});

describe('static UI and security headers', () => {
  it('serves a built-in page when the UI has not been built, with a strict CSP', async () => {
    for (const url of ['/', '/orgs/acme/issues', '/takeover/some.signed.token']) {
      const res = await h.api.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('has not been built');
    }
    const res = await h.api.app.inject({ method: 'GET', url: '/' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('serves a built UI with SPA fallback for client-side routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-ui-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Conductor UI</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    const built = await createHarness({ uiDir: dir });
    try {
      for (const url of ['/', '/orgs/acme/board', `/takeover/${'t'.repeat(400)}`]) {
        const res = await built.api.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
        expect(res.body).toContain('Conductor UI');
        expect(res.headers['content-security-policy']).toBeDefined();
      }
      const asset = await built.api.app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toMatch(/javascript/);
      expect((await built.api.app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
      const traversal = await built.api.app.inject({ method: 'GET', url: '/..%2f..%2fpackage.json' });
      expect([403, 404]).toContain(traversal.statusCode);
      // The API is still authenticated when a UI is present.
      expect((await built.api.app.inject({ method: 'GET', url: '/api/v1/orgs' })).statusCode).toBe(401);
    } finally {
      await built.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mounts routes contributed by other contexts through plugins', async () => {
    const extra = await createHarness({ plugins: [async (app) => {
      app.post('/gateways/slack/events', async () => ({ ok: true }));
    }] });
    try {
      const res = await extra.api.app.inject({ method: 'POST', url: '/gateways/slack/events', payload: {} });
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await extra.close();
    }
  });

  it('answers unknown API paths and assets with a JSON 404, not the SPA', async () => {
    const api = await h.api.app.inject({ method: 'GET', url: '/api/v1/nope', headers: h.owner });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('not_found');
    expect((await h.api.app.inject({ method: 'GET', url: '/assets/app.js' })).statusCode).toBe(404);
    expect((await h.api.app.inject({ method: 'POST', url: '/somewhere' })).statusCode).toBe(404);
  });
});
