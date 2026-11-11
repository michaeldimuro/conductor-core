import { z } from 'zod';
import { playbooks, projects } from '../db/schema/index.js';
import type { Actor } from '../contracts/types.js';
import type { Organization } from '../contracts/rows.js';
import type { OrgBundle } from '../contracts/org-work.js';
import { invalid } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { resolveInside } from '../shared/paths.js';
import { envelopeSchema, goalSchema, idList, playbookSchema, projectSchema } from './bundle-schemas.js';
import { assertBoard, type Ctx } from './context.js';
import { insertAgent } from './agents.js';
import { createDeptCore, persistDept } from './departments.js';
import { restoreCapabilities, type CredentialGap } from './import-capabilities.js';
import { createOrgCore } from './orgs.js';
import { recordRevision, requireDept } from './repo.js';
import { sanitize } from './sanitize.js';
import {
  agentExtrasSchema, createDeptSchema, createOrgSchema, hireAgentSchema, parse, SLUG_RE, updateOrgSchema,
} from './schemas.js';
import { insertGoal } from './templates.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
/** Bundle slugs are reused when valid and not already taken in this import; otherwise one is derived. */
const slugOf = (v: unknown, used: Set<string>): string | undefined => {
  const s = str(v);
  if (!s || !SLUG_RE.test(s) || used.has(s)) return undefined;
  used.add(s);
  return s;
};
export interface ImportResult {
  org: Organization;
  /** Capability re-creation through the other contexts' contracts (async); null when there is nothing to do. */
  background: Promise<void> | null;
}

/**
 * Recreate an org from a bundle under a new name. Everything gets a fresh id
 * and every internal reference (dept, reportsTo, lead, goal parent/owner,
 * playbook manager/steps, project goal) is remapped. The structural part is
 * one transaction; skills, connectors, grants, connector lists, memories and
 * MEMORY.md / owner-model documents are then re-created through the owning
 * contexts' contracts (`restoreCapabilities`).
 *
 * The bundle is untrusted: it is re-sanitized (secret refs stripped, strings
 * redacted) and validated before anything is written. Credentials are never
 * imported: whatever needs one is listed as "needs credential".
 */
