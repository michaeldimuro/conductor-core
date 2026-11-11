#!/usr/bin/env node
/**
 * conductord — the always-on control plane.
 *
 *   conductord --serve      run the daemon (what launchd executes)
 *
 * Exit codes matter: launchd's KeepAlive={SuccessfulExit:false} restarts us on
 * any non-zero exit (crash) but not after a clean, requested shutdown (0).
 */
import { readFileSync, existsSync } from 'node:fs';
import { VERSION } from './container.js';
import { SHUTDOWN_BUDGET_MS } from './lifecycle.js';
import { startDaemon } from './server.js';

async function serve(): Promise<void> {
  // Headless profile: the vault passphrase lives in a root-only key file, never in the plist.
  const keyFile = process.env.CONDUCTOR_VAULT_KEY_FILE;
  if (keyFile && !process.env.CONDUCTOR_VAULT_KEY && existsSync(keyFile)) {
    process.env.CONDUCTOR_VAULT_KEY = readFileSync(keyFile, 'utf8').trim();
  }

  const daemon = await startDaemon();
  const log = daemon.services.kernel.log;
  // What FR-1 is measured against: process launch → API reachable.
  log.info({ sinceProcessStartMs: Math.round(process.uptime() * 1000), startupMs: daemon.startupMs }, 'conductord start time');

  let stopping = false;
  const shutdown = async (signal: string, code: number) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal, budgetMs: SHUTDOWN_BUDGET_MS }, 'conductord shutting down');
    // Backstop: stop() is time-boxed itself; this only fires if something blocks the event loop's exit path.
    const force = setTimeout(() => process.exit(code || 1), SHUTDOWN_BUDGET_MS + 1_000);
    force.unref();
    try {
      const report = await daemon.stop();
      log.info(report, 'conductord stopped');
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    }
    process.exit(code);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  // A bug in one request or job must not take the control plane down…
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
  // …but a truly unknown state should: exit non-zero and let launchd restart us; the journal recovers in-flight runs.
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
} else if (args.includes('--serve') || args.length === 0) {
  serve().catch((err) => {
    console.error('conductord failed to start:', err);
    process.exit(1);
  });
} else {
  console.error('usage: conductord --serve');
  process.exit(2);
}
