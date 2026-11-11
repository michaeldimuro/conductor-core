import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Services } from '../../daemon/container.js';
import { OWNER } from '../../contracts/types.js';
import { body, orgOf, param, query } from '../http.js';
import * as q from '../schemas/org-work.js';
import { optionalBody } from '../schemas/common.js';
import type { Ok } from '../types.js';

/** Runs + transcripts, approvals (per org and the cross-org inbox), budgets, activity log. */
export function runRoutes(app: FastifyInstance, s: Services): void {
  const oid = (req: FastifyRequest): string => orgOf(s, req).id;
  const { approvals, budgets } = s.governance;

  /* ── Runs ── */
  app.get('/orgs/:orgId/runs', async (req) => s.runtime.listRuns(oid(req), query(req, q.listRunsQ)));
  app.get('/orgs/:orgId/runs/:runId', async (req) => s.runtime.getRun(oid(req), param(req, 'runId')));
  app.get('/orgs/:orgId/runs/:runId/transcript', async (req) => s.runtime.transcript(oid(req), param(req, 'runId'), query(req, q.transcriptQ)));
  app.post('/orgs/:orgId/runs/:runId/cancel', async (req): Promise<Ok> => {
    const orgId = oid(req);
    const { reason } = body(req, optionalBody(q.cancelRun));
    await s.runtime.cancelRun(orgId, param(req, 'runId'), reason);
    return { ok: true };
  });

  /* ── Approvals ── */
  app.get('/approvals', async (req) => approvals.list(null, query(req, q.listApprovalsQ)));
  app.get('/orgs/:orgId/approvals', async (req) => approvals.list(oid(req), query(req, q.listApprovalsQ)));
  app.get('/orgs/:orgId/approvals/:approvalId', async (req) => approvals.get(oid(req), param(req, 'approvalId')));
  app.post('/orgs/:orgId/approvals/:approvalId/decide', async (req) => {
    const orgId = oid(req);
    const { decision, note } = body(req, q.decideApproval);
    return approvals.decide(orgId, param(req, 'approvalId'), decision, OWNER, note);
  });

  /* ── Budgets ── */
  app.get('/orgs/:orgId/budget/summary', async (req) => budgets.summary(oid(req), query(req, q.budgetSummaryQ)));
  app.get('/orgs/:orgId/budget/ledger', async (req) => budgets.ledger(oid(req), query(req, q.ledgerQ)));

  /* ── Activity ── */
  app.get('/orgs/:orgId/activity', async (req) => {
    const orgId = oid(req);
    const filter = query(req, q.activityQ);
    return s.kernel.audit.query({ ...filter, orgId, limit: filter.limit ?? 200 });
  });
}
