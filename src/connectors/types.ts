import type { BuiltinToolProvider, ToolContent, ToolDef } from '../contracts/tools.js';
import type { Connector, ConnectorGrant } from '../contracts/rows.js';
import type { ToolPolicy } from '../contracts/types.js';

/** MCP tool annotations the gateway uses to classify risk. */
export interface UpstreamAnnotations {
  /** Human-readable name of the tool, when the upstream gives one. */
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface UpstreamTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: UpstreamAnnotations;
}

export interface UpstreamResult {
  content: ToolContent[];
  isError?: boolean;
  /** Cost of this call in USD when the upstream reports one (MCP result `_meta`). */
  costUsd?: number;
}

/** One live connection to an upstream tool source (MCP server or wrapped OpenAPI spec). */
export interface UpstreamClient {
  listTools(): Promise<UpstreamTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<UpstreamResult>;
  close(): Promise<void>;
  /** True once the underlying transport has gone away; the pool reconnects. */
  readonly closed: boolean;
  /** Called when the upstream announces `tools/list_changed`. */
  onToolsChanged?: (fn: () => void) => void;
}

/** Who the upstream connection is for; decides which credentials are injected. */
export interface CredentialContext {
  orgId: string;
  orgSlug: string;
  agentId: string;
  connector: Connector;
  /** Secret-ref prefixes, most specific first (grant authRef, then connector authRef). */
  authRefs: string[];
}

/** The upstream needs (re-)authorization; surfaced to the board as a `connector_auth` Approval. */
export class AuthRequiredError extends Error {
  constructor(
    message: string,
    readonly authUrl: string | null,
  ) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export interface GatewayOptions {
  /** How long an upstream tool list is reused before re-listing (ms, by kernel clock). Default 60s. */
  toolCacheTtlMs?: number;
  /** Connectors exposing at least this many tools are served through find_tools/call_tool. Default 20. */
  largeToolkitThreshold?: number;
  /** Upstream call timeout (ms). Default 120s. */
  callTimeoutMs?: number;
  /** A denied Ask-first call is not re-filed for this long (ms). Default 1h. */
  deniedCooldownMs?: number;
}

/** A tool the caller may use, fully resolved. */
export interface ToolEntry {
  /** Gateway-qualified name `<server>__<tool>`. */
  qualified: string;
  serverName: string;
  /** connectors.id, or the provider id for a builtin without a connector row. */
  connectorId: string;
  def: ToolDef;
  /** Upstream annotations of the tool (untrusted; used as extra evidence when classifying a call). */
  annotations?: UpstreamAnnotations;
  policy: ToolPolicy;
  /** `owner` when the grant set the policy; `default` for template suggestions and the risk fallback. Absent = owner. */
  policySource?: 'owner' | 'default';
  builtin: BuiltinToolProvider | null;
  connector: Connector | null;
  grant: ConnectorGrant | null;
}

export const META_SERVER = 'gateway';
export const FIND_TOOLS = 'find_tools';
export const CALL_TOOL = 'call_tool';
