import { eq } from 'drizzle-orm';
import { createKernel, type KernelOptions } from '../kernel/index.js';
import { settings } from '../db/schema/index.js';
import type { RunControl } from '../contracts/services.js';
import type { AdapterRegistry, AdapterRescanResult } from '../contracts/adapter.js';
import { createGovernance } from '../governance/index.js';
import { createOrgService } from '../org/index.js';
import { createWorkService, createTasksToolProvider } from '../work/index.js';
import { createSkillService } from '../skills/index.js';
import { createMemoryService, createUtilityModel, createEmbedder } from '../memory/index.js';
import { createConnectorGateway, createFilesToolProvider } from '../connectors/index.js';
import { createBrowserService } from '../browser/index.js';
import { createAdapterRegistry } from '../adapters/index.js';
import { createProviderAuth } from '../adapters/auth/index.js';
import { createModelCatalog } from '../adapters/catalog/index.js';
import type { CliExec } from '../adapters/shared/cli-exec.js';
import { CLI_PROVIDER_ADAPTER } from '../contracts/providers.js';
import { createRuntime, type RuntimeOptions } from '../runtime/index.js';
import type { Supervisor } from '../runtime/supervisor.js';
import { DEFAULT_PORT, VERSION, type DaemonConfig, type Services } from './container.js';
import { bounded } from './lifecycle.js';
import { watchAdapterPlugins } from './plugin-watch.js';

export interface ComposeOptions extends KernelOptions {
  config?: Partial<DaemonConfig>;
  runtime?: RuntimeOptions;
  /** Tests: run adapters in-process / inject a fake registry. */
  supervisor?: Supervisor;
  registry?: AdapterRegistry;
  browserHeadless?: boolean;
  /** Watch the plugin directory and load new adapters without a restart (default true with the real registry). */
  watchPlugins?: boolean;
  /** Tests: how provider status/login/catalog commands are run (default: the real CLIs). */
  cliExec?: CliExec;
  /** Tests: point provider logins at fake CLI binaries. */
  cliCommands?: { claude?: string; codex?: string };
}

export interface CloseOptions {
  /**
   * Upper bound for the whole close. Runs still in flight when it elapses are
   * left to the journal (recovered on the next start). Default: wait for everything.
   */
  graceMs?: number;
}

export type ComposedServices = Services & { config: DaemonConfig; close(opts?: CloseOptions): Promise<void> };

/**
 * Composition root: builds every bounded context and wires them through
 * their contract interfaces. Nothing here starts timers or listens on a port;
 * call `services.runtime.start()` and the API server for that.
 */
