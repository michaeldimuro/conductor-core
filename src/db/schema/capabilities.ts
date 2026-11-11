import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ToolPolicy, SkillEvalResult } from '../../contracts/types.js';

export const SCOPES = ['global', 'org', 'dept', 'agent'] as const;
export type Scope = (typeof SCOPES)[number];

export const SKILL_STATUSES = ['draft', 'active', 'deprecated', 'quarantined'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

export const skills = sqliteTable(
  'skills',
  {
    id: text('id').primaryKey(),
    /** NULL only for scope=global. */
    orgId: text('org_id'),
    scope: text('scope', { enum: SCOPES }).notNull(),
    /** org id / dept id / agent id for the scope; NULL for global. */
    scopeId: text('scope_id'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    version: integer('version').notNull().default(1),
    /** "human" or "agent:<id>" */
    author: text('author').notNull().default('human'),
    status: text('status', { enum: SKILL_STATUSES }).notNull().default('draft'),
    evalScore: real('eval_score'),
    /** Absolute path of the skill folder (contains SKILL.md). */
    path: text('path').notNull(),
    contentHash: text('content_hash').notNull(),
    /** For imported third-party skills: hash pinned at import. */
    pinnedHash: text('pinned_hash'),
    source: text('source'),
    hasScripts: integer('has_scripts', { mode: 'boolean' }).notNull().default(false),
    scanFindings: text('scan_findings', { mode: 'json' })
      .$type<Array<{ rule: string; severity: 'info' | 'warn' | 'block'; detail: string }>>()
      .notNull()
      .default([]),
    createdRunId: text('created_run_id'),
    originIssueId: text('origin_issue_id'),
    useCount: integer('use_count').notNull().default(0),
    successCount: integer('success_count').notNull().default(0),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('skill_scope_name_uq').on(t.scope, t.scopeId, t.name),
    index('skill_org_idx').on(t.orgId),
  ],
);

export const skillVersions = sqliteTable(
  'skill_versions',
  {
    id: text('id').primaryKey(),
    skillId: text('skill_id').notNull(),
    orgId: text('org_id'),
    version: integer('version').notNull(),
    commitSha: text('commit_sha'),
    author: text('author').notNull(),
    runId: text('run_id'),
    message: text('message').notNull().default(''),
    contentHash: text('content_hash').notNull(),
    eval: text('eval', { mode: 'json' }).$type<SkillEvalResult>(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('skill_version_uq').on(t.skillId, t.version)],
);

/** One row per run that loaded a skill, with the run outcome (drives adapt/auto-revert). */
export const skillUsages = sqliteTable(
  'skill_usages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    skillId: text('skill_id').notNull(),
    orgId: text('org_id'),
    version: integer('version').notNull(),
    runId: text('run_id').notNull(),
    agentId: text('agent_id').notNull(),
    success: integer('success', { mode: 'boolean' }),
    humanEdited: integer('human_edited', { mode: 'boolean' }).notNull().default(false),
    costUsd: real('cost_usd').notNull().default(0),
    steps: integer('steps').notNull().default(0),
    ts: integer('ts').notNull(),
  },
  (t) => [index('skill_usage_idx').on(t.skillId, t.ts)],
);

/** Stored eval cases for replaying a skill with/without it in a sandbox. */
export const evalCases = sqliteTable('eval_cases', {
  id: text('id').primaryKey(),
  orgId: text('org_id'),
  skillId: text('skill_id').notNull(),
  issueId: text('issue_id'),
  prompt: text('prompt').notNull(),
  /** Natural-language success criteria judged by the utility model. */
  successCriteria: text('success_criteria').notNull().default(''),
  createdAt: integer('created_at').notNull(),
});

export const CONNECTOR_KINDS = ['mcp_stdio', 'mcp_http', 'composio', 'arcade', 'builtin', 'openapi'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const connectors = sqliteTable(
  'connectors',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    scope: text('scope', { enum: SCOPES }).notNull().default('org'),
    scopeId: text('scope_id'),
    kind: text('kind', { enum: CONNECTOR_KINDS }).notNull(),
    name: text('name').notNull(),
    /** Catalog template id this was installed from, if any. */
    templateId: text('template_id'),
    /** Kind-specific config (command/args/url/toolkit/spec…). Never contains secrets. */
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    /** Secret-store reference for default credentials. */
    authRef: text('auth_ref'),
    /** Connector-level allowlist; NULL = all tools. */
    toolAllowlist: text('tool_allowlist', { mode: 'json' }).$type<string[] | null>(),
    status: text('status', { enum: ['active', 'disabled', 'error'] }).notNull().default('active'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('connector_scope_name_uq').on(t.orgId, t.name), index('connector_org_idx').on(t.orgId)],
);

/** A connector granted to an agent, with a tool allowlist, per-tool policy and bound credentials. */
export const connectorGrants = sqliteTable(
  'connector_grants',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    connectorId: text('connector_id').notNull(),
    agentId: text('agent_id').notNull(),
    /** NULL = every tool the connector allows. */
    toolAllowlist: text('tool_allowlist', { mode: 'json' }).$type<string[] | null>(),
    /** Per-tool policy: allowed | ask | off. */
    toolPolicies: text('tool_policies', { mode: 'json' }).$type<Record<string, ToolPolicy>>().notNull().default({}),
    defaultPolicy: text('default_policy', { enum: ['allowed', 'ask', 'off'] }).notNull().default('allowed'),
    /** Per-grant credentials (e.g. a different Composio connected account). */
    authRef: text('auth_ref'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('grant_uq').on(t.connectorId, t.agentId), index('grant_agent_idx').on(t.agentId)],
);

/** Pinned tool schema hashes. A changed upstream schema is quarantined until re-trusted. */
export const toolPins = sqliteTable(
  'tool_pins',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orgId: text('org_id'),
    connectorId: text('connector_id').notNull(),
    toolName: text('tool_name').notNull(),
    schemaHash: text('schema_hash').notNull(),
    /** Hash seen upstream that differs from the pin (awaiting re-trust). */
    pendingHash: text('pending_hash'),
    status: text('status', { enum: ['trusted', 'quarantined'] }).notNull().default('trusted'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('tool_pin_uq').on(t.connectorId, t.toolName)],
);

/** Audit row for every gateway tool call. */
export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    runId: text('run_id'),
    agentId: text('agent_id').notNull(),
    issueId: text('issue_id'),
    connectorId: text('connector_id').notNull(),
    tool: text('tool').notNull(),
    argsHash: text('args_hash').notNull(),
    resultSize: integer('result_size').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    /** ok | error | denied | approval_pending */
    status: text('status').notNull(),
    approvalId: text('approval_id'),
    ts: integer('ts').notNull(),
  },
  (t) => [index('tool_call_run_idx').on(t.runId), index('tool_call_org_idx').on(t.orgId, t.ts)],
);
