import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const APPROVAL_KINDS = [
  'hire_agent',
  'terminate_agent',
  'budget_raise',
  'payment',
  'external_send',
  'publish',
  'grant_connector',
  'grant_skill',
  'promote_skill',
  'tool_call',
  'browser_action',
  'connector_auth',
  'config_change',
  'other',
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    requesterAgentId: text('requester_agent_id'),
    runId: text('run_id'),
    issueId: text('issue_id'),
    kind: text('kind', { enum: APPROVAL_KINDS }).notNull(),
    title: text('title').notNull(),
    /** Kind-specific payload; whatever is needed to execute the action once approved. */
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    status: text('status', { enum: ['pending', 'approved', 'denied', 'expired', 'cancelled'] }).notNull().default('pending'),
    decidedBy: text('decided_by'),
    decisionNote: text('decision_note'),
    decidedAt: integer('decided_at'),
    /** Set once an approved action has been executed (approvals are single-use). */
    consumedAt: integer('consumed_at'),
    expiresAt: integer('expires_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('approval_org_status_idx').on(t.orgId, t.status)],
);

/** Recipients already contacted — "first send to a new external recipient" is approval-gated. */
export const knownRecipients = sqliteTable(
  'known_recipients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orgId: text('org_id').notNull(),
    address: text('address').notNull(),
    firstApprovedAt: integer('first_approved_at').notNull(),
  },
  (t) => [uniqueIndex('recipient_uq').on(t.orgId, t.address)],
);

/**
 * Append-only audit trail. UPDATE and DELETE are rejected by triggers
 * (created in db/virtual.ts).
 */
export const activityLog = sqliteTable(
  'activity_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** NULL for install-level events. */
    orgId: text('org_id'),
    actorKind: text('actor_kind', { enum: ['human', 'agent', 'system'] }).notNull(),
    actorId: text('actor_id'),
    /** dotted verb, e.g. run.started, tool.called, approval.decided, config.changed, memory.written, skill.changed */
    action: text('action').notNull(),
    entityKind: text('entity_kind'),
    entityId: text('entity_id'),
    runId: text('run_id'),
    issueId: text('issue_id'),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    ts: integer('ts').notNull(),
  },
  (t) => [
    index('activity_org_ts_idx').on(t.orgId, t.ts),
    index('activity_issue_idx').on(t.issueId, t.ts),
    index('activity_entity_idx').on(t.entityKind, t.entityId),
  ],
);

/** Revisioned config with rollback for orgs, departments, agents, connectors, grants. */
export const configRevisions = sqliteTable(
  'config_revisions',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),
    revision: integer('revision').notNull(),
    snapshot: text('snapshot', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    author: text('author').notNull(),
    note: text('note'),
    ts: integer('ts').notNull(),
  },
  (t) => [uniqueIndex('revision_uq').on(t.entityKind, t.entityId, t.revision)],
);

/** Bearer tokens. Only SHA-256 hashes are stored. */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    /** owner = full API; run = one agent's permissions for one run; device = remote UI session. */
    kind: text('kind', { enum: ['owner', 'run', 'device'] }).notNull(),
    orgId: text('org_id'),
    agentId: text('agent_id'),
    runId: text('run_id'),
    label: text('label'),
    expiresAt: integer('expires_at'),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('token_run_idx').on(t.runId)],
);

/** Install-level key/value settings (global kill switch, tunnel config, schema of embeddings…). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});
