import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Kernel } from '../../contracts/kernel.js';
import type { OrgService, WorkService } from '../../contracts/org-work.js';
import type { ApprovalService } from '../../contracts/services.js';
import type { ToolCallContext } from '../../contracts/tools.js';
import type { Actor } from '../../contracts/types.js';
import type { Agent, Comment, Goal, Issue } from '../../contracts/rows.js';
import { organizations } from '../../db/schema/index.js';
import { invalid, notFound } from '../../shared/errors.js';
import { resolveInside } from '../../shared/paths.js';
import type { ToolArgs, ToolName } from './defs.js';

export interface TasksToolDeps {
  work: WorkService;
  org: OrgService;
  approvals: ApprovalService;
}

export interface ToolEnv extends TasksToolDeps {
  kernel: Kernel;
}

/** A handler returns a JSON-serializable value; domain failures are thrown as ConductorError. */
export type Handler<K extends ToolName> = (env: ToolEnv, ctx: ToolCallContext, args: ToolArgs<K>) => unknown;
export type Handlers<K extends ToolName> = { [N in K]: Handler<N> };

/** Identity always comes from the run-scoped context, never from arguments. */
export const actorOf = (ctx: ToolCallContext): Actor => ({ kind: 'agent', id: ctx.agentId, runId: ctx.runId });

export function resolveIssue(env: ToolEnv, ctx: ToolCallContext, ref: string | number | undefined): Issue {
  const target = ref ?? ctx.issueId;
  if (target === null || target === undefined) {
    throw invalid('no issue given and this run is not working on an issue; pass `issue`');
  }
  const issue = env.work.findIssue(ctx.orgId, target);
  if (!issue) throw notFound('issue', String(target));
  return issue;
}

export function resolveAgent(env: ToolEnv, ctx: ToolCallContext, ref: string): Agent {
  const agent = env.org.findAgent(ctx.orgId, ref);
  if (!agent || agent.orgId !== ctx.orgId) throw notFound('agent', ref);
  return agent;
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);
const real = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * Artifact paths are confined to the run workspace or the organization's own
 * directory, and stored absolute. An existing file is also checked after
 * symlink resolution, so a link inside the workspace cannot smuggle out a file
 * from elsewhere on the machine (the Work context copies attachments into the
 * org's artifacts directory).
 */
export function sanitizeArtifacts(
  env: ToolEnv,
  ctx: ToolCallContext,
  artifacts: Array<{ name: string; path: string; mime?: string | undefined }> | undefined,
): Comment['attachments'] {
  if (!artifacts?.length) return [];
  let orgDir: string | null | undefined;
  const orgRoot = (): string | null => {
    if (orgDir === undefined) {
      const org = env.kernel.db
        .select({ slug: organizations.slug })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .get();
      orgDir = org ? env.kernel.paths.org(org.slug) : null;
    }
    return orgDir;
  };
  return artifacts.map((a) => {
    if (a.path.includes('\0')) throw invalid('artifact path must not contain NUL');
    const roots = [resolve(ctx.workspacePath), orgRoot()].filter((r): r is string => !!r);
    let path: string;
    if (!isAbsolute(a.path)) {
      path = resolveInside(ctx.workspacePath, a.path);
    } else {
      path = resolve(a.path);
      if (!roots.some((root) => within(path, root))) {
        throw invalid(`artifact path is outside the run workspace: ${a.path}`);
      }
    }
    if (existsSync(path)) {
      const target = real(path);
      const realRoots = roots.map(real).filter((r): r is string => r !== null);
      if (!target || !realRoots.some((root) => within(target, root))) {
        throw invalid(`artifact path resolves outside the run workspace: ${a.path}`);
      }
    }
    return a.mime ? { name: a.name, path, mime: a.mime } : { name: a.name, path };
  });
}

/* ───────────────────────── Views (what agents read) ───────────────────────── */

export const issueBrief = (i: Issue) => ({
  id: i.id,
  number: i.number,
  title: i.title,
  status: i.status,
  priority: i.priority,
  assigneeAgentId: i.assigneeAgentId,
  reviewerAgentId: i.reviewerAgentId,
  goalId: i.goalId,
  parentIssueId: i.parentIssueId,
  blockedBy: i.blockedBy,
  blockedReason: i.blockedReason,
  labels: i.labels,
  updatedAt: i.updatedAt,
});

export const issueFull = (i: Issue) => ({
  ...issueBrief(i),
  body: i.body,
  expectedOutput: i.expectedOutput,
  taskType: i.taskType,
  projectId: i.projectId,
  playbookId: i.playbookId,
  creator: `${i.creatorKind}:${i.creatorId ?? ''}`,
  checkedOut: i.checkoutLock !== null,
  reviewOutcome: i.reviewOutcome,
  reworkCount: i.reworkCount,
  createdAt: i.createdAt,
  closedAt: i.closedAt,
});

export const commentView = (c: Comment) => ({
  id: c.id,
  issueId: c.issueId,
  parentCommentId: c.parentCommentId,
  author: `${c.authorKind}:${c.authorId ?? ''}`,
  body: c.body,
  mentions: c.mentions,
  attachments: c.attachments,
  createdAt: c.createdAt,
});

export const agentView = (a: Agent) => ({
  id: a.id,
  slug: a.slug,
  name: a.name,
  role: a.role,
  deptId: a.deptId,
  reportsTo: a.reportsTo,
  autonomyLevel: a.autonomyLevel,
  status: a.status,
});

export const goalView = (g: Goal) => ({
  id: g.id,
  title: g.title,
  description: g.description,
  level: g.level,
  parentGoalId: g.parentGoalId,
  deptId: g.deptId,
  ownerAgentId: g.ownerAgentId,
  successMetric: g.successMetric,
  target: g.target,
  weight: g.weight,
  due: g.due,
  status: g.status,
});
