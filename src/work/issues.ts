import { and, asc, desc, eq, inArray, isNull, max, or, sql, type SQL } from 'drizzle-orm';
import type { CreateIssueInput, IssueFilter } from '../contracts/org-work.js';
import type { Actor } from '../contracts/types.js';
import type { Issue, Organization } from '../contracts/rows.js';
import { issues, playbooks, projects } from '../db/schema/index.js';
import type { IssueStatus } from '../db/schema/work.js';
import { invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { parse, requireAgent, requireAssignable, requireOrg, type WorkCtx } from './context.js';
import { activeGoalOfAgent, ensureDefaultGoal, getGoal } from './goals.js';
import { getProject } from './projects.js';
import { actingAgent, assertCanAssign, assertCanTouch, assertMayCreateIssues } from './permissions.js';
import { issueFilter, issueInput, issuePatch } from './schemas.js';
import { CREATABLE_STATUSES, assertTransition, isClosed, statusForNewHolder } from './status.js';

/**
 * True when every issue listed in `issues.blocked_by` is done. Written against
 * the outer table name so the same text works in the checkout UPDATE and in
 * the inbox SELECT. CROSS JOIN pins the join order (blocker ids first, then a
 * primary-key lookup each) — left to itself the planner scans the org's issues.
 */
export const BLOCKERS_DONE_SQL = `NOT EXISTS (
  SELECT 1 FROM json_each("issues"."blocked_by") AS j
  CROSS JOIN issues AS b ON b.id = j.value
  WHERE b.org_id = "issues"."org_id" AND b.status <> 'done'
)`;

export function getIssue(ctx: WorkCtx, orgId: string, issueId: string): Issue {
  const row = ctx.kernel.db
    .select()
    .from(issues)
    .where(and(eq(issues.orgId, orgId), eq(issues.id, issueId)))
    .get();
  if (!row) throw notFound('issue', issueId);
  return row;
}

/** By id, or by per-org number (`12`, `"12"`, `"#12"`, `"ACME-12"`). */
export function findIssue(ctx: WorkCtx, orgId: string, idOrNumber: string | number): Issue | null {
  let num: number | null = null;
  if (typeof idOrNumber === 'number') num = idOrNumber;
  else {
    const m = /^(?:#|[A-Za-z][A-Za-z0-9]*-)?(\d{1,15})$/.exec(idOrNumber.trim());
    if (m?.[1]) num = Number(m[1]);
  }
  const match = num !== null ? eq(issues.number, num) : eq(issues.id, String(idOrNumber));
  if (num !== null && !Number.isSafeInteger(num)) return null;
  return (
    ctx.kernel.db
      .select()
      .from(issues)
      .where(and(eq(issues.orgId, orgId), match))
      .get() ?? null
  );
}

function requirePlaybook(ctx: WorkCtx, orgId: string, playbookId: string): void {
  const row = ctx.kernel.db
    .select({ id: playbooks.id })
    .from(playbooks)
    .where(and(eq(playbooks.orgId, orgId), eq(playbooks.id, playbookId)))
    .get();
  if (!row) throw notFound('playbook', playbookId);
}

function validateBlockers(ctx: WorkCtx, orgId: string, ids: string[], selfId?: string): string[] {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    if (id === selfId) throw invalid('an issue cannot be blocked by itself');
    getIssue(ctx, orgId, id);
  }
  return unique;
}

/**
 * Every issue traces to a goal (PRD "Domain model"), so this never returns
 * null: explicit → parent issue's → the project's → the assignee's active goal
 * → the creating agent's active goal → the org's default goal (created on
 * first use).
 */
function resolveGoalId(
  ctx: WorkCtx,
  org: Organization,
  explicit: string | null | undefined,
  from: { parentGoalId: string | null; projectId: string | null; assigneeId: string | null; creatorAgentId: string | null },
): string {
  const orgId = org.id;
  if (explicit) return getGoal(ctx, orgId, explicit).id;
  if (from.parentGoalId) return from.parentGoalId;
  if (from.projectId) {
    const project = ctx.kernel.db
      .select({ goalId: projects.goalId })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, from.projectId)))
      .get();
    if (project?.goalId) return project.goalId;
  }
  for (const agentId of [from.assigneeId, from.creatorAgentId]) {
    const goal = agentId ? activeGoalOfAgent(ctx, orgId, agentId) : null;
    if (goal) return goal.id;
  }
  return ensureDefaultGoal(ctx, org).id;
}

