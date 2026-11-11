import { z } from 'zod';
import { DEFAULT_GATED_ACTIONS } from '../../contracts/types.js';
import { ISSUE_STATUSES } from '../../db/schema/work.js';
import { RUN_STATUSES } from '../../db/schema/runs.js';
import { boolQ, csvQ, idStr, intQ, jsonRecord, nameStr, providerBinding, refList, text, usd } from './common.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'slug must be lowercase letters, digits and dashes');

const policies = z.strictObject({
  approvalOverrides: z.partialRecord(z.enum(DEFAULT_GATED_ACTIONS), z.boolean()).optional(),
  extraGated: z.array(z.string().min(1).max(100)).max(100).optional(),
  approvalSpendThresholdUsd: z.number().finite().nonnegative().optional(),
  deptSkillPromotion: z.enum(['lead', 'auto']).optional(),
  ownerApprovesOrgSkillPromotion: z.boolean().optional(),
  networkAllowlist: z.array(z.string().min(1).max(300)).max(500).optional(),
  toolkitDefault: z.enum(['composio', 'arcade']).optional(),
});

/* ── Orgs ── */
export const createOrg = z.strictObject({
  name: nameStr,
  slug: slug.optional(),
  mission: text(4000).optional(),
  budgetMonthlyUsd: usd.optional(),
  seatSecondsMonthly: z.number().int().nonnegative().nullable().optional(),
  defaultProvider: providerBinding.nullable().optional(),
  utilityModel: providerBinding.nullable().optional(),
  policies: policies.optional(),
});
export const updateOrg = createOrg.partial().extend({
  maxConcurrentRuns: z.number().int().min(1).max(64).optional(),
  defaultSkills: refList.optional(),
  defaultConnectors: refList.optional(),
});
export const listOrgsQ = z.object({ includeArchived: boolQ.optional() });
export const fromTemplate = z.strictObject({
  templateId: idStr,
  name: nameStr,
  mission: text(4000).optional(),
  defaultProvider: providerBinding.nullable().optional(),
});
const rec = z.array(jsonRecord).max(10_000);
export const importOrg = z.strictObject({
  name: nameStr,
  bundle: z.looseObject({
    format: z.literal('conductor-org-bundle'),
    version: z.literal(1),
    exportedAt: z.number(),
    org: jsonRecord,
    departments: rec,
    agents: rec,
    goals: rec,
    playbooks: rec,
    connectors: rec,
    skills: z.array(z.strictObject({ scope: z.string(), scopeSlug: z.string().nullable(), name: z.string(), files: z.record(z.string(), z.string()) })).max(5000),
    memories: rec,
  }),
});
export const revisionsQ = z.object({ entityKind: idStr, entityId: idStr });
export const rollbackRevision = z.strictObject({ entityKind: idStr, entityId: idStr, revision: z.number().int().min(1) });

/* ── Departments ── */
export const createDept = z.strictObject({
  name: nameStr,
  slug: slug.optional(),
  charter: text(8000).optional(),
  budgetUsd: usd.optional(),
  sharedSkills: refList.optional(),
  sharedConnectors: refList.optional(),
});
export const updateDept = createDept.partial().extend({ leadAgentId: idStr.nullable().optional() });

/* ── Agents ── */
export const hireAgent = z.strictObject({
  deptId: idStr,
  name: nameStr,
  slug: slug.optional(),
  role: z.string().trim().min(1).max(300),
  goal: text(4000).optional(),
  backstory: text(8000).optional(),
  reportsTo: idStr.nullable().optional(),
  providerBinding: providerBinding.nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  skills: refList.optional(),
  connectors: refList.optional(),
  heartbeatCron: z.string().trim().min(1).max(120).nullable().optional(),
  budgetUsd: usd.optional(),
  autonomyLevel: z.number().int().min(0).max(3).optional(),
  isLead: z.boolean().optional(),
});
export const updateAgent = hireAgent.partial().extend({
  denySkills: refList.optional(),
  denyConnectors: refList.optional(),
  maxSteps: z.number().int().min(1).max(10_000).optional(),
  maxWallMs: z.number().int().min(1000).max(24 * 3_600_000).optional(),
  maxRunsPerHour: z.number().int().min(1).max(3600).optional(),
  browserProfileId: idStr.nullable().optional(),
});
export const listAgentsQ = z.object({ deptId: idStr.optional(), status: z.enum(['active', 'paused', 'terminated']).optional() });
export const pauseAgent = z.strictObject({ reason: z.string().trim().min(1).max(500).optional() });
export const scorecardQ = z.object({ days: intQ(1, 365).optional() });
export const docBody = z.strictObject({ content: text(200_000) });
export const runNow = z.strictObject({ issueId: idStr.nullable().optional(), prompt: text(50_000).optional() });
export const chat = z.strictObject({ message: z.string().min(1).max(50_000), issueId: idStr.nullable().optional() });
export const budgetStatusQ = z.object({ projectId: idStr.optional() });

