import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createConnectorGateway } from '../../src/connectors/index.js';
import type { ConnectorGateway } from '../../src/contracts/services.js';
import { jsonResult, textResult, type BuiltinToolProvider, type ToolCallContext } from '../../src/contracts/tools.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import { fakeApprovals, fakeOrg, listen, runCtx, STDIO_FIXTURE, textOf } from './helpers.js';

/** A builtin server as the daemon would register it (conductor-tasks stand-in). */
const tasksProvider: BuiltinToolProvider = {
  id: 'conductor-tasks',
  description: 'Issues and comments',
  tools: (ctx) => [
    { name: 'whoami', description: 'Who is calling', inputSchema: { type: 'object', properties: {} }, risk: 'read' },
    { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, risk: 'write' },
    ...(ctx.autonomyLevel >= 3 ? [{ name: 'hire_agent', description: 'Hire', inputSchema: { type: 'object' }, risk: 'write' as const }] : []),
  ],
  async call(ctx, tool, args) {
    if (tool === 'whoami') return jsonResult({ agentId: ctx.agentId, runId: ctx.runId, orgId: ctx.orgId });
    return textResult(`created ${String(args.title)}`);
  },
};

describe('gateway MCP endpoint (Streamable HTTP) driven by an SDK client', () => {
  let k: TestKernel;
  let gw: ConnectorGateway;
  let org: Organization;
  let a: Agent;
  let b: Agent;
  let http: Awaited<ReturnType<typeof listen>>;
  /** token -> ctx, standing in for the API layer's run-token authentication. */
  const tokens = new Map<string, ToolCallContext>();
  const clients: Client[] = [];

  const connect = async (token: string, sessionId?: string) => {
    const client = new Client({ name: 'test-adapter', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${http.origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } }, sessionId });
    await client.connect(transport);
    clients.push(client);
    return { client, transport };
  };

  beforeEach(async () => {
    k = createTestKernel();
    gw = createConnectorGateway(k, { approvals: fakeApprovals(k), org: fakeOrg(k) });
    gw.registerBuiltin(tasksProvider);
    org = seedOrg(k);
    const dept = seedDept(k, org.id);
    a = seedAgent(k, org.id, dept.id, 'Ada');
    b = seedAgent(k, org.id, dept.id, 'Bob');
    const notes = await gw.install(org.id, { name: 'notes', kind: 'mcp_stdio', config: { command: process.execPath, args: [STDIO_FIXTURE] } }, OWNER);
    gw.grant(org.id, notes.id, a.id, { toolAllowlist: ['get_note'] }, OWNER);
    tokens.clear();
    http = await listen((req, res) => {
      const ctx = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!ctx) {
        res.writeHead(401).end();
        return;
      }
      void gw.handleMcpRequest(ctx, req, res);
    });
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
    await gw.close();
    await http.close();
    k.dispose();
  });

  it('lists and calls tools end to end with the caller\'s scope', async () => {
    const ctxA = runCtx(k, a);
    const ctxB = runCtx(k, b);
    tokens.set('token-a', ctxA).set('token-b', ctxB);

    const { client: ca, transport } = await connect('token-a');
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const listed = await ca.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(['conductor-tasks__create_issue', 'conductor-tasks__whoami', 'notes__get_note']);
    expect(listed.tools.find((t) => t.name === 'notes__get_note')?.inputSchema).toMatchObject({ type: 'object', properties: { id: { type: 'string' } } });

    const who = await ca.callTool({ name: 'conductor-tasks__whoami', arguments: {} });
    expect(JSON.parse(textOf(who as never))).toEqual({ agentId: a.id, runId: ctxA.runId, orgId: org.id });
    const note = await ca.callTool({ name: 'notes__get_note', arguments: { id: '42' } });
    expect(textOf(note as never)).toContain('note 42');
    expect(textOf(note as never)).toContain('UNTRUSTED EXTERNAL CONTENT');

    // Agent B has no grant: the upstream tool is neither listed nor callable through the endpoint.
    const { client: cb } = await connect('token-b');
    expect((await cb.listTools()).tools.map((t) => t.name).sort()).toEqual(['conductor-tasks__create_issue', 'conductor-tasks__whoami']);
    const denied = await cb.callTool({ name: 'notes__get_note', arguments: { id: '42' } });
    expect(denied.isError).toBe(true);
    expect(k.audit.query({ orgId: org.id, action: 'tool.called', runId: ctxB.runId })).toHaveLength(1);
  });

  it('binds a session to its run: another run or agent cannot reuse the session id', async () => {
    const ctxA = runCtx(k, a);
    tokens.set('token-a', ctxA).set('token-b', runCtx(k, b)).set('token-a-next-run', runCtx(k, a));
    const { transport } = await connect('token-a');
    const sessionId = transport.sessionId!;

    const post = (token: string) => fetch(`${http.origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'conductor-tasks__whoami', arguments: {} } }),
    });
    const own = await post('token-a');
    expect(own.status).toBe(200);
    expect(JSON.stringify(await own.json())).toContain(ctxA.runId);
    for (const token of ['token-b', 'token-a-next-run']) {
      const res = await post(token);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(ctxA.runId);
    }
    // A request without a session that is not an initialize is rejected too.
    const stray = await fetch(`${http.origin}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer token-b', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(stray.status).toBe(400);
    expect((await fetch(`${http.origin}/mcp`, { headers: { authorization: 'Bearer token-b' } })).status).toBe(400);
  });

  it('endRun tears the run\'s sessions down and leaves other runs alone', async () => {
    const ctxA = runCtx(k, a);
    const ctxB = runCtx(k, b);
    tokens.set('token-a', ctxA).set('token-b', ctxB);
    const { client: ca } = await connect('token-a');
    const { client: cb } = await connect('token-b');
    expect((await ca.listTools()).tools.length).toBeGreaterThan(0);

    await gw.endRun(ctxA.runId);
    await expect(ca.listTools()).rejects.toThrow();
    expect((await cb.listTools()).tools.length).toBeGreaterThan(0);
    // The same run token can open a fresh session afterwards (e.g. an adapter reconnect before revocation).
    const { client: again } = await connect('token-a');
    expect((await again.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('lets a builtin connector row restrict a builtin server per agent', async () => {
    const row = await gw.install(org.id, { name: 'tasks-policy', kind: 'builtin', config: { server: 'conductor-tasks' } }, OWNER);
    gw.grant(org.id, row.id, a.id, { toolPolicies: { create_issue: 'off' } }, OWNER);
    const names = async (agent: Agent) => (await gw.listTools(runCtx(k, agent))).map((t) => t.name).filter((n) => n.startsWith('conductor-tasks'));
    expect(await names(a)).toEqual(['conductor-tasks__whoami']);
    expect(await names(b)).toEqual(['conductor-tasks__whoami', 'conductor-tasks__create_issue']);
    expect((await gw.callTool(runCtx(k, a), 'conductor-tasks__create_issue', { title: 'x' })).isError).toBe(true);
    // The provider decides what a caller sees (autonomy), the gateway what it may use.
    expect((await gw.listTools(runCtx(k, b, { autonomyLevel: 3 }))).map((t) => t.name)).toContain('conductor-tasks__hire_agent');
    expect(await gw.snapshot(org.id, b.id)).toEqual(expect.arrayContaining([{ id: row.id, name: 'conductor-tasks', kind: 'builtin', scope: 'org', tools: null }]));
    await gw.update(org.id, row.id, { status: 'disabled' }, OWNER);
    expect(await names(b)).toEqual([]);
  });
});
