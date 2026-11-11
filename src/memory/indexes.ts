import { eq } from 'drizzle-orm';
import type { Db, Embedder, Kernel, Sqlite } from '../contracts/kernel.js';
import { settings } from '../db/schema/index.js';
import { bufferToVec, isResolvable, vecToBuffer } from './embedder.js';

export const EMBED_INDEX_SETTING = 'embeddings.index';

function tableSql(sqlite: Sqlite, name: string): string | null {
  const row = sqlite.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(name) as { sql: string } | undefined;
  return row?.sql ?? null;
}

function createVec(sqlite: Sqlite, dims: number): void {
  sqlite.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[${dims}] distance_metric=cosine)`);
}

/**
 * Idempotently create the companion virtual tables Drizzle cannot express:
 * `memories_fts` (FTS5 over content + entity), `memories_vec` (sqlite-vec),
 * `session_summaries_fts`. All share the rowid of their base table and are
 * kept in sync by triggers. A dimension change drops and recreates the vec table.
 */
export function ensureMemoryIndexes(sqlite: Sqlite, dims: number): { vecRebuilt: boolean } {
  if (!Number.isInteger(dims) || dims < 1 || dims > 8192) throw new Error(`invalid embedding dims: ${dims}`);
  const hadMemFts = tableSql(sqlite, 'memories_fts') !== null;
  const hadSessFts = tableSql(sqlite, 'session_summaries_fts') !== null;
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, entity, content='memories', content_rowid='rowid', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, entity) VALUES (new.rowid, new.content, new.entity);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, entity) VALUES ('delete', old.rowid, old.content, old.entity);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content, entity ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, entity) VALUES ('delete', old.rowid, old.content, old.entity);
      INSERT INTO memories_fts(rowid, content, entity) VALUES (new.rowid, new.content, new.entity);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
      summary, content='session_summaries', content_rowid='rowid', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS session_summaries_fts_ai AFTER INSERT ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(rowid, summary) VALUES (new.rowid, new.summary);
    END;
    CREATE TRIGGER IF NOT EXISTS session_summaries_fts_ad AFTER DELETE ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, summary) VALUES ('delete', old.rowid, old.summary);
    END;
    CREATE TRIGGER IF NOT EXISTS session_summaries_fts_au AFTER UPDATE OF summary ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, summary) VALUES ('delete', old.rowid, old.summary);
      INSERT INTO session_summaries_fts(rowid, summary) VALUES (new.rowid, new.summary);
    END;
  `);
  if (!hadMemFts) sqlite.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
  if (!hadSessFts) sqlite.exec("INSERT INTO session_summaries_fts(session_summaries_fts) VALUES ('rebuild')");

  const vecSql = tableSql(sqlite, 'memories_vec');
  let vecRebuilt = false;
  if (vecSql === null) {
    createVec(sqlite, dims);
  } else {
    const current = Number(/float\[(\d+)\]/i.exec(vecSql)?.[1] ?? NaN);
    if (current !== dims) {
      sqlite.exec('DROP TABLE memories_vec');
      createVec(sqlite, dims);
      vecRebuilt = true;
    }
  }
  return { vecRebuilt };
}

