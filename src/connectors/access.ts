import type { Kernel } from '../contracts/kernel.js';
import type { Approval, Connector, ConnectorGrant } from '../contracts/rows.js';
import type { ApprovalService } from '../contracts/services.js';
import type { OrgService } from '../contracts/org-work.js';
import { qualifyTool, TOOL_NS_SEP, type BuiltinToolProvider, type ToolCallContext, type ToolDef } from '../contracts/tools.js';
import type { CapabilitySnapshot } from '../contracts/types.js';
import { errorMessage } from '../shared/errors.js';
import { sha256 } from '../shared/util.js';
import { findTemplate } from './catalog.js';
import { syncPins } from './pins.js';
import { classifyRisk, intersectAllowlists, resolvePolicyWithSource } from './risk.js';
import type { ConnectorStore } from './store.js';
import { AuthRequiredError, type CredentialContext, type ToolEntry, type UpstreamTool } from './types.js';
import { credentialKey } from './upstream/factory.js';
import type { UpstreamPool } from './upstream/pool.js';

interface Server {
  name: string;
  connectorId: string;
  builtin: BuiltinToolProvider | null;
  connector: Connector | null;
  grant: ConnectorGrant | null;
}

interface AgentScope {
  orgId: string;
  orgSlug: string;
  agentId: string;
  servers: Server[];
  /** Org policy: which toolkit source wins when Composio and Arcade both offer the same tool. */
  toolkitDefault?: 'composio' | 'arcade';
}

export type Resolution =
  | { kind: 'ok'; entry: ToolEntry }
  | { kind: 'none'; connectorId: string }
  | { kind: 'auth'; connector: Connector; approval: Approval; authUrl: string | null };

type Who = Pick<ToolCallContext, 'orgId' | 'agentId'> & Partial<Pick<ToolCallContext, 'runId' | 'issueId'>>;

const toolKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Org policy `toolkitDefault`: when a Composio and an Arcade connector both
 * offer the same tool to this agent, only the preferred source's copy is
 * listed. (A call by exact name to the other one still resolves — the policy
 * picks a default, it does not revoke a grant.) No policy → both are listed.
 */
export function preferToolkit<S extends { connector: Connector | null }>(
  perServer: Array<{ server: S; tools: ToolEntry[] }>, preferred: 'composio' | 'arcade' | undefined,
): Array<{ server: S; tools: ToolEntry[] }> {
  if (!preferred) return perServer;
  const other = preferred === 'composio' ? 'arcade' : 'composio';
  const offered = new Set(perServer.filter((p) => p.server.connector?.kind === preferred).flatMap((p) => p.tools.map((t) => toolKey(t.def.name))));
  if (offered.size === 0) return perServer;
  return perServer.map((p) => (p.server.connector?.kind === other ? { server: p.server, tools: p.tools.filter((t) => !offered.has(toolKey(t.def.name))) } : p));
}

/**
 * Per-agent scoping: which servers an agent may reach and, for each, which
 * tools under which policy. Identity comes only from the ToolCallContext.
 */
export class AccessResolver {
  private readonly builtins = new Map<string, BuiltinToolProvider>();

  constructor(
    private readonly k: Kernel,
    private readonly store: ConnectorStore,
    private readonly pool: UpstreamPool,
    private readonly deps: { approvals: ApprovalService; org: Pick<OrgService, 'getAgent' | 'resolveCapabilityRefs'> },
    private readonly largeThreshold: number,
  ) {}

  registerBuiltin(provider: BuiltinToolProvider): void {
    this.builtins.set(provider.id, provider);
  }

