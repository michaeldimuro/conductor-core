import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createConnectorGateway } from '../../src/connectors/index.js';
import type { ConnectorGateway } from '../../src/contracts/services.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import { fakeApprovals, fakeOrg, listen, runCtx, startHttpMcp, textOf } from './helpers.js';

/**
 * Hosted toolkits never get a made-up endpoint: Composio's MCP URL is issued by its
 * API, Arcade needs the slug of a gateway the user created. Both providers are
 * faked locally (`baseUrl`), shaped like their documented responses.
 */
describe('hosted toolkits: Composio and Arcade', () => {
  let k: TestKernel;
  let gw: ConnectorGateway;
  let org: Organization;
  let agent: Agent;
  const closers: Array<() => Promise<void>> = [];

  beforeEach(() => {
    k = createTestKernel();
    gw = createConnectorGateway(k, { approvals: fakeApprovals(k), org: fakeOrg(k) }, { toolCacheTtlMs: 0 });
    org = seedOrg(k);
    agent = seedAgent(k, org.id, seedDept(k, org.id).id, 'Ada', { autonomyLevel: 3 });
  });
  afterEach(async () => {
    await gw.close();
    await Promise.all(closers.splice(0).map((c) => c()));
    k.dispose();
  });

  /** A Composio REST API stand-in that issues URLs on the MCP fixture. */
  async function fakeComposio(mcpUrl: string) {
    const requests: Array<{ path: string; key: string | undefined; body: Record<string, unknown> }> = [];
    const api = await listen((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const key = req.headers['x-api-key'] as string | undefined;
        requests.push({ path: req.url ?? '', key, body });
        res.setHeader('content-type', 'application/json');
        if (key !== 'good-composio-key') {
          res.writeHead(401).end(JSON.stringify({ error: { message: 'Invalid API key: ck_**7VmY', code: 801, status: 401 } }));
          return;
        }
        if (req.url === '/api/v3.1/tool_router/session') {
          res.end(JSON.stringify({ session_id: 'trs_1', mcp: { url: `${mcpUrl}?session=trs_1&user_id=${String(body.user_id)}`, headers: { 'x-session-token': 'sess-123' } } }));
        } else if (req.url === '/api/v3.1/mcp/servers/generate') {
          if (body.mcp_server_id !== 'srv_gmail') {
            res.writeHead(404).end(JSON.stringify({ error: { message: 'MCP server not found', code: 1143, status: 404 } }));
            return;
          }
          res.end(JSON.stringify({ mcp_server_id: 'srv_gmail', user_ids_url: [`${mcpUrl}?server=srv_gmail&user_id=${String((body.user_ids as string[])[0])}`] }));
        } else res.writeHead(404).end('{}');
      });
    });
    closers.push(api.close);
    return { origin: api.origin, requests };
  }

  it('Composio with no server: a session covering every connected toolkit, issued by the API', async () => {
    const mcp = await startHttpMcp([{ name: 'GMAIL_FETCH_EMAILS', description: 'Fetch emails', handler: (_a, h, url) => ({ text: `user=${url.searchParams.get('user_id')} session=${url.searchParams.get('session')} token=${String(h['x-session-token'])}` }) }]);
    closers.push(mcp.close);
    const api = await fakeComposio(mcp.url);
    const row = await gw.installFromTemplate(org.id, 'composio', { secrets: { COMPOSIO_API_KEY: 'good-composio-key' }, config: { baseUrl: api.origin } }, OWNER);
    gw.grant(org.id, row.id, agent.id, {}, OWNER);

    expect((await gw.discoverTools(org.id, row.id)).map((t) => t.name)).toEqual(['GMAIL_FETCH_EMAILS']);
    expect(textOf(await gw.callTool(runCtx(k, agent), 'composio__GMAIL_FETCH_EMAILS', {}))).toContain(`user=${org.id} session=trs_1 token=sess-123`);
    expect(api.requests[0]).toEqual({ path: '/api/v3.1/tool_router/session', key: 'good-composio-key', body: { user_id: org.id } });
    expect(mcp.calls.at(-1)?.headers['x-api-key']).toBe('good-composio-key');
  });

  it('Composio with a server ID: a per-user URL from /mcp/servers/generate, never built by hand', async () => {
    const mcp = await startHttpMcp([{ name: 'GMAIL_SEND', description: 'Send', handler: (_a, _h, url) => ({ text: `server=${url.searchParams.get('server')} user=${url.searchParams.get('user_id')}` }) }]);
    closers.push(mcp.close);
    const api = await fakeComposio(mcp.url);
    const row = await gw.installFromTemplate(org.id, 'composio', { secrets: { COMPOSIO_API_KEY: 'good-composio-key' }, config: { baseUrl: api.origin, serverId: 'srv_gmail', entityMode: 'agent' } }, OWNER);
    gw.grant(org.id, row.id, agent.id, {}, OWNER);
    expect((await gw.discoverTools(org.id, row.id)).map((t) => t.name)).toEqual(['GMAIL_SEND']);
    expect(api.requests[0]).toMatchObject({ path: '/api/v3.1/mcp/servers/generate', body: { mcp_server_id: 'srv_gmail', managed_auth_by_composio: true } });
  });

  it('Composio errors say what to fix: a rejected key, an unknown server', async () => {
    const mcp = await startHttpMcp([]);
    closers.push(mcp.close);
    const api = await fakeComposio(mcp.url);
    const bad = await gw.installFromTemplate(org.id, 'composio', { name: 'composio-bad-key', secrets: { COMPOSIO_API_KEY: 'ck_wrong' }, config: { baseUrl: api.origin } }, OWNER);
    await expect(gw.discoverTools(org.id, bad.id)).rejects.toThrow(/Composio rejected the API key \(Invalid API key: ck_\*\*7VmY\)\. Use a project API key/);
    const missing = await gw.installFromTemplate(org.id, 'composio', { name: 'composio-bad-server', secrets: { COMPOSIO_API_KEY: 'good-composio-key' }, config: { baseUrl: api.origin, serverId: 'srv_nope' } }, OWNER);
    await expect(gw.discoverTools(org.id, missing.id)).rejects.toThrow(/Composio: MCP server not found\. Check the MCP server ID/);
  });

  it('Arcade: needs the slug of a real gateway, and reaches it with the API key + Arcade-User-ID', async () => {
    await expect(gw.installFromTemplate(org.id, 'arcade', { secrets: { ARCADE_API_KEY: 'arcade-key' } }, OWNER)).rejects.toThrow(/Arcade needs "MCP gateway slug"/);
    const mcp = await startHttpMcp([{ name: 'Gmail_ListEmails', description: 'List', handler: (_a, h, url) => ({ text: `path=${url.pathname} user=${String(h['arcade-user-id'])} auth=${String(h.authorization)}` }) }]);
    closers.push(mcp.close);
    const row = await gw.installFromTemplate(org.id, 'arcade', { secrets: { ARCADE_API_KEY: 'arcade-key' }, config: { gateway: 'team-tools', baseUrl: `${mcp.origin}/mcp` } }, OWNER);
    gw.grant(org.id, row.id, agent.id, {}, OWNER);
    expect(textOf(await gw.callTool(runCtx(k, agent), 'arcade__Gmail_ListEmails', {}))).toContain(`path=/mcp/team-tools user=${org.id} auth=Bearer arcade-key`);
  });

  it('Arcade: the old "default" placeholder and an unknown slug both explain how to get a gateway', async () => {
    const missing = await listen((_req, res) => res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'gateway_not_found', message: 'Gateway not found' })));
    closers.push(missing.close);
    const legacy = await gw.installFromTemplate(org.id, 'arcade', { name: 'arcade-legacy', secrets: { ARCADE_API_KEY: 'arcade-key' }, config: { gateway: 'default' } }, OWNER);
    await expect(gw.discoverTools(org.id, legacy.id)).rejects.toThrow(/has no MCP gateway yet\. Create an MCP gateway in the Arcade dashboard with user mode "Arcade Headers"/);
    const unknown = await gw.installFromTemplate(org.id, 'arcade', { name: 'arcade-unknown', secrets: { ARCADE_API_KEY: 'arcade-key' }, config: { gateway: 'nope', baseUrl: `${missing.origin}/mcp` } }, OWNER);
    await expect(gw.discoverTools(org.id, unknown.id)).rejects.toThrow(/Arcade has no MCP gateway at nope\./);
  });
});
