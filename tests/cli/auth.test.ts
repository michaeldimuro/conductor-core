import { describe, expect, it, vi } from 'vitest';
import type { LoginSession, ModelCatalog, ProviderAuthStatus } from '../../src/api/types.js';
import { harness } from './harness.js';

const status = (p: Partial<ProviderAuthStatus> & Pick<ProviderAuthStatus, 'provider'>): ProviderAuthStatus => ({
  adapterId: `${p.provider}_local`, label: p.provider === 'claude' ? 'Claude Code' : 'Codex', installed: true, version: '1.0.0',
  loggedIn: 'no', method: 'none', plan: null, expiresAt: null, detail: '', loginMethods: [], storedCredentials: [], activeSession: null, checkedAt: 0, ...p,
});
const session = (p: Partial<LoginSession>): LoginSession => ({
  id: 'lgn_1', provider: 'codex', method: 'device', state: 'starting', url: null, userCode: null, needsCode: false, message: '',
  startedAt: 0, expiresAt: 0, endedAt: null, storedRef: null, ...p,
});

describe('conductor auth', () => {
  it('status shows each CLI login and stored binding credentials', async () => {
    const h = harness({ client: { listProviders: vi.fn(async () => [
      status({ provider: 'claude', loggedIn: 'yes', method: 'subscription', plan: 'max', storedCredentials: [{ auth: 'token', ref: 'conductor/claude-oauth-token', present: true }] }),
      status({ provider: 'codex' }),
    ]) } });
    const r = await h.run('auth', 'status');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Claude Code.*logged in \(subscription\), max plan.*token: conductor\/claude-oauth-token/);
    expect(r.stdout).toMatch(/Codex.*not logged in.*none/);
  });

  it('login codex (device): prints the link and code, polls until logged in', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(session({ state: 'waiting', url: 'https://auth.example/device', userCode: 'ABCD-1234' }))
      .mockResolvedValueOnce(session({ state: 'succeeded', url: 'https://auth.example/device', userCode: 'ABCD-1234', message: 'logged in with ChatGPT account' }));
    const start = vi.fn(async () => session({}));
    const h = harness({ client: { startLogin: start, getLoginSession: get } });
    const r = await h.run('auth', 'login', 'codex');
    expect(r.code).toBe(0);
    expect(start).toHaveBeenCalledWith('codex', { method: 'device' });
    expect(r.stdout).toContain('https://auth.example/device');
    expect(r.stdout).toContain('ABCD-1234');
    expect(r.stdout).toContain('codex: logged in with ChatGPT account');
  });

  it('login claude: relays the code pasted at the prompt', async () => {
    const waiting = session({ provider: 'claude', method: 'subscription', state: 'waiting', url: 'https://claude.example/authorize', needsCode: true });
    const submit = vi.fn(async () => ({ ...waiting, state: 'verifying' as const }));
    const h = harness({
      stdinIsTTY: true, answers: ['  pasted-code  '],
      client: { startLogin: vi.fn(async () => waiting), submitLoginCode: submit, getLoginSession: vi.fn(async () => ({ ...waiting, state: 'succeeded' as const, message: 'logged in' })) },
    });
    const r = await h.run('auth', 'login', 'claude-code');
    expect(r.code).toBe(0);
    expect(submit).toHaveBeenCalledWith('lgn_1', 'pasted-code');
    expect(h.prompts[0]!.question).toMatch(/Paste the code/);
  });

  it('login claude --method token reads the token from a hidden prompt and never prints it', async () => {
    const start = vi.fn(async () => session({ provider: 'claude', method: 'token', state: 'succeeded', message: 'token stored', storedRef: 'org/acme/claude-oauth-token' }));
    const h = harness({ stdinIsTTY: true, answers: ['sk-ant-oat01-secret-value-123456'], client: { startLogin: start } });
    const r = await h.run('--org', 'acme', 'auth', 'login', 'claude', '--method', 'token');
    expect(r.code).toBe(0);
    expect(start).toHaveBeenCalledWith('claude', { method: 'token', orgId: 'acme', secret: 'sk-ant-oat01-secret-value-123456' });
    expect(h.prompts[0]).toMatchObject({ hidden: true });
    expect(r.stdout + r.stderr).not.toContain('sk-ant-oat01-secret-value-123456');
    expect(r.stdout).toContain('stored as org/acme/claude-oauth-token');
  });

  it('a failed login exits non-zero', async () => {
    const h = harness({ client: { startLogin: vi.fn(async () => session({ state: 'failed', message: 'device code expired' })) } });
    const r = await h.run('auth', 'login', 'codex');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('device code expired');
  });

  it('logout asks first, or takes --yes', async () => {
    const logout = vi.fn(async () => status({ provider: 'codex' }));
    expect((await harness({ client: { logoutProvider: logout } }).run('auth', 'logout', 'codex')).code).toBe(2);
    expect((await harness({ client: { logoutProvider: logout } }).run('auth', 'logout', 'codex', '--yes')).code).toBe(0);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown providers and methods', async () => {
    expect((await harness().run('auth', 'login', 'gemini')).code).toBe(2);
    expect((await harness().run('auth', 'login', 'codex', '--method', 'magic')).code).toBe(2);
  });
});

