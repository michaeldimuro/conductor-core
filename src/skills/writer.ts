import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { skills, skillVersions } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Skill, SkillVersion } from '../contracts/rows.js';
import type { Actor, SkillEvalResult } from '../contracts/types.js';
import { ConductorError, conflict, errorMessage, invalid } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { syncEvalCases } from './eval-cases.js';
import { hashSkillDir, readSkillMd, assertDescription, copySkillDir } from './format.js';
import { hasBlockingFinding, scanSkillDir, type ScanFinding } from './scan.js';
import type { SkillGit } from './git.js';
import { authorOf, type ScopeTarget, type SkillStatus } from './store.js';

export type ChangeKind = 'create' | 'patch' | 'edit' | 'import' | 'rollback' | 'revert' | 'promote';

/** A skill folder is small; this only bounds the safety copy taken while a candidate is committed. */
const HOLD_LIMITS = { maxFiles: 5000, maxBytes: 200 * 1024 * 1024 };

export interface WriteRequest {
  existing: Skill | null;
  target: ScopeTarget;
  /** Apply the file changes to the skill folder. */
  mutate: (dir: string) => void | Promise<void>;
  actor: Actor;
  runId?: string | null;
  issueId?: string | null;
  change: ChangeKind;
  message: string;
  /** Status after this change, given the previous status and the scan verdict. */
  decideStatus: (s: { prev: SkillStatus | null; blocked: boolean }) => SkillStatus;
  /** Fields set only when the row is created. */
  create?: { author?: string; source?: string | null; pin?: boolean; createdRunId?: string | null; originIssueId?: string | null; evalScore?: number | null };
  /**
   * The eval gate for patches: when the skill is ACTIVE and the writer is not a human, record the
   * change as a candidate version and keep the current version live (folder, hash and `skills`
   * row untouched) until the candidate passes its evaluation. Imported (hash-pinned) skills are
   * excluded: a non-human change to them is quarantined as before.
   */
  holdLive?: boolean;
  /** Eval carried onto the new version (rollback to an already-evaluated tree, promotion copy). */
  versionEval?: SkillEvalResult | null;
  extraAudit?: Record<string, unknown>;
}

/**
 * The single write path: files → hash + scan → one git commit → `skills` row +
 * one `skill_versions` row → audit + `skill.changed`. Callers must hold
 * `git.exclusive`.
 */
export class SkillWriter {
  /** Folders with a write in flight: resolve must not mistake them for drift. */
  readonly busy = new Set<string>();

  constructor(private readonly kernel: Kernel, private readonly git: SkillGit) {}