export interface CreateIssueOptions {
  /** The caller has already applied the actor rules (playbooks); skip them here. */
  preauthorized?: boolean;
}

export function createIssue(
  ctx: WorkCtx,
  orgId: string,
  raw: CreateIssueInput,
  actor: Actor,
  opts: CreateIssueOptions = {},
): Issue {
  const input = parse(issueInput, raw);
  return ctx.tx(() => {
    const org = requireOrg(ctx, orgId);
    const agent = actingAgent(ctx, orgId, actor);
    const assigneeId = input.assigneeAgentId ?? null;
    const parent = input.parentIssueId ? getIssue(ctx, orgId, input.parentIssueId) : null;
    if (!opts.preauthorized) {
      assertMayCreateIssues(agent, parent);
      if (assigneeId) assertCanAssign(ctx, orgId, agent, assigneeId);
    }
    if (assigneeId) requireAssignable(ctx, orgId, assigneeId);
    if (input.reviewerAgentId) requireAgent(ctx, orgId, input.reviewerAgentId);

    const projectId = input.projectId ? getProject(ctx, orgId, input.projectId).id : (parent?.projectId ?? null);
    if (input.playbookId) requirePlaybook(ctx, orgId, input.playbookId);
    const blockedBy = validateBlockers(ctx, orgId, input.blockedBy ?? []);
    const goalId = resolveGoalId(ctx, org, input.goalId, {
      parentGoalId: parent?.goalId ?? null,
      projectId,
      assigneeId,
      creatorAgentId: agent?.id ?? null,
    });

    const status: IssueStatus = input.status ?? (assigneeId ? 'todo' : 'backlog');
    if (!(CREATABLE_STATUSES as readonly IssueStatus[]).includes(status)) {
      throw invalid(`an issue cannot be created as ${status}`, { allowed: CREATABLE_STATUSES });
    }

    // Per-org sequence: read-max + insert inside the IMMEDIATE transaction, so no two writers share a number.
    const last = ctx.kernel.db
      .select({ n: max(issues.number) })
      .from(issues)
      .where(eq(issues.orgId, orgId))
      .get();
    const now = ctx.now();
    const row = ctx.kernel.db
      .insert(issues)
      .values({
        id: newId('issue'),
        orgId,
        number: (last?.n ?? 0) + 1,
        goalId,
        projectId,
        title: input.title,
        body: input.body ?? '',
        expectedOutput: input.expectedOutput ?? '',
        taskType: input.taskType ?? null,
        assigneeAgentId: assigneeId,
        reviewerAgentId: input.reviewerAgentId ?? null,
        creatorKind: actor.kind,
        creatorId: actor.id ?? null,
        status,
        priority: input.priority ?? 2,
        parentIssueId: parent?.id ?? null,
        blockedBy,
        labels: [...new Set(input.labels ?? [])],
        playbookId: input.playbookId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    ctx.kernel.audit.record({
      orgId,
      actor,
      action: 'issue.created',
      entityKind: 'issue',
      entityId: row.id,
      issueId: row.id,
      data: {
        number: row.number,
        title: row.title,
        status,
        assigneeAgentId: assigneeId,
        goalId,
        parentIssueId: row.parentIssueId,
      },
    });
    ctx.emit('issue.created', { orgId, issueId: row.id, assigneeAgentId: assigneeId });
    if (assigneeId) ctx.emit('issue.assigned', { orgId, issueId: row.id, agentId: assigneeId });
    return row;
  });
}

/** Columns the Work context changes after creation. */
export type IssueChanges = Partial<
  Pick<
    Issue,
    | 'title' | 'body' | 'expectedOutput' | 'taskType' | 'goalId' | 'projectId' | 'assigneeAgentId'
    | 'reviewerAgentId' | 'status' | 'blockedReason' | 'priority' | 'parentIssueId' | 'blockedBy' | 'labels'
    | 'playbookId' | 'checkoutLock' | 'checkoutAt' | 'reviewOutcome' | 'reworkCount'
  >
>;

const LONG_TEXT = new Set(['title', 'body', 'expectedOutput']);
const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The single write path for an existing issue: diffs, stamps
 * `updatedAt`/`closedAt`, audits (with `issueId`, so the timeline shows it) and
 * emits `issue.updated` (+ `issue.assigned`, `issue.done`). Callers have
 * already validated permissions and the status transition.
 */
export function applyChanges(
  ctx: WorkCtx,
  issue: Issue,
  changes: IssueChanges,
  actor: Actor,
  audit: { action: string; data?: Record<string, unknown> },
): Issue {
  const set: Record<string, unknown> = {};
  const diff: Record<string, unknown> = {};
  const current = issue as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || same(current[key], value)) continue;
    set[key] = value;
    diff[key] = LONG_TEXT.has(key) ? { changed: true } : { from: current[key], to: value };
  }
  const statusChanged = typeof set.status === 'string';
  const nextStatus = (statusChanged ? set.status : issue.status) as IssueStatus;
  if (statusChanged) {
    set.closedAt = isClosed(nextStatus) ? ctx.now() : null;
    if (issue.status === 'blocked' && changes.blockedReason === undefined && issue.blockedReason !== null) {
      set.blockedReason = null;
    }
  }
  if (Object.keys(set).length === 0) return issue;

  const row = ctx.kernel.db
    .update(issues)
    .set({ ...(set as IssueChanges), updatedAt: ctx.now() })
    .where(and(eq(issues.orgId, issue.orgId), eq(issues.id, issue.id)))
    .returning()
    .get();
  if (!row) throw notFound('issue', issue.id);

  ctx.kernel.audit.record({
    orgId: issue.orgId,
    actor,
    action: audit.action,
    entityKind: 'issue',
    entityId: issue.id,
    issueId: issue.id,
    data: { ...audit.data, changes: diff },
  });
  if (row.assigneeAgentId && row.assigneeAgentId !== issue.assigneeAgentId) {
    ctx.emit('issue.assigned', { orgId: row.orgId, issueId: row.id, agentId: row.assigneeAgentId });
  }
  ctx.emit('issue.updated', { orgId: row.orgId, issueId: row.id, status: row.status });
  if (statusChanged && row.status === 'done') ctx.emit('issue.done', { orgId: row.orgId, issueId: row.id });
  return row;
}

