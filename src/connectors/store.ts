import { and, desc, eq } from 'drizzle-orm';
import type { Kernel } from '../contracts/kernel.js';
import type { Connector, ConnectorGrant, Organization, ToolPin } from '../contracts/rows.js';
import type { Actor } from '../contracts/types.js';
import { configRevisions, connectorGrants, connectors, departments, organizations, runs, toolPins } from '../db/schema/index.js';
import { notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';

export const actorLabel = (actor: Actor): string => (actor.kind === 'agent' ? `agent:${actor.id ?? 'unknown'}` : (actor.id ?? actor.kind));

/** Org-scoped persistence for the connector context's own tables (plus the reads it needs). */
export class ConnectorStore {
  constructor(private readonly k: Kernel) {}

  org(orgId: string): Organization {
    const row = this.k.db.select().from(organizations).where(eq(organizations.id, orgId)).get();
    if (!row) throw notFound('organization', orgId);
    return row;
  }

  deptExists(orgId: string, deptId: string): boolean {
    return !!this.k.db.select({ id: departments.id }).from(departments).where(and(eq(departments.orgId, orgId), eq(departments.id, deptId))).get();
  }

  find(orgId: string, connectorId: string): Connector | null {
    return this.k.db.select().from(connectors).where(and(eq(connectors.orgId, orgId), eq(connectors.id, connectorId))).get() ?? null;
  }

  get(orgId: string, connectorId: string): Connector {
    const row = this.find(orgId, connectorId);
    if (!row) throw notFound('connector', connectorId);
    return row;
  }

  findByName(orgId: string, name: string): Connector | null {
    return this.k.db.select().from(connectors).where(and(eq(connectors.orgId, orgId), eq(connectors.name, name))).get() ?? null;
  }

  list(orgId: string): Connector[] {
    return this.k.db.select().from(connectors).where(eq(connectors.orgId, orgId)).orderBy(connectors.name).all();
  }

  insert(row: typeof connectors.$inferInsert): Connector {
    this.k.db.insert(connectors).values(row).run();
    return this.get(row.orgId ?? '', row.id);
  }

  patch(orgId: string, connectorId: string, patch: Partial<typeof connectors.$inferInsert>): Connector {
    this.k.db
      .update(connectors)
      .set({ ...patch, updatedAt: this.k.clock.now() })
      .where(and(eq(connectors.orgId, orgId), eq(connectors.id, connectorId)))
      .run();
    return this.get(orgId, connectorId);
  }

  /** Records a connection outcome without bumping updatedAt (which would recycle pooled clients). */
  setHealth(orgId: string, connectorId: string, lastError: string | null): void {
    this.k.db.update(connectors).set({ lastError }).where(and(eq(connectors.orgId, orgId), eq(connectors.id, connectorId))).run();
  }

  delete(orgId: string, connectorId: string): void {
    this.k.db.transaction((tx) => {
      tx.delete(connectorGrants).where(and(eq(connectorGrants.orgId, orgId), eq(connectorGrants.connectorId, connectorId))).run();
      tx.delete(toolPins).where(and(eq(toolPins.orgId, orgId), eq(toolPins.connectorId, connectorId))).run();
      tx.delete(connectors).where(and(eq(connectors.orgId, orgId), eq(connectors.id, connectorId))).run();
    });
  }

  findGrant(orgId: string, connectorId: string, agentId: string): ConnectorGrant | null {
    return (
      this.k.db
        .select()
        .from(connectorGrants)
        .where(and(eq(connectorGrants.orgId, orgId), eq(connectorGrants.connectorId, connectorId), eq(connectorGrants.agentId, agentId)))
        .get() ?? null
    );
  }

  listGrants(orgId: string, filter: { agentId?: string; connectorId?: string } = {}): ConnectorGrant[] {
    const where = [eq(connectorGrants.orgId, orgId)];
    if (filter.agentId) where.push(eq(connectorGrants.agentId, filter.agentId));
    if (filter.connectorId) where.push(eq(connectorGrants.connectorId, filter.connectorId));
    return this.k.db.select().from(connectorGrants).where(and(...where)).orderBy(connectorGrants.createdAt).all();
  }

  /** `id` names the row when a new grant is inserted (rollback restores a revoked grant under its old id). */
  upsertGrant(orgId: string, connectorId: string, agentId: string, values: Pick<ConnectorGrant, 'toolAllowlist' | 'toolPolicies' | 'defaultPolicy' | 'authRef'>, id?: string): ConnectorGrant {
    const now = this.k.clock.now();
    const existing = this.findGrant(orgId, connectorId, agentId);
    if (existing) {
      this.k.db.update(connectorGrants).set({ ...values, updatedAt: now }).where(and(eq(connectorGrants.orgId, orgId), eq(connectorGrants.id, existing.id))).run();
    } else {
      this.k.db.insert(connectorGrants).values({ id: id ?? newId('grant'), orgId, connectorId, agentId, ...values, createdAt: now, updatedAt: now }).run();
    }
    return this.findGrant(orgId, connectorId, agentId)!;
  }

  deleteGrant(orgId: string, grantId: string): void {
    this.k.db.delete(connectorGrants).where(and(eq(connectorGrants.orgId, orgId), eq(connectorGrants.id, grantId))).run();
  }

  pins(orgId: string, connectorId: string): ToolPin[] {
    return this.k.db.select().from(toolPins).where(and(eq(toolPins.orgId, orgId), eq(toolPins.connectorId, connectorId))).all();
  }

  findPin(orgId: string, connectorId: string, toolName: string): ToolPin | null {
    return (
      this.k.db.select().from(toolPins).where(and(eq(toolPins.orgId, orgId), eq(toolPins.connectorId, connectorId), eq(toolPins.toolName, toolName))).get() ?? null
    );
  }

  insertPin(orgId: string, connectorId: string, toolName: string, schemaHash: string): void {
    this.k.db.insert(toolPins).values({ orgId, connectorId, toolName, schemaHash, status: 'trusted', updatedAt: this.k.clock.now() }).run();
  }

  patchPin(orgId: string, pinId: number, patch: Partial<Pick<ToolPin, 'schemaHash' | 'pendingHash' | 'status'>>): void {
    this.k.db.update(toolPins).set({ ...patch, updatedAt: this.k.clock.now() }).where(and(eq(toolPins.orgId, orgId), eq(toolPins.id, pinId))).run();
  }

  /** Append a config revision (connectors and grants are revisioned for rollback/audit). Returns the new revision number. */
  revision(orgId: string, entityKind: 'connector' | 'connector_grant', entityId: string, snapshot: Record<string, unknown>, actor: Actor, note?: string): number {
    const last = this.k.db
      .select({ revision: configRevisions.revision })
      .from(configRevisions)
      .where(and(eq(configRevisions.entityKind, entityKind), eq(configRevisions.entityId, entityId)))
      .orderBy(desc(configRevisions.revision))
      .get();
    const revision = (last?.revision ?? 0) + 1;
    this.k.db
      .insert(configRevisions)
      .values({ id: newId('revision'), orgId, entityKind, entityId, revision, snapshot, author: actorLabel(actor), note: note ?? null, ts: this.k.clock.now() })
      .run();
    return revision;
  }

  runIngestedUntrusted(orgId: string, runId: string): boolean {
    const row = this.k.db.select({ v: runs.ingestedUntrusted }).from(runs).where(and(eq(runs.orgId, orgId), eq(runs.id, runId))).get();
    return row?.v === true;
  }

  /** The connector context's one sanctioned write to `runs`. */
  markRunUntrusted(orgId: string, runId: string): void {
    this.k.db.update(runs).set({ ingestedUntrusted: true }).where(and(eq(runs.orgId, orgId), eq(runs.id, runId))).run();
  }
}
