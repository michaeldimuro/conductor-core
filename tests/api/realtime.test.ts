import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createHarness, type Harness } from './fake-services.js';
import { SESSION_COOKIE, VIEWER_COOKIE } from '../../src/api/index.js';
import { ConductorError } from '../../src/shared/errors.js';

let h: Harness;
let url: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  h = await createHarness({ wsHeartbeatMs: 40 });
  url = await h.listen();
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await h.close();
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Client {
  ws: WebSocket;
  msgs: Array<Record<string, unknown>>;
  send(msg: unknown): void;
  closed: Promise<number>;
}

function open(path: string, headers: Record<string, string>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}${path}`, { headers });
    sockets.push(ws);
    const msgs: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d)) as Record<string, unknown>));
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('open', () => resolve({ ws, msgs, send: (m) => ws.send(JSON.stringify(m)), closed }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

const cookieOf = (res: Response, name: string): string => {
  const c = res.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
  if (!c) throw new Error(`no ${name} cookie`);
  return c.split(';')[0]!;
};

describe('WS /api/v1/ws', () => {
  it('fans out bus events filtered by the subscribed org', async () => {
    const c = await open('/api/v1/ws', h.owner);
    c.send({ type: 'subscribe', orgId: 'acme' });
    await until(() => c.msgs.length === 1);
    expect(c.msgs[0]).toEqual({ type: 'subscribed', orgId: h.orgA.id, runId: null });

    h.kernel.bus.emit('issue.created', { orgId: h.orgB.id, issueId: 'iss_b', assigneeAgentId: null });
    h.kernel.bus.emit('issue.created', { orgId: h.orgA.id, issueId: 'iss_a', assigneeAgentId: null });
    h.kernel.bus.emit('run.event', { orgId: h.orgA.id, runId: 'run_1', seq: 1, event: { type: 'text', text: 'noise' } });
    h.kernel.bus.emit('org.kill_switch', { orgId: null, engaged: true });
    await until(() => c.msgs.length === 3);
    expect(c.msgs.slice(1)).toEqual([
      { type: 'event', name: 'issue.created', payload: { orgId: h.orgA.id, issueId: 'iss_a', assigneeAgentId: null } },
      { type: 'event', name: 'org.kill_switch', payload: { orgId: null, engaged: true } },
    ]);
  });

  it('delivers run.event only for subscribed runs, and stops after unsubscribe', async () => {
    const c = await open('/api/v1/ws', h.owner);
    c.send({ type: 'subscribe', orgId: h.orgA.id, runId: 'run_1' });
    await until(() => c.msgs.length === 1);
    h.kernel.bus.emit('run.event', { orgId: h.orgA.id, runId: 'run_2', seq: 1, event: {} });
    h.kernel.bus.emit('run.event', { orgId: h.orgA.id, runId: 'run_1', seq: 5, event: { type: 'text', text: 'hi' } });
    await until(() => c.msgs.length === 2);
    expect(c.msgs[1]).toMatchObject({ type: 'event', name: 'run.event', payload: { runId: 'run_1', seq: 5 } });

    c.send({ type: 'unsubscribe', runId: 'run_1' });
    await until(() => c.msgs.length === 3);
    h.kernel.bus.emit('run.event', { orgId: h.orgA.id, runId: 'run_1', seq: 6, event: {} });
    h.kernel.bus.emit('issue.done', { orgId: h.orgA.id, issueId: 'iss_1' });
    await until(() => c.msgs.length === 4);
    expect(c.msgs[3]).toMatchObject({ name: 'issue.done' });
  });

  it('supports a cross-org subscription and reports bad messages without dropping the socket', async () => {
    const c = await open('/api/v1/ws', h.owner);
    c.send({ type: 'subscribe', orgId: 'no-such-org' });
    c.ws.send('{broken');
    c.send({ type: 'subscribe' });
    c.send({ type: 'ping' });
    await until(() => c.msgs.length === 4);
    expect(c.msgs.map((m) => m.type)).toEqual(['error', 'error', 'subscribed', 'pong']);
    h.kernel.bus.emit('issue.done', { orgId: h.orgB.id, issueId: 'iss_b' });
    await until(() => c.msgs.length === 5);
    expect(c.msgs[4]).toMatchObject({ name: 'issue.done', payload: { orgId: h.orgB.id } });
  });

  it('requires an owner/device principal', async () => {
    await expect(open('/api/v1/ws', {})).rejects.toThrow('HTTP 401');
    const run = h.startRun();
    await expect(open('/api/v1/ws', { authorization: `Bearer ${run.token}` })).rejects.toThrow('HTTP 403');
  });

  it('checks Origin on cookie-authenticated upgrades (cross-site WebSocket hijacking)', async () => {
    const login = await fetch(`${url}/api/v1/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: h.ownerToken }) });
    const cookie = cookieOf(login, SESSION_COOKIE);
    await expect(open('/api/v1/ws', { cookie, origin: 'https://evil.example' })).rejects.toThrow('HTTP 403');
    await expect(open('/api/v1/ws', { cookie })).rejects.toThrow('HTTP 403');
    const c = await open('/api/v1/ws', { cookie, origin: url });
    c.send({ type: 'ping' });
    await until(() => c.msgs.length === 1);
  });

  it('pings clients and cleans up subscriptions on close', async () => {
    const c = await open('/api/v1/ws', h.owner);
    let pings = 0;
    c.ws.on('ping', () => pings++);
    c.send({ type: 'subscribe', orgId: 'acme' });
    await until(() => pings >= 2);
    expect(h.api.app.websocketServer.clients.size).toBe(1);
    c.ws.close();
    await c.closed;
    await until(() => h.api.app.websocketServer.clients.size === 0);
    expect(() => h.kernel.bus.emit('issue.done', { orgId: h.orgA.id, issueId: 'iss_1' })).not.toThrow();
  });
});

