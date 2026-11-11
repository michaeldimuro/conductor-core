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
  skills: Array<{ scope: string; scopeSlug: string | null; name: string; files: Record<string, string> }>;
  memories: Array<Record<string, unknown>>;
}

export interface OrgService {
  createOrg(input: CreateOrgInput, actor: Actor): Organization;
  updateOrg(orgId: string, patch: Partial<CreateOrgInput> & { maxConcurrentRuns?: number; defaultSkills?: string[]; defaultConnectors?: string[] }, actor: Actor): Organization;
  archiveOrg(orgId: string, actor: Actor): Organization;
  getOrg(orgId: string): Organization;
  getOrgBySlug(slug: string): Organization | null;
  listOrgs(opts?: { includeArchived?: boolean }): Organization[];

  createDept(orgId: string, input: CreateDeptInput, actor: Actor): Department;
  updateDept(orgId: string, deptId: string, patch: Partial<CreateDeptInput> & { leadAgentId?: string | null }, actor: Actor): Department;
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
  /** Approval-gated for agent actors, direct for the owner. */
  terminateAgent(orgId: string, agentId: string, actor: Actor): { agent?: Agent; approval?: Approval };
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
}

export type TimelineEntry =
  | { kind: 'comment'; ts: number; comment: Comment }
  | { kind: 'activity'; ts: number; activity: AuditRecord };

export interface WorkService {
  createGoal(orgId: string, input: CreateGoalInput, actor: Actor): Goal;
  updateGoal(orgId: string, goalId: string, patch: Partial<CreateGoalInput> & { status?: Goal['status'] }, actor: Actor): Goal;
  getGoal(orgId: string, goalId: string): Goal;
  listGoals(orgId: string, filter?: { ownerAgentId?: string; deptId?: string; status?: Goal['status'] }): Goal[];
  goalTree(orgId: string): GoalNode[];

  createProject(orgId: string, input: { name: string; goalId?: string | null; workspacePath?: string | null; budgetUsd?: number | null }, actor: Actor): Project;
  getProject(orgId: string, projectId: string): Project;
  listProjects(orgId: string): Project[];

  /**
   * Create an issue. For agent actors the reporting-line rule applies to
   * `assigneeAgentId` and autonomy 0 agents may not create issues.
   * Every issue should trace to a goal: when goalId is absent it is
   * inherited from the parent issue, else from the assignee's/creator's goal.
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

  addComment(orgId: string, issueId: string, input: { body: string; parentCommentId?: string | null; attachments?: Comment['attachments']; runId?: string }, actor: Actor): Comment;
  listComments(orgId: string, issueId: string, opts?: { since?: number }): Comment[];
  timeline(orgId: string, issueId: string): TimelineEntry[];

  createPlaybook(orgId: string, input: { name: string; description?: string; process?: 'sequential' | 'hierarchical'; managerAgentId?: string | null; steps: Playbook['steps'] }, actor: Actor): Playbook;
  listPlaybooks(orgId: string): Playbook[];
  /**
   * Run a playbook inside an issue: create one child issue per step.
   * sequential → each step blockedBy the previous; hierarchical → all steps
   * assigned by/reviewed by the manager agent.
   */
  runPlaybook(orgId: string, playbookId: string, issueId: string, actor: Actor): Issue[];
}
