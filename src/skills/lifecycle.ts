import { eq } from 'drizzle-orm';
import { skills } from '../db/schema/index.js';
import type { Skill } from '../contracts/rows.js';
import type { Actor } from '../contracts/types.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import { hashSkillDir, listSkillFiles, readSkillMd } from './format.js';
import { hasBlockingFinding, scanSkillDir } from './scan.js';
import { agentWriteStatus, humanWriteStatus } from './writer.js';
import { authorAgentId, policyDenied, type SkillCtx, type SkillStatus } from './store.js';

export function readSkill(ctx: SkillCtx, skillId: string): { skill: Skill; body: string; files: string[] } {
  const skill = ctx.store.get(skillId);
  return { skill, body: readSkillMd(skill.path).body, files: listSkillFiles(skill.path) };
}

/** Unified git diff between two versions' commits, limited to the skill folder (default: previous → current). */
export async function diffVersions(ctx: SkillCtx, skillId: string, fromVersion?: number, toVersion?: number): Promise<string> {
  const skill = ctx.store.get(skillId);
  const to = toVersion ?? skill.version;
  const from = fromVersion ?? to - 1;
  const toRow = ctx.store.version(skillId, to);
  if (!toRow?.commitSha) throw notFound('skill version', String(to));
  let fromSha: string | null = null;
  if (from !== 0) {
    const fromRow = ctx.store.version(skillId, from);
    if (!fromRow?.commitSha) throw notFound('skill version', String(from));
    fromSha = fromRow.commitSha;
  }
  return ctx.git.exclusive(async () => {
    await ctx.git.ensureRepo();
    return ctx.git.diff(fromSha, toRow.commitSha as string, skill.path);
  });
}

/** Restore an old version's tree as a NEW version/commit. Callers must hold `git.exclusive`. */
export async function restoreVersion(
  ctx: SkillCtx,
  skill: Skill,
  toVersion: number,
  actor: Actor,
  opts: { change: 'rollback' | 'revert'; message: string; extraAudit?: Record<string, unknown> },
): Promise<Skill> {
  if (!Number.isInteger(toVersion) || toVersion < 1) throw invalid('toVersion must be a positive integer');
  if (toVersion === skill.version) throw conflict(`skill is already at version ${toVersion}`);
  const old = ctx.store.version(skill.id, toVersion);
  if (!old?.commitSha) throw notFound('skill version', String(toVersion));
  const sha = old.commitSha;
  return ctx.writer.commit({
    existing: skill,
    target: { orgId: skill.orgId, scope: skill.scope, scopeId: skill.scopeId, name: skill.name, dir: skill.path },
    mutate: (dir) => ctx.git.restoreTree(sha, dir),
    actor,
    change: opts.change,
    message: opts.message,
    decideStatus: actor.kind === 'human' ? humanWriteStatus() : agentWriteStatus,
    versionEval: old.eval ?? null,
    extraAudit: { restoredVersion: toVersion, restoredCommit: sha, ...opts.extraAudit },
  });
}

export function rollback(ctx: SkillCtx, skillId: string, toVersion: number, actor: Actor): Promise<Skill> {
  return ctx.git.exclusive(async () => {
    const skill = ctx.store.get(skillId);
    ctx.store.assertCanEdit(skill, actor);
    if (actor.kind === 'agent' && skill.status === 'quarantined') throw forbidden('a quarantined skill can only be changed by a human');
    return restoreVersion(ctx, skill, toVersion, actor, { change: 'rollback', message: `rollback ${skill.name} to v${toVersion}` });
  });
}

const isAgentWrittenOrImported = (skill: Skill): boolean => authorAgentId(skill.author) !== null || skill.pinnedHash !== null || skill.source !== null;

/** Compare the folder with the recorded hash (and the import pin). Returns the drift reason, if any. */
export function driftOf(skill: Skill): { reason: 'content_drift' | 'pinned_hash_mismatch'; actual: string } | null {
  const actual = hashSkillDir(skill.path);
  if (actual !== skill.contentHash) return { reason: 'content_drift', actual };
  if (skill.pinnedHash && skill.pinnedHash !== actual) return { reason: 'pinned_hash_mismatch', actual };
  return null;
}

/**
 * draft → active. Gate: folder matches its hash, scan has no `block` finding,
 * and the current version's eval `passed`. A human may `force` past the scan
 * and the eval; a quarantined skill is only released by a human.
 * Callers must hold `git.exclusive`.
 */
