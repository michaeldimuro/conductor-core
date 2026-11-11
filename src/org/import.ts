import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { playbooks } from '../db/schema/index.js';
import { MEMORY_KINDS, MEMORY_SCOPES } from '../db/schema/memory.js';
import type { Actor } from '../contracts/types.js';
import type { Organization } from '../contracts/rows.js';
import type { OrgBundle } from '../contracts/org-work.js';
import { errorMessage, invalid } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { assertBoard, type Ctx } from './context.js';
import { insertAgent } from './agents.js';
import { createDeptCore, persistDept } from './departments.js';
import { createOrgCore } from './orgs.js';
import { requireDept } from './repo.js';
import { redactText, sanitize } from './sanitize.js';
import {
  agentExtrasSchema, createDeptSchema, createOrgSchema, hireAgentSchema, parse, SLUG_RE, updateOrgSchema,
} from './schemas.js';
import { insertGoal } from './templates.js';

const record = z.record(z.string(), z.unknown());
const ref = z.string().min(1).max(200).nullish();
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const skillSchema = z.object({
  scope: z.enum(['org', 'dept', 'agent']),
  scopeSlug: z.string().max(64).nullable(),
  name: z.string().regex(SKILL_NAME_RE, 'invalid skill name'),
  files: z.record(z.string().min(1).max(300), z.string().max(1024 * 1024)),
});

const envelopeSchema = z.object({
  format: z.literal('conductor-org-bundle'),
  version: z.literal(1),
  org: record,
  departments: z.array(record).max(200),
  agents: z.array(record).max(1000),
  goals: z.array(record).max(2000).default([]),
  playbooks: z.array(record).max(500).default([]),
  connectors: z.array(record).max(500).default([]),
  skills: z.array(skillSchema).max(500).default([]),
  memories: z.array(record).max(20_000).default([]),
});

const goalSchema = z.object({
  id: ref,
  parentGoalId: ref,
  level: z.enum(['org', 'dept', 'agent']).default('org'),
  deptId: ref,
  ownerAgentId: ref,
  title: z.string().trim().min(1).max(500),
  description: z.string().max(8000).default(''),
  successMetric: z.string().max(2000).default(''),
  target: z.string().max(2000).default(''),
  weight: z.number().finite().nonnegative().default(1),
  due: z.number().int().nullish(),
  status: z.enum(['proposed', 'active', 'achieved', 'abandoned']).default('active'),
});

const playbookSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(8000).default(''),
  process: z.enum(['sequential', 'hierarchical']).default('sequential'),
  managerAgentId: ref,
  steps: z
    .array(z.object({
      title: z.string().max(500),
      description: z.string().max(8000).default(''),
      expectedOutput: z.string().max(8000).default(''),
      agentRole: z.string().max(200).nullish(),
      agentId: ref,
    }))
    .max(100)
    .default([]),
});

const memorySchema = z.object({
  scope: z.enum(MEMORY_SCOPES),
  scopeId: z.string().min(1),
  kind: z.enum(MEMORY_KINDS),
  content: z.string().min(1).max(100_000),
  entity: z.string().max(500).nullish(),
  taskType: z.string().max(200).nullish(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
});

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
/** Bundle slugs are reused when valid and not already taken in this import; otherwise one is derived. */
const slugOf = (v: unknown, used: Set<string>): string | undefined => {
  const s = str(v);
  if (!s || !SLUG_RE.test(s) || used.has(s)) return undefined;
  used.add(s);
  return s;
};
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

export interface ImportResult {
  org: Organization;
  /** Skill/memory re-creation through the optional deps (async contracts); null when there is nothing to do. */
  background: Promise<void> | null;
}

/**
 * Recreate an org from a bundle under a new name. Everything gets a fresh id
 * and every internal reference (dept, reportsTo, lead, goal parent/owner,
 * playbook manager/steps) is remapped. The structural part is one transaction;
 * skills and memories are then re-created through their own services.
 *
 * The bundle is untrusted: it is re-sanitized (secret refs stripped, strings
 * redacted) and validated before anything is written. Connector references
 * are not carried over — connectors need credentials and are re-installed.
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
      k.db
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
        .run();
      k.audit.record({ orgId: created.id, actor, action: 'playbook.created', entityKind: 'playbook', entityId: id, data: { name: p.name, imported: true } });
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
        skills: skillEntries.length,
        memories: bundle.memories.length,
        connectorsNotImported: bundle.connectors.length,
      },
    });
    return created;
  });

  const scopeId = (scope: string, slug: string | null): string | null =>
    scope === 'org' ? org.id : scope === 'dept' ? deptBySlug.get(slug ?? '') ?? null : agentBySlug.get(slug ?? '') ?? null;
  const memoryScopeId = (scope: string, oldId: string): string | null =>
    scope === 'org' ? org.id : scope === 'dept' ? mapDept(oldId) : mapAgent(oldId);

  if (skillEntries.length === 0 && bundle.memories.length === 0) return { org, background: null };

  const background = (async (): Promise<void> => {
    const counts = { skills: 0, memories: 0, skipped: 0 };
    const failures: string[] = [];
    // Deps are read here, not captured earlier, so late binding via setImportDeps works.
    const { skills, memory } = ctx.deps;

    for (const entry of skillEntries) {
      const target = scopeId(entry.scope, entry.scopeSlug);
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
        // Imported skills start as drafts until reviewed (PRD "Safety rails").
        await skills.upsert(org.id, { scope: entry.scope, scopeId: target, name: entry.name, description, body, files, status: 'draft' }, actor);
        counts.skills++;
      } catch (err) {
        failures.push(`skill ${entry.name}: ${errorMessage(err)}`);
      }
    }

    for (const raw of bundle.memories) {
      const parsed = memorySchema.safeParse(raw);
      const target = parsed.success ? memoryScopeId(parsed.data.scope, parsed.data.scopeId) : null;
      if (!memory || !parsed.success || !target) {
        counts.skipped++;
        continue;
      }
      const m = parsed.data;
      try {
        await memory.write(org.id, {
          scope: m.scope,
          scopeId: target,
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

    if (failures.length > 0) k.log.warn({ orgId: org.id, failures: failures.slice(0, 20) }, 'org import: some items failed');
    k.audit.record({
      orgId: org.id,
      actor,
      action: 'org.import_completed',
      entityKind: 'org',
      entityId: org.id,
      data: { ...counts, failed: failures.length, failures: failures.slice(0, 20) },
    });
  })();

  return { org, background };
}
