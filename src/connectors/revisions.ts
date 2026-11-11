import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Kernel } from '../contracts/kernel.js';
import type { ConfigRevision, Connector } from '../contracts/rows.js';
import type { OrgService } from '../contracts/org-work.js';
import type { Actor } from '../contracts/types.js';
import { configRevisions } from '../db/schema/index.js';
import { CONNECTOR_KINDS } from '../db/schema/capabilities.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import { findTemplate } from './catalog.js';
import { assertNoSecrets, parseConfig } from './config.js';
import type { ConnectorStore } from './store.js';

/** Revision kinds the connector context records and can roll back. */
export const CONNECTOR_REVISION_KINDS = ['connector', 'connector_grant'] as const;
export type ConnectorRevisionKind = (typeof CONNECTOR_REVISION_KINDS)[number];

export interface RevisionDeps {
  org: Pick<OrgService, 'getAgent'>;
  /** Drop pooled upstream clients after a connector's config changed. */
  invalidate: (connectorId: string) => Promise<void>;
  /** Grants to agents outside a department-scoped connector's department no longer stand. */
  dropOutOfScopeGrants: (orgId: string, connector: Connector, actor: Actor) => void;
}

const policy = z.enum(['allowed', 'ask', 'off']);
const nullableStr = z.string().min(1).nullish().transform((v) => v ?? null);
const allowlist = z.array(z.string()).nullish().transform((v) => v ?? null);

/** What `ConnectorRegistry` snapshots for a connector. Credentials are never part of it: only `authRef`. */
const connectorSnapshot = z.object({
  name: z.string().min(1),
  kind: z.enum(CONNECTOR_KINDS),
  scope: z.enum(['global', 'org', 'dept', 'agent']).default('org'),
  scopeId: nullableStr,
  config: z.record(z.string(), z.unknown()).default({}),
  authRef: nullableStr,
  toolAllowlist: allowlist,
  templateId: nullableStr,
  status: z.string().catch('active'),
  removed: z.boolean().optional(),
});

const grantSnapshot = z.object({
  connectorId: z.string().min(1),
  agentId: z.string().min(1),
  toolAllowlist: allowlist,
  toolPolicies: z.record(z.string(), policy).default({}),
  defaultPolicy: policy.default('allowed'),
  authRef: nullableStr,
  revoked: z.boolean().optional(),
});

function read<S extends z.ZodType>(schema: S, rev: ConfigRevision): z.output<S> {
  const r = schema.safeParse(rev.snapshot);
  if (!r.success) throw invalid(`revision ${rev.revision} of ${rev.entityKind} ${rev.entityId} cannot be restored: snapshot is malformed`);
  return r.data;
}

/**
 * Rollback for connectors (config, scope, allowlist, status) and connector
 * grants (tool allowlist, per-tool policies, default policy). A rollback is a
 * new revision; a connector or grant that was removed since is re-created
 * under its old id. Secrets are not part of any revision: a restored
 * connector points at the same `authRef` and may need its credentials
 * supplied again.
 */
export class ConnectorRevisions {
  constructor(
    private readonly k: Kernel,
    private readonly store: ConnectorStore,
    private readonly deps: RevisionDeps,
  ) {}

  private find(orgId: string, kind: ConnectorRevisionKind, entityId: string, revision: number): ConfigRevision {
    const row = this.k.db.select().from(configRevisions).where(and(
      eq(configRevisions.orgId, orgId), eq(configRevisions.entityKind, kind), eq(configRevisions.entityId, entityId), eq(configRevisions.revision, revision),
    )).get();
    if (!row) throw notFound(`${kind} revision`, `${entityId}@${revision}`);
    return row;
  }

  async rollback(orgId: string, entityKind: string, entityId: string, revision: number, actor: Actor): Promise<void> {
    if (actor.kind === 'agent') throw forbidden('agents may not roll back configuration; this is a board action');
    if (!(CONNECTOR_REVISION_KINDS as readonly string[]).includes(entityKind)) {
      throw invalid(`unsupported entity kind "${entityKind}" (expected ${CONNECTOR_REVISION_KINDS.join(', ')})`);
    }
    this.store.org(orgId);
    const kind = entityKind as ConnectorRevisionKind;
    const rev = this.find(orgId, kind, entityId, revision);
    if (kind === 'connector') await this.rollbackConnector(orgId, entityId, rev, actor);
    else this.rollbackGrant(orgId, entityId, rev, actor);
  }

