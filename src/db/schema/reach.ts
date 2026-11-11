import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Persistent Chromium profile; one per agent or shared per department. Never crosses orgs. */
export const browserProfiles = sqliteTable(
  'browser_profiles',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id'),
    deptId: text('dept_id'),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    userDataDir: text('user_data_dir').notNull(),
    /** Secret-store ref of the key encrypting the at-rest cookie jar. */
    cookieVaultRef: text('cookie_vault_ref'),
    /** Hostname patterns the profile may visit; empty = unrestricted. */
    domainAllowlist: text('domain_allowlist', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Hostname patterns where submits/purchases require an Approval before the click. */
    sensitiveDomains: text('sensitive_domains', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Lease: a profile is used by one run at a time (part of the run journal). */
    leasedRunId: text('leased_run_id'),
    leasedAt: integer('leased_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('browser_profile_slug_uq').on(t.orgId, t.slug)],
);

/** Human-takeover sessions and their one-time share links. */
export const browserSessions = sqliteTable(
  'browser_sessions',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    profileId: text('profile_id').notNull(),
    runId: text('run_id'),
    issueId: text('issue_id'),
    agentId: text('agent_id'),
    reason: text('reason').notNull().default(''),
    /** SHA-256 of the signed share token. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    /** Set when the single permitted viewer first opens the link. */
    claimedAt: integer('claimed_at'),
    viewerId: text('viewer_id'),
    /** pending | active (human in control) | handed_back | expired | cancelled */
    status: text('status', { enum: ['pending', 'active', 'handed_back', 'expired', 'cancelled'] }).notNull().default('pending'),
    handedBackAt: integer('handed_back_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('browser_session_run_idx').on(t.runId), uniqueIndex('browser_session_token_uq').on(t.tokenHash)],
);

export const GATEWAY_KINDS = ['telegram', 'slack', 'discord', 'imessage', 'email'] as const;
export type GatewayKind = (typeof GATEWAY_KINDS)[number];

/** Messaging gateways (Hermes-style). */
export const gateways = sqliteTable('gateways', {
  id: text('id').primaryKey(),
  /** NULL = serves every org (owner-level gateway). */
  orgId: text('org_id'),
  kind: text('kind', { enum: GATEWAY_KINDS }).notNull(),
  name: text('name').notNull(),
  /** Non-secret config: allowed chat ids, channel, digest time, SMTP host… */
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  authRef: text('auth_ref'),
  status: text('status', { enum: ['active', 'disabled', 'error'] }).notNull().default('active'),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Which org/agent a chat thread is currently talking to. */
export const gatewayChats = sqliteTable(
  'gateway_chats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gatewayId: text('gateway_id').notNull(),
    chatId: text('chat_id').notNull(),
    orgId: text('org_id'),
    agentId: text('agent_id'),
    /** Issue used as the conversation thread with the agent. */
    issueId: text('issue_id'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('gateway_chat_uq').on(t.gatewayId, t.chatId)],
);

export const webhooks = sqliteTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    direction: text('direction', { enum: ['in', 'out'] }).notNull(),
    name: text('name').notNull(),
    /** in: github | stripe | composio | generic (selects signature verification). */
    source: text('source').notNull().default('generic'),
    /** in: agent to wake. */
    agentId: text('agent_id'),
    /** out: destination URL. */
    url: text('url'),
    /** out: event names to deliver; in: optional event filter. */
    events: text('events', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Secret-store ref for the HMAC signing secret. */
    secretRef: text('secret_ref'),
    status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('webhook_org_idx').on(t.orgId, t.direction)],
);
