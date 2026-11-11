import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Services } from '../../daemon/container.js';
import type { Issue } from '../../contracts/rows.js';
import type { IssueFilter } from '../../contracts/org-work.js';
import { OWNER } from '../../contracts/types.js';
import { notFound } from '../../shared/errors.js';
import { body, orgOf, param, query, resolveIssue, supported } from '../http.js';
import * as q from '../schemas/org-work.js';
import { attachmentRoutes } from './attachments.js';
import type { Ok, Page } from '../types.js';

const DEFAULT_PAGE = 100;

/** Goals, projects, issues (paginated), comments, playbooks. */
export function workRoutes(app: FastifyInstance, s: Services): void {
  const { work } = s;
  const oid = (req: FastifyRequest): string => orgOf(s, req).id;
  const issueOf = (req: FastifyRequest): { orgId: string; issue: Issue } => {
    const orgId = oid(req);
    return { orgId, issue: resolveIssue(s, orgId, param(req, 'issueId')) };
  };

  /* ── Goals ── */
  app.get('/orgs/:orgId/goals', async (req) => work.listGoals(oid(req), query(req, q.listGoalsQ)));
  app.post('/orgs/:orgId/goals', async (req) => work.createGoal(oid(req), body(req, q.createGoal), OWNER));
  app.get('/orgs/:orgId/goals/tree', async (req) => work.goalTree(oid(req)));
  app.get('/orgs/:orgId/goals/:goalId', async (req) => work.getGoal(oid(req), param(req, 'goalId')));
  app.patch('/orgs/:orgId/goals/:goalId', async (req) => work.updateGoal(oid(req), param(req, 'goalId'), body(req, q.updateGoal), OWNER));
  app.delete('/orgs/:orgId/goals/:goalId', async (req): Promise<Ok> => {
    supported(work.deleteGoal, 'deleting a goal').call(work, oid(req), param(req, 'goalId'), OWNER);
    return { ok: true };
  });

  /* ── Projects ── */
  app.get('/orgs/:orgId/projects', async (req) => work.listProjects(oid(req)));
  app.post('/orgs/:orgId/projects', async (req) => work.createProject(oid(req), body(req, q.createProject), OWNER));
  app.get('/orgs/:orgId/projects/:projectId', async (req) => work.getProject(oid(req), param(req, 'projectId')));
  app.patch('/orgs/:orgId/projects/:projectId', async (req) =>
    supported(work.updateProject, 'editing a project').call(work, oid(req), param(req, 'projectId'), body(req, q.updateProject), OWNER));

  /* ── Issues ── */
  app.get('/orgs/:orgId/issues', async (req): Promise<Page<Issue>> => {
    const orgId = oid(req);
    const { parentIssueId, limit = DEFAULT_PAGE, offset = 0, ...rest } = query(req, q.listIssuesQ);
    const filter: IssueFilter = { ...rest, limit: limit + 1, offset };
    if (parentIssueId !== undefined) filter.parentIssueId = parentIssueId === 'null' ? null : parentIssueId;
    // One extra row tells us whether another page exists without a COUNT(*) over the board.
    const rows = work.listIssues(orgId, filter);
    const items = rows.slice(0, limit);
    return { items, limit, offset, nextOffset: rows.length > limit ? offset + limit : null };
  });
  app.post('/orgs/:orgId/issues', async (req) => work.createIssue(oid(req), body(req, q.createIssue), OWNER));
  app.get('/orgs/:orgId/issues/:issueId', async (req) => issueOf(req).issue);
  app.patch('/orgs/:orgId/issues/:issueId', async (req) => {
    const { orgId, issue } = issueOf(req);
    return work.updateIssue(orgId, issue.id, body(req, q.updateIssue), OWNER);
  });
  app.post('/orgs/:orgId/issues/:issueId/assign', async (req) => {
    const { orgId, issue } = issueOf(req);
    return work.assign(orgId, issue.id, body(req, q.assignIssue).agentId, OWNER);
  });
  app.post('/orgs/:orgId/issues/:issueId/delegate', async (req) => {
    const { orgId, issue } = issueOf(req);
    return work.delegate(orgId, issue.id, body(req, q.delegateIssue).children, OWNER);
  });
  app.post('/orgs/:orgId/issues/:issueId/escalate', async (req) => {
    const { orgId, issue } = issueOf(req);
    return work.escalate(orgId, issue.id, body(req, q.escalateIssue).reason, OWNER);
  });
  app.post('/orgs/:orgId/issues/:issueId/review', async (req) => {
    const { orgId, issue } = issueOf(req);
    const { outcome, note } = body(req, q.reviewIssue);
    return work.review(orgId, issue.id, outcome, note, OWNER);
  });
  app.get('/orgs/:orgId/issues/:issueId/comments', async (req) => {
    const { orgId, issue } = issueOf(req);
    return work.listComments(orgId, issue.id, query(req, q.listCommentsQ));
  });
  app.post('/orgs/:orgId/issues/:issueId/comments', async (req) => {
    const { orgId, issue } = issueOf(req);
    return work.addComment(orgId, issue.id, body(req, q.addComment), OWNER);
  });
  app.get('/orgs/:orgId/issues/:issueId/timeline', async (req) => {
    const { orgId, issue } = issueOf(req);
    return work.timeline(orgId, issue.id);
  });

  attachmentRoutes(app, s);

  /* ── Playbooks ── */
  app.get('/orgs/:orgId/playbooks', async (req) => work.listPlaybooks(oid(req)));
  app.post('/orgs/:orgId/playbooks', async (req) => work.createPlaybook(oid(req), body(req, q.createPlaybook), OWNER));
  app.get('/orgs/:orgId/playbooks/:playbookId', async (req) => {
    const id = param(req, 'playbookId');
    const playbook = work.listPlaybooks(oid(req)).find((p) => p.id === id);
    if (!playbook) throw notFound('playbook', id);
    return playbook;
  });
  app.patch('/orgs/:orgId/playbooks/:playbookId', async (req) =>
    supported(work.updatePlaybook, 'editing a playbook').call(work, oid(req), param(req, 'playbookId'), body(req, q.updatePlaybook), OWNER));
  app.delete('/orgs/:orgId/playbooks/:playbookId', async (req): Promise<Ok> => {
    supported(work.deletePlaybook, 'deleting a playbook').call(work, oid(req), param(req, 'playbookId'), OWNER);
    return { ok: true };
  });
  app.post('/orgs/:orgId/playbooks/:playbookId/run', async (req) => {
    const orgId = oid(req);
    const issue = resolveIssue(s, orgId, body(req, q.runPlaybook).issueId);
    return work.runPlaybook(orgId, param(req, 'playbookId'), issue.id, OWNER);
  });
}
