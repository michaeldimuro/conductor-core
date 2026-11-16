import type { Kernel } from '../contracts/kernel.js';
import type { OrgService, WorkService } from '../contracts/org-work.js';
import { createWorkCtx } from './context.js';
import * as goals from './goals.js';
import * as issues from './issues.js';
import * as checkout from './checkout.js';
import * as inbox from './inbox.js';
import * as comments from './comments.js';
import { listIssueArtifacts, listOrgArtifacts } from './artifacts.js';
import * as flows from './flows.js';
import * as playbooks from './playbooks.js';
import * as projects from './projects.js';
import * as uploads from './uploads.js';

export { createTasksToolProvider } from './tools/index.js';
export type { TasksToolDeps } from './tools/index.js';

export interface WorkDeps {
  org: OrgService;
}

/**
 * The Work context: goals, projects, issues, comments, atomic checkout and
 * playbooks. Reporting-line decisions are delegated to the Org context.
 */
/** The Work context's full surface: every optional `WorkService` method is implemented. */
export type WorkContext = WorkService &
  Required<Pick<WorkService, 'deleteGoal' | 'updateProject' | 'updatePlaybook' | 'deletePlaybook' | 'listIssueArtifacts' | 'listArtifacts' | 'listIssueFiles' | 'addIssueFile' | 'removeIssueFile'>>;

export function createWorkService(kernel: Kernel, deps: WorkDeps): WorkContext {
  const ctx = createWorkCtx(kernel, deps.org);
  return {
    createGoal: (orgId, input, actor) => goals.createGoal(ctx, orgId, input, actor),
    updateGoal: (orgId, goalId, patch, actor) => goals.updateGoal(ctx, orgId, goalId, patch, actor),
    getGoal: (orgId, goalId) => goals.getGoal(ctx, orgId, goalId),
    listGoals: (orgId, filter) => goals.listGoals(ctx, orgId, filter),
    deleteGoal: (orgId, goalId, actor) => goals.deleteGoal(ctx, orgId, goalId, actor),
    goalTree: (orgId) => goals.goalTree(ctx, orgId),

    createProject: (orgId, input, actor) => projects.createProject(ctx, orgId, input, actor),
    updateProject: (orgId, projectId, patch, actor) => projects.updateProject(ctx, orgId, projectId, patch, actor),
    getProject: (orgId, projectId) => projects.getProject(ctx, orgId, projectId),
    listProjects: (orgId) => projects.listProjects(ctx, orgId),

    createIssue: (orgId, input, actor) => issues.createIssue(ctx, orgId, input, actor),
    updateIssue: (orgId, issueId, patch, actor) => issues.updateIssue(ctx, orgId, issueId, patch, actor),
    getIssue: (orgId, issueId) => issues.getIssue(ctx, orgId, issueId),
    findIssue: (orgId, idOrNumber) => issues.findIssue(ctx, orgId, idOrNumber),
    listIssues: (orgId, filter) => issues.listIssues(ctx, orgId, filter),
    assign: (orgId, issueId, agentId, actor) => issues.assign(ctx, orgId, issueId, agentId, actor),
    delegate: (orgId, parentIssueId, children, actor) => flows.delegate(ctx, orgId, parentIssueId, children, actor),
    escalate: (orgId, issueId, reason, actor) => flows.escalate(ctx, orgId, issueId, reason, actor),
    review: (orgId, issueId, outcome, note, actor) => flows.review(ctx, orgId, issueId, outcome, note, actor),
    handOff: (orgId, issueId, toAgentId, note, actor) => flows.handOff(ctx, orgId, issueId, toAgentId, note, actor),

    checkout: (orgId, issueId, runId) => checkout.checkout(ctx, orgId, issueId, runId),
    release: (orgId, issueId, runId, to) => checkout.release(ctx, orgId, issueId, runId, to),
    releaseAllForRun: (orgId, runId, toStatus) => checkout.releaseAllForRun(ctx, orgId, runId, toStatus),

    inbox: (orgId, agentId) => inbox.inbox(ctx, orgId, agentId),
    markInboxSeen: (orgId, agentId, at) => inbox.markInboxSeen(ctx, orgId, agentId, at),

    addComment: (orgId, issueId, input, actor) => comments.addComment(ctx, orgId, issueId, input, actor),
    listComments: (orgId, issueId, opts) => comments.listComments(ctx, orgId, issueId, opts),
    timeline: (orgId, issueId) => comments.timeline(ctx, orgId, issueId),
    listIssueArtifacts(orgId, issueId) {
      const issue = issues.getIssue(ctx, orgId, issueId);
      return listIssueArtifacts(ctx, deps.org.getOrg(orgId), issue.id);
    },
    listArtifacts: (orgId, filter) => listOrgArtifacts(ctx, deps.org.getOrg(orgId), filter),
    listIssueFiles(orgId, issueId) {
      const issue = issues.getIssue(ctx, orgId, issueId);
      return uploads.listIssueFiles(kernel.paths, deps.org.getOrg(orgId).slug, issue.id);
    },
    addIssueFile(orgId, issueId, input, actor) {
      const issue = issues.getIssue(ctx, orgId, issueId);
      const saved = uploads.addIssueFile(kernel.paths, deps.org.getOrg(orgId).slug, issue.id, input.name, input.data);
      kernel.audit.record({
        orgId, actor, action: 'issue.file_attached', entityKind: 'issue', entityId: issue.id, issueId: issue.id,
        data: { name: saved.name, bytes: saved.bytes },
      });
      ctx.emit('artifact.saved', { orgId, path: saved.path, issueId: issue.id, runId: null });
      return saved;
    },
    removeIssueFile(orgId, issueId, name, actor) {
      const issue = issues.getIssue(ctx, orgId, issueId);
      const gone = uploads.removeIssueFile(kernel.paths, deps.org.getOrg(orgId).slug, issue.id, name);
      kernel.audit.record({
        orgId, actor, action: 'issue.file_removed', entityKind: 'issue', entityId: issue.id, issueId: issue.id, data: { name: gone.name },
      });
      ctx.emit('artifact.removed', { orgId, path: gone.path, issueId: issue.id });
      return gone;
    },

    createPlaybook: (orgId, input, actor) => playbooks.createPlaybook(ctx, orgId, input, actor),
    listPlaybooks: (orgId) => playbooks.listPlaybooks(ctx, orgId),
    updatePlaybook: (orgId, playbookId, patch, actor) => playbooks.updatePlaybook(ctx, orgId, playbookId, patch, actor),
    deletePlaybook: (orgId, playbookId, actor) => playbooks.deletePlaybook(ctx, orgId, playbookId, actor),
    runPlaybook: (orgId, playbookId, issueId, actor) => playbooks.runPlaybook(ctx, orgId, playbookId, issueId, actor),
  };
}
