import type { FastifyInstance } from 'fastify';
import type { Services } from '../../daemon/container.js';
import type { OrgBundle } from '../../contracts/org-work.js';
import { OWNER } from '../../contracts/types.js';
import { body, orgOf, param, query, resolveAgent, supported } from '../http.js';
import * as q from '../schemas/org-work.js';
import { optionalBody } from '../schemas/common.js';
import type { AgentActionResponse, ChatResponse, DocResponse, KillSwitchResponse, Ok, RunNowResponse } from '../types.js';

/** Organizations, departments, agents, org chart, config revisions. Human callers act as OWNER. */
export function orgRoutes(app: FastifyInstance, s: Services): void {
  const { org } = s;

  /* ── Organizations ── */
  app.get('/orgs', async (req) => org.listOrgs(query(req, q.listOrgsQ)));
  app.post('/orgs', async (req) => org.createOrg(body(req, q.createOrg), OWNER));
  app.get('/org-templates', async () => org.listTemplates());
  app.post('/orgs/from-template', async (req) => {
    const { templateId, ...input } = body(req, q.fromTemplate);
    return org.createFromTemplate(templateId, input, OWNER);
  });
  app.post('/orgs/import', async (req) => {
    const { bundle, name } = body(req, q.importOrg);
    return org.importOrg(bundle as OrgBundle, { name }, OWNER);
  });
  app.get('/orgs/:orgId', async (req) => orgOf(s, req));
  app.patch('/orgs/:orgId', async (req) => org.updateOrg(orgOf(s, req).id, body(req, q.updateOrg), OWNER));
  app.post('/orgs/:orgId/archive', async (req) => org.archiveOrg(orgOf(s, req).id, OWNER));
  app.delete('/orgs/:orgId', async (req) => org.archiveOrg(orgOf(s, req).id, OWNER));
  app.post('/orgs/:orgId/unarchive', async (req) => {
    const o = orgOf(s, req);
    const restored = supported(org.unarchiveOrg, 'restoring an archived organization').call(org, o.id, OWNER);
    s.runtime.syncSchedules();
    return restored;
  });
  app.get('/orgs/:orgId/export', async (req) => org.exportOrg(orgOf(s, req).id));
  app.get('/orgs/:orgId/chart', async (req) => org.orgChart(orgOf(s, req).id));

  app.post('/orgs/:orgId/kill-switch', async (req): Promise<KillSwitchResponse> => {
    const o = orgOf(s, req);
    s.governance.killSwitch.engage(o.id, OWNER);
    return { engaged: s.governance.killSwitch.isEngaged(o.id) };
  });
  app.delete('/orgs/:orgId/kill-switch', async (req): Promise<KillSwitchResponse> => {
    const o = orgOf(s, req);
    s.governance.killSwitch.release(o.id, OWNER);
    return { engaged: s.governance.killSwitch.isEngaged(o.id) };
  });

  app.get('/orgs/:orgId/revisions', async (req) => {
    const { entityKind, entityId } = query(req, q.revisionsQ);
    return org.listRevisions(orgOf(s, req).id, entityKind, entityId);
  });
  app.post('/orgs/:orgId/revisions/rollback', async (req): Promise<Ok> => {
    const { entityKind, entityId, revision } = body(req, q.rollbackRevision);
    org.rollback(orgOf(s, req).id, entityKind, entityId, revision, OWNER);
    s.runtime.syncSchedules();
    return { ok: true };
  });

  /* ── Departments ── */
  app.get('/orgs/:orgId/departments', async (req) => org.listDepts(orgOf(s, req).id));
  app.post('/orgs/:orgId/departments', async (req) => org.createDept(orgOf(s, req).id, body(req, q.createDept), OWNER));
  app.get('/orgs/:orgId/departments/:deptId', async (req) => org.getDept(orgOf(s, req).id, param(req, 'deptId')));
  app.patch('/orgs/:orgId/departments/:deptId', async (req) => org.updateDept(orgOf(s, req).id, param(req, 'deptId'), body(req, q.updateDept), OWNER));
  app.post('/orgs/:orgId/departments/:deptId/archive', async (req) =>
    supported(org.archiveDept, 'archiving a department').call(org, orgOf(s, req).id, param(req, 'deptId'), OWNER));
  app.post('/orgs/:orgId/departments/:deptId/unarchive', async (req) =>
    supported(org.unarchiveDept, 'restoring a department').call(org, orgOf(s, req).id, param(req, 'deptId'), OWNER));

  /* ── Agents ── */
  const agentOf = (req: Parameters<typeof orgOf>[1]) => {
    const o = orgOf(s, req);
    return { o, agent: resolveAgent(s, o.id, param(req, 'agentId')) };
  };

  app.get('/orgs/:orgId/agents', async (req) => org.listAgents(orgOf(s, req).id, query(req, q.listAgentsQ)));
  app.post('/orgs/:orgId/agents', async (req): Promise<AgentActionResponse> => {
    return org.hireAgent(orgOf(s, req).id, body(req, q.hireAgent), OWNER);
  });
  app.get('/orgs/:orgId/agents/:agentId', async (req) => agentOf(req).agent);
  app.patch('/orgs/:orgId/agents/:agentId', async (req) => {
    const { o, agent } = agentOf(req);
    return org.updateAgent(o.id, agent.id, body(req, q.updateAgent), OWNER);
  });
  app.post('/orgs/:orgId/agents/:agentId/pause', async (req) => {
    const { o, agent } = agentOf(req);
    const { reason } = body(req, optionalBody(q.pauseAgent));
    return org.pauseAgent(o.id, agent.id, reason ?? 'paused by owner', OWNER);
  });
  app.post('/orgs/:orgId/agents/:agentId/resume', async (req) => {
    const { o, agent } = agentOf(req);
    return org.resumeAgent(o.id, agent.id, OWNER);
  });
  const terminate = async (req: Parameters<typeof orgOf>[1]): Promise<AgentActionResponse> => {
    const { o, agent } = agentOf(req);
    return org.terminateAgent(o.id, agent.id, OWNER);
  };
  app.post('/orgs/:orgId/agents/:agentId/terminate', terminate);
  app.delete('/orgs/:orgId/agents/:agentId', terminate);

  app.get('/orgs/:orgId/agents/:agentId/capabilities', async (req) => {
    const { o, agent } = agentOf(req);
    return org.resolveCapabilityRefs(o.id, agent.id);
  });
  app.get('/orgs/:orgId/agents/:agentId/scorecard', async (req) => {
    const { o, agent } = agentOf(req);
    return s.memory.scorecard(o.id, agent.id, query(req, q.scorecardQ));
  });
  app.get('/orgs/:orgId/agents/:agentId/budget', async (req) => {
    const { o, agent } = agentOf(req);
    return s.governance.budgets.check(o.id, agent.id, query(req, q.budgetStatusQ).projectId ?? null);
  });
  app.get('/orgs/:orgId/agents/:agentId/memory-doc', async (req): Promise<DocResponse> => {
    const { o, agent } = agentOf(req);
    return { content: s.memory.getProfileDoc(o.id, agent.id) };
  });
  app.put('/orgs/:orgId/agents/:agentId/memory-doc', async (req): Promise<DocResponse> => {
    const { o, agent } = agentOf(req);
    s.memory.setProfileDoc(o.id, agent.id, body(req, q.docBody).content, OWNER);
    return { content: s.memory.getProfileDoc(o.id, agent.id) };
  });
  app.post('/orgs/:orgId/agents/:agentId/run', async (req): Promise<RunNowResponse> => {
    const { o, agent } = agentOf(req);
    const input = body(req, optionalBody(q.runNow));
    // `skipped` says why no run starts (paused, over budget, kill switch…) instead of a job id that silently goes nowhere.
    const r = await s.runtime.runNow(o.id, agent.id, { issueId: input.issueId ?? null, prompt: input.prompt, trigger: 'manual' });
    return { jobId: r.jobId, ...(r.skipped ? { skipped: r.skipped } : {}) };
  });
  app.post('/orgs/:orgId/agents/:agentId/chat', async (req): Promise<ChatResponse> => {
    const { o, agent } = agentOf(req);
    const input = body(req, q.chat);
    return s.runtime.chat(o.id, agent.id, input.message, { issueId: input.issueId ?? null });
  });
}
