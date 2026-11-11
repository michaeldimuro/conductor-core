import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolCallContext, ToolDef, ToolResult } from '../contracts/tools.js';
import type { Logger } from '../shared/util.js';

interface Session {
  ctx: ToolCallContext;
  server: Server;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
}

export interface EndpointBackend {
  listTools(ctx: ToolCallContext): Promise<ToolDef[]>;
  callTool(ctx: ToolCallContext, name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

const MAX_SESSIONS_PER_RUN = 8;

function reject(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * The gateway's own MCP endpoint (Streamable HTTP). Sessions are stateful and
 * bound to the run that initialized them: a session id presented by any other
 * run or agent is refused, and `endRun` tears a run's sessions down.
 */
export class McpEndpoint {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly backend: EndpointBackend,
    private readonly log: Logger,
  ) {}

  async handle(ctx: ToolCallContext, req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      // An unknown id and another run's id are indistinguishable to the caller.
      if (!session || session.ctx.runId !== ctx.runId || session.ctx.agentId !== ctx.agentId || session.ctx.orgId !== ctx.orgId) {
        return reject(res, 404, 'Session not found');
      }
      return session.transport.handleRequest(req, res, parsedBody);
    }
    if (req.method !== 'POST') return reject(res, 400, 'Bad Request: mcp-session-id header is required');
    await this.open({ ...ctx }, req, res, parsedBody);
  }

  private async open(ctx: ToolCallContext, req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    const server = new Server({ name: 'conductor-gateway', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (await this.backend.listTools(ctx)).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { ...t.inputSchema, type: 'object' as const },
        annotations: {
          readOnlyHint: t.risk === 'read' || t.risk === 'external_read',
          destructiveHint: t.risk === 'high',
          openWorldHint: t.risk !== 'read' && t.risk !== 'write',
        },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const r = await this.backend.callTool(ctx, request.params.name, request.params.arguments ?? {});
      return { content: r.content, ...(r.isError ? { isError: true } : {}) };
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        this.sessions.set(id, { ctx, server, transport, createdAt: Date.now() });
        this.trim(ctx.runId);
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    // A request that never initializes a session must not leave a server behind.
    res.once('close', () => {
      if (!transport.sessionId || !this.sessions.has(transport.sessionId)) void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  /** Bound the sessions one run can hold open (oldest first). */
  private trim(runId: string): void {
    const mine = [...this.sessions].filter(([, s]) => s.ctx.runId === runId).sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id, s] of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_RUN))) {
      this.sessions.delete(id);
      void s.server.close().catch((e: unknown) => this.log.debug({ err: e }, 'closing evicted MCP session failed'));
    }
  }

  async endRun(runId: string): Promise<void> {
    const mine = [...this.sessions].filter(([, s]) => s.ctx.runId === runId);
    for (const [id] of mine) this.sessions.delete(id);
    await Promise.all(mine.map(([, s]) => s.server.close().catch(() => undefined)));
  }

  async close(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.server.close().catch(() => undefined)));
  }

  sessionCount(runId?: string): number {
    return runId ? [...this.sessions.values()].filter((s) => s.ctx.runId === runId).length : this.sessions.size;
  }
}
