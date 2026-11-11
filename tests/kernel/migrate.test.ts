import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'db', 'migrations');
const FIRST = '0000_shallow_hawkeye';

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

/** A migrations folder holding only the first migration: the schema an existing install was created with. */
function baselineFolder(dir: string): string {
  const folder = join(dir, 'baseline');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  cpSync(join(MIGRATIONS, `${FIRST}.sql`), join(folder, `${FIRST}.sql`));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.tag === FIRST) }));
  return folder;
}

const columns = (sqlite: Database.Database, table: string): string[] =>
  (sqlite.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name);

describe('db: upgrading an existing database', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conductor-migrate-'));
    file = join(dir, 'conductor.db');
    // Create the DB exactly as the first release did, then put data in it.
    const sqlite = new Database(file);
    migrate(drizzle(sqlite), { migrationsFolder: baselineFolder(dir) });
    expect(columns(sqlite, 'browser_profiles')).not.toContain('engine');
    expect(columns(sqlite, 'memories')).not.toContain('external_ref');
    sqlite.exec(`
      INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ('org_1', 'acme', 'Acme', 1, 1);
      INSERT INTO issues (id, org_id, number, title, created_at, updated_at) VALUES ('iss_1', 'org_1', 1, 'First', 1, 1), ('iss_2', 'org_1', 2, 'Second', 1, 1);
      INSERT INTO browser_profiles (id, org_id, slug, name, user_data_dir, created_at, updated_at) VALUES ('bp_1', 'org_1', 'main', 'Main', '/tmp/p', 1, 1);
      INSERT INTO memories (id, org_id, scope, scope_id, kind, content, created_at, updated_at) VALUES ('mem_1', 'org_1', 'org', 'org_1', 'semantic', 'A fact', 1, 1);
    `);
    sqlite.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('openDb applies the newer migrations and keeps the data', () => {
    const { sqlite, close } = openDb(file);
    try {
      expect(sqlite.prepare('SELECT id, number, title FROM issues ORDER BY number').all()).toEqual([
        { id: 'iss_1', number: 1, title: 'First' },
        { id: 'iss_2', number: 2, title: 'Second' },
      ]);
      // New columns exist; existing rows got the defaults.
      expect(sqlite.prepare('SELECT id, engine, headed FROM browser_profiles').all()).toEqual([{ id: 'bp_1', engine: 'bundled', headed: null }]);
      expect(sqlite.prepare('SELECT id, content, external_ref FROM memories').all()).toEqual([{ id: 'mem_1', content: 'A fact', external_ref: null }]);

      // Issue numbers are now unique per org — and only per org.
      const insert = sqlite.prepare("INSERT INTO issues (id, org_id, number, title, created_at, updated_at) VALUES (?, ?, ?, 'x', 1, 1)");
      expect(() => insert.run('iss_dup', 'org_1', 2)).toThrow(/UNIQUE/);
      sqlite.exec("INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ('org_2', 'beta', 'Beta', 1, 1)");
      expect(() => insert.run('iss_other', 'org_2', 2)).not.toThrow();
      const indexes = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'issues'").all() as Array<{ name: string }>).map((i) => i.name);
      expect(indexes).toContain('issue_org_number_uq');
      expect(indexes).not.toContain('issue_org_number_idx');
    } finally {
      close();
    }
  });

  it('reopening an up-to-date database is a no-op', () => {
    openDb(file).close();
    const { sqlite, close } = openDb(file);
    try {
      expect(sqlite.prepare('SELECT count(*) AS n FROM issues').get()).toEqual({ n: 2 });
      expect(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
        n: (JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal).entries.length,
      });
    } finally {
      close();
    }
  });
});