describe('agent API and the MCP gateway endpoint', () => {
  const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });

  it('lists and calls tools with the context of the run behind the token', async () => {
    const run = h.startRun();
    const tools = await fetch(`${url}/api/v1/agent/tools`, { headers: auth(run.token) });
    expect(((await tools.json()) as Array<{ name: string }>)[0]!.name).toBe('conductor-tasks__create_issue');
    expect(h.connectors.listTools).toHaveBeenCalledWith(run.ctx);

    const res = await fetch(`${url}/api/v1/agent/tools/conductor-tasks__create_issue`, {
      method: 'POST', headers: auth(run.token), body: JSON.stringify({ arguments: { title: 'T', agentId: 'someone-else' } }),
    });
    expect(res.status).toBe(200);
    expect(h.connectors.callTool).toHaveBeenCalledWith(run.ctx, 'conductor-tasks__create_issue', { title: 'T', agentId: 'someone-else' });

    h.liveRuns.delete(run.runId);
    expect((await fetch(`${url}/api/v1/agent/tools`, { headers: auth(run.token) })).status).toBe(409);
  });

  it('delegates POST /mcp to the connector gateway with the right ctx and parsed body', async () => {
    const run = h.startRun({ issueId: 'iss_9' });
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const res = await fetch(`${url}/mcp`, { method: 'POST', headers: auth(run.token), body: JSON.stringify(rpc) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: 'POST', ctx: run.ctx, body: rpc });
    expect(run.ctx.issueId).toBe('iss_9');

    const del = await fetch(`${url}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${run.token}` } });
    expect(await del.json()).toMatchObject({ method: 'DELETE', body: null });
  });

  it('streams SSE responses from GET /mcp', async () => {
    const run = h.startRun();
    const res = await fetch(`${url}/mcp`, { headers: { authorization: `Bearer ${run.token}`, accept: 'text/event-stream' } });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toBe(`data: {"runId":"${run.runId}","n":1}\n\ndata: {"runId":"${run.runId}","n":2}\n\n`);
  });

  it('rejects missing, non-run and revoked tokens, and dead runs', async () => {
    const none = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Bearer');
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: auth(h.ownerToken), body: '{}' })).status).toBe(403);

    const run = h.startRun();
    h.liveRuns.delete(run.runId);
    const dead = await fetch(`${url}/mcp`, { method: 'POST', headers: auth(run.token), body: '{}' });
    expect(dead.status).toBe(409);
    expect(((await dead.json()) as { error: { message: string } }).error.message).toBe('run is not live');
    h.runs.delete(run.runId);
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: auth(run.token), body: '{}' })).status).toBe(404);

    const other = h.startRun();
    h.services.governance.tokens.revokeRunTokens(other.runId);
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: auth(other.token), body: '{}' })).status).toBe(401);
    expect(h.connectors.handleMcpRequest).not.toHaveBeenCalled();
  });

  it('answers with a JSON-RPC error when the gateway throws before responding', async () => {
    const run = h.startRun();
    h.connectors.handleMcpRequest.mockRejectedValueOnce(new ConductorError('unavailable', 'gateway down'));
    const res = await fetch(`${url}/mcp`, { method: 'POST', headers: auth(run.token), body: '{}' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'gateway down' }, id: null });
  });
});

