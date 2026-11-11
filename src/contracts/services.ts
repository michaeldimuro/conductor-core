import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Actor, CapabilitySnapshot, RunGrade, SkillEvalResult, ToolPolicy, ProviderBinding } from './types.js';
import type {
  Approval, Skill, SkillVersion, Memory, Connector, ConnectorGrant, BrowserProfile, BrowserSession, Run, Scorecard, LedgerRow,
} from './rows.js';
import type { ApprovalKind } from '../db/schema/governance.js';
import type { MemoryKind, MemoryScope } from '../db/schema/memory.js';
import type { Scope, ConnectorKind } from '../db/schema/capabilities.js';
import type { RunTrigger } from '../db/schema/runs.js';
import type { BuiltinToolProvider, ToolCallContext, ToolDef, ToolResult } from './tools.js';
import type { ResolvedSkillRef, RunContext, RunEvent, RunResult } from './adapter.js';

/* ───────────────────────── Governance ───────────────────────── */

export interface ApprovalService {
  /** True when this action kind needs board approval in this org (defaults + org policy). */
  requiresApproval(orgId: string, kind: ApprovalKind | string, ctx?: { amountUsd?: number }): boolean;
  request(input: {
    orgId: string; kind: ApprovalKind; title: string; payload?: Record<string, unknown>;
    requesterAgentId?: string | null; runId?: string | null; issueId?: string | null; expiresAt?: number | null;
  }): Approval;
  /** Emits `approval.decided`. The requesting context executes its own action on that event. */
  decide(orgId: string, approvalId: string, decision: 'approved' | 'denied', by: Actor, note?: string): Approval;
  get(orgId: string, approvalId: string): Approval;
  list(orgId: string | null, filter?: { status?: Approval['status']; kind?: string; limit?: number }): Approval[];
  /**
   * Find an approved, unconsumed approval for (kind, matchKey) and mark it
   * consumed. `payload.matchKey` identifies the exact action (e.g. agent+tool+argsHash).
   */
  consume(orgId: string, kind: ApprovalKind, matchKey: string): Approval | null;
  /** Pending or approved-unconsumed approval for the same action, if any (avoids duplicates). */
  findOpen(orgId: string, kind: ApprovalKind, matchKey: string): Approval | null;
  /** First-send-to-new-recipient gate helpers. */
  isKnownRecipient(orgId: string, address: string): boolean;
  rememberRecipient(orgId: string, address: string): void;
}

export interface BudgetLine {
  scope: 'org' | 'dept' | 'agent' | 'project';
  id: string;
  capUsd: number | null;
  spentUsd: number;
  pct: number | null;
}

export interface BudgetStatus {
  allowed: boolean;
  /** Remaining under the tightest cap; null = uncapped everywhere. */
  remainingUsd: number | null;
  tightest: BudgetLine | null;
  lines: BudgetLine[];
  seat: { capSeconds: number | null; usedSeconds: number; allowed: boolean };
  reason?: string;
}

export interface BudgetService {
  /** Monthly caps at org, department, agent and project level; the tightest applies. */
  check(orgId: string, agentId: string, projectId?: string | null): BudgetStatus;
  /**
   * Record spend. Emits `budget.alert` (soft at 80%, hard at 100%); on hard
   * stop pauses the agent (status=paused, reason=budget) and emits agent.paused.
   */
  record(entry: {
    orgId: string; agentId?: string | null; projectId?: string | null; runId?: string | null;
    category?: string; provider?: string | null; model?: string | null;
    tokensIn?: number; tokensOut?: number; costUsd: number; subscription?: boolean; seatSeconds?: number;
  }): BudgetStatus | null;
  summary(orgId: string, opts?: { since?: number; until?: number }): {
    totalUsd: number; seatSeconds: number; lines: BudgetLine[];
    byAgent: Array<{ agentId: string; costUsd: number; tokensIn: number; tokensOut: number; runs: number }>;
    byDay: Array<{ day: string; costUsd: number }>;
  };
  ledger(orgId: string, opts?: { agentId?: string; limit?: number }): LedgerRow[];
}

export interface KillSwitch {
  /** orgId null = global. Engaging cancels in-flight runs via the `org.kill_switch` event. */
  engage(orgId: string | null, actor: Actor): void;
  release(orgId: string | null, actor: Actor): void;
  /** True when the global switch or this org's switch is engaged. */
  isEngaged(orgId: string): boolean;
  globalEngaged(): boolean;
}

