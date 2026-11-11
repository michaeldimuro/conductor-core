import { eq } from 'drizzle-orm';
import type { Kernel, UtilityModel } from '../contracts/kernel.js';
import type { Memory } from '../contracts/rows.js';
import type { Actor } from '../contracts/types.js';
import { memories } from '../db/schema/index.js';
import { errorMessage } from '../shared/errors.js';
import { slugify } from '../shared/ids.js';
import { estimateTokens } from '../shared/util.js';
import { cosine } from './embedder.js';
import { compactDocument } from './heuristics.js';
import { PROFILE_TOKEN_BUDGET } from './ranking.js';
import { roleCard, type Recall } from './recall.js';
import { openSkillDraft, type SkillDeps } from './skill-draft.js';
import type { MemoryStore } from './store.js';
import { tag } from './transcript.js';

const DAY = 86_400_000;
/** Nightly dedupe threshold (a little looser than the write path's). */
export const DREAM_MERGE_THRESHOLD = 0.86;
/** A procedure used / restated this often is a skill candidate. */
export const PROMOTE_THRESHOLD = 3;
/** Memories idle this long start losing importance. */
export const DECAY_AFTER_MS = 30 * DAY;
export const DECAY_FACTOR = 0.85;
/** Below this importance an unpinned idle memory is forgotten. */
export const IMPORTANCE_FLOOR = 0.08;
const MIN_DOC_BUDGET = 400;

const DREAM: Actor = { kind: 'system', id: 'dream' };
const DEDUPE_KINDS: Memory['kind'][] = ['procedural', 'semantic', 'lesson', 'episodic'];

/** The nightly "dream" for one agent. */
export class Consolidator {
  constructor(
    private readonly kernel: Kernel,
    private readonly store: MemoryStore,
    private readonly recall: Recall,
    private readonly utility: UtilityModel,
    private readonly skills: () => SkillDeps | undefined,
  ) {}

  async consolidate(orgId: string, agentId: string): Promise<{ merged: number; decayed: number; promotedToSkillDrafts: number; profileTokens: number }> {
    this.store.agent(orgId, agentId);
    await this.store.index.ready();
    const { merged, clusterSize } = this.dedupe(orgId, agentId);
    const promotedToSkillDrafts = await this.promote(orgId, agentId, clusterSize);
    const decayed = this.decay(orgId, agentId);
    const profileTokens = await this.rewriteProfile(orgId, agentId);
    this.kernel.audit.record({ orgId, actor: DREAM, action: 'memory.consolidated', entityKind: 'agent', entityId: agentId, data: { merged, decayed, promotedToSkillDrafts, profileTokens } });
    return { merged, decayed, promotedToSkillDrafts, profileTokens };
  }

