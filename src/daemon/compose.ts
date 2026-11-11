import { eq } from 'drizzle-orm';
import { createKernel, type KernelOptions } from '../kernel/index.js';
import { settings } from '../db/schema/index.js';
import type { RunControl } from '../contracts/services.js';
import type { AdapterRegistry } from '../contracts/adapter.js';
import { createGovernance } from '../governance/index.js';
import { createOrgService } from '../org/index.js';
import { createWorkService, createTasksToolProvider } from '../work/index.js';
import { createSkillService } from '../skills/index.js';
import { createMemoryService, createUtilityModel, createEmbedder } from '../memory/index.js';
import { createConnectorGateway, createFilesToolProvider } from '../connectors/index.js';
import { createBrowserService } from '../browser/index.js';
import { createAdapterRegistry } from '../adapters/index.js';
import { createRuntime, type RuntimeOptions } from '../runtime/index.js';
import type { Supervisor } from '../runtime/supervisor.js';
import { DEFAULT_PORT, VERSION, type DaemonConfig, type Services } from './container.js';

export interface ComposeOptions extends KernelOptions {
  config?: Partial<DaemonConfig>;
  runtime?: RuntimeOptions;
  /** Tests: run adapters in-process / inject a fake registry. */
  supervisor?: Supervisor;
  registry?: AdapterRegistry;
  browserHeadless?: boolean;
}

/**
 * Composition root: builds every bounded context and wires them through
 * their contract interfaces. Nothing here starts timers or listens on a port;
 * call `services.runtime.start()` and the API server for that.
 */
export async function createServices(opts: ComposeOptions = {}): Promise<Services & { config: DaemonConfig; close(): Promise<void> }> {
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

  const registry = opts.registry ?? createAdapterRegistry({ pluginDir: kernel.paths.ensure(kernel.paths.adapters), log: kernel.log });
  if (!opts.registry) await registry.loadPlugins();

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

  return {
    kernel, org, work, governance, skills, memory, connectors, browser, runtime, registry, utility, embedder,
    baseUrl, publicUrl, version: VERSION, config,
    async close() {
      await runtime.stop().catch((err) => kernel.log.warn({ err }, 'runtime stop failed'));
      await browser.shutdown().catch((err) => kernel.log.warn({ err }, 'browser shutdown failed'));
      await connectors.close().catch((err) => kernel.log.warn({ err }, 'connector close failed'));
      kernel.close();
    },
  };
}
