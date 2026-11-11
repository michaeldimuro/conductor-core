/**
 * Tool-side contracts shared by the connector gateway and every builtin
 * tool server (conductor-tasks, conductor-memory, conductor-skills,
 * conductor-browser, conductor-files).
 */

export type ToolRisk =
  /** Reads Conductor-internal state. */
  | 'read'
  /** Writes Conductor-internal state (issues, memory, skills). */
  | 'write'
  /** Reads from the outside world (web pages, email, SaaS) — output is UNTRUSTED. */
  | 'external_read'
  /** Changes the outside world: send, post, publish, submit. */
  | 'external_write'
  /** Pay, purchase, delete, shell. */
  | 'high';

export interface ToolDef {
  /** Unqualified tool name within its server, e.g. "create_issue". */
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 / MCP inputSchema). */
  inputSchema: Record<string, unknown>;
  risk: ToolRisk;
}

/** Identity of the caller, derived from the run-scoped token. Never trust args for identity. */
export interface ToolCallContext {
  orgId: string;
  agentId: string;
  deptId: string;
  runId: string;
  issueId: string | null;
  workspacePath: string;
  autonomyLevel: number;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  /** True when content came from the outside world (marks the run as having ingested untrusted input). */
  untrusted?: boolean;
}

export const textResult = (text: string, opts: { isError?: boolean; untrusted?: boolean } = {}): ToolResult => ({
  content: [{ type: 'text', text }],
  ...opts,
});

export const jsonResult = (value: unknown): ToolResult => textResult(JSON.stringify(value, null, 2));

/**
 * A builtin tool server hosted inside the daemon. The gateway exposes its
 * tools to agents as `<serverId>__<tool>` after applying grant policy.
 * Providers enforce their own domain rules and may throw ConductorError.
 */
export interface BuiltinToolProvider {
  /** e.g. "conductor-tasks" */
  readonly id: string;
  readonly description: string;
  /** Tools visible to this caller (may vary by autonomy level). */
  tools(ctx: ToolCallContext): ToolDef[] | Promise<ToolDef[]>;
  call(ctx: ToolCallContext, tool: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** Separator between server id and tool name in gateway-qualified tool names. */
export const TOOL_NS_SEP = '__';
export const qualifyTool = (serverName: string, tool: string) => `${serverName}${TOOL_NS_SEP}${tool}`;