function assertNoParentCycle(ctx: WorkCtx, orgId: string, issueId: string, parentId: string): void {
  let cursor: string | null = parentId;
  for (let hops = 0; cursor && hops < 1000; hops++) {
    if (cursor === issueId) throw invalid('an issue cannot be its own ancestor');
    cursor = getIssue(ctx, orgId, cursor).parentIssueId;
  }
}

export function updateIssue(
  ctx: WorkCtx,
  orgId: string,
  issueId: string,
  raw: Partial<CreateIssueInput> & { blockedReason?: string | null },
  actor: Actor,
  auditAction = 'issue.updated',
): Issue {
  const patch = parse(issuePatch, raw);
  return ctx.tx(() => {
    const issue = getIssue(ctx, orgId, issueId);
    const agent = actingAgent(ctx, orgId, actor);
    assertCanTouch(ctx, orgId, agent, issue);

    const changes: IssueChanges = {
      title: patch.title,
      body: patch.body,
      expectedOutput: patch.expectedOutput,
      taskType: patch.taskType,
      priority: patch.priority,
      blockedReason: patch.blockedReason,
    };
    if (patch.labels) changes.labels = [...new Set(patch.labels)];
    if (patch.projectId !== undefined) {
      changes.projectId = patch.projectId ? getProject(ctx, orgId, patch.projectId).id : null;
    }
    if (patch.reviewerAgentId !== undefined) {
      changes.reviewerAgentId = patch.reviewerAgentId ? requireAgent(ctx, orgId, patch.reviewerAgentId).id : null;
    }
    if (patch.playbookId !== undefined) {
      if (patch.playbookId) requirePlaybook(ctx, orgId, patch.playbookId);
      changes.playbookId = patch.playbookId;
    }
    if (patch.parentIssueId !== undefined) {
      if (patch.parentIssueId) assertNoParentCycle(ctx, orgId, issueId, patch.parentIssueId);
      changes.parentIssueId = patch.parentIssueId;
    }
    if (patch.blockedBy) changes.blockedBy = validateBlockers(ctx, orgId, patch.blockedBy, issueId);
    // An issue is never left without a goal: clearing it (null) — or touching a
    // legacy goal-less issue — falls back to the inherited/default goal.
    if (patch.goalId !== undefined || issue.goalId === null) {
      const parentId = changes.parentIssueId !== undefined ? changes.parentIssueId : issue.parentIssueId;
      changes.goalId = resolveGoalId(ctx, requireOrg(ctx, orgId), patch.goalId, {
        parentGoalId: parentId ? getIssue(ctx, orgId, parentId).goalId : null,
        projectId: changes.projectId !== undefined ? changes.projectId : issue.projectId,
        assigneeId: issue.assigneeAgentId,
        creatorAgentId: issue.creatorKind === 'agent' ? issue.creatorId : null,
      });
    }

    let status = patch.status;
    if (patch.assigneeAgentId !== undefined && patch.assigneeAgentId !== issue.assigneeAgentId) {
      if (patch.assigneeAgentId) {
        assertCanAssign(ctx, orgId, agent, patch.assigneeAgentId);
        requireAssignable(ctx, orgId, patch.assigneeAgentId);
        // The new holder is woken on it, so it must be able to act: reopen work it could not otherwise pick up.
        if (status === undefined) status = statusForNewHolder(issue, patch.assigneeAgentId);
      }
      changes.assigneeAgentId = patch.assigneeAgentId;
    }
    if (status !== undefined && status !== issue.status) {
      assertTransition(issue.status, status);
      changes.status = status;
    }
    return applyChanges(ctx, issue, changes, actor, { action: auditAction });
  });
}

