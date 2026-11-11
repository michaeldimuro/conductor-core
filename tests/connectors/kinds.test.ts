import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createConnectorGateway } from '../../src/connectors/index.js';
import type { ConnectorGateway } from '../../src/contracts/services.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import { fakeApprovals, fakeOrg, listen, runCtx, startHttpMcp, textOf } from './helpers.js';

const REQUIRED_TEMPLATES = ['composio', 'arcade', 'zapier', 'make', 'github', 'linear', 'notion', 'slack', 'stripe', 'honcho', 'mem0', 'zep', 'supermemory'];

describe('connector kinds and catalog', () => {
  let k: TestKernel;
  let gw: ConnectorGateway;
  let approvals: ReturnType<typeof fakeApprovals>;
  let org: Organization;
  let agent: Agent;
  const closers: Array<() => Promise<void>> = [];

  beforeEach(() => {
    k = createTestKernel();
    approvals = fakeApprovals(k);
    gw = createConnectorGateway(k, { approvals, org: fakeOrg(k) }, { toolCacheTtlMs: 0 });
    org = seedOrg(k);
    agent = seedAgent(k, org.id, seedDept(k, org.id).id, 'Ada', { autonomyLevel: 3 });
  });
  afterEach(async () => {
    await gw.close();
    await Promise.all(closers.splice(0).map((c) => c()));
    k.dispose();
  });

  it('installs every catalog template, storing secrets only in the secret store (FR-11)', async () => {
    const catalog = gw.catalog();
    expect(catalog.map((t) => t.id)).toEqual(expect.arrayContaining(REQUIRED_TEMPLATES));
    for (const t of catalog) {
      expect(t.requiredSecrets.length, t.id).toBeGreaterThan(0);
      expect(t.docsUrl, t.id).toMatch(/^https:\/\//);
      expect(Object.values(t.suggestedPolicies ?? {}), t.id).toContain('ask');
      const secrets = Object.fromEntries(t.requiredSecrets.map((s) => [s, `value-of-${t.id}-${s}`]));
      // Account-specific settings are never defaulted: a template asks for them and refuses to install without.
      const required = (t.configFields ?? []).filter((f) => f.required);
      if (required.length) await expect(gw.installFromTemplate(org.id, t.id, { name: `${t.id}-incomplete`, secrets }, OWNER)).rejects.toThrow(required[0]!.label);
      const config = Object.fromEntries(required.map((f) => [f.key, `my-${f.key}`]));
      const row = await gw.installFromTemplate(org.id, t.id, { secrets, ...(required.length ? { config } : {}) }, OWNER);
      expect(row).toMatchObject({ orgId: org.id, name: t.id, kind: t.kind, templateId: t.id, status: 'active', authRef: `org/acme/connector/${t.id}` });
      for (const s of t.requiredSecrets) {
        expect(await k.secrets.get(`org/acme/connector/${t.id}/${s}`)).toBe(`value-of-${t.id}-${s}`);
        expect(JSON.stringify(row)).not.toContain(`value-of-${t.id}-${s}`);
      }
    }
    expect(catalog.filter((t) => t.category === 'memory').map((t) => t.id).sort()).toEqual(['honcho', 'mem0', 'supermemory', 'zep']);
    expect(gw.list(org.id)).toHaveLength(catalog.length);
    expect(JSON.stringify(k.audit.query({ orgId: org.id }))).not.toContain('value-of-');
    await expect(gw.installFromTemplate(org.id, 'nope', {}, OWNER)).rejects.toThrow(/not found/);
    await expect(gw.installFromTemplate(org.id, 'github', {}, OWNER)).rejects.toThrow(/already exists/);

    // Removing a template install cleans up its secret namespace.
    const github = gw.list(org.id).find((c) => c.name === 'github')!;
    await gw.remove(org.id, github.id, OWNER);
    expect(await k.secrets.has('org/acme/connector/github/GITHUB_PERSONAL_ACCESS_TOKEN')).toBe(false);
  });

  it('applies template suggested policies: a send tool asks first', async () => {
    const upstream = await startHttpMcp([{ name: 'chat_send_message', description: 'Send a chat message' }, { name: 'list_channels', description: 'List channels' }]);
    closers.push(upstream.close);
    const row = await gw.installFromTemplate(org.id, 'slack', { secrets: { SLACK_ACCESS_TOKEN: 'slack-user-token-1' }, config: { url: upstream.url } }, OWNER);
    gw.grant(org.id, row.id, agent.id, {}, OWNER);
    const ctx = runCtx(k, agent);
    expect(textOf(await gw.callTool(ctx, 'slack__list_channels', {}))).toContain('list_channels ok');
    expect(upstream.calls.at(-1)?.authorization).toBe('Bearer slack-user-token-1');
    // The channel is already a known recipient, so what asks here is the template's policy, not the first-send gate.
    approvals.rememberRecipient(org.id, 'slack:c012ab');
    const message = { channel: 'C012AB', text: 'hi' };
    expect(textOf(await gw.callTool(ctx, 'slack__chat_send_message', message))).toMatch(/Approval required/);
    expect(approvals.all().at(-1)).toMatchObject({ kind: 'tool_call' });
    // An explicit per-tool policy on the grant wins over the template.
    gw.grant(org.id, row.id, agent.id, { toolPolicies: { chat_send_message: 'allowed' } }, OWNER);
    expect(textOf(await gw.callTool(runCtx(k, agent), 'slack__chat_send_message', { ...message, text: 'hello' }))).toContain('chat_send_message ok');
  });

  it('mcp_http OAuth: a missing or expired token raises a connector_auth Approval with the advertised authorization URL', async () => {
    const upstream = await startHttpMcp([{ name: 'list_items', description: 'List items' }]);
    closers.push(upstream.close);
    upstream.requireBearer = 'fresh-access-token';
    const row = await gw.install(org.id, { name: 'vault', kind: 'mcp_http', config: { url: upstream.url, auth: { type: 'oauth', clientId: 'conductor' } }, authRef: 'org/acme/vault' }, OWNER);
    gw.grant(org.id, row.id, agent.id, {}, OWNER);
    const ctx = runCtx(k, agent);

    expect(await gw.listTools(ctx)).toEqual([]);
    const [approval] = approvals.all();
    expect(approval).toMatchObject({ kind: 'connector_auth', status: 'pending' });
    const authUrl = new URL(approval!.payload.authUrl as string);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(`${upstream.origin}/authorize`);
    expect(authUrl.searchParams.get('client_id')).toBe('conductor');

    const pending = await gw.callTool(ctx, 'vault__list_items', {});
    expect(pending.isError).toBeFalsy();
    expect(textOf(pending)).toContain(approval!.id);
    expect(approvals.all()).toHaveLength(1);

    // Expired token: still auth-required, no upstream call.
    await k.secrets.set('org/acme/vault/access_token', JSON.stringify({ access_token: 'fresh-access-token', expires_at: k.clock.now() - 1000 }));
    expect(textOf(await gw.callTool(ctx, 'vault__list_items', {}))).toContain(approval!.id);
    // A token the server rejects (401) is reported the same way.
    await k.secrets.set('org/acme/vault/access_token', 'stale-token');
    expect(textOf(await gw.callTool(ctx, 'vault__list_items', {}))).toContain(approval!.id);
    expect(upstream.calls).toHaveLength(0);

    await k.secrets.set('org/acme/vault/access_token', JSON.stringify({ access_token: 'fresh-access-token', expires_at: k.clock.now() + 3_600_000 }));
    approvals.decide(org.id, approval!.id, 'approved', OWNER);
    expect(textOf(await gw.callTool(ctx, 'vault__list_items', {}))).toContain('list_items ok');
  });

  it('mcp_http falls back to the legacy HTTP+SSE transport when Streamable HTTP is not offered', async () => {
    const transports = new Map<string, SSEServerTransport>();
    const seenAuth: Array<string | undefined> = [];
    const legacy = await listen((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      seenAuth.push(req.headers.authorization);
      if (req.method === 'GET' && url.pathname === '/sse') {
        const server = new Server({ name: 'legacy-sse', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' as const } }] }));
        server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text' as const, text: 'pong over sse' }] }));
        const transport = new SSEServerTransport('/messages', res);
        transports.set(transport.sessionId, transport);
        void server.connect(transport);
      } else if (req.method === 'POST' && url.pathname === '/messages') {
        void transports.get(url.searchParams.get('sessionId') ?? '')?.handlePostMessage(req, res);
      } else {
        res.writeHead(405).end();
      }
    });
    closers.push(legacy.close);
    await k.secrets.set('org/acme/legacy/token', 'legacy-bearer-token');
    const row = await gw.install(org.id, { name: 'legacy', kind: 'mcp_http', config: { url: `${legacy.origin}/sse`, auth: { type: 'bearer' } }, authRef: 'org/acme/legacy' }, OWNER);
    gw.grant(org.id, row.id, agent.id, {}, OWNER);
    expect(textOf(await gw.callTool(runCtx(k, agent), 'legacy__ping', {}))).toContain('pong over sse');
    expect(new Set(seenAuth)).toEqual(new Set(['Bearer legacy-bearer-token']));
  });

  it('composio: one entity per org by default, a different connected account per grant', async () => {
    const upstream = await startHttpMcp([{ name: 'GMAIL_FETCH_EMAILS', description: 'Fetch emails', handler: (_a, _h, url) => ({ text: `entity=${url.searchParams.get('user_id')}` }) }]);
    closers.push(upstream.close);
    const bob = seedAgent(k, org.id, agent.deptId, 'Bob', { autonomyLevel: 3 });
    const row = await gw.installFromTemplate(org.id, 'composio', { secrets: { COMPOSIO_API_KEY: 'composio-key-123' }, config: { mcpUrl: upstream.url, toolkit: 'gmail' } }, OWNER);
    await k.secrets.set('org/acme/composio-bob/entity_id', 'bobs-connected-account');
    gw.grant(org.id, row.id, agent.id, {}, OWNER);
    gw.grant(org.id, row.id, bob.id, { authRef: 'org/acme/composio-bob' }, OWNER);

    expect(textOf(await gw.callTool(runCtx(k, agent), 'composio__GMAIL_FETCH_EMAILS', {}))).toContain(`entity=${org.id}`);
    expect(textOf(await gw.callTool(runCtx(k, bob), 'composio__GMAIL_FETCH_EMAILS', {}))).toContain('entity=bobs-connected-account');
    expect(upstream.calls.map((c) => c.headers['x-api-key'])).toEqual(['composio-key-123', 'composio-key-123']);

    // entityMode "agent": each agent is its own Composio entity.
    await gw.update(org.id, row.id, { config: { mcpUrl: upstream.url, entityMode: 'agent', apiKeyRef: 'COMPOSIO_API_KEY' } }, OWNER);
    expect(textOf(await gw.callTool(runCtx(k, agent), 'composio__GMAIL_FETCH_EMAILS', {}))).toContain(`entity=${agent.id}`);
  });

  it('arcade: an authorization-required tool response becomes a connector_auth Approval (just-in-time OAuth)', async () => {
    let authorized = false;
    const upstream = await startHttpMcp([{
      name: 'Gmail_ListEmails',
      description: 'List emails',
      handler: () => authorized
        ? { text: '3 emails' }
        : { text: JSON.stringify({ message: 'Authorization required to use this tool', authorization_url: 'https://accounts.example.com/o/oauth2/auth?state=abc' }), isError: true },
    }]);
    closers.push(upstream.close);
    const row = await gw.installFromTemplate(org.id, 'arcade', { secrets: { ARCADE_API_KEY: 'arcade-key-123' }, config: { mcpUrl: upstream.url } }, OWNER);
    gw.grant(org.id, row.id, agent.id, {}, OWNER);
    const ctx = runCtx(k, agent);

    const r = await gw.callTool(ctx, 'arcade__Gmail_ListEmails', {});
    expect(r.isError).toBeFalsy();
    const [approval] = approvals.all();
    expect(approval).toMatchObject({ kind: 'connector_auth', status: 'pending', requesterAgentId: agent.id });
    expect(approval!.payload.authUrl).toBe('https://accounts.example.com/o/oauth2/auth?state=abc');
    expect(textOf(r)).toContain(approval!.id);
    expect(upstream.calls.at(-1)?.authorization).toBe('Bearer arcade-key-123');
    expect(upstream.calls.at(-1)?.headers['arcade-user-id']).toBe(org.id);
    await gw.callTool(ctx, 'arcade__Gmail_ListEmails', {});
    expect(approvals.all()).toHaveLength(1);

    authorized = true;
    approvals.decide(org.id, approval!.id, 'approved', OWNER);
    expect(textOf(await gw.callTool(ctx, 'arcade__Gmail_ListEmails', {}))).toContain('3 emails');
  });

  describe('openapi', () => {
    const seen: Array<{ method: string; url: string; auth?: string; body: string }> = [];
    let api: Awaited<ReturnType<typeof listen>>;
    let elsewhere: Awaited<ReturnType<typeof listen>>;
    const spec = (servers: string[]) => ({
      openapi: '3.0.3',
      info: { title: 'Pets', version: '1' },
      servers: servers.map((url) => ({ url })),
      components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
      paths: {
        '/pets/{petId}': {
          parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
          get: { operationId: 'getPet', summary: 'Get a pet', parameters: [{ name: 'verbose', in: 'query', schema: { type: 'boolean' } }] },
          delete: { operationId: 'deletePet', summary: 'Delete a pet' },
        },
        '/pets': { post: { operationId: 'createPet', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
        '/away': { get: { operationId: 'goAway' } },
      },
    });

    beforeEach(async () => {
      seen.length = 0;
      elsewhere = await listen((req, res) => {
        seen.push({ method: req.method ?? '', url: `elsewhere${req.url}`, auth: req.headers.authorization, body: '' });
        res.end('leaked');
      });
      api = await listen((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
          if (req.url === '/v1/away') {
            res.writeHead(302, { location: `${elsewhere.origin}/steal` }).end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: req.url }));
        });
      });
      closers.push(api.close, elsewhere.close);
      await k.secrets.set('org/acme/pets/token', 'pets-api-token-1');
    });

    it('wraps each operation as a tool and executes it over HTTP with credentials from the secret store', async () => {
      const row = await gw.install(org.id, { name: 'pets', kind: 'openapi', config: { spec: spec([`${api.origin}/v1`]), auth: { type: 'bearer' } }, authRef: 'org/acme/pets' }, OWNER);
      gw.grant(org.id, row.id, agent.id, { toolPolicies: { '*': 'allowed' } }, OWNER);
      const ctx = runCtx(k, agent);
      const tools = await gw.listTools(ctx);
      expect(Object.fromEntries(tools.map((t) => [t.name, t.risk]))).toEqual({ pets__getPet: 'external_read', pets__deletePet: 'high', pets__createPet: 'external_write', pets__goAway: 'external_read' });
      expect(tools.find((t) => t.name === 'pets__getPet')?.inputSchema).toMatchObject({ properties: { petId: { type: 'string' }, verbose: { type: 'boolean' } }, required: ['petId'] });
      expect(tools.find((t) => t.name === 'pets__createPet')?.inputSchema).toMatchObject({ properties: { body: { properties: { name: { type: 'string' } } } }, required: ['body'] });

      const got = await gw.callTool(ctx, 'pets__getPet', { petId: 'a/b', verbose: true });
      expect(got.untrusted).toBe(true);
      expect(textOf(got)).toContain('/v1/pets/a%2Fb?verbose=true');
      await gw.callTool(runCtx(k, agent), 'pets__createPet', { body: { name: 'Rex' } });
      expect(seen).toEqual([
        { method: 'GET', url: '/v1/pets/a%2Fb?verbose=true', auth: 'Bearer pets-api-token-1', body: '' },
        { method: 'POST', url: '/v1/pets', auth: 'Bearer pets-api-token-1', body: '{"name":"Rex"}' },
      ]);
      expect((await gw.callTool(runCtx(k, agent), 'pets__getPet', {})).isError).toBe(true);
    });

    it('only talks to the spec\'s servers: off-allowlist base URLs and redirects are refused', async () => {
      const off = await gw.install(org.id, { name: 'offlist', kind: 'openapi', config: { spec: spec([`${api.origin}/v1`]), baseUrl: `${elsewhere.origin}/v1`, auth: { type: 'bearer' } }, authRef: 'org/acme/pets' }, OWNER);
      gw.grant(org.id, off.id, agent.id, { toolPolicies: { '*': 'allowed' } }, OWNER);
      const refused = await gw.callTool(runCtx(k, agent), 'offlist__getPet', { petId: '1' });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toMatch(/not one of the OpenAPI spec's servers/);

      const row = await gw.install(org.id, { name: 'pets', kind: 'openapi', config: { spec: spec([`${api.origin}/v1`]), auth: { type: 'bearer' } }, authRef: 'org/acme/pets' }, OWNER);
      gw.grant(org.id, row.id, agent.id, { toolPolicies: { '*': 'allowed' } }, OWNER);
      const redirected = await gw.callTool(runCtx(k, agent), 'pets__goAway', {});
      expect(redirected.isError).toBe(true);
      expect(textOf(redirected)).toMatch(/redirect .* refused/);
      expect(seen.filter((s) => s.url.startsWith('elsewhere'))).toEqual([]);
    });

    it('loads a YAML spec from a file under the conductor home and refuses paths outside it', async () => {
      mkdirSync(join(k.paths.home, 'specs'));
      writeFileSync(join(k.paths.home, 'specs', 'pets.yaml'), `openapi: 3.0.3\nservers:\n  - url: ${api.origin}/v1\npaths:\n  /pets/{petId}:\n    get:\n      operationId: getPet\n      parameters:\n        - { name: petId, in: path, required: true, schema: { type: string } }\n`);
      const row = await gw.install(org.id, { name: 'yamlpets', kind: 'openapi', config: { specPath: 'specs/pets.yaml' } }, OWNER);
      expect((await gw.discoverTools(org.id, row.id)).map((t) => t.name)).toEqual(['getPet']);
      const escape = await gw.install(org.id, { name: 'escape', kind: 'openapi', config: { specPath: '../../etc/passwd' } }, OWNER);
      await expect(gw.discoverTools(org.id, escape.id)).rejects.toThrow(/escapes root/);
      await expect(gw.install(org.id, { name: 'none', kind: 'openapi', config: {} }, OWNER)).rejects.toThrow(/exactly one of/);
    });
  });
});