export type Principal =
  | { kind: 'owner'; tokenId: string }
  | { kind: 'device'; tokenId: string }
  | { kind: 'run'; tokenId: string; orgId: string; agentId: string; runId: string };

export interface TokenService {
  issueOwnerToken(label?: string): string;
  issueDeviceToken(label: string, ttlMs: number): string;
  issueRunToken(orgId: string, agentId: string, runId: string, ttlMs: number): string;
  verify(token: string): Principal | null;
  revokeRunTokens(runId: string): void;
  revoke(tokenId: string): void;
  /** Path of the 0600 file holding the local owner token used by the CLI. */
  ownerTokenFile(): string;
}

export interface Governance {
  approvals: ApprovalService;
  budgets: BudgetService;
  killSwitch: KillSwitch;
  tokens: TokenService;
}

/* ───────────────────────── Skills ───────────────────────── */

export interface SkillManageInput {
  action: 'create' | 'patch' | 'deprecate';
  name: string;
  description?: string;
  /** SKILL.md body (instructions) for create; full replacement body for patch when given. */
  body?: string;
  /** patch: targeted replacement instead of a full body. */
  find?: string;
  replace?: string;
  /** Extra files, relative path → content (scripts/, references/, assets/). */
  files?: Record<string, string>;
  reason?: string;
}

export interface SkillService {
  /** Effective ACTIVE skills: org defaults ∪ dept shared ∪ agent own, minus deny list. */
  resolveForAgent(orgId: string, agentId: string): ResolvedSkillRef[];
  /** Progressive disclosure: full SKILL.md body, only when the agent decides it applies. */
  loadBody(orgId: string, agentId: string, name: string): string;
  /** The built-in `skill_manage` tool: agent writes into its OWN scope with status draft. */
  manage(ctx: { orgId: string; agentId: string; runId?: string; issueId?: string | null }, input: SkillManageInput): Promise<Skill>;
  /** Human/owner authoring into any scope. */
  upsert(orgId: string | null, input: { scope: Scope; scopeId: string | null; name: string; description: string; body: string; files?: Record<string, string>; status?: Skill['status'] }, actor: Actor): Promise<Skill>;
  /** Import a third-party skill folder: pinned by hash, starts as draft. */
  importSkill(orgId: string | null, input: { sourceDir: string; scope: Scope; scopeId: string | null; source?: string }, actor: Actor): Promise<Skill>;
  get(skillId: string): Skill;
  list(filter: { orgId?: string | null; scope?: Scope; scopeId?: string | null; status?: Skill['status']; includeGlobal?: boolean }): Skill[];
  read(skillId: string): { skill: Skill; body: string; files: string[] };
  history(skillId: string): SkillVersion[];
  /** Unified diff between two versions (default: previous → current). */
  diff(skillId: string, fromVersion?: number, toVersion?: number): Promise<string>;
  rollback(skillId: string, toVersion: number, actor: Actor): Promise<Skill>;
  /** Replay with and without the skill in a sandboxed workspace; store result on the version. */
  evaluate(skillId: string): Promise<SkillEvalResult>;
  /** draft → active (after scan + eval gate). `force` lets the owner skip the eval. */
  activate(skillId: string, actor: Actor, opts?: { force?: boolean }): Promise<Skill>;
  /** Promote to a wider scope. dept: lead (or auto per policy); org/global: owner approval. */
  promote(skillId: string, toScope: Scope, actor: Actor): Promise<{ skill?: Skill; approval?: Approval }>;
  setStatus(skillId: string, status: Skill['status'], actor: Actor): Promise<Skill>;
  /** Record run outcome for the skills a run loaded; may trigger auto-revert of a regressed version. */
  recordUsage(input: { orgId: string; runId: string; agentId: string; skillIds: string[]; success: boolean | null; humanEdited?: boolean; costUsd: number; steps: number }): Promise<void>;
  /** Mark skills unused for 60 days (or superseded) deprecated. Returns retired ids. */
  retireStale(now?: number): Promise<string[]>;
  toolProvider(): BuiltinToolProvider;
}

