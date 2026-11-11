import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { connectorGrants, connectors, goals, memories, playbooks, projects, skills } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { ProviderBinding } from '../contracts/types.js';
import type { OrgBundle } from '../contracts/org-work.js';
import type { Ctx } from './context.js';
import { listAgentRows, listDeptRows, requireOrg } from './repo.js';
import { redactIdentifier, redactText, sanitize } from './sanitize.js';

const MAX_SKILL_FILES = 200;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_DOC_BYTES = 256 * 1024;

/** A standing-rules document (MEMORY.md / USER.md), redacted; '' when absent, oversized or not a regular file. */
function readDoc(file: string): string {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_DOC_BYTES) return '';
    return redactText(readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}

/** True when the binding (or one of its fallbacks) is bound to a stored credential. */
const bindingNeedsCredential = (b: ProviderBinding | null): boolean =>
  !!b && (b.authRef !== undefined || (b.fallback ?? []).some((f) => f.authRef !== undefined));

/** Read a skill folder as { relativePath: utf8 }. Skips dotfiles, symlinks, binaries and oversized files. */
function readSkillFolder(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  let count = 0;
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile() && count < MAX_SKILL_FILES && statSync(abs).size <= MAX_SKILL_FILE_BYTES) {
        const buf = readFileSync(abs);
        if (buf.includes(0)) continue;
        files[rel] = redactText(buf.toString('utf8'));
        count++;
      }
    }
  };
  walk(root, '');
  return files;
}

function exportSkills(
  k: Kernel,
  orgId: string,
  deptSlugs: Map<string, string>,
  agentSlugs: Map<string, string>,
): OrgBundle['skills'] {
  const out: OrgBundle['skills'] = [];
  const rows = k.db.select().from(skills).where(eq(skills.orgId, orgId)).orderBy(asc(skills.createdAt), sql`rowid`).all();
  for (const row of rows) {
    if (row.status === 'quarantined' || row.status === 'deprecated') continue;
    let scopeSlug: string | null = null;
    if (row.scope === 'dept') scopeSlug = deptSlugs.get(row.scopeId ?? '') ?? null;
    else if (row.scope === 'agent') scopeSlug = agentSlugs.get(row.scopeId ?? '') ?? null;
    else if (row.scope !== 'org') continue;
    if (row.scope !== 'org' && scopeSlug === null) continue;

    let folder: string;
    try {
      folder = k.paths.safe(row.path);
    } catch {
      k.log.warn({ skillId: row.id }, 'skill path is outside conductor home; not exported');
      continue;
    }
    if (!existsSync(folder) || !statSync(folder).isDirectory()) continue;
    const files = readSkillFolder(folder);
    if (Object.keys(files).length === 0) continue;
    out.push({
      scope: row.scope,
      scopeSlug,
      name: redactIdentifier(row.name),
      files,
      status: row.status,
      author: row.author.startsWith('agent') ? 'agent' : 'human',
    });
  }
  return out;
}

/**
 * Portable bundle: org chart, agent configs (with their connector lists),
 * goals, projects, playbooks, connector config, connector grants with their
 * tool policies, skill folders, sanitized memory, each agent's MEMORY.md and
 * the owner model. Secret references are stripped and every string is passed
 * through the credential redactor — a bundle never contains secrets, nor the
 * names of this install's secrets (FR-18). Wherever a credential was bound,
 * `needsCredential: true` is left behind so the importer can tell the owner
 * what to re-supply. Internal ids are kept only so the importer can remap
 * references; import always mints fresh ones.
 */
