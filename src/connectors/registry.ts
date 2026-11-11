import { z } from 'zod';
import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Approval, Connector, ConnectorGrant } from '../contracts/rows.js';
import type { ApprovalService, GrantInput, InstallConnectorInput } from '../contracts/services.js';
import type { OrgService } from '../contracts/org-work.js';
import { SYSTEM, type Actor } from '../contracts/types.js';
import { conflict, errorMessage, forbidden, invalid, notFound } from '../shared/errors.js';
import { newId, slugify } from '../shared/ids.js';
import { sha256, stableStringify } from '../shared/util.js';
import { findTemplate } from './catalog.js';
import { assertNoSecrets, grantSchema, idSchema, installSchema, parseConfig, parseWith, templateInstallSchema, updateSchema } from './config.js';
import type { ConnectorStore } from './store.js';

export interface RegistryDeps {
  approvals: ApprovalService;
  org: Pick<OrgService, 'getAgent' | 'resolveCapabilityRefs'>;
  /** Drop pooled upstream clients after a connector's config or credentials changed. */
  invalidate: (connectorId: string) => Promise<void>;
}

const GRANT_SOURCE = 'connector_gateway';

const grantApprovalPayload = z.object({
  source: z.literal(GRANT_SOURCE),
  matchKey: z.string().min(1),
  connectorId: z.string().min(1),
  agentId: z.string().min(1),
  grant: grantSchema,
});

function assertOperator(actor: Actor, what: string): void {
  if (actor.kind === 'agent') throw forbidden(`agents may not ${what}`);
}

/** A department-scoped connector belongs to that department: it cannot be granted to an agent of another one. */
function assertInScope(connector: Connector, agent: Pick<Agent, 'deptId' | 'name'>): void {
  if (connector.scope === 'dept' && connector.scopeId !== agent.deptId) {
    throw forbidden(`connector "${connector.name}" is scoped to another department and cannot be granted to ${agent.name}`);
  }
}

const snapshotOf = (c: Connector): Record<string, unknown> => ({
  name: c.name, kind: c.kind, scope: c.scope, scopeId: c.scopeId, config: c.config, authRef: c.authRef,
  toolAllowlist: c.toolAllowlist, templateId: c.templateId, status: c.status,
});

/** Install / update / remove connectors and grant them to agents (PRD "Per-agent scoping"). */
export class ConnectorRegistry {
  constructor(
    private readonly k: Kernel,
    private readonly store: ConnectorStore,
    private readonly deps: RegistryDeps,
  ) {}

  /** Apply approved `grant_connector` approvals filed by this context. Returns the unsubscribe fn. */
  subscribe(): () => void {
    return this.k.bus.on('approval.decided', (e) => {
      if (e.status !== 'approved') return;
      try {
        this.applyApprovedGrant(e.orgId, e.approvalId);
      } catch (err) {
        this.k.log.warn({ approvalId: e.approvalId, err: errorMessage(err) }, 'could not apply approved connector grant');
      }
    });
  }

  private scopeOf(orgId: string, scope: 'org' | 'dept' | undefined, scopeId: string | null | undefined): { scope: 'org' | 'dept'; scopeId: string } {
    if (scope === 'dept') {
      if (!scopeId || !this.store.deptExists(orgId, scopeId)) throw notFound('department', scopeId ?? undefined);
      return { scope: 'dept', scopeId };
    }
    return { scope: 'org', scopeId: orgId };
  }

  install(orgId: string, rawInput: InstallConnectorInput, actor: Actor): Connector {
    assertOperator(actor, 'install connectors');
    this.store.org(orgId);
    const input = parseWith(installSchema, rawInput, 'connector');
    const config = parseConfig(input.kind, input.config) as Record<string, unknown>;
    assertNoSecrets(config);
    if (this.store.findByName(orgId, input.name)) throw conflict(`a connector named "${input.name}" already exists in this org`);
    if (input.templateId && !findTemplate(input.templateId)) throw notFound('connector template', input.templateId);
    const now = this.k.clock.now();
    const row = this.store.insert({
      id: newId('connector'), orgId, ...this.scopeOf(orgId, input.scope, input.scopeId), kind: input.kind, name: input.name,
      templateId: input.templateId ?? null, config, authRef: input.authRef ?? null, toolAllowlist: input.toolAllowlist ?? null,
      status: 'active', createdAt: now, updatedAt: now,
    });
    this.store.revision(orgId, 'connector', row.id, snapshotOf(row), actor, 'installed');
    this.k.audit.record({ orgId, actor, action: 'connector.installed', entityKind: 'connector', entityId: row.id, data: { name: row.name, kind: row.kind, scope: row.scope, templateId: row.templateId } });
    return row;
  }

