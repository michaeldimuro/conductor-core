import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ApprovalService } from '../../src/contracts/services.js';
import type { OrgService } from '../../src/contracts/org-work.js';
import type { Agent, Approval } from '../../src/contracts/rows.js';
import type { ToolCallContext } from '../../src/contracts/tools.js';
import type { OrgPolicies } from '../../src/contracts/types.js';
import { agents, approvals, departments, knownRecipients, organizations, runs } from '../../src/db/schema/index.js';
import { evaluateGate } from '../../src/governance/policy.js';
import { notFound } from '../../src/shared/errors.js';
import { newId } from '../../src/shared/ids.js';
import type { TestKernel } from '../helpers/kernel.js';

export const STDIO_FIXTURE = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));

/**
 * Governance stand-in backed by the real `approvals` / `known_recipients`
 * tables; `decide` emits `approval.decided` like the real service. Gates are
 * decided by the real policy function over the org's policies (`gated`
 * forces one answer for every kind).
 */
export function fakeApprovals(k: TestKernel, opts: { gated?: boolean } = {}): ApprovalService & { all(): Approval[] } {
  const byKey = (orgId: string, kind: string, matchKey: string) =>
    and(eq(approvals.orgId, orgId), eq(approvals.kind, kind as Approval['kind']), sql`json_extract(${approvals.payload}, '$.matchKey') = ${matchKey}`);
  const get = (orgId: string, id: string): Approval => {
    const row = k.db.select().from(approvals).where(and(eq(approvals.orgId, orgId), eq(approvals.id, id))).get();
    if (!row) throw notFound('approval', id);
    return row;
  };
  return {
    all: () => k.db.select().from(approvals).all(),
    requiresApproval: (orgId, kind, ctx) =>
      opts.gated ?? evaluateGate(k.db.select().from(organizations).where(eq(organizations.id, orgId)).get()?.policies, String(kind), ctx),
    request(input) {
      const id = newId('approval');
      k.db.insert(approvals).values({
        id, orgId: input.orgId, kind: input.kind, title: input.title, payload: input.payload ?? {}, requesterAgentId: input.requesterAgentId ?? null,
        runId: input.runId ?? null, issueId: input.issueId ?? null, createdAt: k.clock.now(),
      }).run();
      k.bus.emit('approval.requested', { orgId: input.orgId, approvalId: id, kind: input.kind });
      return get(input.orgId, id);
    },
    decide(orgId, approvalId, decision, by) {
      const row = get(orgId, approvalId);
      k.db.update(approvals).set({ status: decision, decidedBy: by.id ?? by.kind, decidedAt: k.clock.now() }).where(eq(approvals.id, approvalId)).run();
      k.bus.emit('approval.decided', { orgId, approvalId, status: decision, requesterAgentId: row.requesterAgentId });
      return get(orgId, approvalId);
    },
    get,
    list: (orgId) => k.db.select().from(approvals).where(orgId ? eq(approvals.orgId, orgId) : undefined).all(),
    consume(orgId, kind, matchKey) {
      const row = k.db.select().from(approvals).where(and(byKey(orgId, kind, matchKey), eq(approvals.status, 'approved'), isNull(approvals.consumedAt))).get();
      if (!row) return null;
      k.db.update(approvals).set({ consumedAt: k.clock.now() }).where(eq(approvals.id, row.id)).run();
      return get(orgId, row.id);
    },
    findOpen(orgId, kind, matchKey) {
      const rows = k.db.select().from(approvals).where(byKey(orgId, kind, matchKey)).all();
      return rows.find((r) => r.status === 'pending' || (r.status === 'approved' && r.consumedAt === null)) ?? null;
    },
    isKnownRecipient: (orgId, address) =>
      !!k.db.select().from(knownRecipients).where(and(eq(knownRecipients.orgId, orgId), eq(knownRecipients.address, address.trim().toLowerCase()))).get(),
    rememberRecipient(orgId, address) {
      k.db.insert(knownRecipients).values({ orgId, address: address.trim().toLowerCase(), firstApprovedAt: k.clock.now() }).onConflictDoNothing().run();
    },
  };
}

/** Replace an org's policies (e.g. loosen a default gate the test is not about). */
export function setPolicies(k: TestKernel, orgId: string, policies: OrgPolicies): void {
  k.db.update(organizations).set({ policies }).where(eq(organizations.id, orgId)).run();
}