export function getSetting(db: Db, key: string): unknown {
  return db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

export function setSetting(db: Db, key: string, value: unknown, now: number): void {
  db.insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}

export function deleteSetting(db: Db, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}

/**
 * Vector + keyword index access. Tracks which embedder built the vec table
 * (`settings["embeddings.index"]`) and rebuilds + re-embeds when it changes.
 */
export class MemoryIndex {
  private readyFor: string | null = null;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly kernel: Kernel,
    readonly embedder: Embedder,
  ) {
    // Tables must exist before the first (possibly synchronous) query.
    const recorded = getSetting(kernel.db, EMBED_INDEX_SETTING) as { dims?: number } | null;
    ensureMemoryIndexes(kernel.sqlite, typeof recorded?.dims === 'number' ? recorded.dims : embedder.dims);
  }

  /** Settle the embedder, then make sure the vec table matches it. Call before any vector operation. */
  async ready(): Promise<void> {
    if (isResolvable(this.embedder)) await this.embedder.resolve();
    const key = `${this.embedder.id}|${this.embedder.dims}`;
    if (this.readyFor === key) return;
    if (!this.pending) {
      this.pending = this.sync(key).finally(() => {
        this.pending = null;
      });
    }
    await this.pending;
    if (this.readyFor !== key) await this.ready();
  }

  private async sync(key: string): Promise<void> {
    const { db, sqlite, clock, log } = this.kernel;
    const { id, dims } = this.embedder;
    const recorded = getSetting(db, EMBED_INDEX_SETTING) as { id?: string; dims?: number } | null;
    const changed = recorded !== null && (recorded.id !== id || recorded.dims !== dims);
    const { vecRebuilt } = ensureMemoryIndexes(sqlite, dims);
    if (changed && !vecRebuilt) sqlite.exec('DELETE FROM memories_vec');
    const missing = sqlite
      .prepare("select m.rowid as rowid, m.content as content from memories m where m.status != 'forgotten' and m.rowid not in (select rowid from memories_vec)")
      .all() as Array<{ rowid: number; content: string }>;
    if (missing.length > 0) {
      if (changed) log.info({ from: recorded, to: { id, dims }, count: missing.length }, 'embedder changed; re-embedding memories');
      for (let i = 0; i < missing.length; i += 64) {
        const batch = missing.slice(i, i + 64);
        const vecs = await this.embedder.embed(batch.map((m) => m.content));
        // The embedder switched mid-sync (provider fallback): stop; `ready()` re-syncs against the new one.
        if (this.embedder.id !== id || this.embedder.dims !== dims) return;
        const tx = sqlite.transaction(() => {
          batch.forEach((m, j) => {
            const v = vecs[j];
            if (v) this.put(m.rowid, v);
          });
        });
        tx();
      }
    }
    if (recorded === null || changed) setSetting(db, EMBED_INDEX_SETTING, { id, dims }, clock.now());
    this.readyFor = key;
  }

  async embed(text: string): Promise<Float32Array> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.ready();
      const key = `${this.embedder.id}|${this.embedder.dims}`;
      const [v] = await this.embedder.embed([text]);
      // The embedder may switch while embedding (provider fallback): re-sync the index and embed again.
      if (`${this.embedder.id}|${this.embedder.dims}` !== key) continue;
      if (!v || v.length !== this.embedder.dims) throw new Error('embedder returned an invalid vector');
      return v;
    }
    throw new Error('embedder kept changing while embedding');
  }

  put(rowid: number, vec: Float32Array): void {
    const id = BigInt(rowid);
    this.kernel.sqlite.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(id);
    this.kernel.sqlite.prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)').run(id, vecToBuffer(vec));
  }

  remove(rowid: number): void {
    this.kernel.sqlite.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(BigInt(rowid));
  }

  /** Cosine similarity (1 − distance) of `query` to each given rowid that has a vector. */
  similarities(query: Float32Array, rowids: number[]): Map<number, number> {
    const out = new Map<number, number>();
    const q = vecToBuffer(query);
    for (let i = 0; i < rowids.length; i += 400) {
      const chunk = rowids.slice(i, i + 400);
      const rows = this.kernel.sqlite
        .prepare(`select rowid, vec_distance_cosine(embedding, ?) as d from memories_vec where rowid in (${chunk.map(() => '?').join(',')})`)
        .all(q, ...chunk) as Array<{ rowid: number; d: number | null }>;
      for (const r of rows) out.set(Number(r.rowid), 1 - (r.d ?? 1));
    }
    return out;
  }

  vectors(rowids: number[]): Map<number, Float32Array> {
    const out = new Map<number, Float32Array>();
    for (let i = 0; i < rowids.length; i += 400) {
      const chunk = rowids.slice(i, i + 400);
      const rows = this.kernel.sqlite
        .prepare(`select rowid, embedding from memories_vec where rowid in (${chunk.map(() => '?').join(',')})`)
        .all(...chunk) as Array<{ rowid: number; embedding: Buffer }>;
      for (const r of rows) out.set(Number(r.rowid), bufferToVec(r.embedding));
    }
    return out;
  }

  /** bm25 keyword hits within one org: rowid → positive relevance (higher = better). */
  keywordHits(orgId: string, match: string, limit = 400): Map<number, number> {
    const rows = this.kernel.sqlite
      .prepare(
        `select memories_fts.rowid as rowid, bm25(memories_fts) as s
         from memories_fts join memories m on m.rowid = memories_fts.rowid
         where memories_fts match ? and m.org_id = ? order by s limit ?`,
      )
      .all(match, orgId, limit) as Array<{ rowid: number; s: number }>;
    return new Map(rows.map((r) => [Number(r.rowid), Math.max(-r.s, 1e-12)]));
  }

  sessionHits(orgId: string, agentId: string | null, match: string, limit: number): Array<{ runId: string; issueId: string | null; summary: string; createdAt: number }> {
    return this.kernel.sqlite
      .prepare(
        `select s.run_id as runId, s.issue_id as issueId, s.summary as summary, s.created_at as createdAt
         from session_summaries_fts join session_summaries s on s.rowid = session_summaries_fts.rowid
         where session_summaries_fts match ? and s.org_id = ? and (? is null or s.agent_id = ?)
         order by bm25(session_summaries_fts), s.created_at desc limit ?`,
      )
      .all(match, orgId, agentId, agentId, limit) as Array<{ runId: string; issueId: string | null; summary: string; createdAt: number }>;
  }
}