  async installFromTemplate(orgId: string, templateId: string, rawInput: unknown, actor: Actor): Promise<Connector> {
    assertOperator(actor, 'install connectors');
    const template = findTemplate(parseWith(idSchema, templateId, 'template id'));
    if (!template) throw notFound('connector template', templateId);
    const org = this.store.org(orgId);
    const input = parseWith(templateInstallSchema, rawInput ?? {}, 'template install');
    const name = input.name ?? template.id;
    // Secrets live only in the secret store, namespaced per org + connector; the row keeps the ref.
    const authRef = `org/${org.slug}/connector/${slugify(name)}`;
    const row = this.install(
      orgId,
      { name, kind: template.kind, scope: input.scope, scopeId: input.scopeId, config: { ...template.config, ...(input.config ?? {}) }, authRef, templateId: template.id },
      actor,
    );
    try {
      for (const [secretName, value] of Object.entries(input.secrets ?? {})) await this.k.secrets.set(`${authRef}/${secretName}`, value);
    } catch (e) {
      this.store.delete(orgId, row.id);
      throw e;
    }
    return row;
  }

  async update(orgId: string, connectorId: string, rawPatch: Partial<InstallConnectorInput> & { status?: Connector['status'] }, actor: Actor): Promise<Connector> {
    assertOperator(actor, 'change connectors');
    const current = this.store.get(orgId, connectorId);
    const patch = parseWith(updateSchema, rawPatch, 'connector patch');
    const kind = patch.kind ?? current.kind;
    const set: Parameters<ConnectorStore['patch']>[2] = {};
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.config !== undefined || patch.kind !== undefined) {
      const config = parseConfig(kind, patch.config ?? current.config) as Record<string, unknown>;
      assertNoSecrets(config);
      set.config = config;
    }
    if (patch.name !== undefined && patch.name !== current.name) {
      if (this.store.findByName(orgId, patch.name)) throw conflict(`a connector named "${patch.name}" already exists in this org`);
      set.name = patch.name;
    }
    if (patch.scope !== undefined || patch.scopeId !== undefined) Object.assign(set, this.scopeOf(orgId, patch.scope ?? (current.scope === 'dept' ? 'dept' : 'org'), patch.scopeId ?? current.scopeId));
    if (patch.authRef !== undefined) set.authRef = patch.authRef;
    if (patch.toolAllowlist !== undefined) set.toolAllowlist = patch.toolAllowlist;
    if (patch.templateId !== undefined) set.templateId = patch.templateId;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.status === 'active') set.lastError = null;
    const row = this.store.patch(orgId, connectorId, set);
    this.dropOutOfScopeGrants(orgId, row, actor);
    this.store.revision(orgId, 'connector', row.id, snapshotOf(row), actor, 'updated');
    this.k.audit.record({ orgId, actor, action: 'connector.updated', entityKind: 'connector', entityId: row.id, data: { fields: Object.keys(set) } });
    await this.deps.invalidate(connectorId);
    return row;
  }

  /** After a connector was re-scoped to a department: grants to agents outside it no longer stand. */
  private dropOutOfScopeGrants(orgId: string, connector: Connector, actor: Actor): void {
    if (connector.scope !== 'dept') return;
    for (const grant of this.store.listGrants(orgId, { connectorId: connector.id })) {
      let deptId: string | null = null;
      try {
        deptId = this.deps.org.getAgent(orgId, grant.agentId).deptId;
      } catch {
        // The agent is gone: its grant goes too.
      }
      if (deptId === connector.scopeId) continue;
      this.store.revision(orgId, 'connector_grant', grant.id, { connectorId: connector.id, agentId: grant.agentId, revoked: true }, actor, 'out of scope');
      this.store.deleteGrant(orgId, grant.id);
      this.k.audit.record({
        orgId, actor, action: 'connector.grant_revoked', entityKind: 'connector_grant', entityId: grant.id,
        data: { connectorId: connector.id, agentId: grant.agentId, reason: 'connector re-scoped to another department' },
      });
    }
  }

  async remove(orgId: string, connectorId: string, actor: Actor): Promise<void> {
    assertOperator(actor, 'remove connectors');
    const row = this.store.get(orgId, connectorId);
    await this.deps.invalidate(connectorId);
    this.store.revision(orgId, 'connector', row.id, { ...snapshotOf(row), removed: true }, actor, 'removed');
    this.store.delete(orgId, connectorId);
    const org = this.store.org(orgId);
    const template = findTemplate(row.templateId);
    // Template installs own their secret namespace; clean it up with the connector.
    if (template && row.authRef === `org/${org.slug}/connector/${slugify(row.name)}`) {
      for (const s of template.requiredSecrets) await this.k.secrets.delete(`${row.authRef}/${s}`).catch(() => undefined);
    }
    this.k.audit.record({ orgId, actor, action: 'connector.removed', entityKind: 'connector', entityId: row.id, data: { name: row.name, kind: row.kind } });
  }

  grant(orgId: string, connectorId: string, agentId: string, rawInput: GrantInput, actor: Actor): { grant?: ConnectorGrant; approval?: Approval } {
    const connector = this.store.get(orgId, connectorId);
    const agent = this.deps.org.getAgent(orgId, agentId);
    if (agent.orgId !== orgId) throw notFound('agent', agentId);
    const input = parseWith(grantSchema, rawInput ?? {}, 'grant');
    assertInScope(connector, agent);
    const needsApproval = actor.kind === 'agent' || (actor.kind !== 'human' && this.deps.approvals.requiresApproval(orgId, 'grant_connector'));
    if (!needsApproval) return { grant: this.applyGrant(orgId, connector, agentId, input, actor) };

    const matchKey = sha256(`grant|${connectorId}|${agentId}|${stableStringify(input)}`);
    const open = this.deps.approvals.findOpen(orgId, 'grant_connector', matchKey);
    if (open) return { approval: open };
    const approval = this.deps.approvals.request({
      orgId,
      kind: 'grant_connector',
      title: `Grant connector "${connector.name}" to ${agent.name}`,
      payload: { source: GRANT_SOURCE, matchKey, connectorId, agentId, connectorName: connector.name, agentName: agent.name, grant: input },
      requesterAgentId: actor.kind === 'agent' ? (actor.id ?? null) : null,
      runId: actor.runId ?? null,
    });
    return { approval };
  }

  private applyApprovedGrant(orgId: string, approvalId: string): void {
    const approval = this.deps.approvals.get(orgId, approvalId);
    if (approval.kind !== 'grant_connector' || approval.status !== 'approved') return;
    const parsed = grantApprovalPayload.safeParse(approval.payload);
    if (!parsed.success) return; // filed by another context
    const p = parsed.data;
    const consumed = this.deps.approvals.consume(orgId, 'grant_connector', p.matchKey);
    if (!consumed) return;
    const connector = this.store.get(orgId, p.connectorId);
    // Re-checked at apply time: the agent may have moved department since the request was filed.
    assertInScope(connector, this.deps.org.getAgent(orgId, p.agentId));
    this.applyGrant(orgId, connector, p.agentId, p.grant, SYSTEM, consumed.id);
  }

  private applyGrant(orgId: string, connector: Connector, agentId: string, input: z.infer<typeof grantSchema>, actor: Actor, approvalId?: string): ConnectorGrant {
    const existing = this.store.findGrant(orgId, connector.id, agentId);
    const grant = this.store.upsertGrant(orgId, connector.id, agentId, {
      toolAllowlist: input.toolAllowlist !== undefined ? input.toolAllowlist : (existing?.toolAllowlist ?? null),
      toolPolicies: input.toolPolicies ?? existing?.toolPolicies ?? {},
      defaultPolicy: input.defaultPolicy ?? existing?.defaultPolicy ?? 'allowed',
      authRef: input.authRef !== undefined ? input.authRef : (existing?.authRef ?? null),
    });
    this.store.revision(orgId, 'connector_grant', grant.id, {
      connectorId: grant.connectorId, agentId: grant.agentId, toolAllowlist: grant.toolAllowlist, toolPolicies: grant.toolPolicies,
      defaultPolicy: grant.defaultPolicy, authRef: grant.authRef,
    }, actor, approvalId ? `approved by ${approvalId}` : existing ? 'updated' : 'granted');
    this.k.audit.record({
      orgId, actor, action: 'connector.granted', entityKind: 'connector_grant', entityId: grant.id,
      data: { connectorId: connector.id, connectorName: connector.name, agentId, approvalId: approvalId ?? null, updated: !!existing },
    });
    return grant;
  }

  revokeGrant(orgId: string, connectorId: string, agentId: string, actor: Actor): void {
    assertOperator(actor, 'revoke connector grants');
    this.store.get(orgId, connectorId);
    const grant = this.store.findGrant(orgId, connectorId, agentId);
    if (!grant) throw notFound('connector grant');
    this.store.revision(orgId, 'connector_grant', grant.id, { connectorId, agentId, revoked: true }, actor, 'revoked');
    this.store.deleteGrant(orgId, grant.id);
    this.k.audit.record({ orgId, actor, action: 'connector.grant_revoked', entityKind: 'connector_grant', entityId: grant.id, data: { connectorId, agentId } });
  }

  retrustTool(orgId: string, connectorId: string, toolName: string, actor: Actor): void {
    assertOperator(actor, 're-trust tools');
    this.store.get(orgId, connectorId);
    const pin = this.store.findPin(orgId, connectorId, toolName);
    if (!pin) throw notFound('tool pin', toolName);
    if (pin.status !== 'quarantined' || !pin.pendingHash) throw invalid(`tool "${toolName}" is not quarantined`);
    this.store.patchPin(orgId, pin.id, { schemaHash: pin.pendingHash, pendingHash: null, status: 'trusted' });
    this.k.audit.record({
      orgId, actor, action: 'tool.retrusted', entityKind: 'connector', entityId: connectorId,
      data: { tool: toolName, previousHash: pin.schemaHash, schemaHash: pin.pendingHash },
    });
  }
}
