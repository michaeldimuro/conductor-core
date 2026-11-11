import type { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { Actor, ToolPolicy } from '../contracts/types.js';
import type { Organization } from '../contracts/rows.js';
import { errorMessage } from '../shared/errors.js';
import { persistAgent } from './agents.js';
import { connectorSchema, grantSchema, memorySchema, profileDocSchema, type skillSchema } from './bundle-schemas.js';
import type { Ctx } from './context.js';
import { persistDept } from './departments.js';
import { persistOrg } from './orgs.js';
import { findAgentRow, findDept, requireOrg } from './repo.js';
import { redactText } from './sanitize.js';

/** Something the owner must re-supply a credential for after an import. */
export interface CredentialGap {
  kind: 'provider' | 'connector' | 'grant';
  name: string;
}

export interface CapabilityInput {
  skills: Array<z.infer<typeof skillSchema>>;
  connectors: Array<Record<string, unknown>>;
  grants: Array<Record<string, unknown>>;
  memories: Array<Record<string, unknown>>;
  profileDocs: Array<Record<string, unknown>>;
  ownerModel: string;
  /** Connector-id lists as they were in the source org (old connector ids, new owner ids). */
  connectorLists: {
    org: string[];
    depts: Array<{ id: string | null; shared: string[] }>;
    agents: Array<{ id: string | null; own: string[]; deny: string[] }>;
  };
  /** Gaps already found while importing the structure (provider bindings). */
  credentialGaps: CredentialGap[];
  mapAgent(oldId: unknown): string | null;
  mapDept(oldId: unknown): string | null;
  deptBySlug: Map<string, string>;
  agentBySlug: Map<string, string>;
}

const REDACTED = '[REDACTED]';
const orUndef = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

/** Split SKILL.md into its frontmatter description and instruction body. */
function splitSkillDoc(doc: string): { description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(doc);
  if (!m) return { description: '', body: doc };
  let description = '';
  try {
    const fm = parseYaml(m[1] ?? '') as unknown;
    if (fm && typeof fm === 'object' && typeof (fm as Record<string, unknown>).description === 'string') {
      description = (fm as Record<string, string>).description ?? '';
    }
  } catch {
    // Malformed frontmatter: keep the body, leave the description empty.
  }
  return { description, body: m[2] ?? '' };
}

const safeRelPath = (p: string): boolean =>
  !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

/**
 * Second phase of an import: re-create everything owned by other contexts
 * through their contracts — skills (SkillService), connectors and grants
 * (ConnectorGateway), memories and standing-rules documents (MemoryService) —
 * then point the org's, departments' and agents' connector lists at the new
 * connector ids. Each item is independent: a failure is recorded and the rest
 * still imports. A missing dep skips its items (counted in `skipped`).
 *
 * Credentials never travel in a bundle. A connector that had one is installed
 * disabled, and every gap (connector, grant, provider binding) is listed in
 * the `org.import_completed` audit record and announced with a notification.
 */
export async function restoreCapabilities(ctx: Ctx, org: Organization, actor: Actor, input: CapabilityInput): Promise<void> {
  const k = ctx.kernel;
  const counts = { skills: 0, connectors: 0, grants: 0, memories: 0, profileDocs: 0, skipped: 0 };
  const failures: string[] = [];
  const gaps: CredentialGap[] = [...input.credentialGaps];
  // Deps are read here, not captured earlier, so late binding via setImportDeps works.
  const { skills, memory, connectors } = ctx.deps;

  for (const entry of input.skills) {
    const target =
      entry.scope === 'org' ? org.id : entry.scope === 'dept' ? input.deptBySlug.get(entry.scopeSlug ?? '') ?? null : input.agentBySlug.get(entry.scopeSlug ?? '') ?? null;
    const doc = entry.files['SKILL.md'];
    if (!skills || !target || doc === undefined) {
      counts.skipped++;
      continue;
    }
    const { description, body } = splitSkillDoc(redactText(doc));
    const files: Record<string, string> = {};
    for (const [path, content] of Object.entries(entry.files)) {
      if (path !== 'SKILL.md' && safeRelPath(path)) files[path] = redactText(content);
    }
    try {
      // A skill that was active in the exported org stays active; everything else is a draft until reviewed.
      const status = entry.status === 'active' ? 'active' : 'draft';
      await skills.upsert(org.id, { scope: entry.scope, scopeId: target, name: entry.name, description, body, files, status }, actor);
      counts.skills++;
    } catch (err) {
      failures.push(`skill ${entry.name}: ${errorMessage(err)}`);
    }
  }

  const connectorIdMap = new Map<string, string>();
  const connectorNames = new Map<string, string>();
  for (const raw of input.connectors) {
    const parsed = connectorSchema.safeParse(raw);
    const scopeId = parsed.success && parsed.data.scope === 'dept' ? input.mapDept(parsed.data.scopeId) : null;
    if (!connectors || !parsed.success || (parsed.data.scope === 'dept' && !scopeId)) {
      counts.skipped++;
      continue;
    }
    const c = parsed.data;
    try {
      const installed = await connectors.install(org.id, {
        name: c.name,
        kind: c.kind,
        scope: c.scope,
        scopeId,
        config: c.config,
        authRef: null,
        toolAllowlist: c.toolAllowlist ?? null,
        templateId: c.templateId ?? null,
      }, actor);
      connectorIdMap.set(c.id, installed.id);
      connectorNames.set(c.id, c.name);
      counts.connectors++;
      // A credential was bound (or redacted out of the config): unusable until the owner re-supplies it.
      const needsCredential = c.needsCredential || JSON.stringify(c.config).includes(REDACTED);
      if (needsCredential) gaps.push({ kind: 'connector', name: c.name });
      if (needsCredential || c.status === 'disabled') await connectors.update(org.id, installed.id, { status: 'disabled' }, actor);
    } catch (err) {
      failures.push(`connector ${c.name}: ${errorMessage(err)}`);
    }
  }

  for (const raw of input.grants) {
    const parsed = grantSchema.safeParse(raw);
    const connectorId = parsed.success ? connectorIdMap.get(parsed.data.connectorId) : undefined;
    const agentId = parsed.success ? input.mapAgent(parsed.data.agentId) : null;
    if (!connectors || !parsed.success || !connectorId || !agentId) {
      counts.skipped++;
      continue;
    }
    const g = parsed.data;
    const label = `${connectorNames.get(g.connectorId) ?? g.connectorId} → ${findAgentRow(k, org.id, agentId)?.slug ?? agentId}`;
    try {
      const toolPolicies: Record<string, ToolPolicy> = {};
      for (const p of g.policies) toolPolicies[p.tool] = p.policy;
      const result = connectors.grant(org.id, connectorId, agentId, { toolAllowlist: g.toolAllowlist ?? null, toolPolicies, defaultPolicy: g.defaultPolicy, authRef: null }, actor);
      if (!result.grant) throw new Error('the grant was not applied (approval pending)');
      counts.grants++;
      if (g.needsCredential) gaps.push({ kind: 'grant', name: label });
    } catch (err) {
      failures.push(`grant ${label}: ${errorMessage(err)}`);
    }
  }

  if (connectorIdMap.size > 0) {
    try {
      relinkConnectors(ctx, org.id, actor, input.connectorLists, connectorIdMap);
    } catch (err) {
      failures.push(`connector lists: ${errorMessage(err)}`);
    }
  }

  for (const raw of input.memories) {
    const parsed = memorySchema.safeParse(raw);
    const scopeId = !parsed.success
      ? null
      : parsed.data.scope === 'org' ? org.id : parsed.data.scope === 'dept' ? input.mapDept(parsed.data.scopeId) : input.mapAgent(parsed.data.scopeId);
    if (!memory || !parsed.success || !scopeId) {
      counts.skipped++;
      continue;
    }
    const m = parsed.data;
    try {
      await memory.write(org.id, {
        scope: m.scope,
        scopeId,
        kind: m.kind,
        content: m.content,
        entity: m.entity ?? null,
        taskType: m.taskType ?? null,
        importance: orUndef(m.importance),
        confidence: orUndef(m.confidence),
        pinned: orUndef(m.pinned),
        author: 'import',
      }, actor);
      counts.memories++;
    } catch (err) {
      failures.push(`memory: ${errorMessage(err)}`);
    }
  }

  for (const raw of input.profileDocs) {
    const parsed = profileDocSchema.safeParse(raw);
    const agentId = parsed.success ? input.mapAgent(parsed.data.agentId) : null;
    if (!memory?.setProfileDoc || !parsed.success || !agentId) {
      counts.skipped++;
      continue;
    }
    try {
      memory.setProfileDoc(org.id, agentId, redactText(parsed.data.content), actor);
      counts.profileDocs++;
    } catch (err) {
      failures.push(`MEMORY.md: ${errorMessage(err)}`);
    }
  }
  if (input.ownerModel.trim()) {
    if (!memory?.setOwnerModel) counts.skipped++;
    else {
      try {
        memory.setOwnerModel(org.id, redactText(input.ownerModel), actor);
        counts.profileDocs++;
      } catch (err) {
        failures.push(`owner model: ${errorMessage(err)}`);
      }
    }
  }

  if (failures.length > 0) k.log.warn({ orgId: org.id, failures: failures.slice(0, 20) }, 'org import: some items failed');
  k.audit.record({
    orgId: org.id,
    actor,
    action: 'org.import_completed',
    entityKind: 'org',
    entityId: org.id,
    data: { ...counts, failed: failures.length, failures: failures.slice(0, 20), needsCredential: gaps.slice(0, 200) },
  });
  if (gaps.length > 0) {
    k.bus.emit('notification', {
      orgId: org.id,
      kind: 'org.import_needs_credentials',
      title: `${org.name}: ${gaps.length} imported item(s) need a credential`,
      body: gaps.slice(0, 50).map((g) => `${g.kind}: ${g.name}`).join('\n'),
      link: `/orgs/${org.id}/connectors`,
      data: { needsCredential: gaps.slice(0, 200) },
    });
  }
}

/** Rewrite the connector-id lists of the org, its departments and its agents onto the newly installed connectors. */
function relinkConnectors(
  ctx: Ctx,
  orgId: string,
  actor: Actor,
  lists: CapabilityInput['connectorLists'],
  idMap: Map<string, string>,
): void {
  const k = ctx.kernel;
  const remap = (ids: string[]): string[] => [...new Set(ids.flatMap((id) => idMap.get(id) ?? []))];
  const note = 'connectors restored from bundle';
  ctx.mutate(() => {
    const defaults = remap(lists.org);
    if (defaults.length > 0) {
      persistOrg(ctx, requireOrg(k, orgId), { defaultConnectors: defaults }, actor, { action: 'config.changed', note, data: { change: 'org.updated' } });
    }
    for (const d of lists.depts) {
      const shared = remap(d.shared);
      const dept = d.id ? findDept(k, orgId, d.id) : undefined;
      if (dept && shared.length > 0) persistDept(ctx, dept, { sharedConnectors: shared }, actor, note);
    }
    for (const a of lists.agents) {
      const own = remap(a.own);
      const deny = remap(a.deny);
      const agent = a.id ? findAgentRow(k, orgId, a.id) : undefined;
      if (!agent || (own.length === 0 && deny.length === 0)) continue;
      persistAgent(ctx, agent, { connectors: own, denyConnectors: deny }, actor, {
        action: 'config.changed', note, event: 'agent.updated', data: { change: 'agent.updated' },
      });
    }
  });
}
