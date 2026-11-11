import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Kernel, UtilityModel } from '../contracts/kernel.js';
import type { Agent, Memory } from '../contracts/rows.js';
import type { MemoryService, MemoryWriteInput, ScoredMemory } from '../contracts/services.js';
import type { Actor } from '../contracts/types.js';
import { agents, departments, memories, organizations, MEMORY_KINDS, MEMORY_SCOPES, type MemoryKind } from '../db/schema/index.js';
import { errorMessage, invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { externalRefKey, externalScopeKey, resolveBackend } from './external.js';
import { heuristicConflict } from './heuristics.js';
import { deleteSetting, getSetting, setSetting, type MemoryIndex } from './indexes.js';
import {
  blendSimilarity, byScore, CONFLICT_MIN_SIMILARITY, IDENTICAL_THRESHOLD, MERGE_THRESHOLD, REVIEW_CONFIDENCE, scoreMemory, SIMILARITY_FLOOR,
} from './ranking.js';
import { ftsQuery, normalizeEntity } from './text.js';
import { tag } from './transcript.js';

const unit = z.number().min(0).max(1);
const STATUSES = ['active', 'review', 'superseded', 'forgotten'] as const;

const writeSchema = z.object({
  scope: z.enum(MEMORY_SCOPES),
  scopeId: z.string().min(1),
  kind: z.enum(MEMORY_KINDS),
  content: z.string().trim().min(1).max(8000),
  entity: z.string().max(200).nullish(),
  taskType: z.string().trim().min(1).max(120).nullish(),
  importance: unit.optional(),
  confidence: unit.optional(),
  sourceRunId: z.string().min(1).nullish(),
  author: z.string().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
});

const searchSchema = z.object({
  agentId: z.string().min(1).optional(),
  text: z.string().trim().min(1).max(20_000),
  kinds: z.array(z.enum(MEMORY_KINDS)).optional(),
  entity: z.string().optional(),
  taskType: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  includeReview: z.boolean().optional(),
});

const updateSchema = z
  .object({
    content: z.string().trim().min(1).max(8000),
    importance: unit,
    confidence: unit,
    pinned: z.boolean(),
    status: z.enum(STATUSES),
    kind: z.enum(MEMORY_KINDS),
  })
  .partial()
  .strict();

const listSchema = z
  .object({
    scope: z.enum(MEMORY_SCOPES),
    scopeId: z.string(),
    kind: z.enum(MEMORY_KINDS),
    status: z.enum(STATUSES),
    limit: z.number().int().min(1).max(500),
    offset: z.number().int().min(0),
  })
  .partial();

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid(`invalid ${what}: ${r.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
  return r.data;
}

export interface SearchOptions {
  /** Keep candidates regardless of similarity (task-type lessons, entity matches). */
  noFloor?: boolean;
  /** Skip the use_count / last_used_at bump (internal lookups). */
  noBump?: boolean;
}

/** Storage, hybrid retrieval and the contradiction-aware write path. */
export class MemoryStore {
  constructor(
    private readonly kernel: Kernel,
    readonly index: MemoryIndex,
    private readonly utility: UtilityModel,
  ) {}

  /* ───────────── lookups ───────────── */

  agent(orgId: string, agentId: string): Agent {
    const a = this.kernel.db.select().from(agents).where(and(eq(agents.orgId, orgId), eq(agents.id, agentId))).get();
    if (!a) throw notFound('agent', agentId);
    return a;
  }

  org(orgId: string): typeof organizations.$inferSelect {
    const o = this.kernel.db.select().from(organizations).where(eq(organizations.id, orgId)).get();
    if (!o) throw notFound('organization', orgId);
    return o;
  }

  private assertScope(orgId: string, scope: Memory['scope'], scopeId: string): void {
    if (scope === 'org') {
      this.org(orgId);
      if (scopeId !== orgId) throw notFound('organization', scopeId);
    } else if (scope === 'dept') {
      const d = this.kernel.db.select({ id: departments.id }).from(departments).where(and(eq(departments.orgId, orgId), eq(departments.id, scopeId))).get();
      if (!d) throw notFound('department', scopeId);
    } else {
      this.agent(orgId, scopeId);
    }
  }

  /** An agent sees its own scope ∪ its department ∪ its org — nothing else. */
  visibility(orgId: string, agentId: string): { where: SQL; scopes: Array<{ scope: Memory['scope']; scopeId: string }> } {
    const a = this.agent(orgId, agentId);
    const scopes: Array<{ scope: Memory['scope']; scopeId: string }> = [
      { scope: 'agent', scopeId: a.id },
      { scope: 'dept', scopeId: a.deptId },
      { scope: 'org', scopeId: orgId },
    ];
    const where = or(...scopes.map((s) => and(eq(memories.scope, s.scope), eq(memories.scopeId, s.scopeId))));
    return { where: where as SQL, scopes };
  }

  get(orgId: string, memoryId: string): Memory {
    const m = this.kernel.db.select().from(memories).where(and(eq(memories.orgId, orgId), eq(memories.id, memoryId))).get();
    if (!m) throw notFound('memory', memoryId);
    return m;
  }

  list(orgId: string, filter: Parameters<MemoryService['list']>[1] = {}): Memory[] {
    const f = parse(listSchema, filter, 'memory filter');
    const conds: SQL[] = [eq(memories.orgId, orgId)];
    if (f.scope) conds.push(eq(memories.scope, f.scope));
    if (f.scopeId) conds.push(eq(memories.scopeId, f.scopeId));
    if (f.kind) conds.push(eq(memories.kind, f.kind));
    if (f.status) conds.push(eq(memories.status, f.status));
    return this.kernel.db.select().from(memories).where(and(...conds)).orderBy(desc(memories.createdAt), desc(memories.rowid)).limit(f.limit ?? 100).offset(f.offset ?? 0).all();
  }

  /* ───────────── write path ───────────── */

  async write(orgId: string, input: MemoryWriteInput, actor: Actor, opts: { forceReview?: boolean } = {}): Promise<Memory> {
    const { db, clock } = this.kernel;
    const p = parse(writeSchema, input, 'memory');
    this.assertScope(orgId, p.scope, p.scopeId);
    const entity = normalizeEntity(p.entity);
    const confidence = p.confidence ?? 0.7;
    const importance = p.importance ?? 0.5;
    const status: Memory['status'] = opts.forceReview || confidence < REVIEW_CONFIDENCE ? 'review' : 'active';
    const vec = await this.index.embed(p.content);
    const now = clock.now();

    const peers = db
      .select()
      .from(memories)
      .where(and(eq(memories.orgId, orgId), eq(memories.scope, p.scope), eq(memories.scopeId, p.scopeId), eq(memories.kind, p.kind), inArray(memories.status, ['active', 'review'])))
      .all();
    const sims = this.index.similarities(vec, peers.map((m) => m.rowid));
    const ranked = peers
      .map((m) => ({ m, sim: sims.get(m.rowid) ?? 0 }))
      .filter((x) => (x.m.entity ?? null) === entity)
      .sort((a, b) => b.sim - a.sim);

    const mergeInto = async (target: Memory): Promise<Memory> => {
      const content = p.content.length > target.content.length ? p.content : target.content;
      const promoted = target.status === 'review' && status === 'active';
      db.update(memories)
        .set({
          content,
          confidence: Math.max(target.confidence, confidence),
          importance: Math.max(target.importance, importance),
          taskType: target.taskType ?? p.taskType ?? null,
          sourceRunId: target.sourceRunId ?? p.sourceRunId ?? null,
          pinned: target.pinned || (p.pinned ?? false),
          status: promoted ? 'active' : target.status,
          useCount: target.useCount + 1,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(eq(memories.rowid, target.rowid))
        .run();
      if (content !== target.content) this.index.put(target.rowid, vec);
      const merged = this.get(orgId, target.id);
      this.announce(orgId, merged, actor, 'memory.written', { merged: true, status: merged.status });
      return merged;
    };

    // 1. The same statement again → merge.
    const identical = p.kind === 'episodic' ? undefined : ranked.find((x) => x.sim >= IDENTICAL_THRESHOLD);
    if (identical) return mergeInto(identical.m);

    // 2. A conflicting fact about the same entity → the new memory supersedes the old one.
    const superseded: Memory[] = [];
    const factKind = p.kind === 'semantic' || p.kind === 'owner_model';
    if (status === 'active' && factKind && (entity !== null || p.kind === 'owner_model')) {
      for (const x of ranked.filter((r) => r.m.status === 'active' && r.sim >= CONFLICT_MIN_SIMILARITY).slice(0, 3)) {
        if (await this.conflicts(orgId, x.m.content, p.content, entity)) superseded.push(x.m);
      }
    }

    // 3. Near-duplicate (very high similarity, same scope + kind) that does not contradict → merge.
    if (superseded.length === 0 && p.kind !== 'episodic') {
      const near = ranked.find((x) => x.sim >= MERGE_THRESHOLD);
      if (near) return mergeInto(near.m);
    }

    const id = newId('memory');
    const author = p.author ?? (actor.kind === 'agent' ? `agent:${actor.id ?? 'unknown'}` : actor.kind === 'human' ? (actor.id ?? 'owner') : 'system');
    const inserted = this.kernel.sqlite.transaction(() => {
      const row = db
        .insert(memories)
        .values({
          id, orgId, scope: p.scope, scopeId: p.scopeId, kind: p.kind, content: p.content, entity, taskType: p.taskType ?? null,
          importance, confidence, sourceRunId: p.sourceRunId ?? actor.runId ?? null, author, status, pinned: p.pinned ?? false, createdAt: now, updatedAt: now,
        })
        .returning()
        .get();
      this.index.put(row.rowid, vec);
      for (const old of superseded) {
        db.update(memories).set({ status: 'superseded', supersededBy: id, updatedAt: now }).where(eq(memories.rowid, old.rowid)).run();
      }
      return row;
    })();

    for (const old of superseded) this.kernel.audit.record({ orgId, actor, action: 'memory.updated', entityKind: 'memory', entityId: old.id, data: { status: 'superseded', supersededBy: id } });
    this.announce(orgId, inserted, actor, 'memory.written', { kind: inserted.kind, scope: inserted.scope, status, supersedes: superseded.map((s) => s.id) });
    await this.mirror(orgId, inserted);
    return inserted;
  }

  /** Cheap heuristic first; the utility model's verdict wins when a live one is configured. */
  private async conflicts(orgId: string, existing: string, incoming: string, entity: string | null): Promise<boolean> {
    const guess = heuristicConflict(existing, incoming, entity);
    try {
      const res = await this.utility.complete({
        orgId,
        purpose: 'judge',
        json: true,
        maxTokens: 2000,
        system: 'You decide whether two stored facts contradict each other. Facts that add different details about the same subject do NOT conflict; a conflict means both cannot be true now.',
        prompt: [
          entity ? `Both facts are about: ${entity}` : 'Both facts describe the same owner.',
          tag('existing_fact', existing),
          tag('new_fact', incoming),
          'Answer as JSON: {"conflict": true|false, "reason": "<short>"}',
        ].join('\n\n'),
      });
      const verdict = (res.json as { conflict?: unknown } | null)?.conflict;
      if (!res.offline && typeof verdict === 'boolean') return verdict;
    } catch (e) {
      this.kernel.log.warn({ err: errorMessage(e) }, 'conflict judge failed; using heuristic');
    }
    return guess;
  }

  private announce(orgId: string, m: Memory, actor: Actor, action: string, data: Record<string, unknown>): void {
    this.kernel.audit.record({ orgId, actor, action, entityKind: 'memory', entityId: m.id, runId: actor.runId ?? m.sourceRunId ?? undefined, data });
    this.kernel.bus.emit('memory.written', { orgId, memoryId: m.id });
  }

  /* ───────────── edit / delete ───────────── */

  forget(orgId: string, memoryId: string, actor: Actor): void {
    const m = this.get(orgId, memoryId);
    const now = this.kernel.clock.now();
    this.kernel.db.update(memories).set({ status: 'forgotten', updatedAt: now }).where(eq(memories.rowid, m.rowid)).run();
    this.index.remove(m.rowid);
    this.kernel.audit.record({ orgId, actor, action: 'memory.forgotten', entityKind: 'memory', entityId: m.id, data: { kind: m.kind, scope: m.scope } });
    void this.unmirror(orgId, m);
  }

  async update(orgId: string, memoryId: string, patch: Parameters<MemoryService['update']>[2], actor: Actor): Promise<Memory> {
    const p = parse(updateSchema, patch, 'memory patch');
    const before = this.get(orgId, memoryId);
    const now = this.kernel.clock.now();
    this.kernel.db.update(memories).set({ ...p, updatedAt: now }).where(eq(memories.rowid, before.rowid)).run();
    const after = this.get(orgId, memoryId);
    if (after.status === 'forgotten') {
      this.index.remove(after.rowid);
      void this.unmirror(orgId, after);
    } else if (after.content !== before.content || before.status === 'forgotten') {
      this.index.put(after.rowid, await this.index.embed(after.content));
      if (after.content !== before.content) await this.mirror(orgId, after);
    }
    this.kernel.audit.record({ orgId, actor, action: 'memory.updated', entityKind: 'memory', entityId: after.id, data: { fields: Object.keys(p) } });
    this.kernel.bus.emit('memory.written', { orgId, memoryId: after.id });
    return after;
  }

  /* ───────────── retrieval ───────────── */

  async search(orgId: string, query: Parameters<MemoryService['search']>[1], opts: SearchOptions = {}): Promise<ScoredMemory[]> {
    const q = parse(searchSchema, query, 'memory query');
    const conds: SQL[] = [eq(memories.orgId, orgId), inArray(memories.status, q.includeReview ? ['active', 'review'] : ['active'])];
    let scopes: Array<{ scope: Memory['scope']; scopeId: string }> | null = null;
    if (q.agentId) {
      const vis = this.visibility(orgId, q.agentId);
      conds.push(vis.where);
      scopes = vis.scopes;
    } else {
      this.org(orgId);
    }
    if (q.kinds && q.kinds.length > 0) conds.push(inArray(memories.kind, q.kinds as MemoryKind[]));
    const entity = normalizeEntity(q.entity);
    if (entity) conds.push(eq(memories.entity, entity));
    if (q.taskType) conds.push(eq(memories.taskType, q.taskType));

    const qvec = await this.index.embed(q.text);
    const candidates = this.kernel.db.select().from(memories).where(and(...conds)).all();
    if (candidates.length === 0) return [];
    const cos = this.index.similarities(qvec, candidates.map((m) => m.rowid));
    const match = ftsQuery(q.text);
    const kw = match ? this.index.keywordHits(orgId, match) : new Map<number, number>();
    const external = await this.externalScores(orgId, q.text, scopes ?? [{ scope: 'org', scopeId: orgId }], candidates);
    let maxKw = 0;
    for (const m of candidates) maxKw = Math.max(maxKw, kw.get(m.rowid) ?? 0);

    const now = this.kernel.clock.now();
    const scored: ScoredMemory[] = [];
    for (const m of candidates) {
      const c = cos.get(m.rowid);
      const k = kw.get(m.rowid);
      const ext = external.get(m.id);
      const similarity = Math.max(blendSimilarity(c, k, maxKw), ext ?? 0);
      const related = (c ?? 0) >= SIMILARITY_FLOOR || k !== undefined || ext !== undefined;
      if (!related && !opts.noFloor) continue;
      scored.push(scoreMemory(m, similarity, now));
    }
    const top = scored.sort(byScore).slice(0, q.limit ?? 10);
    if (!opts.noBump) this.bump(top.map((s) => s.memory));
    return top;
  }

  /** Retrieval feedback: used memories stay fresh. */
  bump(used: Memory[]): void {
    if (used.length === 0) return;
    const now = this.kernel.clock.now();
    this.kernel.db
      .update(memories)
      .set({ useCount: sql`${memories.useCount} + 1`, lastUsedAt: now })
      .where(inArray(memories.rowid, used.map((m) => m.rowid)))
      .run();
  }

  /* ───────────── external mirror (never breaks local memory) ───────────── */

  private async mirror(orgId: string, m: Memory): Promise<void> {
    if (m.status !== 'active') return;
    try {
      const backend = await resolveBackend(this.kernel, orgId);
      if (!backend) return;
      const { externalId } = await backend.write({
        id: m.id,
        content: m.content,
        scopeKey: externalScopeKey(orgId, m.scope, m.scopeId),
        metadata: { kind: m.kind, ...(m.entity ? { entity: m.entity } : {}), ...(m.taskType ? { task_type: m.taskType } : {}) },
      });
      if (externalId) setSetting(this.kernel.db, externalRefKey(m.id), { kind: backend.kind, externalId }, this.kernel.clock.now());
    } catch (e) {
      this.kernel.log.warn({ orgId, memoryId: m.id, err: errorMessage(e) }, 'external memory mirror failed');
    }
  }

  private async unmirror(orgId: string, m: Memory): Promise<void> {
    try {
      const ref = getSetting(this.kernel.db, externalRefKey(m.id)) as { kind?: string; externalId?: string } | null;
      if (!ref?.externalId) return;
      const backend = await resolveBackend(this.kernel, orgId);
      if (backend && backend.kind === ref.kind) await backend.delete(ref.externalId, externalScopeKey(orgId, m.scope, m.scopeId));
      deleteSetting(this.kernel.db, externalRefKey(m.id));
    } catch (e) {
      this.kernel.log.warn({ orgId, memoryId: m.id, err: errorMessage(e) }, 'external memory delete failed');
    }
  }

  /** External hits mapped back onto local, visible candidates: memory id → score. */
  private async externalScores(orgId: string, text: string, scopes: Array<{ scope: Memory['scope']; scopeId: string }>, candidates: Memory[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const backend = await resolveBackend(this.kernel, orgId);
      if (!backend) return out;
      const hits = await backend.search(text, { scopeKeys: scopes.map((s) => externalScopeKey(orgId, s.scope, s.scopeId)), limit: 20 });
      if (hits.length === 0) return out;
      const byId = new Map(candidates.map((m) => [m.id, m]));
      let byExternal: Map<string, string> | null = null;
      for (const h of hits) {
        let id = h.conductorId && byId.has(h.conductorId) ? h.conductorId : null;
        if (!id && h.externalId) {
          byExternal ??= new Map(
            candidates.flatMap((m) => {
              const ref = getSetting(this.kernel.db, externalRefKey(m.id)) as { kind?: string; externalId?: string } | null;
              return ref?.externalId && ref.kind === backend.kind ? [[ref.externalId, m.id] as [string, string]] : [];
            }),
          );
          id = byExternal.get(h.externalId) ?? null;
        }
        if (id) out.set(id, Math.max(out.get(id) ?? 0, h.score));
      }
    } catch (e) {
      this.kernel.log.warn({ orgId, err: errorMessage(e) }, 'external memory search failed');
    }
    return out;
  }
}
