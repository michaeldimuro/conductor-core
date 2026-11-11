import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as sqliteVec from 'sqlite-vec';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import * as schema from './schema/index.js';
import type { Db, Sqlite } from '../contracts/kernel.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface OpenDb {
  db: Db;
  sqlite: Sqlite;
  close(): void;
}

/**
 * Open (and migrate) the single SQLite file. WAL + synchronous=NORMAL gives
 * journaled, crash-safe writes; sqlite-vec is loaded for semantic memory.
 */
export function openDb(file: string): OpenDb {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqliteVec.load(sqlite);

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  ensureGuards(sqlite);

  return { db, sqlite, close: () => sqlite.close() };
}

/** Objects Drizzle cannot express: append-only guards on the audit trail. */
function ensureGuards(sqlite: Sqlite): void {
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS activity_log_no_update
    BEFORE UPDATE ON activity_log
    BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS activity_log_no_delete
    BEFORE DELETE ON activity_log
    BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;
  `);
}

/** Consistent point-in-time snapshot (nightly backup). */
export function vacuumInto(sqlite: Sqlite, destFile: string): void {
  mkdirSync(dirname(destFile), { recursive: true });
  sqlite.prepare('VACUUM INTO ?').run(destFile);
}
