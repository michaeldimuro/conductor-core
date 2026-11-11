/**
 * Request/response DTOs of the Conductor REST + WebSocket API (v1).
 * Type-only: safe to import from the CLI and the web UI. DTOs are the row
 * types from `contracts/rows` wherever possible.
 */
import type {
  Organization, Department, Agent, Goal, Project, Issue, Comment, Playbook, Run, Approval, Skill, SkillVersion, Memory,
  Connector, ConnectorGrant, BrowserProfile, BrowserSession, Gateway, Webhook, ConfigRevision, LedgerRow,
} from '../contracts/rows.js';
import type {
  CreateOrgInput, CreateDeptInput, HireAgentInput, CreateGoalInput, CreateIssueInput, IssueFilter, OrgChartNode, CapabilityRefs,
  OrgTemplate, OrgBundle, GoalNode, TimelineEntry, OrgService, WorkService,
} from '../contracts/org-work.js';
import type {
  AgentScorecard, BudgetService, BudgetStatus, ConnectorTemplate, GrantInput, InstallConnectorInput, MemoryWriteInput, MemoryService,
  Principal, RuntimeService, ScoredMemory, BrowserInputEvent, ConnectorGateway, SkillService, BrowserService,
} from '../contracts/services.js';
import type { AdapterRegistry, Health as AdapterHealth, RunEvent } from '../contracts/adapter.js';
import type { AuditLog, AuditRecord } from '../contracts/kernel.js';
import type { ProviderBinding, SkillEvalResult } from '../contracts/types.js';
import type { ToolDef, ToolResult } from '../contracts/tools.js';
import type { DomainEvents, EventName } from '../shared/events.js';

export type {
  Organization, Department, Agent, Goal, Project, Issue, Comment, Playbook, Run, Approval, Skill, SkillVersion, Memory,
  Connector, ConnectorGrant, BrowserProfile, BrowserSession, Gateway, Webhook, ConfigRevision, LedgerRow,
  CreateOrgInput, CreateDeptInput, HireAgentInput, CreateGoalInput, CreateIssueInput, IssueFilter, OrgChartNode, CapabilityRefs,
  OrgTemplate, OrgBundle, GoalNode, TimelineEntry, AgentScorecard, BudgetStatus, ConnectorTemplate, GrantInput, InstallConnectorInput,
  ScoredMemory, BrowserInputEvent, AuditRecord, ProviderBinding, SkillEvalResult, ToolDef, ToolResult, RunEvent, Principal, AdapterHealth,
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
export interface StatusResponse {
  version: string;
  publicUrl: string;
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
export interface RollbackRevisionRequest {
  entityKind: string;
  entityId: string;
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
  jobId: string;
}
export interface ChatRequest {
  message: string;
  issueId?: string | null;
}
export interface ChatResponse {
  reply: string;
  runId: string;
}

/* ── Work ── */
export type UpdateGoalRequest = Parameters<WorkService['updateGoal']>[2];
export type CreateProjectRequest = Parameters<WorkService['createProject']>[1];
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

/* ── Connectors / browser ── */
export type UpdateConnectorRequest = Parameters<ConnectorGateway['update']>[2];
export type InstallFromTemplateRequest = { templateId: string } & Parameters<ConnectorGateway['installFromTemplate']>[2];
export type DiscoveredTool = ToolDef & { quarantined: boolean };
export interface GrantResponse {
  grant?: ConnectorGrant;
  approval?: Approval;
}
export type BrowserSessionDto = Omit<BrowserSession, 'tokenHash' | 'viewerId'>;
export type CreateProfileRequest = Parameters<BrowserService['createProfile']>[1];
export type UpdateProfileRequest = Parameters<BrowserService['updateProfile']>[2];

/* ── Gateways / webhooks ── */
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