export function assign(ctx: WorkCtx, orgId: string, issueId: string, agentId: string | null, actor: Actor): Issue {
  return updateIssue(ctx, orgId, issueId, { assigneeAgentId: agentId }, actor, 'issue.assigned');
}

const likeEscape = (term: string): string => term.replace(/[\\%_]/g, (c) => `\\${c}`);

export function listIssues(ctx: WorkCtx, orgId: string, rawFilter?: IssueFilter): Issue[] {
  const filter = parse(issueFilter, rawFilter);
  const where: SQL[] = [eq(issues.orgId, orgId)];
  if (Array.isArray(filter.status)) where.push(inArray(issues.status, filter.status));
  else if (filter.status) where.push(eq(issues.status, filter.status));
  if (filter.assigneeAgentId) where.push(eq(issues.assigneeAgentId, filter.assigneeAgentId));
  if (filter.goalId) where.push(eq(issues.goalId, filter.goalId));
  if (filter.projectId) where.push(eq(issues.projectId, filter.projectId));
  if (filter.parentIssueId === null) where.push(isNull(issues.parentIssueId));
  else if (filter.parentIssueId) where.push(eq(issues.parentIssueId, filter.parentIssueId));
  if (filter.label) {
    where.push(sql`EXISTS (SELECT 1 FROM json_each(${issues.labels}) WHERE value = ${filter.label})`);
  }
  // Every search term must appear in the title or body (or be the issue number).
  for (const term of (filter.search ?? '').split(/\s+/).filter(Boolean).slice(0, 12)) {
    const pattern = `%${likeEscape(term)}%`;
    const clauses: SQL[] = [
      sql`${issues.title} LIKE ${pattern} ESCAPE '\\'`,
      sql`${issues.body} LIKE ${pattern} ESCAPE '\\'`,
    ];
    const asNumber = /^#?(\d{1,15})$/.exec(term);
    if (asNumber?.[1]) clauses.push(eq(issues.number, Number(asNumber[1])));
    const any = or(...clauses);
    if (any) where.push(any);
  }
  return ctx.kernel.db
    .select()
    .from(issues)
    .where(and(...where))
    .orderBy(asc(issues.priority), desc(issues.createdAt), desc(issues.number))
    .limit(filter.limit ?? 500)
    .offset(filter.offset ?? 0)
    .all();
}
