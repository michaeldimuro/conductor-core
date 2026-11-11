import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServices } from '../../src/daemon/compose.js';
import { MemorySecretStore } from '../../src/kernel/index.js';
import { ConductorClient, createApiServer, type ApiServer } from '../../src/api/index.js';
import type { LoginSession } from '../../src/contracts/providers.js';
import { fakeCli, fakeCliExec } from '../adapters/helpers/fake-auth.js';

/** Provider accounts and model catalogs through the composed daemon, with fake `claude` / `codex` binaries. */
describe('API: provider accounts and model catalogs', () => {
  let home: string;
  let services: Awaited<ReturnType<typeof createServices>>;
  let api: ApiServer;
  let client: ConductorClient;
  let baseUrl: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'conductor-api-providers-'));
    writeFileSync(join(home, 'state.json'), JSON.stringify({ claude: true }));
    const commands = { claude: fakeCli(home, 'claude'), codex: fakeCli(home, 'codex') };
    services = await createServices({
      home, secrets: new MemorySecretStore(), config: { port: 0 }, runtime: { powerAssertion: false, tickMs: 0, systemJobs: false },
      cliCommands: commands, cliExec: fakeCliExec(commands),
    });
    api = await createApiServer(services, { uiDir: join(home, 'no-ui') });
    await api.listen('127.0.0.1', 0);
    baseUrl = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
    client = new ConductorClient({ baseUrl, token: services.governance.tokens.issueOwnerToken('providers-test') });
  });

  afterAll(async () => {
    await api?.close();
    await services?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('lists models for the dropdowns: CLI aliases and catalogs, effort keys', async () => {
    const claude = await client.listModels('claude_local');
    expect(claude.models.slice(0, 2).map((m) => m.id)).toEqual(['alpha', 'beta']);
    expect(claude).toMatchObject({ effortKey: 'effort', efforts: ['low', 'medium', 'high'] });
    const codex = await client.listModels('codex_local', { refresh: true });
    expect(codex.models.map((m) => m.id)).toEqual(['gpt-fake-1', 'gpt-fake-2', 'gpt-internal']);
    expect(codex.models[1]).toMatchObject({ efforts: ['low', 'medium'], defaultEffort: 'medium' });
    await expect(client.listModels('no_such_adapter')).rejects.toMatchObject({ status: 404 });
  });

  it('reports both CLI logins, with no account identifiers on the wire', async () => {
    const res = await fetch(`${baseUrl}/api/v1/providers`, { headers: { authorization: `Bearer ${services.governance.tokens.issueOwnerToken('raw')}` } });
    const raw = await res.text();
    expect(raw).not.toContain('person@example.com');
    const list = JSON.parse(raw) as Array<{ provider: string; loggedIn: string; plan: string | null }>;
    expect(list.map((p) => [p.provider, p.loggedIn, p.plan])).toEqual([['claude', 'yes', 'max'], ['codex', 'no', null]]);
    await expect(client.getProvider('gemini' as never)).rejects.toMatchObject({ status: 404 });
  });

  it('requires the owner: no token, no provider status or login', async () => {
    expect((await fetch(`${baseUrl}/api/v1/providers`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/v1/providers/codex/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"method":"device"}' })).status).toBe(401);
  });

  it('runs a Codex device login end to end and an org-scoped Claude token, then binds an agent to it', async () => {
    const started = await client.startLogin('codex', { method: 'device' });
    let s: LoginSession = started;
    for (let i = 0; i < 200 && !['succeeded', 'failed', 'expired', 'cancelled'].includes(s.state); i++) {
      await new Promise((r) => setTimeout(r, 25));
      s = await client.getLoginSession(started.id);
    }
    expect(s).toMatchObject({ state: 'succeeded', url: 'https://auth.example/codex/device', userCode: 'ABCD-12345' });
    expect((await client.getProvider('codex', { refresh: true })).loggedIn).toBe('yes');

    const org = await client.createOrg({ name: 'Token Co' });
    await expect(client.startLogin('claude', { method: 'token', secret: 'nope' })).rejects.toMatchObject({ status: 400 });
    const tok = await client.startLogin('claude', { method: 'token', secret: 'sk-ant-oat01-0123456789abcdefghij', orgId: org.slug });
    expect(tok).toMatchObject({ state: 'succeeded', storedRef: 'org/token-co/claude-oauth-token' });
    const st = await client.getProvider('claude', { orgId: org.slug });
    expect(st.storedCredentials.find((c) => c.auth === 'token' && c.ref === 'org/token-co/claude-oauth-token')?.present).toBe(true);

    // The binding's auth mode and effort survive the API's strict schema.
    const dept = await client.createDepartment(org.id, { name: 'Ops' });
    const hired = await client.hireAgent(org.id, {
      deptId: dept.id, name: 'Tess', role: 'Operator',
      providerBinding: { adapter: 'claude_local', model: 'alpha', auth: 'token', config: { effort: 'high' } },
    });
    expect(hired.agent?.providerBinding).toEqual({ adapter: 'claude_local', model: 'alpha', auth: 'token', config: { effort: 'high' } });
    await expect(client.hireAgent(org.id, { deptId: dept.id, name: 'Bad', role: 'x', providerBinding: { adapter: 'claude_local', auth: 'magic' as never } })).rejects.toMatchObject({ status: 400 });

    const forgot = await client.forgetProviderCredential('claude', { auth: 'token', orgId: org.slug, ref: 'org/token-co/claude-oauth-token' });
    expect(forgot.storedCredentials.find((c) => c.ref === 'org/token-co/claude-oauth-token')?.present).toBe(false);
  });

  it('a waiting Claude login takes the pasted code over the API', async () => {
    const s = await client.startLogin('claude', { method: 'subscription' });
    let cur = s;
    for (let i = 0; i < 200 && !cur.needsCode; i++) {
      await new Promise((r) => setTimeout(r, 25));
      cur = await client.getLoginSession(s.id);
    }
    expect(cur.url).toContain('https://claude.example/oauth/authorize');
    await client.submitLoginCode(s.id, 'good-code');
    for (let i = 0; i < 200 && !['succeeded', 'failed'].includes(cur.state); i++) {
      await new Promise((r) => setTimeout(r, 25));
      cur = await client.getLoginSession(s.id);
    }
    expect(cur.state).toBe('succeeded');
    const cancelled = await client.startLogin('claude', { method: 'console' });
    expect((await client.cancelLogin(cancelled.id)).state).toBe('cancelled');
  });
});
