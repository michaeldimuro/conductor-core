import type { Actor, ProviderBinding, OrgPolicies } from './types.js';
import type {
  Organization, Department, Agent, Goal, Project, Issue, Comment, Playbook, ConfigRevision, Approval,
} from './rows.js';
import type { IssueStatus } from '../db/schema/work.js';
import type { AuditRecord } from './kernel.js';

/* ───────────────────────── Org context ───────────────────────── */

export interface CreateOrgInput {
  name: string;
  slug?: string;
  mission?: string;
  budgetMonthlyUsd?: number | null;
  seatSecondsMonthly?: number | null;
  defaultProvider?: ProviderBinding | null;
  utilityModel?: ProviderBinding | null;
  policies?: OrgPolicies;
}

export interface CreateDeptInput {
  name: string;
  slug?: string;
  charter?: string;
  budgetUsd?: number | null;
  sharedSkills?: string[];
  sharedConnectors?: string[];
}

export interface HireAgentInput {
  deptId: string;
  name: string;
  slug?: string;
  role: string;
  goal?: string;
  backstory?: string;
  reportsTo?: string | null;
  providerBinding?: ProviderBinding | null;
  model?: string | null;
  skills?: string[];
  connectors?: string[];
  heartbeatCron?: string | null;
  budgetUsd?: number | null;
  autonomyLevel?: number;
  /** Make this agent the department lead. */
  isLead?: boolean;
}

export interface OrgChartNode {
  agent: Agent;
  department: Department;
  isLead: boolean;
  reports: OrgChartNode[];
}

/** Names/ids only; the skills and connector contexts turn these into concrete resolved sets. */
export interface CapabilityRefs {
  /** org defaults ∪ department shared ∪ agent own, minus deny list. */
  skillNames: string[];
  connectorIds: string[];
  denySkills: string[];
  denyConnectors: string[];
}

export interface OrgTemplate {
  id: string;
  name: string;
  description: string;
  departments: Array<{
    name: string;
    charter: string;
    agents: Array<Omit<HireAgentInput, 'deptId' | 'reportsTo'> & { reportsToRole?: string }>;
  }>;
  goals?: Array<{ title: string; successMetric?: string }>;
}

/** Portable org bundle (org chart, agent configs, skills, sanitized memory; never secrets). */
export interface OrgBundle {
  format: 'conductor-org-bundle';
  version: 1;
  exportedAt: number;
  org: Record<string, unknown>;
  departments: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  goals: Array<Record<string, unknown>>;
  playbooks: Array<Record<string, unknown>>;
  connectors: Array<Record<string, unknown>>;
  /** Skill folders as { scope, scopeSlug, name, files: { relativePath: utf8 content } }. */
  skills: Array<{
    scope: string; scopeSlug: string | null; name: string; files: Record<string, string>;
    /** Status in the source org; `active` skills stay active on import, everything else is a draft. */
    status?: string;
    /** 'human' or 'agent' (never an id). */
    author?: string;
  }>;
  memories: Array<Record<string, unknown>>;
  /** Projects (name, goal, budget; workspace only when it lived inside the org directory, as a relative path). */
  projects?: Array<Record<string, unknown>>;
  /**
   * Connector grants: { connectorId, agentId, toolAllowlist, policies: [{tool, policy}], defaultPolicy, needsCredential }.
   * Credentials are never exported: `needsCredential: true` marks where one must be re-supplied after import.
   */
  grants?: Array<Record<string, unknown>>;
  /** Each agent's MEMORY.md (standing rules), sanitized: { agentId, content }. */
  profileDocs?: Array<Record<string, unknown>>;
  /** The org's owner model (USER.md), sanitized. */
  ownerModel?: string;
}

/** A lead's (or the owner's) request to change an agent's or department's monthly budget. */
export interface BudgetChangeInput {
  scope: 'agent' | 'dept';
  /** Agent id or department id. */
  id: string;
  /** New monthly cap in USD; null removes the cap. */
  budgetUsd: number | null;
  reason?: string;
}

/** A lead's (or the owner's) request to give a skill to an agent, a department (shared skills) or the whole org (default skills). */
export interface SkillGrantInput {
  scope: 'agent' | 'dept' | 'org';
  /** Agent id or department id; not used for the org scope. */
  id?: string;
  /** Skill name, as agents reference it. */
  skill: string;
  reason?: string;
}