describe('remote takeover', () => {
  const claim = (token: string, cookie?: string) =>
    fetch(`${url}/api/v1/takeover/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: url, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ token }),
    });

  it('serves the SPA for the share link itself', async () => {
    const res = await fetch(`${url}/takeover/${'x'.repeat(300)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('claims for one device, streams frames, forwards input and hands back', async () => {
    const t = h.addTakeover('share-token-1', 'Enter the MFA code');
    expect((await claim('wrong-token')).status).toBe(403);

    const res = await claim('share-token-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: t.session.id, reason: 'Enter the MFA code', expiresAt: t.session.expiresAt });
    const raw = res.headers.getSetCookie().find((c) => c.startsWith(VIEWER_COOKIE))!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Strict/);
    expect(raw).toMatch(/Path=\/api\/v1\/takeover/);
    const cookie = cookieOf(res, VIEWER_COOKIE);
    expect(t.session.viewerId).toBe(decodeURIComponent(cookie.split('=')[1]!));

    // A second device (no viewer cookie) is rejected; the same device may reload.
    expect((await claim('share-token-1')).status).toBe(403);
    expect((await claim('share-token-1', cookie)).status).toBe(200);

    const c = await open(`/api/v1/takeover/${t.session.id}/ws`, { cookie, origin: url });
    await until(() => t.io !== null);
    t.io!.sendFrame('anBlZw==', { width: 800, height: 600, url: 'https://login.example', title: 'Sign in' });
    await until(() => c.msgs.length === 1);
    expect(c.msgs[0]).toEqual({ type: 'frame', data: 'anBlZw==', meta: { width: 800, height: 600, url: 'https://login.example', title: 'Sign in' } });

    c.send({ type: 'mouse', action: 'click', x: 10, y: 20 });
    c.send({ type: 'text', text: '123456' });
    c.send({ type: 'teleport', to: 'mars' });
    await until(() => t.inputs.length === 2 && c.msgs.length === 2);
    expect(t.inputs).toEqual([{ type: 'mouse', action: 'click', x: 10, y: 20 }, { type: 'text', text: '123456' }]);
    expect(c.msgs[1]).toEqual({ type: 'error', message: 'invalid input event' });

    const back = await fetch(`${url}/api/v1/takeover/${t.session.id}/hand-back`, { method: 'POST', headers: { cookie, origin: url } });
    expect(back.status).toBe(200);
    expect(t.session.status).toBe('handed_back');
    expect(h.browser.handBack).toHaveBeenCalledWith(t.session.id, t.session.viewerId);

    c.ws.close();
    await until(() => t.detached === 1 && t.io === null);
  });

  it('refuses the viewer socket and hand-back without the claiming device cookie', async () => {
    const t = h.addTakeover('share-token-2');
    const cookie = cookieOf(await claim('share-token-2'), VIEWER_COOKIE);
    const path = `/api/v1/takeover/${t.session.id}`;

    await expect(open(`${path}/ws`, { origin: url })).rejects.toThrow('HTTP 401');
    await expect(open(`${path}/ws`, { cookie, origin: 'https://evil.example' })).rejects.toThrow('HTTP 403');
    expect((await fetch(`${url}${path}/hand-back`, { method: 'POST', headers: { origin: url } })).status).toBe(401);

    const stranger = `${VIEWER_COOKIE}=${'z'.repeat(32)}`;
    expect((await fetch(`${url}${path}/hand-back`, { method: 'POST', headers: { cookie: stranger, origin: url } })).status).toBe(403);
    const c = await open(`${path}/ws`, { cookie: stranger, origin: url });
    expect(await c.closed).toBe(4403);
    expect(c.msgs[0]).toMatchObject({ type: 'error' });
    expect(t.io).toBeNull();
    expect(t.session.status).toBe('active');
  });
});