  /** Null when the agent does not exist in this org (another org's id behaves as not found). */
  private scope(orgId: string, agentId: string): AgentScope | null {
    let orgSlug: string;
    let refs: ReturnType<OrgService['resolveCapabilityRefs']>;
    let deptId: string;
    let toolkitDefault: 'composio' | 'arcade' | undefined;
    try {
      const org = this.store.org(orgId);
      orgSlug = org.slug;
      toolkitDefault = org.policies?.toolkitDefault;
      const agent = this.deps.org.getAgent(orgId, agentId);
      if (agent.orgId !== orgId) return null;
      deptId = agent.deptId;
      refs = this.deps.org.resolveCapabilityRefs(orgId, agentId);
    } catch {
      return null;
    }
    const denied = new Set(refs.denyConnectors);
    const inherited = new Set(refs.connectorIds);
    const rows = this.store.list(orgId);
    const grants = new Map(this.store.listGrants(orgId, { agentId }).map((g) => [g.connectorId, g]));
    const servers: Server[] = [];

    // Builtin servers are available to every agent; a connector row may disable or restrict one.
    for (const provider of this.builtins.values()) {
      const row = rows.find((r) => r.kind === 'builtin' && (r.config as { server?: unknown }).server === provider.id) ?? null;
      if (row && (row.status !== 'active' || denied.has(row.id))) continue;
      servers.push({ name: provider.id, connectorId: row?.id ?? provider.id, builtin: provider, connector: row, grant: row ? (grants.get(row.id) ?? null) : null });
    }
    for (const row of rows) {
      if (row.kind === 'builtin' || row.status !== 'active' || this.builtins.has(row.name)) continue;
      if (denied.has(row.id)) continue;
      // A department's connector never reaches another department, whatever grant or default points at it.
      if (row.scope === 'dept' && row.scopeId !== deptId) continue;
      const grant = grants.get(row.id) ?? null;
      // An explicit grant row, or an implicit one through org defaults / department shared connectors.
      if (!grant && !inherited.has(row.id)) continue;
      servers.push({ name: row.name, connectorId: row.id, builtin: null, connector: row, grant });
    }
    return { orgId, orgSlug, agentId, servers, toolkitDefault };
  }

  private credentials(scope: Pick<AgentScope, 'orgId' | 'orgSlug' | 'agentId'>, connector: Connector, grant: ConnectorGrant | null): CredentialContext {
    const authRefs = [grant?.authRef, connector.authRef].filter((r): r is string => typeof r === 'string' && r.length > 0);
    return { orgId: scope.orgId, orgSlug: scope.orgSlug, agentId: scope.agentId, connector, authRefs: [...new Set(authRefs)] };
  }