export interface OrgService {
  createOrg(input: CreateOrgInput, actor: Actor): Organization;
  updateOrg(orgId: string, patch: Partial<CreateOrgInput> & { maxConcurrentRuns?: number; defaultSkills?: string[]; defaultConnectors?: string[] }, actor: Actor): Organization;
  /** Archive (never delete). Emits `org.archived` so the runtime cancels the org's in-flight runs. */
  archiveOrg(orgId: string, actor: Actor): Organization;
  /** Bring an archived org back. Emits `org.unarchived`. */
  unarchiveOrg?(orgId: string, actor: Actor): Organization;
  getOrg(orgId: string): Organization;
  getOrgBySlug(slug: string): Organization | null;
  listOrgs(opts?: { includeArchived?: boolean }): Organization[];

  createDept(orgId: string, input: CreateDeptInput, actor: Actor): Department;
  updateDept(orgId: string, deptId: string, patch: Partial<CreateDeptInput> & { leadAgentId?: string | null }, actor: Actor): Department;
  /** Archive a department (board only). Refused while it still has non-terminated agents. */
  archiveDept?(orgId: string, deptId: string, actor: Actor): Department;
  unarchiveDept?(orgId: string, deptId: string, actor: Actor): Department;
  getDept(orgId: string, deptId: string): Department;
  listDepts(orgId: string): Department[];

  /**
   * Hire an agent. Human actors hire directly. Agent actors (autonomy 3 only)
   * create a `hire_agent` Approval instead and get `{ approval }` back; the
   * hire executes when the board approves.
   */
  hireAgent(orgId: string, input: HireAgentInput, actor: Actor): { agent?: Agent; approval?: Approval };
  updateAgent(orgId: string, agentId: string, patch: Partial<HireAgentInput> & { denySkills?: string[]; denyConnectors?: string[]; maxSteps?: number; maxWallMs?: number; maxRunsPerHour?: number; browserProfileId?: string | null }, actor: Actor): Agent;
  pauseAgent(orgId: string, agentId: string, reason: string, actor: Actor): Agent;
  resumeAgent(orgId: string, agentId: string, actor: Actor): Agent;
  /** Approval-gated for agent actors, direct for the owner. `opts.reason` is shown on the approval. */
  terminateAgent(orgId: string, agentId: string, actor: Actor, opts?: { reason?: string }): { agent?: Agent; approval?: Approval };
  /**
   * Change an agent's or department's budget. Direct for the owner. Agent
   * actors must be Leads (autonomy 3) acting inside their reporting line and
   * get a `budget_raise` Approval back; the change executes when the board approves.
   */
  proposeBudgetChange?(orgId: string, input: BudgetChangeInput, actor: Actor): { agent?: Agent; department?: Department; approval?: Approval };
  /**
   * Grant a skill to an agent, a department's shared skills or the org's
   * default skills. Direct for the owner. Agent actors must be Leads
   * (autonomy 3) acting inside their reporting line; while the org's
   * `grant_skill` gate is on they get a `grant_skill` Approval back and the
   * grant executes when the board approves.
   */
  proposeSkillGrant?(orgId: string, input: SkillGrantInput, actor: Actor): { agent?: Agent; department?: Department; organization?: Organization; approval?: Approval };
  getAgent(orgId: string, agentId: string): Agent;
  /** Lookup by id or slug within an org; null if absent. */
  findAgent(orgId: string, idOrSlug: string): Agent | null;
  listAgents(orgId: string, filter?: { deptId?: string; status?: Agent['status'] }): Agent[];

  orgChart(orgId: string): OrgChartNode[];
  managerOf(orgId: string, agentId: string): Agent | null;
  reportsOf(orgId: string, agentId: string, opts?: { transitive?: boolean }): Agent[];
  leadOf(orgId: string, deptId: string): Agent | null;
  /**
   * Reporting-line rule: an agent may assign only to itself, its reports
   * (transitive), or a peer through its lead (same manager, and the caller
   * is that lead or the assignment is routed to the lead).
   */
  canAssign(orgId: string, fromAgentId: string, toAgentId: string): boolean;

  resolveCapabilityRefs(orgId: string, agentId: string): CapabilityRefs;

  listTemplates(): OrgTemplate[];
  createFromTemplate(templateId: string, input: { name: string; mission?: string; defaultProvider?: ProviderBinding | null }, actor: Actor): Organization;
  exportOrg(orgId: string): OrgBundle;
  importOrg(bundle: OrgBundle, input: { name: string }, actor: Actor): Organization;

  /**
   * Revision history of owner-editable config. Kinds: org, dept, agent, goal,
   * playbook, project. Rolling back a deleted goal/playbook restores it.
   */
  listRevisions(orgId: string, entityKind: string, entityId: string): ConfigRevision[];
  rollback(orgId: string, entityKind: string, entityId: string, revision: number, actor: Actor): void;
}

/* ───────────────────────── Work context ───────────────────────── */

export interface CreateGoalInput {
  title: string;
  description?: string;
  parentGoalId?: string | null;
  level?: 'org' | 'dept' | 'agent';
  deptId?: string | null;
  ownerAgentId?: string | null;
  successMetric?: string;
  target?: string;
  weight?: number;
  due?: number | null;
}