export function importOrg(ctx: Ctx, rawBundle: OrgBundle, rawInput: { name: string }, actor: Actor): ImportResult {
  assertBoard(actor, 'import organizations');
  const k = ctx.kernel;
  const input = parse(z.strictObject({ name: z.string().trim().min(1).max(120) }), rawInput, 'import input');
  const envelope = parse(envelopeSchema, rawBundle, 'org bundle');
  const { skills: skillEntries, ...rest } = envelope;
  const bundle = sanitize(rest);

  const deptIdMap = new Map<string, string>();
  const agentIdMap = new Map<string, string>();
  const deptBySlug = new Map<string, string>();
  const agentBySlug = new Map<string, string>();
  const mapAgent = (id: unknown): string | null => (typeof id === 'string' ? agentIdMap.get(id) ?? null : null);
  const mapDept = (id: unknown): string | null => (typeof id === 'string' ? deptIdMap.get(id) ?? null : null);
  const credentialGaps: CredentialGap[] = [];

  const org = ctx.mutate(() => {
    const o = bundle.org;
    const orgInput = parse(createOrgSchema, {
      name: input.name,
      mission: str(o.mission),
      budgetMonthlyUsd: o.budgetMonthlyUsd ?? undefined,
      seatSecondsMonthly: o.seatSecondsMonthly ?? undefined,
      defaultProvider: o.defaultProvider ?? undefined,
      utilityModel: o.utilityModel ?? undefined,
      policies: o.policies ?? undefined,
    }, 'bundle organization');
    const orgExtras = parse(updateOrgSchema.pick({ defaultSkills: true, maxConcurrentRuns: true }), {
      defaultSkills: o.defaultSkills ?? undefined,
      maxConcurrentRuns: o.maxConcurrentRuns ?? undefined,
    }, 'bundle organization');
    const created = createOrgCore(ctx, orgInput, actor, {
      ...orgExtras,
      note: 'imported from bundle',
      audit: { importedFrom: str(o.slug) ?? null },
    });
    if (o.needsCredential === true) credentialGaps.push({ kind: 'provider', name: 'organization default provider / utility model' });

    const usedDeptSlugs = new Set<string>();
    const leadByDept: Array<{ deptId: string; lead: unknown }> = [];
    for (const d of bundle.departments) {
      const oldId = str(d.id);
      if (!oldId || deptIdMap.has(oldId)) throw invalid('bundle department is missing an id or the id is duplicated');
      const dept = createDeptCore(ctx, created, parse(createDeptSchema, {
        name: d.name,
        slug: slugOf(d.slug, usedDeptSlugs),
        charter: str(d.charter),
        budgetUsd: d.budgetUsd ?? undefined,
        sharedSkills: d.sharedSkills ?? undefined,
      }, 'bundle department'), actor);
      deptIdMap.set(oldId, dept.id);
      const oldSlug = str(d.slug);
      if (oldSlug && !deptBySlug.has(oldSlug)) deptBySlug.set(oldSlug, dept.id);
      leadByDept.push({ deptId: dept.id, lead: d.leadAgentId });
    }

    // Managers first, so every reportsTo points at an agent that already exists.
    const bundleAgentIds = new Set<string>();
    for (const a of bundle.agents) {
      const oldId = str(a.id);
      if (!oldId || bundleAgentIds.has(oldId)) throw invalid('bundle agent is missing an id or the id is duplicated');
      bundleAgentIds.add(oldId);
    }
    const usedAgentSlugs = new Set<string>();
    let remaining = bundle.agents;
    while (remaining.length > 0) {
      const next: typeof remaining = [];
      for (const a of remaining) {
        const oldId = a.id as string;
        const oldManager = str(a.reportsTo);
        const hasManager = oldManager !== undefined && bundleAgentIds.has(oldManager);
        if (hasManager && !agentIdMap.has(oldManager)) {
          next.push(a);
          continue;
        }
        const deptId = mapDept(a.deptId);
        if (!deptId) throw invalid(`bundle agent ${oldId} references an unknown department`);
        const agent = insertAgent(
          ctx,
          created,
          parse(hireAgentSchema, {
            deptId,
            name: a.name,
            slug: slugOf(a.slug, usedAgentSlugs),
            role: a.role,
            goal: str(a.goal),
            backstory: str(a.backstory),
            reportsTo: hasManager ? agentIdMap.get(oldManager) : null,
            providerBinding: a.providerBinding ?? undefined,
            model: a.model ?? undefined,
            skills: a.skills ?? undefined,
            heartbeatCron: a.heartbeatCron ?? undefined,
            budgetUsd: a.budgetUsd ?? undefined,
            autonomyLevel: a.autonomyLevel ?? undefined,
          }, 'bundle agent'),
          actor,
          {
            extras: parse(agentExtrasSchema, {
              denySkills: a.denySkills ?? undefined,
              maxSteps: a.maxSteps ?? undefined,
              maxWallMs: a.maxWallMs ?? undefined,
              maxRunsPerHour: a.maxRunsPerHour ?? undefined,
            }, 'bundle agent'),
            audit: { imported: true },
          },
        );
        agentIdMap.set(oldId, agent.id);
        if (a.needsCredential === true) credentialGaps.push({ kind: 'provider', name: `agent ${agent.slug}` });
        const oldSlug = str(a.slug);
        if (oldSlug && !agentBySlug.has(oldSlug)) agentBySlug.set(oldSlug, agent.id);
      }
      if (next.length === remaining.length) throw invalid('bundle contains a reporting cycle');
      remaining = next;
    }

    for (const { deptId, lead } of leadByDept) {
      const leadAgentId = mapAgent(lead);
      if (!leadAgentId) continue;
      persistDept(ctx, requireDept(k, created.id, deptId), { leadAgentId }, actor, 'lead restored from bundle');
    }

    const parsedGoals = bundle.goals.map((g) => parse(goalSchema, g, 'bundle goal'));
    const goalIdMap = new Map<string, string>();
    for (const g of parsedGoals) if (g.id) goalIdMap.set(g.id, newId('goal'));
    for (const g of parsedGoals) {
      insertGoal(ctx, created.id, {
        id: g.id ? goalIdMap.get(g.id) : undefined,
        parentGoalId: g.parentGoalId ? goalIdMap.get(g.parentGoalId) ?? null : null,
        level: g.level,
        deptId: mapDept(g.deptId),
        ownerAgentId: mapAgent(g.ownerAgentId),
        title: g.title,
        description: g.description,
        successMetric: g.successMetric,
        target: g.target,
        weight: g.weight,
        due: g.due ?? null,
        status: g.status,
      }, actor);
    }

    const playbookNames = new Set<string>();
    const now = k.clock.now();
    for (const raw of bundle.playbooks) {
      const p = parse(playbookSchema, raw, 'bundle playbook');
      if (playbookNames.has(p.name)) continue;
      playbookNames.add(p.name);
      const id = newId('playbook');
      const row = k.db
        .insert(playbooks)
        .values({
          id,
          orgId: created.id,
          name: p.name,
          description: p.description,
          process: p.process,
          managerAgentId: mapAgent(p.managerAgentId),
          steps: p.steps.map((s) => ({
            title: s.title,
            description: s.description,
            expectedOutput: s.expectedOutput,
            ...(s.agentRole ? { agentRole: s.agentRole } : {}),
            ...(mapAgent(s.agentId) ? { agentId: mapAgent(s.agentId)! } : {}),
          })),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      const revision = recordRevision(k, created.id, 'playbook', id, row, actor, 'imported from bundle');
      k.audit.record({ orgId: created.id, actor, action: 'playbook.created', entityKind: 'playbook', entityId: id, data: { name: p.name, imported: true, revision } });
    }

    const orgDir = k.paths.org(created.slug);
    for (const raw of bundle.projects) {
      const p = parse(projectSchema, raw, 'bundle project');
      const row = k.db
        .insert(projects)
        .values({
          id: newId('project'),
          orgId: created.id,
          name: p.name,
          goalId: p.goalId ? goalIdMap.get(p.goalId) ?? null : null,
          // Confined to the new org's own directory; a traversal attempt fails the whole import.
          workspacePath: p.workspaceRel ? resolveInside(orgDir, p.workspaceRel) : null,
          budgetUsd: p.budgetUsd ?? null,
          status: p.status,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      const revision = recordRevision(k, created.id, 'project', row.id, row, actor, 'imported from bundle');
      k.audit.record({ orgId: created.id, actor, action: 'project.created', entityKind: 'project', entityId: row.id, data: { name: row.name, imported: true, revision } });
    }

    k.audit.record({
      orgId: created.id,
      actor,
      action: 'org.imported',
      entityKind: 'org',
      entityId: created.id,
      data: {
        departments: deptIdMap.size,
        agents: agentIdMap.size,
        goals: parsedGoals.length,
        playbooks: playbookNames.size,
        projects: bundle.projects.length,
        skills: skillEntries.length,
        memories: bundle.memories.length,
        connectors: bundle.connectors.length,
        grants: bundle.grants.length,
      },
    });
    return created;
  });

  const pending =
    skillEntries.length + bundle.memories.length + bundle.connectors.length + bundle.grants.length + bundle.profileDocs.length +
    (bundle.ownerModel.trim() ? 1 : 0) + credentialGaps.length;
  if (pending === 0) return { org, background: null };

  const connectorLists = {
    org: idList.parse(bundle.org.defaultConnectors ?? []),
    depts: bundle.departments.map((d) => ({ id: mapDept(d.id), shared: idList.parse(d.sharedConnectors ?? []) })),
    agents: bundle.agents.map((a) => ({
      id: mapAgent(a.id),
      own: idList.parse(a.connectors ?? []),
      deny: idList.parse(a.denyConnectors ?? []),
    })),
  };
  const background = restoreCapabilities(ctx, org, actor, {
    skills: skillEntries,
    connectors: bundle.connectors,
    grants: bundle.grants,
    memories: bundle.memories,
    profileDocs: bundle.profileDocs,
    ownerModel: bundle.ownerModel,
    connectorLists,
    credentialGaps,
    mapAgent,
    mapDept,
    deptBySlug,
    agentBySlug,
  });
  return { org, background };
}
