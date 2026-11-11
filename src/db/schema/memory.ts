import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

export const MEMORY_KINDS = ['profile', 'owner_model', 'procedural', 'semantic', 'episodic', 'lesson'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_SCOPES = ['org', 'dept', 'agent'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/**
 * Typed long-term memory. Companion virtual tables (created in db/virtual.ts):
 *   memories_fts(content, entity)        — FTS5, rowid = memories.rowid
 *   memories_vec(embedding float[N])     — sqlite-vec, rowid = memories.rowid
 */
export const memories = sqliteTable(
  'memories',
  {
    rowid: integer('rowid').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    orgId: text('org_id').notNull(),
    scope: text('scope', { enum: MEMORY_SCOPES }).notNull(),
    /** org id / dept id / agent id. */
    scopeId: text('scope_id').notNull(),
    kind: text('kind', { enum: MEMORY_KINDS }).notNull(),
    content: text('content').notNull(),
    /** Entity this fact is about (semantic memories), lowercased. */
    entity: text('entity'),
    /** Task type this applies to (procedural/lesson retrieval). */
    taskType: text('task_type'),
    importance: real('importance').notNull().default(0.5),
    confidence: real('confidence').notNull().default(0.7),
    /** Why the agent believes this. */
    sourceRunId: text('source_run_id'),
    author: text('author').notNull().default('agent'),
    /** active | review (low-confidence queue) | superseded | forgotten */
    status: text('status', { enum: ['active', 'review', 'superseded', 'forgotten'] }).notNull().default('active'),
    supersededBy: text('superseded_by'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('memory_scope_idx').on(t.orgId, t.scope, t.scopeId, t.status),
    index('memory_kind_idx').on(t.orgId, t.kind, t.status),
    index('memory_entity_idx').on(t.orgId, t.entity),
  ],
);

/** FTS5-searchable run summaries (Hermes-style session search). */
export const sessionSummaries = sqliteTable(
  'session_summaries',
  {
    rowid: integer('rowid').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull().unique(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    issueId: text('issue_id'),
    summary: text('summary').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('session_summary_agent_idx').on(t.orgId, t.agentId)],
);