export interface GoalNode {
  goal: Goal;
  children: GoalNode[];
  issueCounts: { open: number; done: number };
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  expectedOutput?: string;
  taskType?: string | null;
  goalId?: string | null;
  projectId?: string | null;
  assigneeAgentId?: string | null;
  reviewerAgentId?: string | null;
  status?: IssueStatus;
  priority?: number;
  parentIssueId?: string | null;
  blockedBy?: string[];
  labels?: string[];
  playbookId?: string | null;
}

export interface IssueFilter {
  status?: IssueStatus | IssueStatus[];
  assigneeAgentId?: string;
  goalId?: string;
  projectId?: string;
  parentIssueId?: string | null;
  label?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface Inbox {
  /** Assigned, workable issues ordered by priority then goal weight. Excludes locked/blocked-by-open. */
  issues: Issue[];
  /** Comments on the agent's issues created since its inbox cursor (not authored by it). */
  newComments: Comment[];
  /** Comments mentioning the agent since its cursor. */
  mentions: Comment[];
  /** in_review issues waiting for this agent's verdict as their named reviewer (oldest first). Standing work, not cursor-based. */
  reviews: Issue[];
}

export type TimelineEntry =
  | { kind: 'comment'; ts: number; comment: Comment }
  | { kind: 'activity'; ts: number; activity: AuditRecord };

/** One file under `orgs/<org>/artifacts/<issue>/`. */
export interface IssueArtifact {
  /** File name. */
  name: string;
  /** Path relative to the issue's artifact folder, `/`-separated (e.g. `run_01…/screenshot.png`). */
  path: string;
  /** Absolute path on this machine. */
  file: string;
  bytes: number;
  modifiedAt: number;
  /** `run`: saved by a run's tools; `comment`: copied in as a comment attachment. */
  origin: 'run' | 'comment' | 'other';
  /** The run id or comment id the file belongs to, when the folder name says so. */
  originId: string | null;
}

/** A file attached to an issue itself (not to one of its comments). */
export interface IssueFile {
  name: string;
  /** Absolute path on this machine (what agents read, and what an attachment `path` may name). */
  file: string;
  /** Path relative to the org's artifacts folder, `/`-separated (`<issue>/files/<name>`). */
  path: string;
  bytes: number;
  modifiedAt: number;
}

/**
 * One file anywhere under `orgs/<org>/artifacts/`: what the org-wide artifact
 * store lists. The folder layout says where it came from —
 * `<issue>/<comment>/…` (comment attachment), `<issue>/<run>/…` (a run working
 * the issue), `<run>/…` (a run without an issue, e.g. an agent chat turn).
 */
export interface OrgArtifact {
  name: string;
  /** Path relative to the org's artifacts folder, `/`-separated. Stable id of the artifact. */
  path: string;
  /** Absolute path on this machine. */
  file: string;
  bytes: number;
  modifiedAt: number;
  issueId: string | null;
  runId: string | null;
  commentId: string | null;
}

export interface ArtifactFilter {
  issueId?: string;
  runId?: string;
  /** Case-insensitive substring of the file name. */
  search?: string;
  limit?: number;
}

export interface WorkService {
  createGoal(orgId: string, input: CreateGoalInput, actor: Actor): Goal;
  updateGoal(orgId: string, goalId: string, patch: Partial<CreateGoalInput> & { status?: Goal['status'] }, actor: Actor): Goal;
  getGoal(orgId: string, goalId: string): Goal;
  listGoals(orgId: string, filter?: { ownerAgentId?: string; deptId?: string; status?: Goal['status'] }): Goal[];
  /**
   * Delete a goal (owner, or an agent entitled to set it). Child goals,
   * projects and issues move to its parent goal; issues of a root goal move to
   * the org's default goal, so every issue still traces to a goal.
   */
  deleteGoal?(orgId: string, goalId: string, actor: Actor): void;
  goalTree(orgId: string): GoalNode[];

  createProject(orgId: string, input: { name: string; goalId?: string | null; workspacePath?: string | null; budgetUsd?: number | null }, actor: Actor): Project;
  updateProject?(orgId: string, projectId: string, patch: { name?: string; goalId?: string | null; workspacePath?: string | null; budgetUsd?: number | null; status?: Project['status'] }, actor: Actor): Project;
  getProject(orgId: string, projectId: string): Project;
  listProjects(orgId: string): Project[];

