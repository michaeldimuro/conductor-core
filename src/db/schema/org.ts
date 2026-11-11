import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ProviderBinding, OrgPolicies } from '../../contracts/types.js';

export const organizations = sqliteTable(
  'organizations',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    mission: text('mission').notNull().default(''),
    owner: text('owner').notNull().default('owner'),
    budgetMonthlyUsd: real('budget_monthly_usd'),
    /** Separate "seat time" quota (seconds/month) for local-subscription runs. */
    seatSecondsMonthly: integer('seat_seconds_monthly'),
    defaultProvider: text('default_provider', { mode: 'json' }).$type<ProviderBinding>(),
    /** Cheap model for reflection, summarization and memory extraction. */
    utilityModel: text('utility_model', { mode: 'json' }).$type<ProviderBinding>(),
    policies: text('policies', { mode: 'json' }).$type<OrgPolicies>().notNull().default({}),
    defaultSkills: text('default_skills', { mode: 'json' }).$type<string[]>().notNull().default([]),
    defaultConnectors: text('default_connectors', { mode: 'json' }).$type<string[]>().notNull().default([]),
    maxConcurrentRuns: integer('max_concurrent_runs').notNull().default(4),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    killSwitch: integer('kill_switch', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('org_slug_uq').on(t.slug)],
);

export const departments = sqliteTable(
  'departments',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    charter: text('charter').notNull().default(''),
    leadAgentId: text('lead_agent_id'),
    budgetUsd: real('budget_usd'),
    /** Skill names shared with every member. */
    sharedSkills: text('shared_skills', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Connector ids shared with every member. */
    sharedConnectors: text('shared_connectors', { mode: 'json' }).$type<string[]>().notNull().default([]),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('dept_org_slug_uq').on(t.orgId, t.slug)],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id),
    deptId: text('dept_id').notNull().references(() => departments.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    // CrewAI-style persona
    role: text('role').notNull(),
    goal: text('goal').notNull().default(''),
    backstory: text('backstory').notNull().default(''),
    /** Agent id of the manager; null means reports to the Owner (root). */
    reportsTo: text('reports_to'),
    /** Primary binding + fallback chain. Null inherits the org default. */
    providerBinding: text('provider_binding', { mode: 'json' }).$type<ProviderBinding>(),
    model: text('model'),
    /** Agent's own skill names (beyond org/dept inheritance). */
    skills: text('skills', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Connector ids the agent may use; fine-grained policy lives in connector_grants. */
    connectors: text('connectors', { mode: 'json' }).$type<string[]>().notNull().default([]),
    denySkills: text('deny_skills', { mode: 'json' }).$type<string[]>().notNull().default([]),
    denyConnectors: text('deny_connectors', { mode: 'json' }).$type<string[]>().notNull().default([]),
    browserProfileId: text('browser_profile_id'),
    heartbeatCron: text('heartbeat_cron'),
    budgetUsd: real('budget_usd'),
    /** 0 Assist · 1 Supervised · 2 Autonomous · 3 Lead */
    autonomyLevel: integer('autonomy_level').notNull().default(1),
    status: text('status', { enum: ['active', 'paused', 'terminated'] }).notNull().default('active'),
    pausedReason: text('paused_reason'),
    maxSteps: integer('max_steps').notNull().default(60),
    maxWallMs: integer('max_wall_ms').notNull().default(30 * 60_000),
    maxRunsPerHour: integer('max_runs_per_hour').notNull().default(12),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('agent_org_slug_uq').on(t.orgId, t.slug),
    index('agent_org_idx').on(t.orgId),
    index('agent_dept_idx').on(t.deptId),
  ],
);

/** CrewAI processes as reusable playbooks that agents run inside issues. */
export const playbooks = sqliteTable(
  'playbooks',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    process: text('process', { enum: ['sequential', 'hierarchical'] }).notNull().default('sequential'),
    /** For hierarchical: the manager agent who delegates and reviews. */
    managerAgentId: text('manager_agent_id'),
    steps: text('steps', { mode: 'json' })
      .$type<Array<{ title: string; description: string; expectedOutput: string; agentRole?: string; agentId?: string }>>()
      .notNull()
      .default([]),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('playbook_org_name_uq').on(t.orgId, t.name)],
);