  /** Dedupe/compress: near-duplicates of the same kind (and entity) collapse into the richest one. */
  private dedupe(orgId: string, agentId: string): { merged: number; clusterSize: Map<string, number> } {
    const { db, clock } = this.kernel;
    const all = this.recall.inScope(orgId, 'agent', agentId, DEDUPE_KINDS);
    const vectors = this.store.index.vectors(all.map((m) => m.rowid));
    const clusterSize = new Map<string, number>();
    let merged = 0;
    const now = clock.now();
    for (const kind of DEDUPE_KINDS) {
      // Richest first so the survivor of each cluster is the best text.
      const group = all.filter((m) => m.kind === kind).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.content.length - a.content.length || a.createdAt - b.createdAt);
      const gone = new Set<number>();
      for (const [i, keep] of group.entries()) {
        if (gone.has(keep.rowid)) continue;
        const kv = vectors.get(keep.rowid);
        if (!kv) continue;
        const dupes = group.slice(i + 1).filter((m) => {
          if (gone.has(m.rowid) || (m.entity ?? null) !== (keep.entity ?? null)) return false;
          // Episodes of different runs are history, not duplicates, unless they are the same text.
          const threshold = kind === 'episodic' ? 0.97 : DREAM_MERGE_THRESHOLD;
          const mv = vectors.get(m.rowid);
          return mv !== undefined && cosine(kv, mv) >= threshold;
        });
        clusterSize.set(keep.id, 1 + dupes.length);
        if (dupes.length === 0) continue;
        this.kernel.sqlite.transaction(() => {
          db.update(memories)
            .set({
              confidence: Math.max(keep.confidence, ...dupes.map((d) => d.confidence)),
              importance: Math.max(keep.importance, ...dupes.map((d) => d.importance)),
              useCount: keep.useCount + dupes.reduce((s, d) => s + d.useCount, 0),
              lastUsedAt: Math.max(keep.lastUsedAt ?? 0, ...dupes.map((d) => d.lastUsedAt ?? 0)) || null,
              taskType: keep.taskType ?? dupes.find((d) => d.taskType)?.taskType ?? null,
              updatedAt: now,
            })
            .where(eq(memories.rowid, keep.rowid))
            .run();
          for (const d of dupes) {
            db.update(memories).set({ status: 'superseded', supersededBy: keep.id, updatedAt: now }).where(eq(memories.rowid, d.rowid)).run();
            gone.add(d.rowid);
          }
        })();
        merged += dupes.length;
        this.kernel.audit.record({ orgId, actor: DREAM, action: 'memory.updated', entityKind: 'memory', entityId: keep.id, data: { mergedDuplicates: dupes.map((d) => d.id) } });
      }
    }
    return { merged, clusterSize };
  }

  /** Recurring procedural memories (used ≥ 3 times or restated ≥ 3 times) become skill drafts. */
  private async promote(orgId: string, agentId: string, clusterSize: Map<string, number>): Promise<number> {
    const skills = this.skills();
    if (!skills) return 0;
    let promoted = 0;
    const names = new Set<string>();
    for (const m of this.recall.inScope(orgId, 'agent', agentId, ['procedural'])) {
      if (m.useCount < PROMOTE_THRESHOLD && (clusterSize.get(m.id) ?? 1) < PROMOTE_THRESHOLD) continue;
      const name = slugify(m.taskType || m.content.split(/\s+/).slice(0, 6).join(' '));
      if (names.has(name)) continue;
      names.add(name);
      try {
        const opened = await openSkillDraft(this.kernel, this.utility, skills, {
          orgId,
          agentId,
          name,
          title: m.taskType || m.content.slice(0, 80),
          taskType: m.taskType,
          trigger: 'recurring_procedure',
          steps: [{ kind: 'assistant', text: m.content }],
          notes: [m.content],
          runId: m.sourceRunId ?? undefined,
        });
        if (opened) promoted += 1;
      } catch (e) {
        this.kernel.log.warn({ orgId, agentId, err: errorMessage(e) }, 'could not promote a procedure to a skill draft');
      }
    }
    return promoted;
  }

  /** Decay unused memories; forget the ones that fall under the floor. Pinned and always-on kinds are exempt. */
  private decay(orgId: string, agentId: string): number {
    const { db, clock } = this.kernel;
    const now = clock.now();
    let decayed = 0;
    for (const m of this.recall.inScope(orgId, 'agent', agentId, DEDUPE_KINDS)) {
      if (m.pinned) continue;
      if (now - (m.lastUsedAt ?? m.createdAt) < DECAY_AFTER_MS) continue;
      // At most one decay step per night, even if the job runs twice.
      if (now - m.updatedAt < 20 * 3_600_000) continue;
      const importance = m.importance * DECAY_FACTOR;
      if (importance < IMPORTANCE_FLOOR) {
        db.update(memories).set({ importance, status: 'forgotten', updatedAt: now }).where(eq(memories.rowid, m.rowid)).run();
        this.store.index.remove(m.rowid);
        this.kernel.audit.record({ orgId, actor: DREAM, action: 'memory.forgotten', entityKind: 'memory', entityId: m.id, data: { reason: 'decayed', importance } });
      } else {
        db.update(memories).set({ importance, updatedAt: now }).where(eq(memories.rowid, m.rowid)).run();
      }
      decayed += 1;
    }
    return decayed;
  }

  /** Keep role card + MEMORY.md within the 2k-token budget; lines that had to go become procedural memories. */
  private async rewriteProfile(orgId: string, agentId: string): Promise<number> {
    const agent = this.store.agent(orgId, agentId);
    const doc = this.recall.getProfileDoc(orgId, agentId);
    const header = estimateTokens('\n\n## Standing rules (MEMORY.md)\n');
    const budget = Math.max(MIN_DOC_BUDGET, PROFILE_TOKEN_BUDGET - estimateTokens(roleCard(agent)) - header - 8);
    if (estimateTokens(doc) > budget) {
      let next: string | null = null;
      try {
        const res = await this.utility.complete({
          orgId,
          purpose: 'consolidate',
          system:
            'You maintain an agent\'s MEMORY.md of standing rules. Rewrite it to fit the token budget: merge duplicates, tighten wording, ' +
            'keep every distinct rule that still matters, drop nothing silently unless it is redundant. Output only the new markdown document.',
          prompt: [tag('budget_tokens', String(budget)), tag('document', doc)].join('\n\n'),
        });
        const candidate = res.text.replace(/^```(?:markdown|md)?\n?|\n?```$/g, '').trim();
        if (!res.offline && candidate.length > 0 && estimateTokens(candidate) <= budget) next = candidate;
      } catch (e) {
        this.kernel.log.warn({ orgId, agentId, err: errorMessage(e) }, 'MEMORY.md rewrite model call failed; compacting deterministically');
      }
      if (next === null) {
        const compact = compactDocument(doc, budget);
        next = compact.doc;
        for (const line of compact.dropped.filter((l) => l.length >= 3)) {
          try {
            await this.store.write(orgId, { scope: 'agent', scopeId: agentId, kind: 'procedural', content: line.slice(0, 7900), confidence: 0.8, importance: 0.6, author: 'dream' }, DREAM);
          } catch (e) {
            this.kernel.log.warn({ orgId, agentId, err: errorMessage(e) }, 'could not archive a standing rule dropped from MEMORY.md');
          }
        }
      }
      this.recall.setProfileDoc(orgId, agentId, next, DREAM);
    }
    return estimateTokens(this.recall.profile(orgId, agentId));
  }
}