/** Runs a prompt in an isolated sandbox workspace for skill evals. Implemented by the runtime. */
export interface EvalRunner {
  run(input: { orgId: string; agentId: string; prompt: string; skills: ResolvedSkillRef[]; label: string }): Promise<{ result: RunResult; wallMs: number; finalText: string }>;
}

/* ───────────────────────── Memory & learning ───────────────────────── */

export interface MemoryWriteInput {
  scope: MemoryScope;
  scopeId: string;
  kind: MemoryKind;
  content: string;
  entity?: string | null;
  taskType?: string | null;
  importance?: number;
  confidence?: number;
  sourceRunId?: string | null;
  author?: string;
  pinned?: boolean;
}

export interface ScoredMemory {
  memory: Memory;
  /** similarity × recency decay × importance × confidence */
  score: number;
  similarity: number;
}

export interface RecallBundle {
  /** Role card + MEMORY.md standing rules (≤ 2k tokens). Injected every run. */
  profile: string;
  /** Owner model (USER.md) for the org. Injected every run. */
  ownerModel: string;
  /** Retrieved procedural/semantic/episodic memories + high-priority lessons. */
  memories: ScoredMemory[];
}

export interface ReflectionResult {
  grade: RunGrade;
  memoriesWritten: string[];
  memoriesQueued: string[];
  skillCandidate: { trigger: string; suggestedName: string } | null;
  summary: string;
}

export interface AgentScorecard {
  agentId: string;
  days: number;
  runs: number;
  issuesClosed: number;
  successRate: number;
  reworkRate: number;
  costPerIssue: number;
  /** Weekly buckets, oldest first — the "self-improving" trend. */
  trend: Array<{ weekStart: number; runs: number; successRate: number; costPerIssue: number }>;
  byTaskType: Array<{ taskType: string; runs: number; successRate: number; costPerIssue: number }>;
}

export interface MemoryService {
  /** Write with contradiction handling: near-duplicates merge, conflicting facts supersede (old kept). Confidence below threshold → review queue. */
  write(orgId: string, input: MemoryWriteInput, actor: Actor): Promise<Memory>;
  /** Hybrid FTS5 + vector search over scopes visible to the agent (its own ∪ its dept ∪ org). */
  search(orgId: string, query: { agentId?: string; text: string; kinds?: MemoryKind[]; entity?: string; taskType?: string; limit?: number; includeReview?: boolean }): Promise<ScoredMemory[]>;
  recall(orgId: string, agentId: string, task: { title: string; body: string; taskType?: string | null }): Promise<RecallBundle>;
  forget(orgId: string, memoryId: string, actor: Actor): void;
  update(orgId: string, memoryId: string, patch: { content?: string; importance?: number; confidence?: number; pinned?: boolean; status?: Memory['status']; kind?: MemoryKind }, actor: Actor): Promise<Memory>;
  get(orgId: string, memoryId: string): Memory;
  list(orgId: string, filter?: { scope?: MemoryScope; scopeId?: string; kind?: MemoryKind; status?: Memory['status']; limit?: number; offset?: number }): Memory[];
  /** Read/replace the agent's MEMORY.md (standing rules). */
  getProfileDoc(orgId: string, agentId: string): string;
  setProfileDoc(orgId: string, agentId: string, content: string, actor: Actor): void;
  getOwnerModel(orgId: string): string;
  setOwnerModel(orgId: string, content: string, actor: Actor): void;
  /** FTS5 search across past run summaries. */
  searchSessions(orgId: string, agentId: string | null, text: string, limit?: number): Array<{ runId: string; issueId: string | null; summary: string; createdAt: number }>;

  /** Post-run reflection on the utility model: grade, extract memories, skill check. */
  reflect(orgId: string, runId: string): Promise<ReflectionResult>;
  /** Nightly "dream": dedupe/compress, rewrite MEMORY.md under budget, promote recurring procedures to skill drafts, decay unused. */
  consolidate(orgId: string, agentId: string): Promise<{ merged: number; decayed: number; promotedToSkillDrafts: number; profileTokens: number }>;
  scorecard(orgId: string, agentId: string, opts?: { days?: number }): AgentScorecard;
  snapshotScorecards(orgId: string): Scorecard[];
  /** Weekly review: each dept lead's scorecards → proposals filed as issues for the owner. Returns created issue ids. */
  weeklyReview(orgId: string): Promise<string[]>;
  toolProvider(): BuiltinToolProvider;
}