  async commit(req: WriteRequest): Promise<Skill> {
    const { kernel, git } = this;
    const { existing, target } = req;
    const dir = existing?.path ?? target.dir;
    git.rel(dir); // refuses anything outside the conductor home
    await git.ensureRepo();

    const id = existing?.id ?? newId('skill');
    const version = existing ? this.nextVersion(existing) : 1;
    const hold = req.holdLive === true && existing !== null && existing.status === 'active' && req.actor.kind !== 'human' && !existing.pinnedHash;
    const author = authorOf(req.actor);
    const runId = req.runId ?? req.actor.runId ?? null;
    const existedBefore = existsSync(dir);

    this.busy.add(dir);
    try {
      let contentHash: string;
      let findings: ScanFinding[];
      let hasScripts: boolean;
      let description: string;
      let commitSha: string;
      // The live content, kept aside while the candidate tree is committed from the skill folder.
      const liveCopy = hold ? join(mkdtempSync(join(kernel.paths.ensure(join(kernel.paths.runDir, 'skill-hold')), 'hold-')), target.name) : null;
      try {
        if (liveCopy) copySkillDir(dir, liveCopy, HOLD_LIMITS);
        await req.mutate(dir);
        const parsed = readSkillMd(dir);
        if (parsed.name !== target.name) throw invalid(`SKILL.md name "${parsed.name ?? ''}" does not match the skill folder "${target.name}"`);
        description = assertDescription(parsed.description);
        contentHash = hashSkillDir(dir);
        ({ findings, hasScripts } = scanSkillDir(dir));
        if (hold && hasBlockingFinding(findings)) {
          // A blocked patch never takes the vetted live version down with it.
          kernel.audit.record({
            orgId: target.orgId, actor: req.actor, action: 'skill.patch_blocked', entityKind: 'skill', entityId: id, runId: runId ?? undefined, issueId: req.issueId ?? undefined,
            data: { name: target.name, liveVersion: existing?.version, findings: findings.filter((f) => f.severity === 'block').map((f) => f.rule) },
          });
          throw new ConductorError('policy_denied', 'the static scan blocked this patch; the active version was kept unchanged', {
            skillId: id, findings: findings.filter((f) => f.severity === 'block').map((f) => f.rule),
          });
        }
        commitSha = await git.commit({
          dir,
          author,
          subject: `skill(${target.scope}/${target.name}): ${hold ? 'candidate' : req.change} v${version}`,
          body: req.message,
          trailers: { 'Conductor-Skill': id, 'Conductor-Version': String(version), 'Conductor-Run': runId, 'Conductor-Issue': req.issueId ?? null },
        });
      } catch (e) {
        await git.discard(dir, existedBefore && existing !== null);
        if (liveCopy) rmSync(join(liveCopy, '..'), { recursive: true, force: true });
        throw e;
      }

      if (hold && liveCopy && existing) {
        try {
          return await this.holdCandidate(req, existing, { dir, liveCopy, version, commitSha, contentHash, author, runId });
        } finally {
          rmSync(join(liveCopy, '..'), { recursive: true, force: true });
        }
      }

      const blocked = hasBlockingFinding(findings);
      let status = req.decideStatus({ prev: existing?.status ?? null, blocked });
      let pinnedHash = existing?.pinnedHash ?? (req.create?.pin ? contentHash : null);
      if (pinnedHash && pinnedHash !== contentHash) {
        // A human edit is a review and re-pins; anything else drifting from the pin is quarantined.
        if (req.actor.kind === 'human') pinnedHash = contentHash;
        else status = 'quarantined';
      }

      const now = kernel.clock.now();
      const evalScore = req.versionEval ? req.versionEval.score : existing ? (contentHash === existing.contentHash ? existing.evalScore : null) : (req.create?.evalScore ?? null);
      kernel.db.transaction((tx) => {
        if (existing) {
          tx.update(skills)
            .set({ description, version, status, contentHash, pinnedHash, hasScripts, scanFindings: findings, evalScore, updatedAt: now })
            .where(eq(skills.id, id))
            .run();
        } else {
          tx.insert(skills)
            .values({
              id,
              orgId: target.orgId,
              scope: target.scope,
              scopeId: target.scopeId,
              name: target.name,
              description,
              version,
              author: req.create?.author ?? author,
              status,
              evalScore,
              path: dir,
              contentHash,
              pinnedHash,
              source: req.create?.source ?? null,
              hasScripts,
              scanFindings: findings,
              createdRunId: req.create?.createdRunId ?? null,
              originIssueId: req.create?.originIssueId ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
        tx.insert(skillVersions)
          .values({ id: newId('skillVersion'), skillId: id, orgId: target.orgId, version, commitSha, author, runId, message: req.message, contentHash, eval: req.versionEval ?? null, createdAt: now })
          .run();
      });

      const skill = kernel.db.select().from(skills).where(eq(skills.id, id)).get() as Skill;
      try {
        // Eval cases follow every write: the folder's explicit cases and the issue the write came from.
        syncEvalCases(kernel, skill, { issueId: req.issueId ?? (existing ? null : (req.create?.originIssueId ?? null)) });
      } catch (e) {
        kernel.log.warn({ skillId: id, err: errorMessage(e) }, 'could not sync skill eval cases');
      }
      this.announce(skill, req.actor, {
        change: req.change,
        runId,
        issueId: req.issueId ?? null,
        data: { message: req.message, commitSha, previousStatus: existing?.status ?? null, blocked, findings: findings.filter((f) => f.severity !== 'info').length, ...req.extraAudit },
      });
      return skill;
    } finally {
      this.busy.delete(dir);
    }
  }

  private nextVersion(existing: Skill): number {
    const newest = this.kernel.db.select({ version: skillVersions.version }).from(skillVersions).where(eq(skillVersions.skillId, existing.id)).orderBy(desc(skillVersions.version)).limit(1).get();
    return Math.max(existing.version, newest?.version ?? 0) + 1;
  }

  /**
   * The candidate tree is committed; put the live content back (its own commit, so HEAD always
   * matches the folder that is served) and record the candidate as a version row only.
   */
  private async holdCandidate(
    req: WriteRequest,
    live: Skill,
    c: { dir: string; liveCopy: string; version: number; commitSha: string; contentHash: string; author: string; runId: string | null },
  ): Promise<Skill> {
    const { kernel, git } = this;
    copySkillDir(c.liveCopy, c.dir, HOLD_LIMITS);
    // If this fails the folder no longer matches the recorded hash and resolve quarantines the skill: fail-safe.
    if (hashSkillDir(c.dir) !== live.contentHash) throw conflict('could not restore the live version after recording the candidate', { skillId: live.id });
    await git.commit({
      dir: c.dir,
      author: c.author,
      subject: `skill(${live.scope}/${live.name}): keep v${live.version} live (candidate v${c.version} awaits evaluation)`,
      trailers: { 'Conductor-Skill': live.id, 'Conductor-Version': String(live.version), 'Conductor-Run': c.runId },
    });
    kernel.db
      .insert(skillVersions)
      .values({ id: newId('skillVersion'), skillId: live.id, orgId: live.orgId, version: c.version, commitSha: c.commitSha, author: c.author, runId: c.runId, message: req.message, contentHash: c.contentHash, eval: null, createdAt: kernel.clock.now() })
      .run();
    try {
      // The issue the patch came from becomes a replay case for the candidate's evaluation.
      syncEvalCases(kernel, live, { issueId: req.issueId ?? null });
    } catch (e) {
      kernel.log.warn({ skillId: live.id, err: errorMessage(e) }, 'could not sync skill eval cases');
    }
    this.announce(live, req.actor, {
      change: 'candidate',
      runId: c.runId,
      issueId: req.issueId ?? null,
      data: { message: req.message, commitSha: c.commitSha, candidateVersion: c.version, liveVersion: live.version, requested: req.change, ...req.extraAudit },
    });
    return live;
  }

  /**
   * Make a pending candidate the live version: its tree goes into the folder (one commit) and the
   * `skills` row moves to its version. Callers have checked the gate and hold `git.exclusive`.
   */
  async promoteCandidate(skill: Skill, candidate: SkillVersion, actor: Actor, opts: { force?: boolean } = {}): Promise<Skill> {
    const { kernel, git } = this;
    if (!candidate.commitSha) throw conflict('the candidate version has no recorded commit', { skillId: skill.id });
    const dir = skill.path;
    this.busy.add(dir);
    try {
      let description: string;
      let scan: ReturnType<typeof scanSkillDir>;
      try {
        await git.restoreTree(candidate.commitSha, dir);
        if (hashSkillDir(dir) !== candidate.contentHash) throw conflict('the candidate tree does not match its recorded hash', { skillId: skill.id });
        scan = scanSkillDir(dir);
        if (hasBlockingFinding(scan.findings) && !opts.force) {
          throw new ConductorError('policy_denied', 'static scan found blocking issues; the candidate cannot be activated', { skillId: skill.id });
        }
        description = assertDescription(readSkillMd(dir).description);
        await git.commit({
          dir,
          author: authorOf(actor),
          subject: `skill(${skill.scope}/${skill.name}): activate candidate v${candidate.version}`,
          trailers: { 'Conductor-Skill': skill.id, 'Conductor-Version': String(candidate.version), 'Conductor-Run': actor.runId ?? null },
        });
      } catch (e) {
        await git.discard(dir, true);
        throw e;
      }
      kernel.db
        .update(skills)
        .set({
          description, version: candidate.version, contentHash: candidate.contentHash, hasScripts: scan.hasScripts, scanFindings: scan.findings,
          evalScore: candidate.eval?.score ?? null, updatedAt: kernel.clock.now(),
        })
        .where(eq(skills.id, skill.id))
        .run();
      const next = kernel.db.select().from(skills).where(eq(skills.id, skill.id)).get() as Skill;
      try {
        syncEvalCases(kernel, next, {});
      } catch (e) {
        kernel.log.warn({ skillId: skill.id, err: errorMessage(e) }, 'could not sync skill eval cases');
      }
      this.announce(next, actor, {
        change: 'candidate_activated',
        runId: actor.runId ?? null,
        issueId: null,
        data: { previousVersion: skill.version, forced: opts.force === true, evalScore: candidate.eval?.score ?? null },
      });
      return next;
    } finally {
      this.busy.delete(dir);
    }
  }

  /** Status-only change (no new version): row update + audit + event. */
  changeStatus(skill: Skill, status: SkillStatus, actor: Actor, reason: string, data: Record<string, unknown> = {}): Skill {
    if (skill.status === status) return skill;
    const { kernel } = this;
    kernel.db.update(skills).set({ status, updatedAt: kernel.clock.now() }).where(eq(skills.id, skill.id)).run();
    const next = kernel.db.select().from(skills).where(eq(skills.id, skill.id)).get() as Skill;
    this.announce(next, actor, { change: 'status', runId: actor.runId ?? null, issueId: null, data: { reason, previousStatus: skill.status, ...data } });
    return next;
  }

  /** Audit `skill.changed` (with author and run) and emit the event. */
  announce(skill: Skill, actor: Actor, info: { change: string; runId: string | null; issueId: string | null; data?: Record<string, unknown> }): void {
    this.kernel.audit.record({
      orgId: skill.orgId,
      actor,
      action: 'skill.changed',
      entityKind: 'skill',
      entityId: skill.id,
      runId: info.runId ?? undefined,
      issueId: info.issueId ?? undefined,
      data: { name: skill.name, scope: skill.scope, scopeId: skill.scopeId, version: skill.version, status: skill.status, author: authorOf(actor), change: info.change, ...info.data },
    });
    this.kernel.bus.emit('skill.changed', { orgId: skill.orgId, skillId: skill.id, status: skill.status });
  }
}

/* ── status policies ── */

/** Agent writes and imports: blocked content is quarantined; a quarantined skill stays so until a human steps in. */
export const agentWriteStatus = ({ prev, blocked }: { prev: SkillStatus | null; blocked: boolean }): SkillStatus => {
  if (blocked || prev === 'quarantined') return 'quarantined';
  return prev === 'active' ? 'active' : 'draft';
};

/** Human edits: an explicit status wins, a quarantined skill returns to draft, blocked content never stays/gets active. */
export const humanWriteStatus =
  (requested?: SkillStatus) =>
  ({ prev, blocked }: { prev: SkillStatus | null; blocked: boolean }): SkillStatus => {
    const wanted = requested ?? (prev === null || prev === 'quarantined' ? 'draft' : prev);
    return blocked && wanted === 'active' ? 'draft' : wanted;
  };
