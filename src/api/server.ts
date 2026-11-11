import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import websocket from '@fastify/websocket';
import type { Services } from '../daemon/container.js';
import { OriginGuard, authenticate } from './auth.js';
import { isLoopbackHost, toErrorResponse } from './http.js';
import { registerUi, securityHeaders } from './static.js';
import { eventSocket } from './ws.js';
import { takeoverRoutes } from './takeover.js';
import { systemRoutes } from './routes/system.js';
import { authRoutes } from './routes/auth.js';
import { orgRoutes } from './routes/orgs.js';
import { workRoutes } from './routes/work.js';
import { runRoutes } from './routes/runs.js';
import { capabilityRoutes } from './routes/capabilities.js';
import { reachRoutes, type GatewayControl } from './routes/reach.js';
import { revisionRoutes } from './routes/revisions.js';
import { agentRoutes, mcpRoute } from './routes/agent.js';
import { inboundWebhookRoutes } from './webhooks/inbound.js';
import { startOutboundWebhooks } from './webhooks/outbound.js';
import { API_PREFIX, type BindInfo, type HealthResponse } from './types.js';

export interface ApiServerOptions {
  /** Routes mounted by other contexts (messaging gateways) without the API knowing about them. */
  plugins?: FastifyPluginAsync[];
  /** Live control of the messaging gateways (reload after edits, pairing codes, status). */
  gateways?: GatewayControl;
  /** Built web UI. Default: `ui/dist` at the project root. */
  uiDir?: string;
  /** Inbound webhook deliveries accepted per hook per minute (default 120). */
  webhookRatePerMinute?: number;
  /** WebSocket ping interval (default 30 s). */
  wsHeartbeatMs?: number;
}

export interface ApiServer {
  app: FastifyInstance;
  listen(host: string, port: number): Promise<void>;
  close(): Promise<void>;
}

/** Org bundles and skill folders travel as JSON bodies. */
const BODY_LIMIT = 32 * 1024 * 1024;

/**
 * The one versioned REST + WebSocket API every surface uses (web UI, CLI,
 * messaging gateways, agents), plus the MCP gateway endpoint and webhooks.
 */
export async function createApiServer(services: Services, opts: ApiServerOptions = {}): Promise<ApiServer> {
  const s = services;
  const log = s.kernel.log;
  const startedAt = Date.now();

  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT,
    // MCP tool calls and SSE streams run for many minutes: nothing server-side may cut a request short.
    requestTimeout: 0,
    connectionTimeout: 0,
    keepAliveTimeout: 72_000,
    // Open SSE streams and sockets must not hold up shutdown.
    forceCloseConnections: true,
    // Takeover share tokens and secret refs are long path segments.
    routerOptions: { maxParamLength: 8192 },
  });

  app.decorateRequest('principal', null);
  app.decorateRequest('viaCookie', false);
  securityHeaders(app);

  app.setErrorHandler((err, req, reply) => {
    const r = toErrorResponse(err);
    if (r.internal) log.error({ err, method: req.method, route: req.routeOptions?.url }, 'api request failed');
    return reply.code(r.status).send(r.body);
  });

  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.get('/healthz', async (): Promise<HealthResponse> => ({ status: 'ok', version: s.version, uptimeMs: Date.now() - startedAt }));

  /** Where the socket is bound; before `listen` (in-process use) the configured base URL stands in. */
  let boundHost: string | null = null;
  const bind = (): BindInfo => {
    let host = boundHost;
    if (host === null) {
      try {
        host = new URL(s.baseUrl()).hostname;
      } catch {
        host = '127.0.0.1';
      }
    }
    return { host, loopback: isLoopbackHost(host) };
  };

  const guard = new OriginGuard(s);
  let events: { close(): void } | null = null;

  await app.register(async (api) => {
    api.addHook('onRequest', async (req) => authenticate(s, guard, req));
    authRoutes(api, app, s, guard);
    systemRoutes(api, s, bind);
    orgRoutes(api, s);
    workRoutes(api, s);
    runRoutes(api, s);
    capabilityRoutes(api, s);
    reachRoutes(api, s, opts.gateways);
    revisionRoutes(api, s, () => void opts.gateways?.reload().catch((err) => log.warn({ err }, 'gateway reload failed')));
    agentRoutes(api, s);
    takeoverRoutes(api, s, guard);
    events = eventSocket(api, s, { heartbeatMs: opts.wsHeartbeatMs ?? 30_000 });
  }, { prefix: API_PREFIX });

  mcpRoute(app, s);
  await app.register(async (hooks) => inboundWebhookRoutes(hooks, s, { ratePerMinute: opts.webhookRatePerMinute ?? 120 }));
  for (const plugin of opts.plugins ?? []) await app.register(plugin);
  await registerUi(app, opts.uiDir);

  const stopOutbound = startOutboundWebhooks(s);
  let closed = false;

  return {
    app,
    async listen(host, port) {
      boundHost = host;
      if (!isLoopbackHost(host)) {
        log.warn(
          { host, port },
          `SECURITY WARNING: Conductor is listening on ${host}, not on loopback. Every device that can reach this machine on port ${port} can reach the API; `
          + 'only the owner token stands between the network and your agents. Unset CONDUCTOR_HOST (default 127.0.0.1) and publish through Tailscale or a Cloudflare Tunnel instead.',
        );
      }
      await app.listen({ host, port });
    },
    async close() {
      if (closed) return;
      closed = true;
      stopOutbound();
      (events as { close(): void } | null)?.close();
      await app.close();
    },
  };
}
