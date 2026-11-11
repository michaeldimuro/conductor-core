import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApiServer, type ApiServer } from '../api/index.js';
import { startGateways, type GatewayOptions, type Gateways } from '../gateways/index.js';
import { organizations } from '../db/schema/index.js';
import { createServices, type ComposedServices, type ComposeOptions } from './compose.js';
import { VERSION } from './container.js';
import {
  bounded, RESTART_BUDGET_MS, SHUTDOWN_BUDGET_MS, SHUTDOWN_NETWORK_MS, STARTUP_TARGET_MS, warnIfExposed, type PhaseOutcome,
} from './lifecycle.js';

export interface StartOptions extends ComposeOptions {
  gateways?: GatewayOptions;
  /** Write `<home>/run/conductord.pid` (default true). */
  pidFile?: boolean;
}

export interface StopReport {
  ms: number;
  phases: Record<'gateways' | 'api' | 'services', PhaseOutcome>;
  withinBudget: boolean;
}

export interface DaemonHandle {
  services: ComposedServices;
  api: ApiServer;
  gateways: Gateways;
  /** Milliseconds from the start of composition until the API accepted connections. */
  listeningMs: number;
  /** Milliseconds until the daemon was fully up (API listening and the runtime dispatching). */
  startupMs: number;
  /** Graceful, time-boxed shutdown. Idempotent. */
  stop(opts?: { budgetMs?: number }): Promise<StopReport>;
}

/** Create the PRD on-disk layout: present from first start, not lazily by whichever feature runs first. */
function ensureLayout(services: ComposedServices): () => void {
  const { kernel } = services;
  kernel.paths.ensureBaseLayout();
  kernel.paths.ensure(kernel.paths.logs);
  const ensureOrg = (slug: string): void => {
    try {
      kernel.paths.ensureOrgLayout(slug);
    } catch (err) {
      kernel.log.warn({ err, org: slug }, 'could not create the org directory layout');
    }
  };
  for (const row of kernel.db.select({ slug: organizations.slug }).from(organizations).all()) ensureOrg(row.slug);
  return kernel.bus.on('org.created', ({ orgId }) => {
    const row = kernel.db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId)).get();
    if (row) ensureOrg(row.slug);
  });
}

/**
 * Bring the whole daemon up: compose every context, bind the API, start the
 * gateways and the runtime. Used by `conductord --serve` and by tests that
 * measure FR-1 (start and stop times).
 */
export async function startDaemon(opts: StartOptions = {}): Promise<DaemonHandle> {
  const t0 = performance.now();
  const services = await createServices({ browserHeadless: true, ...opts });
  const { kernel, config } = services;
  const log = kernel.log;
  warnIfExposed(log, config.host, config.port);

  const offLayout = ensureLayout(services);
  // The CLI and first-run UI pairing authenticate with the owner token on disk (0600).
  services.governance.tokens.ownerTokenFile();
  const pidFile = opts.pidFile === false ? null : join(kernel.paths.ensure(kernel.paths.runDir), 'conductord.pid');

  // Messaging gateways contribute their own HTTP routes (Slack events, etc.) as a plugin.
  const gateways = await startGateways(services, opts.gateways);
  const api = await createApiServer(services, { plugins: [gateways.routes], gateways });
  await api.listen(config.host, config.port);
  const listeningMs = Math.round(performance.now() - t0);
  // Runs are only dispatched once the API (and with it the MCP gateway endpoint) is up.
  await services.runtime.start();
  if (pidFile) writeFileSync(pidFile, String(process.pid));
  const startupMs = Math.round(performance.now() - t0);

  log.info({ port: config.port, host: config.host, home: kernel.paths.home, version: VERSION, listeningMs, startupMs }, 'conductord ready');
  if (startupMs > STARTUP_TARGET_MS) {
    log.warn({ startupMs, targetMs: STARTUP_TARGET_MS, restartBudgetMs: RESTART_BUDGET_MS }, 'conductord start was slow; FR-1 requires a killed daemon back within 15 s');
  }

  let stopping: Promise<StopReport> | null = null;
  const stop = (stopOpts: { budgetMs?: number } = {}): Promise<StopReport> => {
    stopping ??= (async () => {
      const budget = stopOpts.budgetMs ?? SHUTDOWN_BUDGET_MS;
      const started = Date.now();
      const networkMs = Math.min(SHUTDOWN_NETWORK_MS, budget / 4);
      offLayout();
      // Stop taking traffic first; a stuck connection must not hold the runs' share of the budget.
      const [g, a] = await Promise.all([
        bounded('gateways', () => gateways.stop(), networkMs, log),
        bounded('api', () => api.close(), networkMs, log),
      ]);
      // In-flight runs are cancelled (their issues released); what cannot finish in time stays in the
      // journal as in-flight and is recovered by the next start.
      const remaining = Math.max(250, budget - (Date.now() - started) - 250);
      const s = await bounded('services', () => services.close({ graceMs: remaining }), remaining + 200, log);
      if (pidFile) rmSync(pidFile, { force: true });
      const ms = Date.now() - started;
      return { ms, phases: { gateways: g, api: a, services: s }, withinBudget: ms <= budget };
    })();
    return stopping;
  };

  return { services, api, gateways, listeningMs, startupMs, stop };
}
