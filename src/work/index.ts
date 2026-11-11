import type { Kernel } from '../contracts/kernel.js';
import type { OrgService, WorkService } from '../contracts/org-work.js';
import { createWorkCtx } from './context.js';
import * as goals from './goals.js';
import * as issues from './issues.js';
import * as checkout from './checkout.js';
import * as inbox from './inbox.js';
import * as comments from './comments.js';
import * as flows from './flows.js';
import * as playbooks from './playbooks.js';

export { createTasksToolProvider } from './tools/index.js';
export type { TasksToolDeps } from './tools/index.js';

export interface WorkDeps {
  org: OrgService;
}

/**
 * The Work context: goals, projects, issues, comments, atomic checkout and
 * playbooks. Reporting-line decisions are delegated to the Org context.
 */
export function createWorkService(kernel: Kernel, deps: WorkDeps): WorkService {
  const ctx = createWorkCtx(kernel, deps.org);
  return {
    createGoal: (orgId, input, actor) => goals.createGoal(ctx, orgId, input, actor),
    updateGoal: (orgId, goalId, patch, actor) => goals.updateGoal(ctx, orgId, goalId, patch, actor),
    getGoal: (orgId, goalId) => goals.getGoal(ctx, orgId, goalId),
    listGoals: (orgId, filter) => goals.listGoals(ctx, orgId, filter),
    goalTree: (orgId) => goals.goalTree(ctx, orgId),

    createProject: (orgId, input, actor) => goals.createProject(ctx, orgId, input, actor),
    getProject: (orgId, projectId) => goals.getProject(ctx, orgId, projectId),
    listProjects: (orgId) => goals.listProjects(ctx, orgId),

    createIssue: (orgId, input, actor) => issues.createIssue(ctx, orgId, input, actor),
    updateIssue: (orgId, issueId, patch, actor) => issues.updateIssue(ctx, orgId, issueId, patch, actor),
    getIssue: (orgId, issueId) => issues.getIssue(ctx, orgId, issueId),
    findIssue: (orgId, idOrNumber) => issues.findIssue(ctx, orgId, idOrNumber),
    listIssues: (orgId, filter) => issues.listIssues(ctx, orgId, filter),
    assign: (orgId, issueId, agentId, actor) => issues.assign(ctx, orgId, issueId, agentId, actor),
    delegate: (orgId, parentIssueId, children, actor) => flows.delegate(ctx, orgId, parentIssueId, children, actor),
    escalate: (orgId, issueId, reason, actor) => flows.escalate(ctx, orgId, issueId, reason, actor),
    review: (orgId, issueId, outcome, note, actor) => flows.review(ctx, orgId, issueId, outcome, note, actor),

    checkout: (orgId, issueId, runId) => checkout.checkout(ctx, orgId, issueId, runId),
    release: (orgId, issueId, runId, to) => checkout.release(ctx, orgId, issueId, runId, to),
    releaseAllForRun: (orgId, runId, toStatus) => checkout.releaseAllForRun(ctx, orgId, runId, toStatus),

    inbox: (orgId, agentId) => inbox.inbox(ctx, orgId, agentId),
    markInboxSeen: (orgId, agentId, at) => inbox.markInboxSeen(ctx, orgId, agentId, at),

    addComment: (orgId, issueId, input, actor) => comments.addComment(ctx, orgId, issueId, input, actor),
    listComments: (orgId, issueId, opts) => comments.listComments(ctx, orgId, issueId, opts),
    timeline: (orgId, issueId) => comments.timeline(ctx, orgId, issueId),

    createPlaybook: (orgId, input, actor) => playbooks.createPlaybook(ctx, orgId, input, actor),
    listPlaybooks: (orgId) => playbooks.listPlaybooks(ctx, orgId),
    runPlaybook: (orgId, playbookId, issueId, actor) => playbooks.runPlaybook(ctx, orgId, playbookId, issueId, actor),
  };
}
