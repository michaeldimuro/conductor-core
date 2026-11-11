#!/usr/bin/env node
/**
 * conductord — the always-on control plane.
 *
 *   conductord --serve      run the daemon (what launchd executes)
 *
 * Exit codes matter: launchd's KeepAlive={SuccessfulExit:false} restarts us on
 * any non-zero exit (crash) but not after a clean, requested shutdown (0).
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServices } from './compose.js';
import { createApiServer } from '../api/index.js';
import { startGateways } from '../gateways/index.js';
import { VERSION } from './container.js';

async function serve(): Promise<void> {
  // Headless profile: the vault passphrase lives in a root-only key file, never in the plist.
  const keyFile = process.env.CONDUCTOR_VAULT_KEY_FILE;
  if (keyFile && !process.env.CONDUCTOR_VAULT_KEY && existsSync(keyFile)) {
    process.env.CONDUCTOR_VAULT_KEY = readFileSync(keyFile, 'utf8').trim();
  }

  const services = await createServices({ browserHeadless: true });
  const { kernel, config } = services;
  const log = kernel.log;
  const pidFile = join(kernel.paths.ensure(kernel.paths.runDir), 'conductord.pid');

  // Messaging gateways contribute their own HTTP routes (Slack events, etc.) as a plugin.
  const gateways = await startGateways(services);
  const api = await createApiServer(services, { plugins: [gateways.routes] });
  await api.listen(config.host, config.port);
  // Runs are only dispatched once the API (and with it the MCP gateway endpoint) is up.
  await services.runtime.start();
  writeFileSync(pidFile, String(process.pid));
  log.info({ port: config.port, host: config.host, home: kernel.paths.home, version: VERSION }, 'conductord ready');

  let stopping = false;
  const shutdown = async (signal: string, code: number) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'conductord shutting down');
    const force = setTimeout(() => process.exit(code || 1), 20_000);
    force.unref();
    try {
      await gateways.stop();
      await api.close();
      await services.close();
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    }
    rmSync(pidFile, { force: true });
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