/* ── Goals / projects ── */
export const createGoal = z.strictObject({
  title: z.string().trim().min(1).max(300),
  description: text(20_000).optional(),
  parentGoalId: idStr.nullable().optional(),
  level: z.enum(['org', 'dept', 'agent']).optional(),
  deptId: idStr.nullable().optional(),
  ownerAgentId: idStr.nullable().optional(),
  successMetric: text(2000).optional(),
  target: text(2000).optional(),
  weight: z.number().finite().min(0).max(1000).optional(),
  due: z.number().int().nonnegative().nullable().optional(),
});
const goalStatus = z.enum(['proposed', 'active', 'achieved', 'abandoned']);
export const updateGoal = createGoal.partial().extend({ status: goalStatus.optional() });
export const listGoalsQ = z.object({ ownerAgentId: idStr.optional(), deptId: idStr.optional(), status: goalStatus.optional() });
export const createProject = z.strictObject({
  name: nameStr,
  goalId: idStr.nullable().optional(),
  workspacePath: z.string().min(1).max(2000).nullable().optional(),
  budgetUsd: usd.optional(),
});

/* ── Issues ── */
const issueStatus = z.enum(ISSUE_STATUSES);
export const createIssue = z.strictObject({
  title: z.string().trim().min(1).max(500),
  body: text(200_000).optional(),
  expectedOutput: text(20_000).optional(),
  taskType: z.string().trim().min(1).max(100).nullable().optional(),
  goalId: idStr.nullable().optional(),
  projectId: idStr.nullable().optional(),
  assigneeAgentId: idStr.nullable().optional(),
  reviewerAgentId: idStr.nullable().optional(),
  status: issueStatus.optional(),
  priority: z.number().int().min(0).max(3).optional(),
  parentIssueId: idStr.nullable().optional(),
  blockedBy: z.array(idStr).max(200).optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  playbookId: idStr.nullable().optional(),
});
export const updateIssue = createIssue.partial().extend({ blockedReason: text(2000).nullable().optional() });
export const MAX_PAGE = 500;
export const listIssuesQ = z.object({
  status: csvQ(ISSUE_STATUSES).optional(),
  assigneeAgentId: idStr.optional(),
  goalId: idStr.optional(),
  projectId: idStr.optional(),
  /** `null` (literal) selects top-level issues. */
  parentIssueId: idStr.optional(),
  label: z.string().min(1).max(100).optional(),
  search: z.string().min(1).max(500).optional(),
  limit: intQ(1, MAX_PAGE).optional(),
  offset: intQ(0, 10_000_000).optional(),
});
export const assignIssue = z.strictObject({ agentId: idStr.nullable() });
export const delegateIssue = z.strictObject({ children: z.array(createIssue).min(1).max(50) });
export const escalateIssue = z.strictObject({ reason: z.string().trim().min(1).max(4000) });
export const reviewIssue = z.strictObject({ outcome: z.enum(['accepted', 'edited', 'rejected']), note: text(20_000).optional() });
export const addComment = z.strictObject({
  body: z.string().min(1).max(200_000),
  parentCommentId: idStr.nullable().optional(),
  attachments: z.array(z.strictObject({ name: nameStr, path: z.string().min(1).max(2000), mime: z.string().max(200).optional() })).max(50).optional(),
});
export const listCommentsQ = z.object({ since: intQ(0, Number.MAX_SAFE_INTEGER).optional() });

/* ── Playbooks ── */
export const createPlaybook = z.strictObject({
  name: nameStr,
  description: text(8000).optional(),
  process: z.enum(['sequential', 'hierarchical']).optional(),
  managerAgentId: idStr.nullable().optional(),
  steps: z
    .array(z.strictObject({
      title: z.string().trim().min(1).max(500),
      description: text(20_000),
      expectedOutput: text(20_000),
      agentRole: z.string().max(300).optional(),
      agentId: idStr.optional(),
    }))
    .min(1)
    .max(100),
});
export const runPlaybook = z.strictObject({ issueId: idStr });

/* ── Runs / approvals / budgets / activity ── */
export const listRunsQ = z.object({
  agentId: idStr.optional(),
  issueId: idStr.optional(),
  status: z.enum(RUN_STATUSES).optional(),
  limit: intQ(1, 1000).optional(),
});
export const transcriptQ = z.object({ afterSeq: intQ(0, Number.MAX_SAFE_INTEGER).optional() });
export const cancelRun = z.strictObject({ reason: z.string().trim().min(1).max(500).optional() });
export const listApprovalsQ = z.object({
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']).optional(),
  kind: z.string().min(1).max(100).optional(),
  limit: intQ(1, 1000).optional(),
});
export const decideApproval = z.strictObject({ decision: z.enum(['approved', 'denied']), note: text(4000).optional() });
export const budgetSummaryQ = z.object({ since: intQ(0, Number.MAX_SAFE_INTEGER).optional(), until: intQ(0, Number.MAX_SAFE_INTEGER).optional() });
export const ledgerQ = z.object({ agentId: idStr.optional(), limit: intQ(1, 5000).optional() });
export const activityQ = z.object({
  issueId: idStr.optional(),
  runId: idStr.optional(),
  entityKind: idStr.optional(),
  entityId: idStr.optional(),
  action: z.string().min(1).max(200).optional(),
  since: intQ(0, Number.MAX_SAFE_INTEGER).optional(),
  limit: intQ(1, 1000).optional(),
});