/** Org-context stand-in implementing capability resolution straight from the rows. */
export function fakeOrg(k: TestKernel): Pick<OrgService, 'getAgent' | 'resolveCapabilityRefs'> {
  const getAgent = (orgId: string, agentId: string): Agent => {
    const row = k.db.select().from(agents).where(and(eq(agents.orgId, orgId), eq(agents.id, agentId))).get();
    if (!row) throw notFound('agent', agentId);
    return row;
  };
  return {
    getAgent,
    resolveCapabilityRefs(orgId, agentId) {
      const agent = getAgent(orgId, agentId);
      const org = k.db.select().from(organizations).where(eq(organizations.id, orgId)).get()!;
      const dept = k.db.select().from(departments).where(eq(departments.id, agent.deptId)).get()!;
      const deny = new Set(agent.denyConnectors);
      const ids = [...new Set([...org.defaultConnectors, ...dept.sharedConnectors, ...agent.connectors])].filter((c) => !deny.has(c));
      return { skillNames: [], connectorIds: ids, denySkills: agent.denySkills, denyConnectors: agent.denyConnectors };
    },
  };
}

/** A ToolCallContext for the agent plus a real `runs` row. */
export function runCtx(k: TestKernel, agent: Agent, extra: Partial<ToolCallContext> = {}): ToolCallContext {
  const runId = newId('run');
  k.db.insert(runs).values({ id: runId, orgId: agent.orgId, agentId: agent.id, trigger: 'manual', status: 'running', createdAt: k.clock.now() }).run();
  return {
    orgId: agent.orgId, agentId: agent.id, deptId: agent.deptId, runId, issueId: newId('issue'),
    workspacePath: k.paths.home, autonomyLevel: 2, ...extra,
  };
}

export interface FixtureTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  handler?: (args: Record<string, unknown>, headers: IncomingHttpHeaders, url: URL) => { text: string; isError?: boolean; meta?: Record<string, unknown> };
}

export interface HttpFixture {
  url: string;
  origin: string;
  /** Mutable: tests change it to simulate upstream drift. */
  tools: FixtureTool[];
  calls: Array<{ tool: string; args: Record<string, unknown>; authorization?: string; headers: IncomingHttpHeaders; url: string }>;
  /** When set, requests without `Authorization: Bearer <requireBearer>` get a 401. */
  requireBearer?: string;
  close(): Promise<void>;
}

export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: HttpServer; origin: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    origin,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

/** A real MCP server over Streamable HTTP on an ephemeral port (stateless: one Server per request). */
export async function startHttpMcp(tools: FixtureTool[]): Promise<HttpFixture> {
  const fixture: HttpFixture = { url: '', origin: '', tools, calls: [], close: async () => undefined };
  const http = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/.well-known/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        res.end(JSON.stringify({ resource: fixture.url, authorization_servers: [fixture.origin] }));
      } else {
        res.end(JSON.stringify({
          issuer: fixture.origin, authorization_endpoint: `${fixture.origin}/authorize`, token_endpoint: `${fixture.origin}/token`,
          response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
        }));
      }
      return;
    }
    if (fixture.requireBearer && req.headers.authorization !== `Bearer ${fixture.requireBearer}`) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
      return;
    }
    const server = new Server({ name: 'fixture-http', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: fixture.tools.map((t) => ({
        name: t.name, description: t.description, inputSchema: { type: 'object' as const, ...(t.inputSchema ?? {}) }, ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = fixture.tools.find((t) => t.name === request.params.name);
      const args = request.params.arguments ?? {};
      fixture.calls.push({ tool: request.params.name, args, authorization: req.headers.authorization, headers: req.headers, url: req.url ?? '' });
      const r = tool?.handler?.(args, req.headers, url) ?? { text: tool ? `${tool.name} ok` : 'unknown tool', isError: !tool };
      const meta = 'meta' in r && r.meta ? { _meta: r.meta } : {};
      return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}), ...meta };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => void server.close());
    void server.connect(transport).then(() => transport.handleRequest(req, res));
  });
  fixture.origin = http.origin;
  fixture.url = `${http.origin}/mcp`;
  fixture.close = http.close;
  return fixture;
}

export const textOf = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.map((c) => c.text ?? '').join('\n');
