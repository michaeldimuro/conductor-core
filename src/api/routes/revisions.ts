import type { FastifyInstance } from 'fastify';
import type { Services } from '../../daemon/container.js';
import type { ConfigRevision } from '../../contracts/rows.js';
import { OWNER } from '../../contracts/types.js';
import { body, orgOf, param, query } from '../http.js';
import { listRevisions, revisionById, revisionOf, rollbackRevision } from '../revisions.js';
import * as q from '../schemas/org-work.js';
import type { Ok, RollbackResponse } from '../types.js';

const ORG_SERVICE_KINDS = new Set(['org', 'dept', 'agent', 'goal', 'playbook', 'project']);

/**
 * Config revision history and rollback for every revisioned kind: org chart
 * (org, dept, agent), work config (goal, playbook, project), connectors and
 * their grants / tool policies, browser profiles, gateways and webhooks.
 * A rollback is itself a new revision. Human callers act as OWNER.
 */
export function revisionRoutes(app: FastifyInstance, s: Services, reloadGateways?: () => void): void {
  app.get('/orgs/:orgId/revisions', async (req): Promise<ConfigRevision[]> => {
    const { entityKind, entityId } = query(req, q.revisionsQ);
    return listRevisions(s, orgOf(s, req).id, entityKind, entityId);
  });

  app.post('/orgs/:orgId/revisions/rollback', async (req): Promise<Ok> => {
    const { entityKind, entityId, revision } = body(req, q.rollbackRevision);
    const orgId = orgOf(s, req).id;
    if (ORG_SERVICE_KINDS.has(entityKind)) {
      // The org context looks the revision up itself (and reports an unknown one).
      s.org.rollback(orgId, entityKind, entityId, revision, OWNER);
      s.runtime.syncSchedules();
    } else {
      await rollbackRevision(s, revisionOf(s, orgId, entityKind, entityId, revision), { reloadGateways });
    }
    return { ok: true };
  });

  /** A gateway may serve every org (`org_id` NULL), so its history is addressed by gateway id alone. */
  app.get('/gateways/:gatewayId/revisions', async (req): Promise<ConfigRevision[]> => listRevisions(s, null, 'gateway', param(req, 'gatewayId')));

  /* ── By revision id (what `conductor revisions rollback <revisionId>` uses) ── */
  app.get('/revisions/:revisionId', async (req): Promise<ConfigRevision> => revisionById(s, param(req, 'revisionId')));
  app.post('/revisions/:revisionId/rollback', async (req): Promise<RollbackResponse> => {
    const rev = revisionById(s, param(req, 'revisionId'));
    await rollbackRevision(s, rev, { reloadGateways });
    const [latest] = listRevisions(s, rev.orgId, rev.entityKind, rev.entityId);
    return { ok: true, entityKind: rev.entityKind, entityId: rev.entityId, rolledBackTo: rev.revision, revision: latest?.revision ?? rev.revision };
  });
}
