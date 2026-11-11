import { z } from 'zod';
import { AUTONOMY } from '../../contracts/types.js';
import type { ToolDef, ToolRisk } from '../../contracts/tools.js';
import { ISSUE_STATUSES } from '../../db/schema/work.js';

/**
 * The `conductor-tasks` tool catalogue. Each tool's zod schema is the single
 * source of truth: it validates the call and is rendered to the JSON Schema
 * agents see. Identity is never an argument — it comes from ToolCallContext.
 */

const issueRef = z
  .union([z.string().min(1).max(200), z.number().int().positive()])
  .describe('Issue id ("iss_…") or per-org number (12, "#12").');
const optionalIssue = issueRef.optional().describe('Issue id or number. Defaults to the issue this run is working on.');
const agentRef = z.string().min(1).max(200).describe('Agent id or slug.');
const priority = z.number().int().min(0).max(3).describe('0 urgent · 1 high · 2 normal · 3 low.');
const labels = z.array(z.string().trim().min(1).max(100)).max(50);
const title = z.string().trim().min(1).max(500);
const body = z.string().max(200_000);
const expectedOutput = z.string().max(20_000).describe('What a finished result looks like (the acceptance bar).');

const artifact = z.strictObject({
  name: z.string().trim().min(1).max(255),
  path: z.string().min(1).max(4096).describe('File path, relative to the run workspace (or absolute inside it).'),
  mime: z.string().max(200).optional(),
});

const childIssue = z.strictObject({
  title,
  body: body.optional(),
  expectedOutput: expectedOutput.optional(),
  assignee: agentRef.describe('Who does the work: yourself, one of your reports, or a peer through your lead.'),
  reviewer: agentRef.optional(),
  taskType: z.string().trim().min(1).max(200).optional(),
  priority: priority.optional(),
  labels: labels.optional(),
});

const empty = z.strictObject({});

export const REQUESTABLE_APPROVAL_KINDS = ['budget_raise', 'payment', 'external_send', 'publish', 'other'] as const;

interface Spec<S extends z.ZodType> {
  description: string;
  risk: ToolRisk;
  /** Lowest autonomy level that sees (and may call) the tool. */
  minAutonomy: number;
  schema: S;
}
const spec = <S extends z.ZodType>(s: Spec<S>): Spec<S> => s;

