import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { organizations } from './org.js';
import type { CapabilitySnapshot, RunGrade } from '../../contracts/types.js';

export const RUN_STATUSES = ['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'released'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ['heartbeat', 'assignment', 'mention', 'approval', 'webhook', 'manual', 'chat', 'resume', 'system'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** One heartbeat execution. Also the run journal: status transitions are durable. */
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id),
    agentId: text('agent_id').notNull(),
    issueId: text('issue_id'),
    trigger: text('trigger', { enum: RUN_TRIGGERS }).notNull(),
    /** Adapter id that actually ran (after fallback). */
    provider: text('provider'),
    model: text('model'),
    status: text('status', { enum: RUN_STATUSES }).notNull().default('queued'),
    /** Which loop step the run reached; used on crash recovery. */
    phase: text('phase'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    /** Subscription (local CLI) runs: $0 marginal, tracked as seat time. */
    subscription: integer('subscription', { mode: 'boolean' }).notNull().default(false),
    seatSeconds: integer('seat_seconds').notNull().default(0),
    steps: integer('steps').notNull().default(0),
    /** completed | failed | cancelled | max_steps | timeout | budget | crashed | no_work */
    outcome: text('outcome'),
    error: text('error'),
    transcriptRef: text('transcript_ref'),
    /** Provider session id for resume (Claude Code --resume, Codex session). */
    sessionId: text('session_id'),
    /** Effective skills/connectors/budget resolved at run start, for audit. */
    capabilitySnapshot: text('capability_snapshot', { mode: 'json' }).$type<CapabilitySnapshot>(),
    /** True once tool output from the outside world entered context (prompt-injection guard). */
    ingestedUntrusted: integer('ingested_untrusted', { mode: 'boolean' }).notNull().default(false),
    grade: text('grade', { mode: 'json' }).$type<RunGrade>(),
    pid: integer('pid'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('run_org_idx').on(t.orgId, t.createdAt),
    index('run_agent_idx').on(t.agentId, t.createdAt),
    index('run_issue_idx').on(t.issueId),
    index('run_status_idx').on(t.status),
  ],
);

/** Normalized RunEvent stream (index); the full transcript also lands in a JSONL file. */
export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    orgId: text('org_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    ts: integer('ts').notNull(),
  },
  (t) => [uniqueIndex('run_event_seq_uq').on(t.runId, t.seq)],
);

export const JOB_KINDS = ['heartbeat', 'event', 'reflect', 'dream', 'weekly_review', 'digest', 'backup', 'skill_eval', 'skill_retire', 'webhook_out'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** DB-backed job table: cron heartbeats + event queue. Survives restarts without Redis. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    kind: text('kind', { enum: JOB_KINDS }).notNull(),
    agentId: text('agent_id'),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    runAt: integer('run_at').notNull(),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed', 'cancelled'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lockedBy: text('locked_by'),
    lockedAt: integer('locked_at'),
    /** At most one pending job per dedupe key (collapses missed heartbeats after sleep). */
    dedupeKey: text('dedupe_key'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('job_due_idx').on(t.status, t.runAt), index('job_dedupe_idx').on(t.dedupeKey, t.status)],
);

/** Per-run cost ledger rows; budgets sum these per month at org/dept/agent/project level. */
export const costLedger = sqliteTable(
  'cost_ledger',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    deptId: text('dept_id'),
    agentId: text('agent_id'),
    projectId: text('project_id'),
    runId: text('run_id'),
    /** run | reflection | embedding | tool | eval */
    category: text('category').notNull().default('run'),
    provider: text('provider'),
    model: text('model'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    subscription: integer('subscription', { mode: 'boolean' }).notNull().default(false),
    seatSeconds: integer('seat_seconds').notNull().default(0),
    ts: integer('ts').notNull(),
  },
  (t) => [index('ledger_org_ts_idx').on(t.orgId, t.ts), index('ledger_agent_ts_idx').on(t.agentId, t.ts)],
);

/** Weekly per-agent scorecard snapshots (success rate, rework rate, cost per issue). */
export const scorecards = sqliteTable(
  'scorecards',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    taskType: text('task_type'),
    periodStart: integer('period_start').notNull(),
    periodEnd: integer('period_end').notNull(),
    runs: integer('runs').notNull().default(0),
    issuesClosed: integer('issues_closed').notNull().default(0),
    successRate: real('success_rate').notNull().default(0),
    reworkRate: real('rework_rate').notNull().default(0),
    costPerIssue: real('cost_per_issue').notNull().default(0),
    avgSteps: real('avg_steps').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('scorecard_agent_idx').on(t.agentId, t.periodStart)],
);
