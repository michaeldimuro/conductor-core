import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';
import type * as schema from '../db/schema/index.js';
import type { ConductorPaths } from '../shared/paths.js';
import type { EventBus } from '../shared/events.js';
import type { Clock, Logger } from '../shared/util.js';
import type { Actor } from './types.js';

export type Db = BetterSQLite3Database<typeof schema>;
export type Sqlite = Database.Database;

/**
 * Secrets never live in the database. Everything else stores a `secret_ref`
 * (an opaque name) and resolves it here at the last possible moment.
 * Implementations: macOS Keychain, encrypted file vault (headless), memory (tests).
 */
export interface SecretStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  has(ref: string): Promise<boolean>;
}

export interface AuditEntry {
  orgId: string | null;
  actor: Actor;
  /** Dotted verb: run.started, tool.called, approval.decided, config.changed, memory.written, skill.changed… */
  action: string;
  entityKind?: string;
  entityId?: string;
  runId?: string;
  issueId?: string;
  data?: Record<string, unknown>;
}

export interface AuditRecord extends AuditEntry {
  id: number;
  ts: number;
}

/** Append-only activity log. */
export interface AuditLog {
  record(entry: AuditEntry): void;
  query(filter: {
    orgId?: string | null;
    issueId?: string;
    runId?: string;
    entityKind?: string;
    entityId?: string;
    action?: string;
    since?: number;
    limit?: number;
  }): AuditRecord[];
}

/**
 * The org's cheap "utility model" used for reflection, summarization,
 * memory extraction and eval judging. Resolved per org from
 * organizations.utility_model; a deterministic heuristic implementation is
 * used when no model is configured so the learning loop still functions offline.
 */
export interface UtilityModel {
  complete(req: {
    orgId: string;
    system?: string;
    prompt: string;
    /** Ask for a JSON object; the result's `json` is parsed (or null on failure). */
    json?: boolean;
    maxTokens?: number;
    /** What this call is for; drives the offline heuristic fallback and ledger category. */
    purpose: 'reflect' | 'summarize' | 'extract' | 'judge' | 'consolidate' | 'review' | 'plan' | 'chat';
  }): Promise<{ text: string; json: unknown | null; tokensIn: number; tokensOut: number; costUsd: number; offline: boolean }>;
}

export interface Embedder {
  readonly id: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** The shared kernel handed to every bounded context's factory. */
export interface Kernel {
  db: Db;
  sqlite: Sqlite;
  paths: ConductorPaths;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  secrets: SecretStore;
  audit: AuditLog;
}
