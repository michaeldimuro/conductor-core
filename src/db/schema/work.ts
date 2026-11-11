import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { organizations } from './org.js';

export const goals = sqliteTable(
  'goals',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id),
    parentGoalId: text('parent_goal_id'),
    /** org | dept | agent — the level of the tree this goal sits at. */
    level: text('level', { enum: ['org', 'dept', 'agent'] }).notNull().default('org'),
    deptId: text('dept_id'),
    ownerAgentId: text('owner_agent_id'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    successMetric: text('success_metric').notNull().default(''),
    target: text('target').notNull().default(''),
    /** Relative weight used to order agent inboxes. */
    weight: real('weight').notNull().default(1),
    due: integer('due'),
    status: text('status', { enum: ['proposed', 'active', 'achieved', 'abandoned'] }).notNull().default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('goal_org_idx').on(t.orgId), index('goal_parent_idx').on(t.parentGoalId)],
);

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id),
    goalId: text('goal_id'),
    name: text('name').notNull(),
    workspacePath: text('workspace_path'),
    budgetUsd: real('budget_usd'),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('project_org_idx').on(t.orgId)],
);

export const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const issues = sqliteTable(
  'issues',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id),
    /** Human-friendly per-org sequence number (ACME-12). */
    number: integer('number').notNull(),
    goalId: text('goal_id'),
    projectId: text('project_id'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** CrewAI task `expected_output`. */
    expectedOutput: text('expected_output').notNull().default(''),
    /** Free-form task type used to group repeated work for scorecards/skills. */
    taskType: text('task_type'),
    assigneeAgentId: text('assignee_agent_id'),
    /** Who reviews work moved to in_review (agent id) — null means the owner. */
    reviewerAgentId: text('reviewer_agent_id'),
    creatorKind: text('creator_kind', { enum: ['human', 'agent', 'system'] }).notNull().default('human'),
    creatorId: text('creator_id'),
    status: text('status', { enum: ISSUE_STATUSES }).notNull().default('backlog'),
    blockedReason: text('blocked_reason'),
    /** 0 urgent · 1 high · 2 normal · 3 low */
    priority: integer('priority').notNull().default(2),
    parentIssueId: text('parent_issue_id'),
    /** Issue ids that must be done before this one can start. */
    blockedBy: text('blocked_by', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** run id holding the atomic checkout, or NULL. */
    checkoutLock: text('checkout_lock'),
    checkoutAt: integer('checkout_at'),
    labels: text('labels', { mode: 'json' }).$type<string[]>().notNull().default([]),
    playbookId: text('playbook_id'),
    /** Reviewer verdict used by outcome grading: accepted | edited | rejected. */
    reviewOutcome: text('review_outcome', { enum: ['accepted', 'edited', 'rejected'] }),
    reworkCount: integer('rework_count').notNull().default(0),
    closedAt: integer('closed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('issue_org_status_idx').on(t.orgId, t.status),
    index('issue_assignee_idx').on(t.assigneeAgentId, t.status),
    index('issue_parent_idx').on(t.parentIssueId),
    index('issue_goal_idx').on(t.goalId),
    index('issue_org_number_idx').on(t.orgId, t.number),
  ],
);

export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id),
    issueId: text('issue_id').notNull().references(() => issues.id),
    parentCommentId: text('parent_comment_id'),
    authorKind: text('author_kind', { enum: ['human', 'agent', 'system'] }).notNull(),
    authorId: text('author_id'),
    runId: text('run_id'),
    body: text('body').notNull(),
    /** Agent ids @mentioned in the body. */
    mentions: text('mentions', { mode: 'json' }).$type<string[]>().notNull().default([]),
    attachments: text('attachments', { mode: 'json' })
      .$type<Array<{ name: string; path: string; mime?: string }>>()
      .notNull()
      .default([]),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('comment_issue_idx').on(t.issueId, t.createdAt), index('comment_org_idx').on(t.orgId)],
);

/** Per-agent read cursor so the inbox only surfaces new comments/mentions. */
export const inboxCursors = sqliteTable('inbox_cursors', {
  agentId: text('agent_id').primaryKey(),
  orgId: text('org_id').notNull(),
  lastSeenAt: integer('last_seen_at').notNull().default(0),
});