  /**
   * Create an issue. For agent actors the reporting-line rule applies to
   * `assigneeAgentId` and autonomy 0 agents may not create issues.
   * Every issue traces to a goal: when goalId is absent it is inherited from
   * the parent issue, else the project's goal, else the assignee's/creator's
   * goal, else the org's default goal (created on first use). Never null.
   * Autonomy 1 agents may only create sub-issues of their own work.
   */
  createIssue(orgId: string, input: CreateIssueInput, actor: Actor): Issue;
  updateIssue(orgId: string, issueId: string, patch: Partial<CreateIssueInput> & { blockedReason?: string | null }, actor: Actor): Issue;
  getIssue(orgId: string, issueId: string): Issue;
  /** By id, or by per-org number. */
  findIssue(orgId: string, idOrNumber: string | number): Issue | null;
  listIssues(orgId: string, filter?: IssueFilter): Issue[];
  assign(orgId: string, issueId: string, agentId: string | null, actor: Actor): Issue;
  /** Split into child issues and delegate down the reporting line. */
  delegate(orgId: string, parentIssueId: string, children: CreateIssueInput[], actor: Actor): Issue[];
  /** Escalate to the assignee's manager (or the owner at the root) with a reason. */
  escalate(orgId: string, issueId: string, reason: string, actor: Actor): Issue;
  /** Reviewer verdict on an in_review issue: accepted → done; edited → done (+flag); rejected → todo (+rework). */
  review(orgId: string, issueId: string, outcome: 'accepted' | 'edited' | 'rejected', note: string | undefined, actor: Actor): Issue;
  /** Hand the issue to the agent who owns its next step; it reopens for them and they are woken on it. */
  handOff(orgId: string, issueId: string, toAgentId: string, note: string, actor: Actor): Issue;

  /**
   * Atomic checkout: `UPDATE … SET checkout_lock = runId WHERE checkout_lock IS NULL`.
   * Returns true only for the single winner; moves the issue to in_progress.
   */
  checkout(orgId: string, issueId: string, runId: string): boolean;
  /** Release the lock held by runId; optionally set a new status (+blockedReason). */
  release(orgId: string, issueId: string, runId: string, to?: { status?: IssueStatus; blockedReason?: string | null }): void;
  /** Release every lock held by a run (crash recovery). Returns affected issue ids. */
  releaseAllForRun(orgId: string, runId: string, toStatus?: IssueStatus): string[];

  inbox(orgId: string, agentId: string): Inbox;
  markInboxSeen(orgId: string, agentId: string, at?: number): void;

  /**
   * Attachments whose `path` is an existing file are copied into the org's
   * `artifacts/<issue>/<comment>/` directory and the stored path points there.
   */
  addComment(orgId: string, issueId: string, input: { body: string; parentCommentId?: string | null; attachments?: Comment['attachments']; runId?: string }, actor: Actor): Comment;
  listComments(orgId: string, issueId: string, opts?: { since?: number }): Comment[];
  timeline(orgId: string, issueId: string): TimelineEntry[];
  /**
   * Files in the org's `artifacts/<issue>/` folder: comment attachments and
   * what runs saved while working the issue (browser screenshots, downloads).
   * Newest first. An issue of another org behaves as not found.
   */
  listIssueArtifacts?(orgId: string, issueId: string): IssueArtifact[];
  /** Every file in the org's artifacts folder (tasks, chats, other runs), newest first. */
  listArtifacts?(orgId: string, filter?: ArtifactFilter): OrgArtifact[];
  /** Files attached to the issue itself (`artifacts/<issue>/files/`), in the order they were added. */
  listIssueFiles?(orgId: string, issueId: string): IssueFile[];
  /** Attach a file to the issue itself. A name clash gets a `-2`, `-3`… suffix; nothing is overwritten. */
  addIssueFile?(orgId: string, issueId: string, input: { name: string; data: Buffer }, actor: Actor): IssueFile;
  /** Detach (delete) one of the issue's own files by name. */
  removeIssueFile?(orgId: string, issueId: string, name: string, actor: Actor): IssueFile;

  createPlaybook(orgId: string, input: { name: string; description?: string; process?: 'sequential' | 'hierarchical'; managerAgentId?: string | null; steps: Playbook['steps'] }, actor: Actor): Playbook;
  listPlaybooks(orgId: string): Playbook[];
  updatePlaybook?(orgId: string, playbookId: string, patch: { name?: string; description?: string; process?: 'sequential' | 'hierarchical'; managerAgentId?: string | null; steps?: Playbook['steps'] }, actor: Actor): Playbook;
  deletePlaybook?(orgId: string, playbookId: string, actor: Actor): void;
  /**
   * Run a playbook inside an issue: create one child issue per step.
   * sequential → each step blockedBy the previous; hierarchical → all steps
   * assigned by/reviewed by the manager agent.
   */
  runPlaybook(orgId: string, playbookId: string, issueId: string, actor: Actor): Issue[];
}
