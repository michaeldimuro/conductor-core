import type { Kernel } from '../contracts/kernel.js';
import type { ApprovalService, ConnectorGateway } from '../contracts/services.js';
import type { OrgService } from '../contracts/org-work.js';
import { AccessResolver } from './access.js';
import { ToolCalls } from './calls.js';
import { connectorCatalog } from './catalog.js';
import { idSchema, parseWith } from './config.js';
import { McpEndpoint } from './endpoint.js';
import { ConnectorRegistry } from './registry.js';
import { ConnectorStore } from './store.js';
import type { GatewayOptions } from './types.js';
import { UpstreamPool } from './upstream/pool.js';

export interface ConnectorGatewayDeps {
  approvals: ApprovalService;
  org: Pick<OrgService, 'getAgent' | 'resolveCapabilityRefs'>;
}

/**
 * The Connector Gateway: the one place tools reach agents. Scoping, policy,
 * approvals, credential injection, schema pinning and audit all happen here,
 * whichever provider adapter is driving the agent.
 */
export function createConnectorGateway(kernel: Kernel, deps: ConnectorGatewayDeps, options: GatewayOptions = {}): ConnectorGateway {
  const store = new ConnectorStore(kernel);
  const pool = new UpstreamPool(kernel, {
    toolCacheTtlMs: options.toolCacheTtlMs ?? 60_000,
    callTimeoutMs: options.callTimeoutMs ?? 120_000,
  });
  const access = new AccessResolver(kernel, store, pool, deps, options.largeToolkitThreshold ?? 20);
  const calls = new ToolCalls(kernel, store, access, deps.approvals, options.deniedCooldownMs ?? 3_600_000);
  const registry = new ConnectorRegistry(kernel, store, { ...deps, invalidate: (id) => pool.invalidate(id) });
  const endpoint = new McpEndpoint({ listTools: (ctx) => calls.listTools(ctx), callTool: (ctx, name, args) => calls.callTool(ctx, name, args) }, kernel.log);
  const unsubscribe = registry.subscribe();
  const id = (value: string, what: string) => parseWith(idSchema, value, what);

  return {
    catalog: () => connectorCatalog(),
    install: async (orgId, input, actor) => registry.install(id(orgId, 'org id'), input, actor),
    installFromTemplate: (orgId, templateId, input, actor) => registry.installFromTemplate(id(orgId, 'org id'), templateId, input, actor),
    update: (orgId, connectorId, patch, actor) => registry.update(id(orgId, 'org id'), id(connectorId, 'connector id'), patch, actor),
    remove: (orgId, connectorId, actor) => registry.remove(id(orgId, 'org id'), id(connectorId, 'connector id'), actor),
    get: (orgId, connectorId) => store.get(id(orgId, 'org id'), id(connectorId, 'connector id')),
    list: (orgId) => store.list(id(orgId, 'org id')),
    grant: (orgId, connectorId, agentId, input, actor) => registry.grant(id(orgId, 'org id'), id(connectorId, 'connector id'), id(agentId, 'agent id'), input, actor),
    revokeGrant: (orgId, connectorId, agentId, actor) => registry.revokeGrant(id(orgId, 'org id'), id(connectorId, 'connector id'), id(agentId, 'agent id'), actor),
    listGrants: (orgId, filter) => store.listGrants(id(orgId, 'org id'), filter),
    discoverTools: (orgId, connectorId) => access.discover(id(orgId, 'org id'), id(connectorId, 'connector id')),
    retrustTool: (orgId, connectorId, toolName, actor) => registry.retrustTool(id(orgId, 'org id'), id(connectorId, 'connector id'), id(toolName, 'tool name'), actor),
    registerBuiltin: (provider) => access.registerBuiltin(provider),
    listTools: (ctx) => calls.listTools(ctx),
    callTool: (ctx, qualifiedName, args) => calls.callTool(ctx, qualifiedName, args),
    snapshot: async (orgId, agentId) => access.snapshot(orgId, agentId),
    handleMcpRequest: (ctx, req, res, parsedBody) => endpoint.handle(ctx, req, res, parsedBody),
    async endRun(runId) {
      calls.endRun(runId);
      await endpoint.endRun(runId);
    },
    async close() {
      unsubscribe();
      await endpoint.close();
      await pool.close();
    },
  };
}

export { createFilesToolProvider } from './files/provider.js';
export { connectorCatalog } from './catalog.js';
export type { GatewayOptions } from './types.js';
