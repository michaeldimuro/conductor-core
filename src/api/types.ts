/**
 * Request/response DTOs of the Conductor REST + WebSocket API (v1).
 * Type-only: safe to import from the CLI and the web UI. DTOs are the row
 * types from `contracts/rows` wherever possible.
 */
import type {
  Organization, Department, Agent, Goal, Project, Issue, Comment, Playbook, Run, Approval, Skill, SkillVersion, Memory,
  Connector, ConnectorGrant, BrowserProfile, BrowserSession, Gateway, Webhook, ConfigRevision, LedgerRow, ChatMessage,
} from '../contracts/rows.js';
import type {
  CreateOrgInput, CreateDeptInput, HireAgentInput, CreateGoalInput, CreateIssueInput, IssueFilter, OrgChartNode, CapabilityRefs,
  OrgTemplate, OrgBundle, GoalNode, TimelineEntry, OrgService, WorkService, IssueArtifact,
} from '../contracts/org-work.js';
import type {
  AgentScorecard, BudgetService, BudgetStatus, ConnectorTemplate, GrantInput, InstallConnectorInput, MemoryWriteInput, MemoryService,
  Principal, RuntimeService, ScoredMemory, BrowserInputEvent, ConnectorGateway, SkillService, BrowserService,
  BrowserEngineConfig, BrowserProfileSettings, ExternalBackendConfig, ExternalBackendStatus, RunSkip, EmbedderStatus,
} from '../contracts/services.js';
import type { AdapterRegistry, Health as AdapterHealth, RunEvent } from '../contracts/adapter.js';
import type { AuditLog, AuditRecord, UtilityModelStatus } from '../contracts/kernel.js';
import type { EvalExpectations, ProviderBinding, SkillEvalCase, SkillEvalResult } from '../contracts/types.js';
import type { ToolDef, ToolResult } from '../contracts/tools.js';
import type {
  BindingAuth, CliProvider, LoginMethod, LoginMethodInfo, LoginSession, ModelCatalog, ModelOption, ProviderAuthStatus,
} from '../contracts/providers.js';
import type { DomainEvents, EventName } from '../shared/events.js';

export type { BindingAuth, CliProvider, LoginMethod, LoginMethodInfo, LoginSession, ModelCatalog, ModelOption, ProviderAuthStatus };

/** `POST /providers/:provider/login`. */
export interface StartLoginBody {
  method: LoginMethod;
  /** Pasted credential (token / API key). Sent once; never stored in logs or echoed back. */
  secret?: string;
  /** Use an already-stored credential instead of pasting one. */
  secretRef?: string;
  /** Where to keep a pasted credential (default: conventional `conductor/…` ref, or `org/<slug>/…` with orgId). */
  saveAs?: string;
  orgId?: string;
  /** Let the CLI open a browser window on the Mac itself. */
  openBrowser?: boolean;
}

export type {
  Organization, Department, Agent, Goal, Project, Issue, Comment, Playbook, Run, Approval, Skill, SkillVersion, Memory,
  Connector, ConnectorGrant, BrowserProfile, BrowserSession, Gateway, Webhook, ConfigRevision, LedgerRow, ChatMessage,
  CreateOrgInput, CreateDeptInput, HireAgentInput, CreateGoalInput, CreateIssueInput, IssueFilter, OrgChartNode, CapabilityRefs,
  OrgTemplate, OrgBundle, GoalNode, TimelineEntry, AgentScorecard, BudgetStatus, ConnectorTemplate, GrantInput, InstallConnectorInput,
  ScoredMemory, BrowserInputEvent, AuditRecord, ProviderBinding, SkillEvalResult, ToolDef, ToolResult, RunEvent, Principal, AdapterHealth,
  BrowserEngineConfig, BrowserProfileSettings, ExternalBackendConfig, ExternalBackendStatus, RunSkip,
  IssueArtifact, EmbedderStatus, UtilityModelStatus, SkillEvalCase, EvalExpectations,
};

export const API_PREFIX = '/api/v1';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  /** Offset of the next page, or null when this is the last one. */
  nextOffset: number | null;
}

export interface Ok {
  ok: true;
}

