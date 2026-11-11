import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { skills, skillVersions } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Skill } from '../contracts/rows.js';
import type { Actor, SkillEvalResult } from '../contracts/types.js';
import { invalid } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { hashSkillDir, readSkillMd, assertDescription } from './format.js';
import { hasBlockingFinding, scanSkillDir, type ScanFinding } from './scan.js';
import type { SkillGit } from './git.js';
import { authorOf, type ScopeTarget, type SkillStatus } from './store.js';

export type ChangeKind = 'create' | 'patch' | 'edit' | 'import' | 'rollback' | 'revert' | 'promote';

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
    const version = existing ? existing.version + 1 : 1;
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
      try {
        await req.mutate(dir);
        const parsed = readSkillMd(dir);
        if (parsed.name !== target.name) throw invalid(`SKILL.md name "${parsed.name ?? ''}" does not match the skill folder "${target.name}"`);
        description = assertDescription(parsed.description);
        contentHash = hashSkillDir(dir);
        ({ findings, hasScripts } = scanSkillDir(dir));
        commitSha = await git.commit({
          dir,
          author,
          subject: `skill(${target.scope}/${target.name}): ${req.change} v${version}`,
          body: req.message,
          trailers: { 'Conductor-Skill': id, 'Conductor-Version': String(version), 'Conductor-Run': runId, 'Conductor-Issue': req.issueId ?? null },
        });
      } catch (e) {
        await git.discard(dir, existedBefore && existing !== null);
        throw e;
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