  private async rollbackConnector(orgId: string, connectorId: string, rev: ConfigRevision, actor: Actor): Promise<void> {
    const snap = read(connectorSnapshot, rev);
    if (snap.removed) throw invalid(`revision ${rev.revision} records the removal of this connector; roll back to an earlier revision to restore it`);
    const config = parseConfig(snap.kind, snap.config) as Record<string, unknown>;
    assertNoSecrets(config);
    const clash = this.store.findByName(orgId, snap.name);
    if (clash && clash.id !== connectorId) throw conflict(`cannot roll back: another connector is now named "${snap.name}"`);
    let scope: { scope: 'org' | 'dept'; scopeId: string } = { scope: 'org', scopeId: orgId };
    if (snap.scope === 'dept') {
      if (!snap.scopeId || !this.store.deptExists(orgId, snap.scopeId)) throw conflict('cannot roll back: the connector\'s department no longer exists');
      scope = { scope: 'dept', scopeId: snap.scopeId };
    }
    const fields = {
      name: snap.name, kind: snap.kind, ...scope, config, authRef: snap.authRef, toolAllowlist: snap.toolAllowlist,
      templateId: snap.templateId && findTemplate(snap.templateId) ? snap.templateId : null,
      // A recorded transient state (error) is not something to restore to.
      status: snap.status === 'disabled' ? ('disabled' as const) : ('active' as const),
      lastError: null,
    };
    const existing = this.store.find(orgId, connectorId);
    const now = this.k.clock.now();
    const row = existing
      ? this.store.patch(orgId, connectorId, fields)
      : this.store.insert({ id: connectorId, orgId, ...fields, createdAt: now, updatedAt: now });
    this.deps.dropOutOfScopeGrants(orgId, row, actor);
    const next = this.store.revision(orgId, 'connector', row.id, {
      name: row.name, kind: row.kind, scope: row.scope, scopeId: row.scopeId, config: row.config, authRef: row.authRef,
      toolAllowlist: row.toolAllowlist, templateId: row.templateId, status: row.status,
    }, actor, `rollback to revision ${rev.revision}`);
    this.k.audit.record({
      orgId, actor, action: 'config.changed', entityKind: 'connector', entityId: row.id,
      data: { change: 'rollback', rollbackTo: rev.revision, revision: next, restored: !existing },
    });
    await this.deps.invalidate(connectorId);
  }

  private rollbackGrant(orgId: string, grantId: string, rev: ConfigRevision, actor: Actor): void {
    const snap = read(grantSnapshot, rev);
    if (snap.revoked) throw invalid(`revision ${rev.revision} records the revocation of this grant; roll back to an earlier revision to restore it`);
    const connector = this.store.find(orgId, snap.connectorId);
    if (!connector) throw conflict('cannot roll back: the connector this grant belongs to no longer exists');
    let agent;
    try {
      agent = this.deps.org.getAgent(orgId, snap.agentId);
    } catch {
      throw conflict('cannot roll back: the agent this grant belongs to no longer exists');
    }
    if (agent.orgId !== orgId || agent.status === 'terminated') throw conflict('cannot roll back: the agent this grant belongs to is no longer available');
    if (connector.scope === 'dept' && connector.scopeId !== agent.deptId) {
      throw conflict(`cannot roll back: connector "${connector.name}" is now scoped to another department`);
    }
    const values = { toolAllowlist: snap.toolAllowlist, toolPolicies: snap.toolPolicies, defaultPolicy: snap.defaultPolicy, authRef: snap.authRef };
    const current = this.store.findGrant(orgId, connector.id, agent.id);
    // Revoked since: the grant comes back under its old id, so its history stays in one place.
    const grant = this.store.upsertGrant(orgId, connector.id, agent.id, values, current ? undefined : grantId);
    const next = this.store.revision(orgId, 'connector_grant', grant.id, {
      connectorId: grant.connectorId, agentId: grant.agentId, toolAllowlist: grant.toolAllowlist, toolPolicies: grant.toolPolicies,
      defaultPolicy: grant.defaultPolicy, authRef: grant.authRef,
    }, actor, `rollback to revision ${rev.revision}`);
    this.k.audit.record({
      orgId, actor, action: 'config.changed', entityKind: 'connector_grant', entityId: grant.id,
      data: { change: 'rollback', rollbackTo: rev.revision, revision: next, restored: !current, connectorId: connector.id, agentId: agent.id },
    });
  }
}
