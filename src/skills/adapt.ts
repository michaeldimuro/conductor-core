import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { skillUsages, skills } from '../db/schema/index.js';
import type { SkillService } from '../contracts/services.js';
import type { Skill } from '../contracts/rows.js';
import { SYSTEM } from '../contracts/types.js';
import { errorMessage } from '../shared/errors.js';
import { parseInput } from './authoring.js';
import { restoreVersion } from './lifecycle.js';
import type { SkillCtx } from './store.js';

export const STALE_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
const MIN_USES = 5;
const REGRESSION_POINTS = 20;
const EDITED_WINDOW = 5;
const EDITED_THRESHOLD = 3;

const usageSchema = z.object({
  orgId: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().min(1),
  skillIds: z.array(z.string().min(1)).max(200),
  success: z.boolean().nullable(),
  humanEdited: z.boolean().optional(),
  costUsd: z.number().min(0),
  steps: z.number().int().min(0),
});

interface VersionStats {
  graded: number;
  successes: number;
}

function versionStats(ctx: SkillCtx, skillId: string): Map<number, VersionStats> {
  const rows = ctx.kernel.db
    .select({
      version: skillUsages.version,
      graded: sql<number>`sum(case when ${skillUsages.success} is not null then 1 else 0 end)`,
      successes: sql<number>`sum(case when ${skillUsages.success} = 1 then 1 else 0 end)`,
    })
    .from(skillUsages)
    .where(eq(skillUsages.skillId, skillId))
    .groupBy(skillUsages.version)
    .all();
  return new Map(rows.map((r) => [r.version, { graded: Number(r.graded), successes: Number(r.successes) }]));
}

const pct = (s: VersionStats): number => Math.round((s.successes / s.graded) * 100);

/**
 * Decide whether the current version regressed:
 *  - ≥ 5 graded uses and a success rate ≥ 20 points below the previous
 *    version's (the nearest earlier version that has graded uses), or
 *  - ≥ 3 of its last 5 uses had their output edited by a human.
 */
function regression(ctx: SkillCtx, skill: Skill): { toVersion: number; reason: string; data: Record<string, unknown> } | null {
  if (skill.version < 2 || skill.status !== 'active') return null;
  const stats = versionStats(ctx, skill.id);
  const cur = stats.get(skill.version);
  if (cur && cur.graded >= MIN_USES) {
    for (let v = skill.version - 1; v >= 1; v--) {
      const prev = stats.get(v);
      if (!prev || prev.graded === 0) continue;
      const drop = pct(prev) - pct(cur);
      if (drop >= REGRESSION_POINTS) {
        return { toVersion: v, reason: 'success_rate_regressed', data: { currentRate: pct(cur), previousRate: pct(prev), uses: cur.graded } };
      }
      break;
    }
  }
  const recent = ctx.kernel.db
    .select({ humanEdited: skillUsages.humanEdited })
    .from(skillUsages)
    .where(and(eq(skillUsages.skillId, skill.id), eq(skillUsages.version, skill.version)))
    .orderBy(desc(skillUsages.id))
    .limit(EDITED_WINDOW)
    .all();
  const edited = recent.filter((r) => r.humanEdited).length;
  if (edited >= EDITED_THRESHOLD) return { toVersion: skill.version - 1, reason: 'human_edited_outcomes', data: { edited, window: recent.length } };
  return null;
}

/** Record a run's outcome for the skills it loaded; auto-revert a version that regressed. */
export async function recordUsage(ctx: SkillCtx, raw: Parameters<SkillService['recordUsage']>[0]): Promise<void> {
  const input = parseInput(usageSchema, raw, 'skill usage');
  const { kernel } = ctx;
  const now = kernel.clock.now();
  const recorded: string[] = [];

  for (const skillId of new Set(input.skillIds)) {
    let skill: Skill;
    try {
      skill = ctx.store.getVisible(input.orgId, skillId);
    } catch {
      kernel.log.warn({ skillId, orgId: input.orgId }, 'skill usage ignored: skill not visible to this org');
      continue;
    }
    kernel.db.transaction((tx) => {
      tx.insert(skillUsages)
        .values({ skillId, orgId: input.orgId, version: skill.version, runId: input.runId, agentId: input.agentId, success: input.success, humanEdited: input.humanEdited ?? false, costUsd: input.costUsd, steps: input.steps, ts: now })
        .run();
      tx.update(skills)
        .set({ useCount: sql`${skills.useCount} + 1`, successCount: sql`${skills.successCount} + ${input.success === true ? 1 : 0}`, lastUsedAt: now })
        .where(eq(skills.id, skillId))
        .run();
    });
    recorded.push(skillId);
  }
  ctx.loaded.delete(input.runId);

  for (const skillId of recorded) {
    await ctx.git.exclusive(async () => {
      const skill = ctx.store.get(skillId);
      const hit = regression(ctx, skill);
      if (!hit) return;
      try {
        const reverted = await restoreVersion(ctx, skill, hit.toVersion, SYSTEM, {
          change: 'revert',
          message: `auto-revert ${skill.name} v${skill.version} → v${hit.toVersion} (${hit.reason})`,
          extraAudit: { reason: hit.reason, ...hit.data },
        });
        kernel.audit.record({
          orgId: skill.orgId,
          actor: SYSTEM,
          action: 'skill.reverted',
          entityKind: 'skill',
          entityId: skill.id,
          runId: input.runId,
          data: { name: skill.name, fromVersion: skill.version, restoredVersion: hit.toVersion, newVersion: reverted.version, reason: hit.reason, ...hit.data },
        });
      } catch (e) {
        kernel.log.error({ skillId, err: errorMessage(e) }, 'skill auto-revert failed');
      }
    });
  }
}

/**
 * Retire: active/draft skills unused for 60 days (by `last_used_at`, falling
 * back to `updated_at`) become deprecated, as do skills superseded by a
 * byte-identical active copy in a wider scope of the same org (a promotion
 * that made the narrower copy redundant).
 */
export async function retireStale(ctx: SkillCtx, now?: number): Promise<string[]> {
  const at = now ?? ctx.kernel.clock.now();
  const live = ctx.kernel.db
    .select()
    .from(skills)
    .where(inArray(skills.status, ['active', 'draft']))
    .all();
  const retired: string[] = [];
  const wider = (s: Skill): Skill | undefined =>
    live.find(
      (o) =>
        o.id !== s.id && o.status === 'active' && o.name === s.name && o.contentHash === s.contentHash && o.orgId === s.orgId && o.source === `promoted:${s.id}` && (s.scope === 'agent' || (s.scope === 'dept' && o.scope === 'org')),
    );
  for (const skill of live) {
    const idleSince = skill.lastUsedAt ?? skill.updatedAt;
    const stale = at - idleSince >= STALE_AFTER_MS;
    const by = stale ? undefined : skill.status === 'active' && skill.scope !== 'org' && skill.scope !== 'global' ? wider(skill) : undefined;
    if (!stale && !by) continue;
    ctx.writer.changeStatus(skill, 'deprecated', SYSTEM, stale ? 'unused_60_days' : 'superseded', stale ? { idleSince } : { supersededBy: by?.id });
    retired.push(skill.id);
  }
  return retired;
}