/* ── System ── */
export interface HealthResponse {
  status: 'ok';
  version: string;
  uptimeMs: number;
}
/** The interface the daemon listens on. Anything but loopback exposes the API to the network. */
export interface BindInfo {
  host: string;
  loopback: boolean;
}
export interface StatusResponse {
  version: string;
  publicUrl: string;
  bind: BindInfo;
  runtime: ReturnType<RuntimeService['status']>;
  killSwitch: { global: boolean; orgs: string[] };
  counts: { orgs: number; agents: number; pendingApprovals: number };
}
export type AdapterInfo = ReturnType<AdapterRegistry['list']>[number];
export interface BindingCheck {
  /** Where the binding comes from: `org-default` or `agent:<slug>`. */
  source: string;
  adapter: string;
  model: string | null;
  health: AdapterHealth;
}
export interface DoctorResponse {
  version: string;
  home: string;
  baseUrl: string;
  publicUrl: string;
  publicUrlConfigured: boolean;
  bind: BindInfo;
  secretStore: { reachable: boolean; detail?: string };
  adapters: AdapterInfo[];
  runtime: ReturnType<RuntimeService['status']>;
  killSwitch: { global: boolean };
  /** Present when `?orgId=` is given: connection tests for that org's bindings. */
  bindings?: BindingCheck[];
}
export interface SettingDto {
  key: string;
  value: unknown;
}
export interface KillSwitchResponse {
  engaged: boolean;
}
export interface SecretStatus {
  ref: string;
  exists: boolean;
}
export interface TestAdapterRequest {
  config?: Record<string, unknown>;
  authRef?: string | null;
  model?: string | null;
  /** Without `authRef`: try this org's conventional key ref before the install-wide one. */
  orgId?: string;
}

/* ── Auth ── */
export interface LoginCodeRequest {
  label?: string;
  ttlMs?: number;
}
export interface LoginCodeResponse {
  code: string;
  /** Open this in a browser to exchange the code for a session cookie. */
  url: string;
  /** Same exchange through the public (tunnel) URL, for pairing a remote device. */
  remoteUrl: string;
  expiresAt: number;
}
export interface MeResponse {
  principal: Principal;
}

/* ── Org ── */
export type UpdateOrgRequest = Parameters<OrgService['updateOrg']>[1];
export type UpdateDeptRequest = Parameters<OrgService['updateDept']>[2];
export type UpdateAgentRequest = Parameters<OrgService['updateAgent']>[2];
export interface FromTemplateRequest {
  templateId: string;
  name: string;
  mission?: string;
  defaultProvider?: ProviderBinding | null;
}
export interface ImportOrgRequest {
  name: string;
  bundle: OrgBundle;
}
/** Every kind of owner-editable config that is revisioned with rollback. */
export const REVISION_KINDS = [
  'org', 'dept', 'agent', 'goal', 'playbook', 'project', 'connector', 'connector_grant', 'browser_profile', 'gateway', 'webhook',
] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];
export interface RollbackRevisionRequest {
  entityKind: string;
  entityId: string;
  revision: number;
}
/** Result of rolling back by revision id: which entity changed and the number of the new (restoring) revision. */
export interface RollbackResponse {
  ok: true;
  entityKind: string;
  entityId: string;
  rolledBackTo: number;
  revision: number;
}
/** Hire / terminate: direct for the owner; `approval` when the action was queued for the board. */
export interface AgentActionResponse {
  agent?: Agent;
  approval?: Approval;
}
export interface DocResponse {
  content: string;
}
export interface RunNowRequest {
  issueId?: string | null;
  prompt?: string;
}
export interface RunNowResponse {
  /** Empty when nothing was queued (see `skipped`). */
  jobId: string;
  /** Why no run starts right now; a `temporary` cause leaves the wake queued. */
  skipped?: RunSkip;
}
export interface ChatRequest {
  message: string;
  issueId?: string | null;
}
export interface ChatResponse {
  reply: string;
  runId: string;
  /** The stored agent message (UI chats, which keep history). */
  messageId?: string;
}
/** `GET /orgs/:orgId/agents/:agentId/chat`: the conversation, oldest first. */
export interface ChatHistoryResponse {
  messages: ChatMessage[];
}

/* ── Work ── */
export type UpdateGoalRequest = Parameters<WorkService['updateGoal']>[2];
export type CreateProjectRequest = Parameters<WorkService['createProject']>[1];
export type UpdateProjectRequest = Parameters<NonNullable<WorkService['updateProject']>>[2];
export type UpdatePlaybookRequest = Parameters<NonNullable<WorkService['updatePlaybook']>>[2];
export type UpdateIssueRequest = Parameters<WorkService['updateIssue']>[2];
export type CreatePlaybookRequest = Parameters<WorkService['createPlaybook']>[1];
export interface ListIssuesQuery extends Omit<IssueFilter, 'parentIssueId'> {
  /** `null` selects top-level issues only. */
  parentIssueId?: string | null;
}
export interface AddCommentRequest {
  body: string;
  parentCommentId?: string | null;
  attachments?: Comment['attachments'];
}
/**
 * `POST /orgs/:orgId/uploads`: a file uploaded for a comment that is not
 * written yet. Pass `{ name, path, mime }` as one of the comment's
 * `attachments`; the comment keeps its own copy and the upload is discarded.
 */
