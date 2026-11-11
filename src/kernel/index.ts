import { openDb } from '../db/client.js';
import { ConductorPaths } from '../shared/paths.js';
import { EventBus } from '../shared/events.js';
import { createLogger, systemClock, type Clock, type Logger } from '../shared/util.js';
import type { Kernel, SecretStore } from '../contracts/kernel.js';
import { SqliteAuditLog } from './audit.js';
import { createSecretStore } from './secrets.js';

export interface KernelOptions {
  home?: string;
  /** Override the DB file (":memory:" in tests). */
  dbFile?: string;
  clock?: Clock;
  secrets?: SecretStore;
  log?: Logger;
}

export interface KernelHandle extends Kernel {
  close(): void;
}

/** Build the shared kernel: paths, DB (migrated), bus, clock, logger, secrets, audit. */
export function createKernel(opts: KernelOptions = {}): KernelHandle {
  const paths = new ConductorPaths(opts.home);
  paths.ensure(paths.home);
  const { db, sqlite, close } = openDb(opts.dbFile ?? paths.db);
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? createLogger('conductord');
  const bus = new EventBus();
  bus.onError = (err, name) => log.error({ err, event: name }, 'event handler failed');
  const secrets = opts.secrets ?? createSecretStore({ vaultFile: paths.vault });
  const audit = new SqliteAuditLog(db, clock);
  return { db, sqlite, paths, bus, clock, log, secrets, audit, close };
}

export { SqliteAuditLog } from './audit.js';
export { KeychainSecretStore, FileVaultSecretStore, MemorySecretStore, createSecretStore } from './secrets.js';
