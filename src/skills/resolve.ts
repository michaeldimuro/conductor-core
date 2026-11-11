import type { ResolvedSkillRef } from '../contracts/adapter.js';
import type { Skill } from '../contracts/rows.js';
import { SYSTEM } from '../contracts/types.js';
import { notFound } from '../shared/errors.js';
import { readSkillMd } from './format.js';
import { driftOf } from './lifecycle.js';
import type { SkillCtx } from './store.js';

/** Narrowest scope wins on a name collision. */
const NARROWNESS: Record<Skill['scope'], number> = { agent: 0, dept: 1, org: 2, global: 3 };

export function toRef(skill: Skill): ResolvedSkillRef {
  return { id: skill.id, name: skill.name, description: skill.description, path: skill.path, scope: skill.scope, version: skill.version, hasScripts: skill.hasScripts };
}

/**
 * Effective ACTIVE skill rows for an agent: own ∪ department ∪ org ∪ the
 * global skills its capability refs name; minus the deny list; narrowest scope
 * wins per name. Each candidate's folder is verified against its recorded hash
 * (and import pin): drift quarantines the skill and excludes it.
 */
export function effectiveSkills(ctx: SkillCtx, orgId: string, agentId: string): Skill[] {
  const agent = ctx.deps.org.getAgent(orgId, agentId);
  const refs = ctx.deps.org.resolveCapabilityRefs(orgId, agentId);
  const deny = new Set(refs.denySkills);
  const candidates = ctx.store.activeCandidates(orgId, agent, refs.skillNames).filter((s) => !deny.has(s.name));

  const byName = new Map<string, Skill>();
  for (const skill of candidates) {
    if (!ctx.writer.busy.has(skill.path)) {
      const drift = driftOf(skill);
      if (drift) {
        ctx.writer.changeStatus(skill, 'quarantined', SYSTEM, drift.reason, { expected: skill.pinnedHash ?? skill.contentHash, actual: drift.actual, detectedFor: agentId });
        ctx.kernel.log.warn({ skillId: skill.id, reason: drift.reason }, 'skill quarantined: folder does not match its recorded hash');
        continue;
      }
    }
    const held = byName.get(skill.name);
    if (!held || NARROWNESS[skill.scope] < NARROWNESS[held.scope]) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveForAgent(ctx: SkillCtx, orgId: string, agentId: string): ResolvedSkillRef[] {
  return effectiveSkills(ctx, orgId, agentId).map(toRef);
}

/** A skill from the caller's effective set, by name — anything else is not found (FR-8). */
export function effectiveByName(ctx: SkillCtx, orgId: string, agentId: string, name: string): Skill {
  const skill = effectiveSkills(ctx, orgId, agentId).find((s) => s.name === name);
  if (!skill) throw notFound('skill', String(name).slice(0, 80));
  return skill;
}

export function loadBody(ctx: SkillCtx, orgId: string, agentId: string, name: string): string {
  return readSkillMd(effectiveByName(ctx, orgId, agentId, name).path).body;
}