export interface StagedUploadDto {
  id: string;
  name: string;
  path: string;
  bytes: number;
  mime: string;
}
/** A file attached to the issue itself (`GET|POST /orgs/:orgId/issues/:issueId/files`). */
export interface IssueFileDto {
  name: string;
  /** Path relative to the org's artifacts folder. */
  path: string;
  bytes: number;
  modifiedAt: number;
  contentType: string;
  downloadPath: string;
  /** Served for display in the dashboard (sandboxed). */
  viewPath: string;
}
/** A file in the issue's artifact folder, with where to download it from (server-relative; needs the session cookie or a bearer token). */
export type IssueArtifactDto = IssueArtifact & { contentType: string; downloadPath: string };
/** `GET /orgs/:orgId/artifacts`: one file of the org-wide artifact store. */
export interface ArtifactDto {
  name: string;
  /** Path relative to the org's artifacts folder: the artifact's stable id. */
  path: string;
  bytes: number;
  modifiedAt: number;
  contentType: string;
  /** `task`: produced on an issue; `chat`: in a direct chat with an agent; `run`: any other run. */
  source: 'task' | 'chat' | 'run';
  issue: { id: string; number: number; title: string } | null;
  runId: string | null;
  commentId: string | null;
  agentId: string | null;
  trigger: string | null;
  /** Who put it there: an agent, a human (comment upload) or the system. */
  author: 'agent' | 'human' | 'system' | null;
  /** Server-relative; a download. */
  downloadPath: string;
  /** Server-relative; served for viewing inside the dashboard (sandboxed). */
  viewPath: string;
}
export interface ListArtifactsQuery {
  issueId?: string;
  runId?: string;
  agentId?: string;
  source?: ArtifactDto['source'];
  q?: string;
  limit?: number;
}
export interface ReviewRequest {
  outcome: 'accepted' | 'edited' | 'rejected';
  note?: string;
}

/* ── Runs / approvals / budgets ── */
export type ListRunsQuery = NonNullable<Parameters<RuntimeService['listRuns']>[1]>;
export type TranscriptEntry = ReturnType<RuntimeService['transcript']>[number];
export interface ListApprovalsQuery {
  status?: Approval['status'];
  kind?: string;
  /** Only approvals raised while working on this issue. */
  issueId?: string;
  /** Only these approval ids; sent comma-separated (at most 100). */
  ids?: string[];
  limit?: number;
}
export interface DecideRequest {
  decision: 'approved' | 'denied';
  note?: string;
}
export type BudgetSummary = ReturnType<BudgetService['summary']>;
export type ActivityQuery = Omit<Parameters<AuditLog['query']>[0], 'orgId'>;

/* ── Skills ── */
export type ListSkillsQuery = Omit<Parameters<SkillService['list']>[0], 'orgId'>;
export type UpsertSkillRequest = Parameters<SkillService['upsert']>[1];
export type ImportSkillRequest = Parameters<SkillService['importSkill']>[1];
export type SkillDetail = ReturnType<SkillService['read']>;
export interface SkillDiffResponse {
  diff: string;
}
export interface AddEvalCaseRequest {
  prompt: string;
  /** Natural-language success criteria. */
  criteria?: string;
  expect?: EvalExpectations;
  /** Issue this case replays (id or per-org number). */
  issueId?: string | null;
}
export interface PromoteSkillResponse {
  skill?: Skill;
  approval?: Approval;
}

/* ── Memory ── */
export type MemorySearchQuery = Parameters<MemoryService['search']>[1];
export type ListMemoryQuery = NonNullable<Parameters<MemoryService['list']>[1]>;
export type WriteMemoryRequest = Omit<MemoryWriteInput, 'sourceRunId' | 'author'>;
export type UpdateMemoryRequest = Parameters<MemoryService['update']>[2];
export type SessionHit = ReturnType<MemoryService['searchSessions']>[number];
export interface MemoryBackendResponse {
  /** Null when the org uses local memory only. Never contains the key, only its secret ref. */
  backend: ExternalBackendStatus | null;
}

