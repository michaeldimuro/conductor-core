/**
 * The provider adapter contract (PRD "Adapter contract").
 *
 * Adapters are deliberately self-contained: they receive a fully resolved,
 * serializable RunContext and reach tools ONLY through `mcpEndpoints`, which
 * always point at the Conductor connector gateway (Streamable HTTP MCP,
 * authenticated with the run-scoped token). They never import daemon services,
 * so they can run inside a supervised child process.
 */

export interface AdapterCapabilities {
  tools: boolean;
  mcp: boolean;
  resume: boolean;
  vision: boolean;
  browser: 'native' | 'via_mcp';
}

export interface Health {
  ok: boolean;
  detail?: string;
  version?: string;
}

export interface McpEndpoint {
  /** Server name as shown to the model, e.g. "conductor". */
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface ResolvedSkillRef {
  id: string;
  name: string;
  description: string;
  /** Absolute path to the skill folder containing SKILL.md. */
  path: string;
  scope: 'global' | 'org' | 'dept' | 'agent';
  version: number;
  hasScripts: boolean;
}

export interface RunContext {
  runId: string;
  orgId: string;
  agentId: string;
  issueId: string | null;
  /** Persona + standing memory + skill index + operating rules. */
  systemPrompt: string;
  /** The task for this heartbeat. */
  prompt: string;
  model: string | null;
  /** Adapter-specific non-secret config from the provider binding. */
  config: Record<string, unknown>;
  /**
   * Secrets resolved by the daemon for this run (e.g. { apiKey }). Passed
   * in-memory / over IPC only; never journaled, logged or written to disk.
   */
  secrets: Record<string, string>;
  skills: ResolvedSkillRef[];
  mcpEndpoints: McpEndpoint[];
  /** Working directory for the run (issue/project workspace). */
  workspacePath: string;
  /** Remaining budget for this run in USD; null = uncapped. Adapters must stop when exceeded. */
  budgetCapUsd: number | null;
  maxSteps: number;
  maxWallMs: number;
  /** Run-scoped bearer token for the Conductor API (process/http adapters). */
  runToken: string;
  apiBaseUrl: string;
  /** Provider session to resume, if the adapter supports resume. */
  resumeSessionId?: string;
  /**
   * Journaled events of the interrupted run named by `resumeSessionId`, oldest
   * first. Populated by the runtime for adapters whose transcript lives in
   * Conductor rather than at the provider (`claude_api`, `openai_api` emit the
   * session id `conductor-run:<runId>`); they rebuild the message history from it.
   */
  priorEvents?: RunEvent[];
  /**
   * Sandbox policy resolved by the daemon for this run (per-agent / per-org).
   * Optional: adapters fall back to safe defaults (network on, Conductor home
   * inferred) when the runtime does not supply it.
   */
  sandbox?: RunSandboxPolicy;
}

/** What the daemon tells an adapter about confining the processes it spawns. */
export interface RunSandboxPolicy {
  /** Absolute path of the Conductor home the child must never read or write (outside its workspace). */
  conductorHome?: string;
  /** `on` (default): outbound network allowed. `local`: loopback only (the Conductor API / MCP gateway). */
  network?: 'on' | 'local';
}

/** How the provider process of a run was confined; attached to a `status` RunEvent. */
export interface SandboxReport {
  /** True when the child runs under the macOS sandbox profile. */
  enabled: boolean;
  /** Why it is not enabled (opt-out, or `sandbox-exec` unavailable). */
  reason?: string;
  /** True when the sandbox was wanted but could not be applied (graceful fallback). */
  fallback?: boolean;
  network?: 'on' | 'local';
  /** Paths the child may write (workspace, temp, the provider CLI's own state). */
  writable?: string[];
}

export type AdapterErrorKind = 'rate_limit' | 'auth' | 'outage' | 'invalid_request' | 'other';

/** Normalized event stream: UI, cost ledger and learning loop never care which provider ran. */
export type RunEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean }
  | { type: 'usage'; tokensIn: number; tokensOut: number; costUsd: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'session'; sessionId: string }
  | { type: 'status'; status: string; sandbox?: SandboxReport }
  | { type: 'error'; kind: AdapterErrorKind; message: string; retryable: boolean };

export type RunOutcome = 'completed' | 'failed' | 'cancelled' | 'max_steps' | 'timeout' | 'budget';

export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
  /** Marginal cost. Subscription (local CLI login) runs report 0 here. */
  costUsd: number;
  /** True when the run used a flat-rate subscription login rather than metered API. */
  subscription: boolean;
  /** Wall seconds of seat time consumed (counted against the seat-time quota). */
  seatSeconds: number;
}

export interface RunResult {
  outcome: RunOutcome;
  /** The agent's final message. */
  finalText: string;
  sessionId?: string;
  usage: RunUsage;
  steps: number;
  error?: { kind: AdapterErrorKind; message: string };
}

export interface AgentAdapter {
  /** e.g. "claude_local" */
  readonly id: string;
  capabilities(): AdapterCapabilities;
  testConnection(cfg: { config: Record<string, unknown>; secrets: Record<string, string>; model?: string | null }): Promise<Health>;
  run(ctx: RunContext, onEvent: (e: RunEvent) => void): Promise<RunResult>;
  cancel(runId: string): Promise<void>;
}

/** Manifest for plugin adapters discovered from ~/.conductor/adapters/<pkg>/conductor-adapter.json. */
export interface AdapterManifest {
  id: string;
  name: string;
  version: string;
  /** Relative path to an ES module whose default export is `() => AgentAdapter` (or an AgentAdapter). */
  entry: string;
  /** JSON Schema for the binding's `config`. */
  configSchema: Record<string, unknown>;
  capabilities: AdapterCapabilities;
  /** Name of the secret the adapter expects in RunContext.secrets (e.g. "apiKey"), if any. */
  secretName?: string;
}

export interface AdapterRegistry {
  get(id: string): AgentAdapter | undefined;
  list(): Array<{ id: string; name: string; capabilities: AdapterCapabilities; configSchema: Record<string, unknown>; builtin: boolean }>;
  /** (Re)scan the plugin directory. */
  loadPlugins(): Promise<void>;
}

/** Outcome of one plugin-directory scan. */
export interface AdapterRescanResult {
  /** Plugin adapter ids registered after the scan. */
  loaded: string[];
  /** Ids that were not registered before this scan. */
  added: string[];
  /** Ids registered before this scan whose plugin is gone (or now fails to load). */
  removed: string[];
  /** Plugin folders that were skipped, with the reason. */
  skipped: Array<{ folder: string; error: string }>;
}

/**
 * A registry that can pick up newly installed plugins without a daemon
 * restart. `createAdapterRegistry` returns this; `rescan()` is the reporting
 * form of `loadPlugins()`.
 */
export interface RescannableAdapterRegistry extends AdapterRegistry {
  rescan(): Promise<AdapterRescanResult>;
}