export async function activateLocked(ctx: SkillCtx, skillId: string, actor: Actor, opts: { force?: boolean } = {}): Promise<Skill> {
  let skill = ctx.store.get(skillId);
  ctx.store.assertCanEdit(skill, actor);
  const force = opts.force === true;
  if (force && actor.kind !== 'human') throw forbidden('only a human can force-activate a skill');
  if (skill.status === 'active') {
    // Nothing to do — unless a patch is waiting: then this activates the candidate version.
    const candidate = ctx.store.pendingCandidate(skill);
    if (!candidate) return skill;
    if (!force) {
      const ev = candidate.eval;
      const details = { skillId, candidateVersion: candidate.version };
      if (!ev) throw policyDenied('the candidate version has not been evaluated; run evaluate first (or force-activate as the owner)', details);
      if (ev.needsReview) throw policyDenied('the candidate\'s evaluation was inconclusive and needs human review (the owner can force-activate)', { ...details, score: ev.score, needsReview: true });
      if (!ev.passed) throw policyDenied('the candidate did not hold up against the live version in its evaluation', { ...details, score: ev.score });
    }
    return ctx.writer.promoteCandidate(skill, candidate, actor, { force });
  }
  if (skill.status === 'quarantined' && !force) throw policyDenied('skill is quarantined: a human must edit or force-activate it', { skillId });

  const drift = driftOf(skill);
  if (drift) {
    if (!force) {
      ctx.writer.changeStatus(skill, 'quarantined', actor, drift.reason, { expected: skill.pinnedHash ?? skill.contentHash, actual: drift.actual });
      throw conflict(`skill folder does not match its recorded hash (${drift.reason}); quarantined`, { skillId });
    }
    // The owner accepts what is on disk: record it as a new version so hash and history stay truthful.
    const prevStatus = skill.status;
    skill = await ctx.writer.commit({
      existing: skill,
      target: { orgId: skill.orgId, scope: skill.scope, scopeId: skill.scopeId, name: skill.name, dir: skill.path },
      mutate: () => undefined,
      actor,
      change: 'edit',
      message: `accept on-disk changes to ${skill.name} (force activation)`,
      decideStatus: () => prevStatus,
      extraAudit: { drift: drift.reason },
    });
  }

  const { findings, hasScripts } = scanSkillDir(skill.path);
  ctx.kernel.db.update(skills).set({ scanFindings: findings, hasScripts }).where(eq(skills.id, skill.id)).run();
  skill = ctx.store.get(skillId);
  if (hasBlockingFinding(findings) && !force) {
    if (isAgentWrittenOrImported(skill)) ctx.writer.changeStatus(skill, 'quarantined', actor, 'scan_blocked');
    throw policyDenied('static scan found blocking issues; the skill cannot be activated', {
      skillId,
      findings: findings.filter((f) => f.severity === 'block').map((f) => f.rule),
    });
  }

  if (!force) {
    const ev = ctx.store.version(skill.id, skill.version)?.eval;
    if (!ev) throw policyDenied('skill has not been evaluated; run evaluate first (or force-activate as the owner)', { skillId });
    if (ev.needsReview) throw policyDenied('skill evaluation was inconclusive and needs human review (the owner can force-activate)', { skillId, score: ev.score, needsReview: true });
    if (!ev.passed) throw policyDenied('skill did not beat the baseline in its evaluation', { skillId, score: ev.score });
  }
  return ctx.writer.changeStatus(skill, 'active', actor, force ? 'force_activated' : 'activated', { forced: force });
}

export async function setStatus(ctx: SkillCtx, skillId: string, status: SkillStatus, actor: Actor): Promise<Skill> {
  if (!['draft', 'active', 'deprecated', 'quarantined'].includes(status)) throw invalid(`unknown skill status: ${String(status)}`);
  return ctx.git.exclusive(async () => {
    const skill = ctx.store.get(skillId);
    ctx.store.assertCanEdit(skill, actor);
    if (skill.status === status) return skill;
    if (status === 'active') return activateLocked(ctx, skillId, actor);
    if (actor.kind === 'agent' && skill.status === 'quarantined') throw forbidden('a quarantined skill can only be released by a human');
    return ctx.writer.changeStatus(skill, status, actor, `status set to ${status}`);
  });
}
