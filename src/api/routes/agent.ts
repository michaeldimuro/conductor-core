import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Services } from '../../daemon/container.js';
import type { Principal } from '../../contracts/services.js';
import type { ToolCallContext } from '../../contracts/tools.js';
import { ConductorError, conflict, forbidden } from '../../shared/errors.js';
import { bearerToken, requirePrincipal } from '../auth.js';
import { body, param, toErrorResponse } from '../http.js';
import { callTool } from '../schemas/capabilities.js';
import type { AgentMeResponse } from '../types.js';

type RunPrincipal = Extract<Principal, { kind: 'run' }>;

/** Tool identity for a verified run token: 404 when the run is unknown, 409 when it is no longer live. */
export function liveContext(s: Services, p: RunPrincipal): ToolCallContext {
  const ctx = s.runtime.toolContext(p.runId);
  if (ctx && ctx.orgId === p.orgId && ctx.agentId === p.agentId) return ctx;
  s.runtime.getRun(p.orgId, p.runId); // throws not_found for an unknown run
  throw conflict('run is not live');
}

/**
 * Agent-facing HTTP API for `process` / `http` adapters. Reachable with a run
 * token only; identity always comes from the token, never from arguments.
 */
export function agentRoutes(app: FastifyInstance, s: Services): void {
  const ctxOf = (req: FastifyRequest): ToolCallContext => {
    const p = requirePrincipal(req);
    if (p.kind !== 'run') throw forbidden('this endpoint requires a run token');
    return liveContext(s, p);
  };

  app.get('/agent/me', { config: { auth: 'run' } }, async (req): Promise<AgentMeResponse> => {
    const ctx = ctxOf(req);
    return {
      orgId: ctx.orgId,
      runId: ctx.runId,
      agent: s.org.getAgent(ctx.orgId, ctx.agentId),
      issue: ctx.issueId ? s.work.findIssue(ctx.orgId, ctx.issueId) : null,
    };
  });
  app.get('/agent/tools', { config: { auth: 'run' } }, async (req) => s.connectors.listTools(ctxOf(req)));
  app.post('/agent/tools/:name', { config: { auth: 'run' } }, async (req) => {
    const ctx = ctxOf(req);
    return s.connectors.callTool(ctx, param(req, 'name'), body(req, callTool).arguments ?? {});
  });
}

/**
 * `ALL /mcp` — the Streamable-HTTP MCP gateway endpoint, the only way agents
 * reach tools. The run token is verified here, then the raw request/response
 * are handed to the connector gateway. Tool calls may run for many minutes and
 * GET opens a long-lived SSE stream, so the socket is exempt from idle timeouts.
 */
export function mcpRoute(app: FastifyInstance, s: Services): void {
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      const token = bearerToken(req);
      const principal = token ? s.governance.tokens.verify(token) : null;
      if (!principal) {
        reply.header('www-authenticate', 'Bearer realm="conductor"');
        throw new ConductorError('unauthorized', 'a run token is required');
      }
      if (principal.kind !== 'run') throw forbidden('the MCP endpoint accepts run tokens only');
      const ctx = liveContext(s, principal);

      reply.hijack();
      const res = reply.raw;
      req.raw.socket.setTimeout(0);
      req.raw.socket.setKeepAlive(true, 30_000);
      try {
        await s.connectors.handleMcpRequest(ctx, req.raw, res, req.body);
      } catch (err) {
        s.kernel.log.error({ err, runId: ctx.runId }, 'mcp request failed');
        if (!res.headersSent) {
          const r = toErrorResponse(err);
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: r.body.error.message }, id: null }));
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    },
  });
}