  /** Tools of one server the caller may use: quarantined, off-allowlist and Off tools removed. */
  private async serverTools(ctx: ToolCallContext, scope: AgentScope, server: Server): Promise<ToolEntry[]> {
    const allow = intersectAllowlists(server.connector?.toolAllowlist, server.grant?.toolAllowlist);
    const suggested = findTemplate(server.connector?.templateId)?.suggestedPolicies;
    let defs: ToolDef[];
    const annotations = new Map<string, UpstreamTool['annotations']>();
    if (server.builtin) {
      defs = await server.builtin.tools(ctx);
    } else {
      const connector = server.connector!;
      const upstream = await this.pool.tools(this.credentials(scope, connector, server.grant));
      if (connector.lastError) this.store.setHealth(scope.orgId, connector.id, null);
      const quarantined = syncPins(this.k, this.store, scope.orgId, connector, upstream);
      defs = upstream
        .filter((t) => !quarantined.has(t.name))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, risk: classifyRisk(t.name, t.annotations, t.description) }));
      for (const t of upstream) if (t.annotations) annotations.set(t.name, t.annotations);
    }
    const out: ToolEntry[] = [];
    for (const def of defs) {
      if (allow && !allow.includes(def.name)) continue;
      const { policy, source: policySource } = resolvePolicyWithSource({
        tool: def.name, risk: def.risk, builtin: !!server.builtin,
        toolPolicies: server.grant?.toolPolicies, defaultPolicy: server.grant?.defaultPolicy, suggested,
      });
      if (policy === 'off') continue;
      out.push({
        qualified: qualifyTool(server.name, def.name), serverName: server.name, connectorId: server.connectorId,
        def, policy, policySource, builtin: server.builtin, connector: server.connector, grant: server.grant,
        ...(annotations.has(def.name) ? { annotations: annotations.get(def.name) } : {}),
      });
    }
    return out;
  }

  /**
   * File (or reuse) the `connector_auth` Approval that asks a human to
   * authorize the upstream account. An earlier approved one is consumed first:
   * it evidently did not result in working credentials.
   */
  requestAuth(who: Who, connector: Connector, grant: ConnectorGrant | null, err: AuthRequiredError): Approval {
    const cred = this.credentials({ orgId: who.orgId, orgSlug: '', agentId: who.agentId }, connector, grant);
    const matchKey = sha256(`connector_auth|${connector.id}|${credentialKey(cred)}`);
    this.deps.approvals.consume(who.orgId, 'connector_auth', matchKey);
    const open = this.deps.approvals.findOpen(who.orgId, 'connector_auth', matchKey);
    if (open) return open;
    return this.deps.approvals.request({
      orgId: who.orgId,
      kind: 'connector_auth',
      title: `Authorize connector "${connector.name}"`,
      payload: { matchKey, connectorId: connector.id, connectorName: connector.name, authUrl: err.authUrl, reason: err.message, authRef: cred.authRefs[0] ?? null },
      requesterAgentId: who.agentId,
      runId: who.runId ?? null,
      issueId: who.issueId ?? null,
    });
  }

  /** Everything the caller may use, split into directly listed tools and large toolkits (find_tools/call_tool). */
  async entries(ctx: ToolCallContext): Promise<{ direct: ToolEntry[]; large: ToolEntry[] }> {
    const scope = this.scope(ctx.orgId, ctx.agentId);
    const direct: ToolEntry[] = [];
    const large: ToolEntry[] = [];
    if (!scope) return { direct, large };
    const perServer = await Promise.all(
      scope.servers.map(async (server) => {
        try {
          return { server, tools: await this.serverTools(ctx, scope, server) };
        } catch (e) {
          if (e instanceof AuthRequiredError && server.connector) this.requestAuth(ctx, server.connector, server.grant, e);
          else if (server.connector) this.store.setHealth(scope.orgId, server.connector.id, errorMessage(e).slice(0, 500));
          this.k.log.warn({ server: server.name, err: errorMessage(e) }, 'connector unavailable while listing tools');
          return { server, tools: [] as ToolEntry[] };
        }
      }),
    );
    const preferred = preferToolkit(perServer, scope.toolkitDefault);
    for (const { server, tools } of preferred) {
      (!server.builtin && tools.length >= this.largeThreshold ? large : direct).push(...tools);
    }
    return { direct, large };
  }

  /** Resolve one qualified tool name for the caller, loading only its server. */
  async resolve(ctx: ToolCallContext, qualified: string): Promise<Resolution> {
    const sep = qualified.indexOf(TOOL_NS_SEP);
    const serverName = sep > 0 ? qualified.slice(0, sep) : qualified;
    const scope = sep > 0 ? this.scope(ctx.orgId, ctx.agentId) : null;
    const server = scope?.servers.find((s) => s.name === serverName);
    if (!scope || !server) return { kind: 'none', connectorId: serverName.slice(0, 100) || 'unknown' };
    try {
      const entry = (await this.serverTools(ctx, scope, server)).find((e) => e.qualified === qualified);
      return entry ? { kind: 'ok', entry } : { kind: 'none', connectorId: server.connectorId };
    } catch (e) {
      if (e instanceof AuthRequiredError && server.connector) {
        return { kind: 'auth', connector: server.connector, approval: this.requestAuth(ctx, server.connector, server.grant, e), authUrl: e.authUrl };
      }
      throw e;
    }
  }

  async callUpstream(ctx: ToolCallContext, entry: ToolEntry, args: Record<string, unknown>) {
    const orgSlug = this.store.org(ctx.orgId).slug;
    return this.pool.call(this.credentials({ orgId: ctx.orgId, orgSlug, agentId: ctx.agentId }, entry.connector!, entry.grant), entry.def.name, args);
  }

  /** Upstream tool list with the connector's default credentials; pins schema hashes on first sight. */
  async discover(orgId: string, connectorId: string): Promise<Array<ToolDef & { quarantined: boolean }>> {
    const connector = this.store.get(orgId, connectorId);
    if (connector.kind === 'builtin') return [];
    const cred = this.credentials({ orgId, orgSlug: this.store.org(orgId).slug, agentId: '' }, connector, null);
    const upstream = await this.pool.tools(cred, { refresh: true });
    const quarantined = syncPins(this.k, this.store, orgId, connector, upstream);
    return upstream.map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema, risk: classifyRisk(t.name, t.annotations, t.description), quarantined: quarantined.has(t.name),
    }));
  }

  /** Connector part of the run's capability snapshot (no upstream connection is made). */
  snapshot(orgId: string, agentId: string): CapabilitySnapshot['connectors'] {
    const scope = this.scope(orgId, agentId);
    if (!scope) return [];
    return scope.servers.map((s) => ({
      id: s.connectorId,
      name: s.name,
      kind: s.connector?.kind ?? 'builtin',
      scope: s.connector?.scope ?? 'global',
      tools: intersectAllowlists(s.connector?.toolAllowlist, s.grant?.toolAllowlist),
    }));
  }
}