/* ───────────────────────── Connectors ───────────────────────── */

export interface ConnectorTemplate {
  id: string;
  name: string;
  description: string;
  kind: ConnectorKind;
  category: 'toolkit' | 'automation' | 'memory' | 'dev' | 'productivity' | 'comms' | 'payments' | 'other';
  config: Record<string, unknown>;
  /** Names of secrets the user must supply (stored via SecretStore under the connector's authRef). */
  requiredSecrets: string[];
  /** Suggested per-tool policies (e.g. send → ask). */
  suggestedPolicies?: Record<string, ToolPolicy>;
  docsUrl?: string;
}

export interface InstallConnectorInput {
  name: string;
  kind: ConnectorKind;
  scope?: 'org' | 'dept';
  scopeId?: string | null;
  config: Record<string, unknown>;
  authRef?: string | null;
  toolAllowlist?: string[] | null;
  templateId?: string | null;
}

export interface GrantInput {
  toolAllowlist?: string[] | null;
  toolPolicies?: Record<string, ToolPolicy>;
  defaultPolicy?: ToolPolicy;
  authRef?: string | null;
}

export interface ConnectorGateway {
  catalog(): ConnectorTemplate[];
  install(orgId: string, input: InstallConnectorInput, actor: Actor): Promise<Connector>;
  installFromTemplate(orgId: string, templateId: string, input: { name?: string; scope?: 'org' | 'dept'; scopeId?: string | null; secrets?: Record<string, string>; config?: Record<string, unknown> }, actor: Actor): Promise<Connector>;
  update(orgId: string, connectorId: string, patch: Partial<InstallConnectorInput> & { status?: Connector['status'] }, actor: Actor): Promise<Connector>;
  remove(orgId: string, connectorId: string, actor: Actor): Promise<void>;
  get(orgId: string, connectorId: string): Connector;
  list(orgId: string): Connector[];
  /** Granting a new connector to an agent is approval-gated for non-owner actors. */
  grant(orgId: string, connectorId: string, agentId: string, input: GrantInput, actor: Actor): { grant?: ConnectorGrant; approval?: Approval };
  revokeGrant(orgId: string, connectorId: string, agentId: string, actor: Actor): void;
  listGrants(orgId: string, filter?: { agentId?: string; connectorId?: string }): ConnectorGrant[];
  /** Upstream tool list for a connector (connects if needed); pins schema hashes on first sight. */
  discoverTools(orgId: string, connectorId: string): Promise<Array<ToolDef & { quarantined: boolean }>>;
  /** Re-trust a tool whose upstream schema changed. */
  retrustTool(orgId: string, connectorId: string, toolName: string, actor: Actor): void;

