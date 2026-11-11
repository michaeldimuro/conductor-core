/**
 * Typed, dependency-free HTTP client for the Conductor API (global `fetch`).
 * One method per endpoint; used by the CLI, and usable from the web UI
 * (leave `token` unset there: the session cookie authenticates).
 */
import type * as t from './types.js';

export interface ClientOptions {
  /** e.g. http://127.0.0.1:7420 */
  baseUrl: string;
  /** Owner, device or run token, sent as `Authorization: Bearer`. */
  token?: string | null;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export class ConductorApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ConductorApiError';
  }
}

type Query = Record<string, unknown> | undefined;
const V1 = '/api/v1';
const e = encodeURIComponent;

function qs(query: Query): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    const value = Array.isArray(v) ? v.join(',') : v === null ? 'null' : String(v);
    parts.push(`${e(k)}=${e(value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export class ConductorClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.headers = opts.headers ?? {};
  }

  /** Low-level call; `path` is relative to the server root. */
  async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...this.headers };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}${qs(opts.query)}`, { method, headers, body });
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const err = (json as Partial<t.ApiErrorBody> | undefined)?.error;
      throw new ConductorApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`, err?.details);
    }
    return json as T;
  }

  private get = <T>(path: string, query?: Query) => this.request<T>('GET', V1 + path, { query });
  private post = <T>(path: string, body?: unknown) => this.request<T>('POST', V1 + path, { body });
  private put = <T>(path: string, body?: unknown) => this.request<T>('PUT', V1 + path, { body });
  private patch = <T>(path: string, body?: unknown) => this.request<T>('PATCH', V1 + path, { body });
  private del = <T>(path: string) => this.request<T>('DELETE', V1 + path);

  /* ── System ── */
  health = () => this.request<t.HealthResponse>('GET', '/healthz');
  status = () => this.get<t.StatusResponse>('/status');
  doctor = (query?: { orgId?: string }) => this.get<t.DoctorResponse>('/doctor', query);
  listSettings = () => this.get<t.SettingDto[]>('/settings');
  getSetting = (key: string) => this.get<t.SettingDto>(`/settings/${e(key)}`);
  putSetting = (key: string, value: unknown) => this.put<t.SettingDto>(`/settings/${e(key)}`, { value });
  engageKillSwitch = () => this.post<t.KillSwitchResponse>('/kill-switch');
  releaseKillSwitch = () => this.del<t.KillSwitchResponse>('/kill-switch');
  private secretPath = (ref: string) => `/secrets/${ref.split('/').map(e).join('/')}`;
  secretExists = (ref: string) => this.get<t.SecretStatus>(this.secretPath(ref));
  putSecret = (ref: string, value: string) => this.put<t.SecretStatus>(this.secretPath(ref), { value });
  deleteSecret = (ref: string) => this.del<t.SecretStatus>(this.secretPath(ref));
  listAdapters = () => this.get<t.AdapterInfo[]>('/adapters');
  rescanAdapters = () => this.post<{ loaded: string[]; added: string[]; removed: string[]; skipped: Array<{ folder: string; error: string }> }>('/adapters/rescan', {});
  testAdapter = (adapterId: string, input: t.TestAdapterRequest = {}) => this.post<t.AdapterHealth>(`/adapters/${e(adapterId)}/test`, input);

  /* ── Auth ── */
  createLoginCode = (input: t.LoginCodeRequest = {}) => this.post<t.LoginCodeResponse>('/auth/login-codes', input);
  createSession = (token: string) => this.post<t.MeResponse>('/auth/session', { token });
  deleteSession = () => this.del<t.Ok>('/auth/session');
  me = () => this.get<t.MeResponse>('/auth/me');

  /* ── Organizations ── */
  listOrgs = (query?: { includeArchived?: boolean }) => this.get<t.Organization[]>('/orgs', query);
  createOrg = (input: t.CreateOrgInput) => this.post<t.Organization>('/orgs', input);
  getOrg = (org: string) => this.get<t.Organization>(`/orgs/${e(org)}`);
  updateOrg = (org: string, patch: t.UpdateOrgRequest) => this.patch<t.Organization>(`/orgs/${e(org)}`, patch);
  archiveOrg = (org: string) => this.post<t.Organization>(`/orgs/${e(org)}/archive`);
  unarchiveOrg = (org: string) => this.post<t.Organization>(`/orgs/${e(org)}/unarchive`);
  listOrgTemplates = () => this.get<t.OrgTemplate[]>('/org-templates');
  createOrgFromTemplate = (input: t.FromTemplateRequest) => this.post<t.Organization>('/orgs/from-template', input);
  exportOrg = (org: string) => this.get<t.OrgBundle>(`/orgs/${e(org)}/export`);
  importOrg = (input: t.ImportOrgRequest) => this.post<t.Organization>('/orgs/import', input);
  engageOrgKillSwitch = (org: string) => this.post<t.KillSwitchResponse>(`/orgs/${e(org)}/kill-switch`);
  releaseOrgKillSwitch = (org: string) => this.del<t.KillSwitchResponse>(`/orgs/${e(org)}/kill-switch`);
  /** Revision history of any revisioned kind (`t.REVISION_KINDS`) inside an org, newest first. */
  listRevisions = (org: string, query: { entityKind: string; entityId: string }) => this.get<t.ConfigRevision[]>(`/orgs/${e(org)}/revisions`, query);
  rollbackRevision = (org: string, input: t.RollbackRevisionRequest) => this.post<t.Ok>(`/orgs/${e(org)}/revisions/rollback`, input);
  /** A gateway's history by gateway id (gateways may serve every org). */
  listGatewayRevisions = (gatewayId: string) => this.get<t.ConfigRevision[]>(`/gateways/${e(gatewayId)}/revisions`);
  getRevision = (revisionId: string) => this.get<t.ConfigRevision>(`/revisions/${e(revisionId)}`);
  /** Roll the entity back to this revision, whatever its kind. */
  rollbackToRevision = (revisionId: string) => this.post<t.RollbackResponse>(`/revisions/${e(revisionId)}/rollback`);
  orgChart = (org: string) => this.get<t.OrgChartNode[]>(`/orgs/${e(org)}/chart`);

  /* ── Departments ── */
  listDepartments = (org: string) => this.get<t.Department[]>(`/orgs/${e(org)}/departments`);
  createDepartment = (org: string, input: t.CreateDeptInput) => this.post<t.Department>(`/orgs/${e(org)}/departments`, input);
  getDepartment = (org: string, deptId: string) => this.get<t.Department>(`/orgs/${e(org)}/departments/${e(deptId)}`);
  updateDepartment = (org: string, deptId: string, patch: t.UpdateDeptRequest) => this.patch<t.Department>(`/orgs/${e(org)}/departments/${e(deptId)}`, patch);
  archiveDepartment = (org: string, deptId: string) => this.post<t.Department>(`/orgs/${e(org)}/departments/${e(deptId)}/archive`);
  unarchiveDepartment = (org: string, deptId: string) => this.post<t.Department>(`/orgs/${e(org)}/departments/${e(deptId)}/unarchive`);

  /* ── Agents ── */
  private agent = (org: string, agent: string) => `/orgs/${e(org)}/agents/${e(agent)}`;
  listAgents = (org: string, query?: { deptId?: string; status?: t.Agent['status'] }) => this.get<t.Agent[]>(`/orgs/${e(org)}/agents`, query);
  hireAgent = (org: string, input: t.HireAgentInput) => this.post<t.AgentActionResponse>(`/orgs/${e(org)}/agents`, input);
  getAgent = (org: string, agent: string) => this.get<t.Agent>(this.agent(org, agent));
  updateAgent = (org: string, agent: string, patch: t.UpdateAgentRequest) => this.patch<t.Agent>(this.agent(org, agent), patch);
  pauseAgent = (org: string, agent: string, reason?: string) => this.post<t.Agent>(`${this.agent(org, agent)}/pause`, reason ? { reason } : {});
  resumeAgent = (org: string, agent: string) => this.post<t.Agent>(`${this.agent(org, agent)}/resume`);
  terminateAgent = (org: string, agent: string) => this.post<t.AgentActionResponse>(`${this.agent(org, agent)}/terminate`);
  agentCapabilities = (org: string, agent: string) => this.get<t.CapabilityRefs>(`${this.agent(org, agent)}/capabilities`);
  agentScorecard = (org: string, agent: string, query?: { days?: number }) => this.get<t.AgentScorecard>(`${this.agent(org, agent)}/scorecard`, query);
  agentBudget = (org: string, agent: string, query?: { projectId?: string }) => this.get<t.BudgetStatus>(`${this.agent(org, agent)}/budget`, query);
  getAgentMemoryDoc = (org: string, agent: string) => this.get<t.DocResponse>(`${this.agent(org, agent)}/memory-doc`);
  putAgentMemoryDoc = (org: string, agent: string, content: string) => this.put<t.DocResponse>(`${this.agent(org, agent)}/memory-doc`, { content });
  runAgent = (org: string, agent: string, input: t.RunNowRequest = {}) => this.post<t.RunNowResponse>(`${this.agent(org, agent)}/run`, input);
  chatWithAgent = (org: string, agent: string, input: t.ChatRequest) => this.post<t.ChatResponse>(`${this.agent(org, agent)}/chat`, input);

  /* ── Goals / projects ── */
  listGoals = (org: string, query?: { ownerAgentId?: string; deptId?: string; status?: t.Goal['status'] }) => this.get<t.Goal[]>(`/orgs/${e(org)}/goals`, query);
  createGoal = (org: string, input: t.CreateGoalInput) => this.post<t.Goal>(`/orgs/${e(org)}/goals`, input);
  goalTree = (org: string) => this.get<t.GoalNode[]>(`/orgs/${e(org)}/goals/tree`);
  getGoal = (org: string, goalId: string) => this.get<t.Goal>(`/orgs/${e(org)}/goals/${e(goalId)}`);
  updateGoal = (org: string, goalId: string, patch: t.UpdateGoalRequest) => this.patch<t.Goal>(`/orgs/${e(org)}/goals/${e(goalId)}`, patch);
  deleteGoal = (org: string, goalId: string) => this.del<t.Ok>(`/orgs/${e(org)}/goals/${e(goalId)}`);
  listProjects = (org: string) => this.get<t.Project[]>(`/orgs/${e(org)}/projects`);
  createProject = (org: string, input: t.CreateProjectRequest) => this.post<t.Project>(`/orgs/${e(org)}/projects`, input);
  getProject = (org: string, projectId: string) => this.get<t.Project>(`/orgs/${e(org)}/projects/${e(projectId)}`);
  updateProject = (org: string, projectId: string, patch: t.UpdateProjectRequest) => this.patch<t.Project>(`/orgs/${e(org)}/projects/${e(projectId)}`, patch);

  /* ── Issues (id or per-org number) ── */
  private issue = (org: string, issue: string | number) => `/orgs/${e(org)}/issues/${e(String(issue))}`;
  listIssues = (org: string, query?: t.ListIssuesQuery) => this.get<t.Page<t.Issue>>(`/orgs/${e(org)}/issues`, query as Query);
  createIssue = (org: string, input: t.CreateIssueInput) => this.post<t.Issue>(`/orgs/${e(org)}/issues`, input);
  getIssue = (org: string, issue: string | number) => this.get<t.Issue>(this.issue(org, issue));
  updateIssue = (org: string, issue: string | number, patch: t.UpdateIssueRequest) => this.patch<t.Issue>(this.issue(org, issue), patch);
  assignIssue = (org: string, issue: string | number, agentId: string | null) => this.post<t.Issue>(`${this.issue(org, issue)}/assign`, { agentId });
  delegateIssue = (org: string, issue: string | number, children: t.CreateIssueInput[]) => this.post<t.Issue[]>(`${this.issue(org, issue)}/delegate`, { children });
  escalateIssue = (org: string, issue: string | number, reason: string) => this.post<t.Issue>(`${this.issue(org, issue)}/escalate`, { reason });
  reviewIssue = (org: string, issue: string | number, input: t.ReviewRequest) => this.post<t.Issue>(`${this.issue(org, issue)}/review`, input);
  listComments = (org: string, issue: string | number, query?: { since?: number }) => this.get<t.Comment[]>(`${this.issue(org, issue)}/comments`, query);
  addComment = (org: string, issue: string | number, input: t.AddCommentRequest) => this.post<t.Comment>(`${this.issue(org, issue)}/comments`, input);
  issueTimeline = (org: string, issue: string | number) => this.get<t.TimelineEntry[]>(`${this.issue(org, issue)}/timeline`);
  /** Comment attachments and run artifacts (browser screenshots, downloads) stored for an issue, newest first. */
  listIssueArtifacts = (org: string, issue: string | number) => this.get<t.IssueArtifactDto[]>(`${this.issue(org, issue)}/artifacts`);
  /** Server-relative download URL of one artifact (`path` as returned by `listIssueArtifacts`). */
  artifactPath = (org: string, issue: string | number, path: string) => `${V1}${this.issue(org, issue)}/artifacts/${path.split('/').map(e).join('/')}`;
  /** Server-relative URL of a comment attachment (a download; needs the session cookie or a bearer token). */
  attachmentPath = (org: string, issue: string | number, commentId: string, index: number) => `${V1}${this.issue(org, issue)}/comments/${e(commentId)}/attachments/${index}`;

  /* ── Playbooks ── */
  listPlaybooks = (org: string) => this.get<t.Playbook[]>(`/orgs/${e(org)}/playbooks`);
  createPlaybook = (org: string, input: t.CreatePlaybookRequest) => this.post<t.Playbook>(`/orgs/${e(org)}/playbooks`, input);
  getPlaybook = (org: string, playbookId: string) => this.get<t.Playbook>(`/orgs/${e(org)}/playbooks/${e(playbookId)}`);
  updatePlaybook = (org: string, playbookId: string, patch: t.UpdatePlaybookRequest) => this.patch<t.Playbook>(`/orgs/${e(org)}/playbooks/${e(playbookId)}`, patch);
  deletePlaybook = (org: string, playbookId: string) => this.del<t.Ok>(`/orgs/${e(org)}/playbooks/${e(playbookId)}`);
  runPlaybook = (org: string, playbookId: string, issueId: string) => this.post<t.Issue[]>(`/orgs/${e(org)}/playbooks/${e(playbookId)}/run`, { issueId });

  /* ── Runs ── */
  listRuns = (org: string, query?: t.ListRunsQuery) => this.get<t.Run[]>(`/orgs/${e(org)}/runs`, query);
  getRun = (org: string, runId: string) => this.get<t.Run>(`/orgs/${e(org)}/runs/${e(runId)}`);
  runTranscript = (org: string, runId: string, query?: { afterSeq?: number }) => this.get<t.TranscriptEntry[]>(`/orgs/${e(org)}/runs/${e(runId)}/transcript`, query);
  cancelRun = (org: string, runId: string, reason?: string) => this.post<t.Ok>(`/orgs/${e(org)}/runs/${e(runId)}/cancel`, reason ? { reason } : {});

  /* ── Approvals / budgets / activity ── */
  approvalInbox = (query?: t.ListApprovalsQuery) => this.get<t.Approval[]>('/approvals', query as Query);
  listApprovals = (org: string, query?: t.ListApprovalsQuery) => this.get<t.Approval[]>(`/orgs/${e(org)}/approvals`, query as Query);
  getApproval = (org: string, approvalId: string) => this.get<t.Approval>(`/orgs/${e(org)}/approvals/${e(approvalId)}`);
  decideApproval = (org: string, approvalId: string, input: t.DecideRequest) => this.post<t.Approval>(`/orgs/${e(org)}/approvals/${e(approvalId)}/decide`, input);
  budgetSummary = (org: string, query?: { since?: number; until?: number }) => this.get<t.BudgetSummary>(`/orgs/${e(org)}/budget/summary`, query);
  budgetLedger = (org: string, query?: { agentId?: string; limit?: number }) => this.get<t.LedgerRow[]>(`/orgs/${e(org)}/budget/ledger`, query);
  activity = (org: string, query?: t.ActivityQuery) => this.get<t.AuditRecord[]>(`/orgs/${e(org)}/activity`, query);

  /* ── Skills ── */
  private skill = (org: string, skillId: string) => `/orgs/${e(org)}/skills/${e(skillId)}`;
  listSkills = (org: string, query?: t.ListSkillsQuery) => this.get<t.Skill[]>(`/orgs/${e(org)}/skills`, query);
  upsertSkill = (org: string, input: t.UpsertSkillRequest) => this.post<t.Skill>(`/orgs/${e(org)}/skills`, input);
  importSkill = (org: string, input: t.ImportSkillRequest) => this.post<t.Skill>(`/orgs/${e(org)}/skills/import`, input);
  readSkill = (org: string, skillId: string) => this.get<t.SkillDetail>(this.skill(org, skillId));
  skillHistory = (org: string, skillId: string) => this.get<t.SkillVersion[]>(`${this.skill(org, skillId)}/history`);
  skillDiff = (org: string, skillId: string, query?: { from?: number; to?: number }) => this.get<t.SkillDiffResponse>(`${this.skill(org, skillId)}/diff`, query);
  rollbackSkill = (org: string, skillId: string, toVersion: number) => this.post<t.Skill>(`${this.skill(org, skillId)}/rollback`, { toVersion });
  evaluateSkill = (org: string, skillId: string) => this.post<t.SkillEvalResult>(`${this.skill(org, skillId)}/evaluate`);
  activateSkill = (org: string, skillId: string, opts: { force?: boolean } = {}) => this.post<t.Skill>(`${this.skill(org, skillId)}/activate`, opts);
  promoteSkill = (org: string, skillId: string, toScope: t.Skill['scope']) => this.post<t.PromoteSkillResponse>(`${this.skill(org, skillId)}/promote`, { toScope });
  listSkillEvalCases = (org: string, skillId: string) => this.get<t.SkillEvalCase[]>(`${this.skill(org, skillId)}/eval-cases`);
  addSkillEvalCase = (org: string, skillId: string, input: t.AddEvalCaseRequest) => this.post<t.SkillEvalCase>(`${this.skill(org, skillId)}/eval-cases`, input);
  removeSkillEvalCase = (org: string, skillId: string, caseId: string) => this.del<t.Ok>(`${this.skill(org, skillId)}/eval-cases/${e(caseId)}`);
  setSkillStatus = (org: string, skillId: string, status: t.Skill['status']) => this.put<t.Skill>(`${this.skill(org, skillId)}/status`, { status });

  /* ── Memory ── */
  searchMemory = (org: string, query: t.MemorySearchQuery) => this.get<t.ScoredMemory[]>(`/orgs/${e(org)}/memory/search`, query as unknown as Query);
  listMemory = (org: string, query?: t.ListMemoryQuery) => this.get<t.Memory[]>(`/orgs/${e(org)}/memory`, query);
  getMemory = (org: string, memoryId: string) => this.get<t.Memory>(`/orgs/${e(org)}/memory/${e(memoryId)}`);
  writeMemory = (org: string, input: t.WriteMemoryRequest) => this.post<t.Memory>(`/orgs/${e(org)}/memory`, input);
  updateMemory = (org: string, memoryId: string, patch: t.UpdateMemoryRequest) => this.patch<t.Memory>(`/orgs/${e(org)}/memory/${e(memoryId)}`, patch);
  forgetMemory = (org: string, memoryId: string) => this.del<t.Ok>(`/orgs/${e(org)}/memory/${e(memoryId)}`);
  getOwnerModel = (org: string) => this.get<t.DocResponse>(`/orgs/${e(org)}/owner-model`);
  putOwnerModel = (org: string, content: string) => this.put<t.DocResponse>(`/orgs/${e(org)}/owner-model`, { content });
  getMemoryBackend = (org: string) => this.get<t.MemoryBackendResponse>(`/orgs/${e(org)}/memory-backend`);
  putMemoryBackend = (org: string, config: t.ExternalBackendConfig) => this.put<t.MemoryBackendResponse>(`/orgs/${e(org)}/memory-backend`, config);
  clearMemoryBackend = (org: string) => this.del<t.MemoryBackendResponse>(`/orgs/${e(org)}/memory-backend`);
  /** Which embedder backs semantic memory search right now (install-wide). */
  embedderStatus = () => this.get<t.EmbedderStatus>('/memory/embedder');
  /** Which backend answers utility-model calls for the org, and why. */
  utilityModelStatus = (org: string) => this.get<t.UtilityModelStatus>(`/orgs/${e(org)}/utility-model`);
  searchSessions = (org: string, query: { text: string; agentId?: string; limit?: number }) => this.get<t.SessionHit[]>(`/orgs/${e(org)}/sessions/search`, query);

  /* ── Connectors ── */
  private connector = (org: string, connectorId: string) => `/orgs/${e(org)}/connectors/${e(connectorId)}`;
  connectorCatalog = () => this.get<t.ConnectorTemplate[]>('/connector-catalog');
  listConnectors = (org: string) => this.get<t.Connector[]>(`/orgs/${e(org)}/connectors`);
  installConnector = (org: string, input: t.InstallConnectorInput) => this.post<t.Connector>(`/orgs/${e(org)}/connectors`, input);
  installConnectorFromTemplate = (org: string, input: t.InstallFromTemplateRequest) => this.post<t.Connector>(`/orgs/${e(org)}/connectors/from-template`, input);
  getConnector = (org: string, connectorId: string) => this.get<t.Connector>(this.connector(org, connectorId));
  updateConnector = (org: string, connectorId: string, patch: t.UpdateConnectorRequest) => this.patch<t.Connector>(this.connector(org, connectorId), patch);
  removeConnector = (org: string, connectorId: string) => this.del<t.Ok>(this.connector(org, connectorId));
  connectorTools = (org: string, connectorId: string) => this.get<t.DiscoveredTool[]>(`${this.connector(org, connectorId)}/tools`);
  retrustTool = (org: string, connectorId: string, toolName: string) => this.post<t.Ok>(`${this.connector(org, connectorId)}/tools/${e(toolName)}/retrust`);
  listGrants = (org: string, query?: { agentId?: string; connectorId?: string }) => this.get<t.ConnectorGrant[]>(`/orgs/${e(org)}/connector-grants`, query);
  grantConnector = (org: string, connectorId: string, agent: string, input: t.GrantInput = {}) => this.put<t.GrantResponse>(`${this.connector(org, connectorId)}/grants/${e(agent)}`, input);
  revokeGrant = (org: string, connectorId: string, agent: string) => this.del<t.Ok>(`${this.connector(org, connectorId)}/grants/${e(agent)}`);

  /* ── Browser ── */
  listBrowserProfiles = (org: string) => this.get<t.BrowserProfileDto[]>(`/orgs/${e(org)}/browser/profiles`);
  createBrowserProfile = (org: string, input: t.CreateProfileRequest) => this.post<t.BrowserProfileDto>(`/orgs/${e(org)}/browser/profiles`, input);
  updateBrowserProfile = (org: string, profileId: string, patch: t.UpdateProfileRequest) => this.patch<t.BrowserProfileDto>(`/orgs/${e(org)}/browser/profiles/${e(profileId)}`, patch);
  /** Owner only: a fresh single-use takeover link for a waiting session (the previous link stops working). */
  takeoverLink = (org: string, sessionId: string) => this.post<t.TakeoverLinkResponse>(`/orgs/${e(org)}/browser/sessions/${e(sessionId)}/share-link`);
  listBrowserSessions = (org: string, query?: { status?: t.BrowserSession['status'] }) => this.get<t.BrowserSessionDto[]>(`/orgs/${e(org)}/browser/sessions`, query);

  /* ── Gateways / webhooks ── */
  listGateways = (query?: { orgId?: string }) => this.get<t.GatewayDto[]>('/gateways', query);
  createGateway = (input: t.CreateGatewayRequest) => this.post<t.GatewayDto>('/gateways', input);
  getGateway = (gatewayId: string) => this.get<t.GatewayDto>(`/gateways/${e(gatewayId)}`);
  updateGateway = (gatewayId: string, patch: t.UpdateGatewayRequest) => this.patch<t.GatewayDto>(`/gateways/${e(gatewayId)}`, patch);
  deleteGateway = (gatewayId: string) => this.del<t.Ok>(`/gateways/${e(gatewayId)}`);
  gatewayPairingCode = (gatewayId: string) => this.post<t.PairingCodeResponse>(`/gateways/${e(gatewayId)}/pairing-code`, {});
  gatewayStatus = () => this.get<t.GatewayStatusDto[]>('/gateways-status');
  listWebhooks = (org: string, query?: { direction?: 'in' | 'out' }) => this.get<t.WebhookDto[]>(`/orgs/${e(org)}/webhooks`, query);
  createWebhook = (org: string, input: t.CreateWebhookRequest) => this.post<t.WebhookDto>(`/orgs/${e(org)}/webhooks`, input);
  getWebhook = (org: string, webhookId: string) => this.get<t.WebhookDto>(`/orgs/${e(org)}/webhooks/${e(webhookId)}`);
  updateWebhook = (org: string, webhookId: string, patch: t.UpdateWebhookRequest) => this.patch<t.WebhookDto>(`/orgs/${e(org)}/webhooks/${e(webhookId)}`, patch);
  deleteWebhook = (org: string, webhookId: string) => this.del<t.Ok>(`/orgs/${e(org)}/webhooks/${e(webhookId)}`);

  /* ── Agent-facing API (run token) ── */
  agentMe = () => this.get<t.AgentMeResponse>('/agent/me');
  agentTools = () => this.get<t.ToolDef[]>('/agent/tools');
  callAgentTool = (name: string, args: Record<string, unknown> = {}) => this.post<t.ToolResult>(`/agent/tools/${e(name)}`, { arguments: args });

  /* ── Takeover (cookie-based; for browser use) ── */
  claimTakeover = (token: string) => this.post<t.ClaimResponse>('/takeover/claim', { token });
  handBackTakeover = (sessionId: string) => this.post<t.Ok>(`/takeover/${e(sessionId)}/hand-back`);
}