/* ── Connectors / browser ── */
export type UpdateConnectorRequest = Parameters<ConnectorGateway['update']>[2];
export type InstallFromTemplateRequest = { templateId: string } & Parameters<ConnectorGateway['installFromTemplate']>[2];
export type DiscoveredTool = ToolDef & { quarantined: boolean };
export interface GrantResponse {
  grant?: ConnectorGrant;
  approval?: Approval;
}
export type BrowserSessionDto = Omit<BrowserSession, 'tokenHash' | 'viewerId'>;
/** The profile row plus the settings that have no column (engine, headed mode, 1Password vaults). */
export type BrowserProfileDto = Omit<BrowserProfile, 'engine' | 'headed'> & BrowserProfileSettings;
/** A freshly minted single-use takeover link. Shown once; only its hash is stored. */
export interface TakeoverLinkResponse {
  sessionId: string;
  /** Absolute link on the public (tunnel) URL, for another device. */
  url: string;
  /** The same link as a path on whatever origin the caller is using. */
  path: string;
  expiresAt: number;
}
export type CreateProfileRequest = Parameters<BrowserService['createProfile']>[1];
export type UpdateProfileRequest = Parameters<BrowserService['updateProfile']>[2];

/* ── Gateways / webhooks ── */
export interface GatewayStatusDto {
  id: string;
  kind: string;
  status: string;
  lastError: string | null;
}
export interface PairingCodeResponse {
  code: string;
}
/**
 * A gateway as the API returns it. The pending pairing code's hash never
 * leaves the daemon: `config` carries no `pairingCodeHash` / `pairingExpiresAt`
 * / `pairingAttempts` keys; `pairingPending` and `pairingExpiresAt` say
 * whether a code is waiting to be redeemed and until when.
 */
export type GatewayDto = Gateway & {
  pairingPending: boolean;
  /** Expiry (epoch ms) of the pending pairing code; null when none is pending. */
  pairingExpiresAt: number | null;
};
export interface CreateGatewayRequest {
  orgId?: string | null;
  kind: Gateway['kind'];
  name: string;
  config?: Record<string, unknown>;
  authRef?: string | null;
  status?: 'active' | 'disabled';
}
export type UpdateGatewayRequest = Partial<Omit<CreateGatewayRequest, 'kind'>>;
export type WebhookSource = 'github' | 'stripe' | 'composio' | 'generic';
export interface CreateWebhookRequest {
  direction: 'in' | 'out';
  name: string;
  source?: WebhookSource;
  agentId?: string | null;
  url?: string | null;
  events?: string[];
  secretRef?: string | null;
  status?: 'active' | 'disabled';
}
export type UpdateWebhookRequest = Partial<Omit<CreateWebhookRequest, 'direction'>>;
/** The row plus, for inbound hooks, the URL the external service must POST to. */
export type WebhookDto = Webhook & { inboundUrl: string | null };
/** JSON body POSTed to outbound webhook destinations. */
export interface WebhookDelivery {
  id: string;
  event: string;
  orgId: string;
  ts: number;
  data: Record<string, unknown>;
}

/* ── Agent-facing API (run tokens) ── */
export interface AgentMeResponse {
  orgId: string;
  runId: string;
  agent: Agent;
  issue: Issue | null;
}
export interface CallToolRequest {
  arguments?: Record<string, unknown>;
}

/* ── Takeover ── */
export interface ClaimResponse {
  sessionId: string;
  reason: string;
  /** When the takeover session ends on its own (epoch ms). */
  expiresAt: number;
}
export type TakeoverServerMessage =
  | { type: 'frame'; data: string; meta: { width: number; height: number; url: string; title: string } }
  | { type: 'error'; message: string };

/* ── WebSocket `/api/v1/ws` ── */
export type WsClientMessage =
  | { type: 'subscribe'; orgId?: string; runId?: string }
  | { type: 'unsubscribe'; orgId?: string; runId?: string }
  | { type: 'ping' };
export type WsEventMessage = { [K in EventName]: { type: 'event'; name: K; payload: DomainEvents[K] } }[EventName];
export type WsServerMessage =
  | WsEventMessage
  | { type: 'subscribed'; orgId: string | null; runId: string | null }
  | { type: 'unsubscribed'; orgId: string | null; runId: string | null }
  | { type: 'pong' }
  | { type: 'error'; message: string };