  registerBuiltin(provider: BuiltinToolProvider): void;
  /**
   * Everything this caller may see, gateway-qualified (`server__tool`), after
   * scoping + policy (Off tools hidden). Connectors with ≥ 20 tools are
   * replaced by the `find_tools` / `call_tool` meta-tools.
   */
  listTools(ctx: ToolCallContext): Promise<ToolDef[]>;
  /**
   * Enforces grant → allowlist → policy (Allowed / Ask first / Off) → schema
   * pin → untrusted-content escalation, injects credentials, logs the call.
   * "Ask first" never blocks: it files an Approval and returns a result telling
   * the agent to continue; after approval the SAME call (same args) succeeds once.
   */
  callTool(ctx: ToolCallContext, qualifiedName: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Connector part of the capability snapshot. */
  snapshot(orgId: string, agentId: string): Promise<CapabilitySnapshot['connectors']>;
  /**
   * Streamable-HTTP MCP endpoint for one authenticated caller. The API layer
   * authenticates the run token, builds ctx, and delegates the raw req/res.
   */
  handleMcpRequest(ctx: ToolCallContext, req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void>;
  /** Drop per-run MCP sessions / upstream state. */
  endRun(runId: string): Promise<void>;
  close(): Promise<void>;
}

/* ───────────────────────── Browser ───────────────────────── */

export interface BrowserService {
  /** The agent's profile (own, else its department's shared one), created on demand. */
  ensureProfile(orgId: string, agentId: string): BrowserProfile;
  createProfile(orgId: string, input: { name: string; agentId?: string | null; deptId?: string | null; domainAllowlist?: string[]; sensitiveDomains?: string[] }, actor: Actor): BrowserProfile;
  updateProfile(orgId: string, profileId: string, patch: { name?: string; domainAllowlist?: string[]; sensitiveDomains?: string[] }, actor: Actor): BrowserProfile;
  listProfiles(orgId: string): BrowserProfile[];
  /** `conductor-browser` tools: navigate, snapshot, click, type, select, screenshot, extract, download, upload, tabs, evaluate, fill_secret, request_human. */
  toolProvider(): BuiltinToolProvider;

  listSessions(orgId: string, filter?: { status?: BrowserSession['status'] }): BrowserSession[];
  /** Create a takeover session + one-time signed share link (15-minute TTL, single viewer). */
  createTakeover(input: { orgId: string; agentId: string; runId: string; issueId: string | null; reason: string }): Promise<{ session: BrowserSession; shareUrl: string; token: string }>;
  /** Validate + claim a share token for one viewer. Subsequent different viewers are rejected. */
  claimShare(token: string, viewerId: string): BrowserSession;
  /** Live view for the claimed session: frames out, input events in. Returns a disposer. */
  attachViewer(sessionId: string, viewerId: string, io: {
    sendFrame: (jpegBase64: string, meta: { width: number; height: number; url: string; title: string }) => void;
    onClose: (fn: () => void) => void;
  }): Promise<{ input: (event: BrowserInputEvent) => Promise<void>; detach: () => Promise<void> }>;
  /** Human clicks "Hand back": cookies persist in the profile, agent input unlocks, run resumes. */
  handBack(sessionId: string, viewerId: string): Promise<void>;
  /** Release the run's profile lease and close its context. */
  endRun(runId: string): Promise<void>;
  /** Release leases held by runs that are no longer alive (crash recovery). */
  recoverLeases(liveRunIds: string[]): void;
  shutdown(): Promise<void>;
}

export type BrowserInputEvent =
  | { type: 'mouse'; action: 'move' | 'down' | 'up' | 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; action: 'down' | 'up' | 'press'; key: string }
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string };

/* ───────────────────────── Runtime (scheduler + runs) ───────────────────────── */

/** Lets other contexts pause/resume a live run (human takeover, approvals). */
export interface RunControl {
  /** Marks the run paused and its issue `blocked` with the reason (e.g. "needs_human"). */
  pauseRun(runId: string, reason: string): void;
  /** Marks the run running again and its issue in_progress. */
  resumeRun(runId: string): void;
  isAlive(runId: string): boolean;
}

export interface RuntimeService extends RunControl {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Enqueue an immediate run for an agent (optionally pinned to an issue). */
  runNow(orgId: string, agentId: string, opts?: { issueId?: string | null; trigger?: RunTrigger; prompt?: string }): Promise<{ jobId: string }>;
  cancelRun(orgId: string, runId: string, reason?: string): Promise<void>;
  getRun(orgId: string, runId: string): Run;
  listRuns(orgId: string, filter?: { agentId?: string; issueId?: string; status?: Run['status']; limit?: number }): Run[];
  transcript(orgId: string, runId: string, opts?: { afterSeq?: number }): Array<{ seq: number; ts: number; event: RunEvent }>;
  /** Tool-call identity for a live run (the API layer builds this from a verified run token). */
  toolContext(runId: string): ToolCallContext | null;
  /** Re-sync cron heartbeats after agent config changes. */
  syncSchedules(): void;
  status(): { running: number; queued: number; perOrg: Record<string, number>; perProvider: Record<string, number>; uptimeMs: number };
  /** One-shot chat turn with an agent outside the issue loop (messaging gateways / UI). */
  chat(orgId: string, agentId: string, message: string, opts?: { issueId?: string | null }): Promise<{ reply: string; runId: string }>;
}

/** What a run worker (child process) needs to execute one adapter run. Serializable. */
export interface WorkerJob {
  adapterId: string;
  ctx: RunContext;
  /** Bindings to try in order (primary + fallback chain), already secret-resolved. */
  chain: Array<{ adapterId: string; model: string | null; config: Record<string, unknown>; secrets: Record<string, string> }>;
}

export type { ProviderBinding };
