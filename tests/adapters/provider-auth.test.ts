import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderAuth, parseLoginOutput, safeTail } from '../../src/adapters/auth/index.js';
import type { LoginSession, ProviderAuthService } from '../../src/contracts/providers.js';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { fakeCli } from './helpers/fake-auth.js';

async function until(svc: ProviderAuthService, id: string, done: (s: LoginSession) => boolean, ms = 10_000): Promise<LoginSession> {
  const end = Date.now() + ms;
  for (;;) {
    const s = svc.getSession(id);
    if (done(s)) return s;
    if (Date.now() > end) throw new Error(`login session stuck in ${s.state}: ${s.message}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const finished = (s: LoginSession) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(s.state);

describe('provider auth: Conductor drives the Claude Code / Codex logins', () => {
  let k: TestKernel;
  let dir: string;
  let svc: ProviderAuthService;
  const state = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8') || '{}') as Record<string, unknown>;

  beforeEach(() => {
    k = createTestKernel();
    dir = mkdtempSync(join(tmpdir(), 'conductor-auth-test-'));
    writeFileSync(join(dir, 'state.json'), '{}');
    svc = createProviderAuth(k, { commands: { claude: fakeCli(dir, 'claude'), codex: fakeCli(dir, 'codex') }, statusTtlMs: 0 });
  });
  afterEach(() => {
    svc.dispose();
    k.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports each CLI\'s login without ever exposing account identifiers', async () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ claude: true }));
    const [claude, codex] = await svc.statusAll();
    expect(claude).toMatchObject({ provider: 'claude', adapterId: 'claude_local', installed: true, version: '9.9.9 (Claude Code)', loggedIn: 'yes', method: 'subscription', plan: 'max' });
    expect(claude!.expiresAt).toBe(Date.parse('2030-01-01T00:00:00Z'));
    expect(codex).toMatchObject({ provider: 'codex', installed: true, loggedIn: 'no', method: 'none' });
    expect(claude!.loginMethods.map((m) => m.method)).toEqual(['subscription', 'console', 'token']);
    expect(codex!.loginMethods.map((m) => m.method)).toEqual(['device', 'browser', 'api_key']);
    expect(claude!.storedCredentials).toEqual([
      { auth: 'token', ref: 'conductor/claude-oauth-token', present: false },
      { auth: 'api_key', ref: 'conductor/anthropic-api-key', present: false },
    ]);
    const json = JSON.stringify([claude, codex]);
    expect(json).not.toContain('person@example.com');
    expect(json).not.toContain('Secret Org');
  });

  it('reports a missing CLI as not installed', async () => {
    const missing = createProviderAuth(k, { commands: { claude: join(dir, 'nope'), codex: join(dir, 'nope') } });
    expect(await missing.status('claude')).toMatchObject({ installed: false, loggedIn: 'no' });
  });

  it('Claude subscription login: shows the link, relays the pasted code, verifies with the CLI', async () => {
    const started = await svc.startLogin('claude', { method: 'subscription' });
    const waiting = await until(svc, started.id, (s) => s.state === 'waiting' && s.needsCode);
    expect(waiting.url).toBe('https://claude.example/oauth/authorize?code=true&state=abc123');
    expect((await svc.status('claude')).activeSession).toBe(started.id);
    // Only one interactive login per CLI at a time.
    await expect(svc.startLogin('claude', { method: 'console' })).rejects.toMatchObject({ code: 'conflict' });

    svc.submitCode(started.id, 'good-code');
    const done = await until(svc, started.id, finished);
    expect(done).toMatchObject({ state: 'succeeded', message: 'logged in with Claude subscription login' });
    expect(state().claude).toBe(true);
    expect((await svc.status('claude')).activeSession).toBeNull();
    const actions = k.audit.query({ entityKind: 'provider' }).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['provider.login_started', 'provider.login_succeeded']));
  });

  it('a wrong code hands the prompt back (as the real CLI keeps waiting), then a good one succeeds', async () => {
    const s = await svc.startLogin('claude', { method: 'subscription' });
    await until(svc, s.id, (x) => x.needsCode);
    svc.submitCode(s.id, 'bad-code');
    const again = await until(svc, s.id, (x) => x.state === 'waiting' && x.message.startsWith('the code was not accepted'));
    expect(again.message).toBe('the code was not accepted: Invalid code. Please make sure the full code was copied.');
    svc.submitCode(s.id, 'good-code');
    expect((await until(svc, s.id, finished)).state).toBe('succeeded');
    expect(() => svc.submitCode(s.id, 'again')).toThrow(/not waiting/);
  });

  it('Codex device login: link + one-time code, then logged in (and the model list is refreshed)', async () => {
    const changed: string[] = [];
    svc.dispose();
    svc = createProviderAuth(k, { commands: { claude: fakeCli(dir, 'claude'), codex: fakeCli(dir, 'codex') }, statusTtlMs: 0, onAccountChange: (p) => changed.push(p) });
    const s = await svc.startLogin('codex', { method: 'device' });
    const waiting = await until(svc, s.id, (x) => x.state === 'waiting' || finished(x));
    expect(waiting).toMatchObject({ url: 'https://auth.example/codex/device', userCode: 'ABCD-12345', needsCode: false });
    const done = await until(svc, s.id, finished);
    expect(done).toMatchObject({ state: 'succeeded', message: 'logged in with ChatGPT account' });
    expect((await svc.status('codex')).method).toBe('chatgpt');
    expect(changed).toEqual(['codex']);
  });

  it('Codex device login: a code printed after the link still reaches the person', async () => {
    const split = createProviderAuth(k, { commands: { codex: fakeCli(dir, 'codex', { FAKE_DEVICE_SPLIT_MS: '400', FAKE_DEVICE_MS: '1500' }) } });
    const s = await split.startLogin('codex', { method: 'device' });
    const linkOnly = await until(split, s.id, (x) => x.state === 'waiting');
    expect(linkOnly.url).toBe('https://auth.example/codex/device');
    const withCode = await until(split, s.id, (x) => x.userCode !== null);
    expect(withCode).toMatchObject({ state: 'waiting', userCode: 'ABCD-12345', message: 'open the link and enter the code' });
    await until(split, s.id, (x) => x.state === 'succeeded');
    split.dispose();
  });

  it('a device login can be cancelled, which kills the CLI', async () => {
    const slow = createProviderAuth(k, { commands: { codex: fakeCli(dir, 'codex', { FAKE_DEVICE_MS: '20000' }) } });
    const s = await slow.startLogin('codex', { method: 'device' });
    await until(slow, s.id, (x) => x.state === 'waiting');
    expect(slow.cancelSession(s.id).state).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 300));
    expect(slow.getSession(s.id).state).toBe('cancelled');
    expect(state().codex).toBeUndefined();
    slow.dispose();
  });

  it('Codex API-key login sends the key on stdin only, and can also store it for metered bindings', async () => {
    await expect(svc.startLogin('codex', { method: 'api_key', secret: 'short' })).rejects.toMatchObject({ code: 'validation' });
    const key = 'sk-test-0123456789abcdefghij';
    const s = await svc.startLogin('codex', { method: 'api_key', secret: key, saveAs: 'conductor/openai-api-key' });
    const done = await until(svc, s.id, finished);
    expect(done.state).toBe('succeeded');
    expect(state()).toMatchObject({ codex: 'api_key', codexKeyArgv: false });
    expect(await k.secrets.get('conductor/openai-api-key')).toBe(key);
    expect(JSON.stringify(done)).not.toContain(key);
    expect(JSON.stringify(k.audit.query({ entityKind: 'provider' }))).not.toContain(key);
    expect((await svc.status('codex')).storedCredentials).toEqual([{ auth: 'api_key', ref: 'conductor/openai-api-key', present: true }]);
  });

  it('stores a long-lived Claude token after the CLI accepts it, without touching the CLI login', async () => {
    await expect(svc.startLogin('claude', { method: 'token', secret: 'not-a-claude-token-xxxxxxxx' })).rejects.toMatchObject({ code: 'validation' });
    const token = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz';
    const s = await svc.startLogin('claude', { method: 'token', secret: token, orgSlug: 'acme' });
    expect(s).toMatchObject({ state: 'succeeded', storedRef: 'org/acme/claude-oauth-token' });
    expect(await k.secrets.get('org/acme/claude-oauth-token')).toBe(token);
    expect(state().claude).toBeUndefined();
    const st = await svc.status('claude', { orgSlug: 'acme' });
    expect(st.storedCredentials.find((c) => c.ref === 'org/acme/claude-oauth-token')?.present).toBe(true);
    expect(JSON.stringify(s)).not.toContain(token);

    const after = await svc.forgetCredential('claude', 'token', 'org/acme/claude-oauth-token', 'acme');
    expect(after.storedCredentials.find((c) => c.ref === 'org/acme/claude-oauth-token')?.present).toBe(false);
  });

  it('logs the CLI out', async () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ claude: true, codex: 'chatgpt' }));
    expect((await svc.logout('claude')).loggedIn).toBe('no');
    expect((await svc.logout('codex')).loggedIn).toBe('no');
    expect(k.audit.query({ action: 'provider.logout' })).toHaveLength(2);
  });

  it('refuses methods a provider does not have', async () => {
    await expect(svc.startLogin('codex', { method: 'token' })).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.startLogin('claude', { method: 'device' })).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('login output parsing', () => {
  it('finds the real CLIs\' links and codes (captured from claude 2.1 / codex 0.163)', () => {
    const codex = '\nWelcome to Codex [v\u001b[90m0.163.0\u001b[0m]\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mBTFH-01DJB\u001b[0m\n';
    expect(parseLoginOutput(codex)).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: 'BTFH-01DJB', needsCode: false });
    const claude = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y\nPaste code here if prompted > ';
    expect(parseLoginOutput(claude)).toEqual({ url: 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y', userCode: null, needsCode: true });
  });

  it('never shows links, emails or secrets in failure messages', () => {
    expect(safeTail('visit https://x.example/?state=1\nLogin failed for person@example.com sk-live-secret', ['sk-live-secret'])).toBe('Login failed for <account> [REDACTED]');
  });
});