export async function createServices(opts: ComposeOptions = {}): Promise<ComposedServices> {
  const kernel = createKernel(opts);

  const stored = (key: string): unknown => kernel.db.select().from(settings).where(eq(settings.key, key)).get()?.value;
  const config: DaemonConfig = {
    host: opts.config?.host ?? process.env.CONDUCTOR_HOST ?? '127.0.0.1',
    port: opts.config?.port ?? Number(process.env.CONDUCTOR_PORT ?? DEFAULT_PORT),
    publicUrl: opts.config?.publicUrl ?? process.env.CONDUCTOR_PUBLIC_URL ?? (stored('daemon.public_url') as string | undefined) ?? null,
  };
  const baseUrl = () => `http://127.0.0.1:${config.port}`;
  const publicUrl = () => (config.publicUrl ?? baseUrl()).replace(/\/+$/, '');

  const governance = createGovernance(kernel);
  const org = createOrgService(kernel, { approvals: governance.approvals });
  const work = createWorkService(kernel, { org });

  const utility = createUtilityModel(kernel, { budgets: governance.budgets });
  const embedder = createEmbedder(kernel);
  const skills = createSkillService(kernel, { org, approvals: governance.approvals, utility });
  const memory = createMemoryService(kernel, { utility, embedder, skills, work, org });
  org.setImportDeps({ skills, memory });

  const connectors = createConnectorGateway(kernel, { approvals: governance.approvals, org });
  org.setImportDeps({ skills, memory, connectors });

  const pluginDir = kernel.paths.ensure(kernel.paths.adapters);
  const ownRegistry = opts.registry ? null : createAdapterRegistry({ pluginDir, log: kernel.log });
  const registry: AdapterRegistry = opts.registry ?? ownRegistry!;
  const rescanAdapters = async (): Promise<AdapterRescanResult> => {
    if (ownRegistry) return ownRegistry.rescan();
    // An injected registry only promises loadPlugins(): diff its listing around the scan.
    const ids = (): string[] => registry.list().filter((a) => !a.builtin).map((a) => a.id);
    const before = ids();
    await registry.loadPlugins();
    const loaded = ids();
    return { loaded, added: loaded.filter((id) => !before.includes(id)), removed: before.filter((id) => !loaded.includes(id)), skipped: [] };
  };
  if (ownRegistry) await ownRegistry.rescan();
  // Third-party adapters install without a restart: dropping a folder into the plugin dir is enough.
  const pluginWatch = ownRegistry && opts.watchPlugins !== false ? watchAdapterPlugins({ pluginDir, rescan: rescanAdapters, log: kernel.log }) : null;

  const runtime = createRuntime(kernel, {
    org, work, governance, skills, memory, connectors, registry, baseUrl,
    supervisor: opts.supervisor,
    options: { powerAssertion: true, ...opts.runtime },
  });
  skills.setEvalRunner(runtime);

  // The browser needs RunControl (to pause a run for human takeover) and the
  // runtime needs the browser (to release leases) — bind late on both sides.
  const runControl: RunControl = {
    pauseRun: (id, reason) => runtime.pauseRun(id, reason),
    resumeRun: (id) => runtime.resumeRun(id),
    isAlive: (id) => runtime.isAlive(id),
  };
  const browser = createBrowserService(kernel, {
    approvals: governance.approvals, runControl, org, shareBaseUrl: publicUrl, headless: opts.browserHeadless ?? true,
  });
  runtime.bindBrowser(browser);

  // Builtin tool servers — every agent reaches them through the gateway.
  connectors.registerBuiltin(createTasksToolProvider(kernel, { work, org, approvals: governance.approvals }));
  connectors.registerBuiltin(memory.toolProvider());
  connectors.registerBuiltin(skills.toolProvider());
  connectors.registerBuiltin(browser.toolProvider());
  connectors.registerBuiltin(createFilesToolProvider(kernel));

  // Provider accounts (Claude Code / Codex logins) and model catalogs for the dropdowns.
  const models = createModelCatalog({ registry, secrets: kernel.secrets, log: kernel.log, ...(opts.cliExec ? { exec: opts.cliExec } : {}) });
  const providerAuth = createProviderAuth(kernel, {
    ...(opts.cliExec ? { exec: opts.cliExec } : {}), ...(opts.cliCommands ? { commands: opts.cliCommands } : {}),
    // Codex's model list depends on the account: refresh it after a login or logout.
    onAccountChange: (provider) => models.invalidate(CLI_PROVIDER_ADAPTER[provider]),
  });

  return {
    kernel, org, work, governance, skills, memory, connectors, browser, runtime, registry, utility, embedder,
    providerAuth, models,
    baseUrl, publicUrl, version: VERSION, config, rescanAdapters,
    async close(closeOpts: CloseOptions = {}) {
      const graceMs = closeOpts.graceMs ?? Number.POSITIVE_INFINITY;
      const deadline = Date.now() + graceMs;
      const left = (): number => (Number.isFinite(graceMs) ? Math.max(0, deadline - Date.now()) : graceMs);
      pluginWatch?.close();
      providerAuth.dispose();
      // Runs get most of the budget to end cleanly (cancel → release their issues); the rest is for teardown.
      await bounded('runtime', () => runtime.stop(), Number.isFinite(graceMs) ? graceMs * 0.75 : graceMs, kernel.log);
      await Promise.all([
        bounded('browser', () => browser.shutdown(), left(), kernel.log),
        bounded('connectors', () => connectors.close(), left(), kernel.log),
      ]);
      kernel.close();
    },
  };
}