export const TOOL_SPECS = {
  inbox: spec({
    description:
      'Your work queue: assigned, workable issues (by priority, goal weight, age) plus new comments and @mentions since you last looked.',
    risk: 'read',
    minAutonomy: AUTONOMY.ASSIST,
    schema: empty,
  }),
  get_issue: spec({
    description: 'Read one issue in full, with its comment thread, child issues and blockers.',
    risk: 'read',
    minAutonomy: AUTONOMY.ASSIST,
    schema: z.strictObject({ issue: optionalIssue }),
  }),
  search_issues: spec({
    description: 'Search issues by words in the title or body. Always run this before creating an issue, to avoid duplicates.',
    risk: 'read',
    minAutonomy: AUTONOMY.ASSIST,
    schema: z.strictObject({
      query: z.string().trim().min(1).max(500).describe('Words that must all appear in the title or body.'),
      status: z.array(z.enum(ISSUE_STATUSES)).min(1).optional().describe('Restrict to these statuses (default: all).'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
    }),
  }),
  create_issue: spec({
    description:
      'Create an issue. It is linked to a goal automatically (parent issue → assignee goal → your goal → org goal) unless goalId is given. Assign only to yourself, your reports, or a peer through your lead.',
    risk: 'write',
    minAutonomy: AUTONOMY.SUPERVISED,
    schema: z.strictObject({
      title,
      body: body.optional(),
      expectedOutput: expectedOutput.optional(),
      taskType: z.string().trim().min(1).max(200).optional().describe('Groups repeated work, e.g. "seo-audit".'),
      goalId: z.string().min(1).max(200).optional(),
      projectId: z.string().min(1).max(200).optional(),
      assignee: agentRef.optional(),
      reviewer: agentRef.optional(),
      priority: priority.optional(),
      parentIssue: issueRef.optional(),
      blockedBy: z.array(issueRef).max(50).optional().describe('Issues that must be done before this one can start.'),
      labels: labels.optional(),
    }),
  }),
  update_issue: spec({
    description:
      'Edit an issue you are assigned, created, or that belongs to one of your reports. To finish work use report_progress; to give a review verdict use review_issue.',
    risk: 'write',
    minAutonomy: AUTONOMY.ASSIST,
    schema: z.strictObject({
      issue: optionalIssue,
      title: title.optional(),
      body: body.optional(),
      expectedOutput: expectedOutput.optional(),
      priority: priority.optional(),
      labels: labels.optional(),
      goalId: z.string().min(1).max(200).nullable().optional(),
      blockedBy: z.array(issueRef).max(50).optional(),
      status: z.enum(['backlog', 'todo', 'in_progress', 'blocked', 'cancelled']).optional(),
      blockedReason: z.string().trim().min(1).max(2000).optional().describe('Why the issue is blocked (with status "blocked").'),
    }),
  }),
  comment: spec({
    description: 'Post a comment on an issue. Mention an agent with @agent-slug to wake it.',
    risk: 'write',
    minAutonomy: AUTONOMY.ASSIST,
    schema: z.strictObject({
      issue: optionalIssue,
      body: body.refine((b) => b.trim().length > 0, 'body must not be empty'),
      parentCommentId: z.string().min(1).max(200).optional().describe('Reply to this comment (threading).'),
      attachments: z.array(artifact).max(50).optional(),
    }),
  }),
  delegate: spec({
    description:
      'Split an issue into child issues and delegate them down the reporting line. Children inherit the goal and project; the parent stays open.',
    risk: 'write',
    minAutonomy: AUTONOMY.SUPERVISED,
    schema: z.strictObject({ issue: optionalIssue, children: z.array(childIssue).min(1).max(50) }),
  }),
  escalate: spec({
    description:
      'Hand an issue up the reporting line with a reason. It goes to the assignee\'s manager; at the top it is blocked and the owner is notified.',
    risk: 'write',
    minAutonomy: AUTONOMY.ASSIST,
    schema: z.strictObject({ issue: optionalIssue, reason: z.string().trim().min(1).max(5000) }),
  }),
  report_progress: spec({
    description:
      'Report the result of your work: posts your summary (and artifacts) as a comment and sets the status. "done" closes the issue only when it has no reviewer and you are autonomy 2+; otherwise it goes to in_review.',
    risk: 'write',
    minAutonomy: AUTONOMY.ASSIST,
    schema: z.strictObject({
      issue: optionalIssue,
      status: z.enum(['done', 'in_review', 'blocked']),
      summary: z.string().trim().min(1).max(100_000).describe('What was done, the result, and anything the reader must know.'),
      blockedReason: z.string().trim().min(1).max(2000).optional().describe('Required in spirit when status is "blocked".'),
      artifacts: z.array(artifact).max(50).optional(),
    }),
  }),
  review_issue: spec({
    description:
      'Give your verdict on an in_review issue you review (or that belongs to one of your reports): accepted → done, edited → done (you fixed it yourself), rejected → back to todo with your note.',
    risk: 'write',
    minAutonomy: AUTONOMY.SUPERVISED,
    schema: z.strictObject({
      issue: issueRef,
      outcome: z.enum(['accepted', 'edited', 'rejected']),
      note: z.string().trim().max(20_000).optional().describe('Feedback for the assignee; expected when rejecting.'),
    }),
  }),
  list_goals: spec({
    description: 'List the organization\'s goals (org → department → agent).',
    risk: 'read',
    minAutonomy: AUTONOMY.ASSIST,
    schema: z.strictObject({
      status: z.enum(['proposed', 'active', 'achieved', 'abandoned']).optional(),
      mine: z.boolean().optional().describe('Only goals you own.'),
    }),
  }),
  create_goal: spec({
    description: 'Set a goal for yourself (level "agent"), or — leads only — for your department (level "dept").',
    risk: 'write',
    minAutonomy: AUTONOMY.AUTONOMOUS,
    schema: z.strictObject({
      title,
      description: z.string().max(20_000).optional(),
      level: z.enum(['agent', 'dept']).optional().describe('Default "agent". "dept" requires autonomy 3.'),
      parentGoalId: z.string().min(1).max(200).optional(),
      successMetric: z.string().max(2000).optional(),
      target: z.string().max(2000).optional(),
      weight: z.number().min(0).max(1000).optional().describe('Relative weight used to order inboxes (default 1).'),
      due: z.number().int().nonnegative().optional().describe('Due date, epoch milliseconds.'),
    }),
  }),
  list_team: spec({
    description: 'Your place in the org chart: your manager, your peers and your direct reports.',
    risk: 'read',
    minAutonomy: AUTONOMY.ASSIST,
    schema: empty,
  }),
  propose_hire: spec({
    description: 'Propose hiring a new agent. Creates a board approval; the hire happens only if the owner approves.',
    risk: 'write',
    minAutonomy: AUTONOMY.LEAD,
    schema: z.strictObject({
      name: z.string().trim().min(1).max(200),
      role: z.string().trim().min(1).max(200),
      goal: z.string().max(5000).optional(),
      backstory: z.string().max(20_000).optional(),
      deptId: z.string().min(1).max(200).optional().describe('Default: your department.'),
      reportsTo: agentRef.optional().describe('Default: you.'),
      model: z.string().min(1).max(200).optional(),
      skills: z.array(z.string().min(1).max(200)).max(100).optional(),
      connectors: z.array(z.string().min(1).max(200)).max(100).optional(),
      heartbeatCron: z.string().min(1).max(200).optional(),
      budgetUsd: z.number().nonnegative().optional(),
      autonomyLevel: z.number().int().min(0).max(3).optional(),
    }),
  }),
  reassign: spec({
    description: 'Move an issue to another agent (or unassign it), within your reporting line.',
    risk: 'write',
    minAutonomy: AUTONOMY.LEAD,
    schema: z.strictObject({ issue: issueRef, assignee: agentRef.nullable().describe('Agent id or slug; null unassigns.') }),
  }),
  request_approval: spec({
    description:
      'Ask the board (owner) to approve an action before you take it: a payment, an external send, publishing, a budget raise, or anything else outside your remit.',
    risk: 'write',
    minAutonomy: AUTONOMY.ASSIST,
    schema: z.strictObject({
      kind: z.enum(REQUESTABLE_APPROVAL_KINDS),
      title: z.string().trim().min(1).max(500),
      payload: z.record(z.string(), z.unknown()).optional().describe('Details the owner needs to decide. Never include secrets.'),
    }),
  }),
  list_playbooks: spec({
    description: 'List the reusable playbooks (sequential or hierarchical step lists) of this organization.',
    risk: 'read',
    minAutonomy: AUTONOMY.ASSIST,
    schema: empty,
  }),
  run_playbook: spec({
    description:
      'Run a playbook inside an issue: creates one child issue per step (sequential steps unblock one after another; hierarchical steps are reviewed by the manager).',
    risk: 'write',
    minAutonomy: AUTONOMY.SUPERVISED,
    schema: z.strictObject({ playbook: z.string().min(1).max(200).describe('Playbook id or name.'), issue: optionalIssue }),
  }),
} as const;

export type ToolName = keyof typeof TOOL_SPECS;
export type ToolArgs<K extends ToolName> = z.output<(typeof TOOL_SPECS)[K]['schema']>;

export const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOL_SPECS, name);

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _draft, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return rest;
}

const DEFS: Array<ToolDef & { minAutonomy: number }> = (Object.keys(TOOL_SPECS) as ToolName[]).map((name) => ({
  name,
  description: TOOL_SPECS[name].description,
  inputSchema: toJsonSchema(TOOL_SPECS[name].schema),
  risk: TOOL_SPECS[name].risk,
  minAutonomy: TOOL_SPECS[name].minAutonomy,
}));

/** Tool definitions visible at an autonomy level. */
export function toolDefsFor(autonomyLevel: number): ToolDef[] {
  return DEFS.filter((d) => autonomyLevel >= d.minAutonomy).map(({ minAutonomy: _min, ...def }) => def);
}