describe('conductor adapter models and agent --auth / --effort', () => {
  const catalog: ModelCatalog = {
    adapterId: 'codex_local', efforts: [], effortKey: 'reasoningEffort', allowCustom: true, defaultModel: 'gpt-b', sources: ['cli'], notes: [], fetchedAt: 0,
    models: [
      { id: 'gpt-a', label: 'GPT A', kind: 'model', efforts: ['low', 'high'], defaultEffort: 'low' },
      { id: 'gpt-hidden', label: 'Hidden', kind: 'model', hidden: true },
    ],
  };

  it('lists models with their effort levels (default starred), hidden ones only with --all', async () => {
    const h = harness({ client: { listModels: vi.fn(async () => catalog) } });
    const r = await h.run('adapter', 'models', 'codex_local');
    expect(r.stdout).toMatch(/gpt-a\s+GPT A\s+low\* high/);
    expect(r.stdout).not.toContain('gpt-hidden');
    expect(r.stdout + r.stderr).toContain('default when unset: gpt-b');
    expect((await harness({ client: { listModels: vi.fn(async () => catalog) } }).run('adapter', 'models', 'codex_local', '--all')).stdout).toContain('gpt-hidden');
  });

  it('agent update --provider … --auth token --effort high builds the binding', async () => {
    const update = vi.fn(async () => ({ id: 'agt_1', slug: 'ada', name: 'Ada', role: 'Engineer' }));
    const mocks = () => ({
      getAgent: vi.fn(async () => ({ id: 'agt_1', slug: 'ada', name: 'Ada' })),
      listAgents: vi.fn(async () => [{ id: 'agt_1', slug: 'ada', name: 'Ada' }]),
      updateAgent: update,
    });
    const h = harness({ client: mocks() });
    const r = await h.run('--org', 'acme', 'agent', 'update', 'ada', '--provider', 'claude_local:opus', '--auth', 'token', '--effort', 'high');
    expect(r.code).toBe(0);
    expect(update).toHaveBeenCalledWith('acme', 'agt_1', expect.objectContaining({ providerBinding: { adapter: 'claude_local', model: 'opus', auth: 'token', config: { effort: 'high' } } }));
    const bad = await harness({ client: mocks() }).run('--org', 'acme', 'agent', 'update', 'ada', '--provider', 'codex_local', '--auth', 'token');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/only for claude_local/);
    expect((await harness({ client: mocks() }).run('--org', 'acme', 'agent', 'update', 'ada', '--effort', 'high')).code).toBe(2);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
