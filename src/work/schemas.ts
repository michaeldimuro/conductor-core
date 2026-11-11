import { z } from 'zod';
import { ISSUE_STATUSES } from '../db/schema/work.js';

/** Boundary validation for everything the Work context accepts. */

const id = z.string().min(1).max(200);
const noNul = (s: string): boolean => !s.includes('\0');

export const goalInput = z.strictObject({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(20_000).optional(),
  parentGoalId: id.nullish(),
  level: z.enum(['org', 'dept', 'agent']).optional(),
  deptId: id.nullish(),
  ownerAgentId: id.nullish(),
  successMetric: z.string().max(2000).optional(),
  target: z.string().max(2000).optional(),
  weight: z.number().finite().min(0).max(1000).optional(),
  due: z.number().int().nonnegative().nullish(),
});

export const goalPatch = goalInput.partial().extend({
  status: z.enum(['proposed', 'active', 'achieved', 'abandoned']).optional(),
});

export const goalFilter = z
  .strictObject({
    ownerAgentId: id.optional(),
    deptId: id.optional(),
    status: z.enum(['proposed', 'active', 'achieved', 'abandoned']).optional(),
  })
  .default({});

export const projectInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  goalId: id.nullish(),
  workspacePath: z.string().min(1).max(4096).refine(noNul, 'must not contain NUL').nullish(),
  budgetUsd: z.number().finite().nonnegative().nullish(),
});

export const issueInput = z.strictObject({
  title: z.string().trim().min(1).max(500),
  body: z.string().max(200_000).optional(),
  expectedOutput: z.string().max(20_000).optional(),
  taskType: z.string().trim().min(1).max(200).nullish(),
  goalId: id.nullish(),
  projectId: id.nullish(),
  assigneeAgentId: id.nullish(),
  reviewerAgentId: id.nullish(),
  status: z.enum(ISSUE_STATUSES).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  parentIssueId: id.nullish(),
  blockedBy: z.array(id).max(200).optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  playbookId: id.nullish(),
});

export const issuePatch = issueInput.partial().extend({
  blockedReason: z.string().max(2000).nullish(),
});

const statusEnum = z.enum(ISSUE_STATUSES);

export const issueFilter = z
  .strictObject({
    status: z.union([statusEnum, z.array(statusEnum).min(1)]).optional(),
    assigneeAgentId: id.optional(),
    goalId: id.optional(),
    projectId: id.optional(),
    parentIssueId: id.nullish(),
    label: z.string().min(1).max(100).optional(),
    search: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .default({});

export const attachment = z.strictObject({
  name: z.string().trim().min(1).max(255),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(noNul, 'must not contain NUL')
    .refine((p) => !p.split(/[\\/]/).includes('..'), 'must not contain ".." segments'),
  mime: z.string().max(200).optional(),
});

export const commentInput = z.strictObject({
  body: z.string().max(200_000).refine((b) => b.trim().length > 0, 'body must not be empty'),
  parentCommentId: id.nullish(),
  attachments: z.array(attachment).max(50).optional(),
  runId: id.optional(),
});

export const playbookStep = z.strictObject({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(20_000).default(''),
  expectedOutput: z.string().max(20_000).default(''),
  agentRole: z.string().trim().min(1).max(200).optional(),
  agentId: id.optional(),
});

export const playbookInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  process: z.enum(['sequential', 'hierarchical']).optional(),
  managerAgentId: id.nullish(),
  steps: z.array(playbookStep).min(1).max(50),
});

export const reviewOutcome = z.enum(['accepted', 'edited', 'rejected']);
export const reasonText = z.string().trim().min(1).max(5000);
export const runIdText = id;