export function exportOrg(ctx: Ctx, orgId: string): OrgBundle {
  const k = ctx.kernel;
  const org = requireOrg(k, orgId);
  const depts = listDeptRows(k, orgId);
  const agentRows = listAgentRows(k, orgId, { excludeTerminated: true });
  const liveAgents = new Set(agentRows.map((a) => a.id));
  const deptIds = new Set(depts.map((d) => d.id));
  const liveRef = (id: string | null): string | null => (id && liveAgents.has(id) ? id : null);

  const goalRows = k.db.select().from(goals).where(eq(goals.orgId, orgId)).orderBy(asc(goals.createdAt), sql`rowid`).all();
  const goalIds = new Set(goalRows.map((g) => g.id));
  const playbookRows = k.db.select().from(playbooks).where(eq(playbooks.orgId, orgId)).orderBy(asc(playbooks.createdAt), sql`rowid`).all();
  const connectorRows = k.db.select().from(connectors).where(eq(connectors.orgId, orgId)).orderBy(asc(connectors.createdAt), sql`rowid`).all();
  const connectorIds = new Set(connectorRows.map((c) => c.id));
  const grantRows = k.db.select().from(connectorGrants).where(eq(connectorGrants.orgId, orgId)).orderBy(asc(connectorGrants.createdAt), sql`rowid`).all();
  const projectRows = k.db.select().from(projects).where(eq(projects.orgId, orgId)).orderBy(asc(projects.createdAt), sql`rowid`).all();
  const orgDir = k.paths.org(org.slug);
  const memoryRows = k.db
    .select()
    .from(memories)
    .where(and(eq(memories.orgId, orgId), eq(memories.status, 'active')))
    .orderBy(asc(memories.rowid))
    .all();

  const scopeExists = (scope: string, scopeId: string): boolean =>
    scope === 'org' ? scopeId === orgId : scope === 'dept' ? deptIds.has(scopeId) : liveAgents.has(scopeId);

  const body = {
    org: {
      name: org.name,
      slug: org.slug,
      mission: org.mission,
      budgetMonthlyUsd: org.budgetMonthlyUsd,
      seatSecondsMonthly: org.seatSecondsMonthly,
      defaultProvider: org.defaultProvider,
      utilityModel: org.utilityModel,
      policies: org.policies,
      defaultSkills: org.defaultSkills,
      defaultConnectors: org.defaultConnectors,
      maxConcurrentRuns: org.maxConcurrentRuns,
      needsCredential: bindingNeedsCredential(org.defaultProvider) || bindingNeedsCredential(org.utilityModel),
    },
    departments: depts.map((d) => ({
      id: d.id,
      slug: d.slug,
      name: d.name,
      charter: d.charter,
      leadAgentId: liveRef(d.leadAgentId),
      budgetUsd: d.budgetUsd,
      sharedSkills: d.sharedSkills,
      sharedConnectors: d.sharedConnectors,
    })),
    agents: agentRows.map((a) => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      role: a.role,
      goal: a.goal,
      backstory: a.backstory,
      deptId: a.deptId,
      reportsTo: liveRef(a.reportsTo),
      providerBinding: a.providerBinding,
      model: a.model,
      skills: a.skills,
      connectors: a.connectors,
      denySkills: a.denySkills,
      denyConnectors: a.denyConnectors,
      heartbeatCron: a.heartbeatCron,
      budgetUsd: a.budgetUsd,
      autonomyLevel: a.autonomyLevel,
      maxSteps: a.maxSteps,
      maxWallMs: a.maxWallMs,
      maxRunsPerHour: a.maxRunsPerHour,
      needsCredential: bindingNeedsCredential(a.providerBinding),
    })),
    goals: goalRows.map((g) => ({
      id: g.id,
      parentGoalId: g.parentGoalId && goalIds.has(g.parentGoalId) ? g.parentGoalId : null,
      level: g.level,
      deptId: g.deptId && deptIds.has(g.deptId) ? g.deptId : null,
      ownerAgentId: liveRef(g.ownerAgentId),
      title: g.title,
      description: g.description,
      successMetric: g.successMetric,
      target: g.target,
      weight: g.weight,
      due: g.due,
      status: g.status,
    })),
    playbooks: playbookRows.map((p) => ({
      name: p.name,
      description: p.description,
      process: p.process,
      managerAgentId: liveRef(p.managerAgentId),
      steps: p.steps.map((s) => ({ ...s, agentId: liveRef(s.agentId ?? null) ?? undefined })),
    })),
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      goalId: p.goalId && goalIds.has(p.goalId) ? p.goalId : null,
      budgetUsd: p.budgetUsd,
      status: p.status,
      // Only a workspace inside the org directory is portable; anything else is re-pointed by the owner.
      workspaceRel: p.workspacePath && p.workspacePath.startsWith(orgDir + sep) ? relative(orgDir, p.workspacePath).split(sep).join('/') : null,
    })),
    // Config only: credentials (auth_ref) are dropped and must be re-supplied after import.
    connectors: connectorRows.map((c) => ({
      id: c.id,
      scope: c.scope,
      scopeId: c.scopeId,
      kind: c.kind,
      name: c.name,
      templateId: c.templateId,
      config: c.config,
      toolAllowlist: c.toolAllowlist,
      status: c.status,
      needsCredential: c.authRef !== null,
    })),
    grants: grantRows
      .filter((g) => connectorIds.has(g.connectorId) && liveAgents.has(g.agentId))
      .map((g) => ({
        connectorId: g.connectorId,
        agentId: g.agentId,
        toolAllowlist: g.toolAllowlist,
        // As pairs, not a map: tool names are data and must not be read as (credential-named) keys.
        policies: Object.entries(g.toolPolicies).map(([tool, policy]) => ({ tool, policy })),
        defaultPolicy: g.defaultPolicy,
        needsCredential: g.authRef !== null,
      })),
    profileDocs: agentRows
      .map((a) => ({ agentId: a.id, content: readDoc(k.paths.agentMemoryFile(org.slug, a.slug)) }))
      .filter((d) => d.content.trim().length > 0),
    ownerModel: readDoc(k.paths.ownerModelFile(org.slug)),
    memories: memoryRows
      .filter((m) => scopeExists(m.scope, m.scopeId))
      .map((m) => ({
        scope: m.scope,
        scopeId: m.scopeId,
        kind: m.kind,
        content: m.content,
        entity: m.entity,
        taskType: m.taskType,
        importance: m.importance,
        confidence: m.confidence,
        pinned: m.pinned,
        author: m.author,
      })),
  };

  const clean = sanitize(body);
  return {
    format: 'conductor-org-bundle',
    version: 1,
    exportedAt: k.clock.now(),
    ...clean,
    skills: exportSkills(k, orgId, new Map(depts.map((d) => [d.id, d.slug])), new Map(agentRows.map((a) => [a.id, a.slug]))),
  };
}
