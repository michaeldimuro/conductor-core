import type { KernelHandle } from '../kernel/index.js';
import type { AdapterRegistry, AdapterRescanResult } from '../contracts/adapter.js';
import type { OrgService, WorkService } from '../contracts/org-work.js';
import type { BrowserService, ConnectorGateway, Governance, MemoryService, SkillService } from '../contracts/services.js';
import type { Embedder, UtilityModel } from '../contracts/kernel.js';
import type { ModelCatalogService, ProviderAuthService } from '../contracts/providers.js';
import type { Runtime } from '../runtime/index.js';

/**
 * The composed daemon: every bounded context behind its contract interface.
 * Interfaces (API, CLI-in-process, gateways, webhooks) depend on this, never
 * on concrete context modules.
 */
export interface Services {
  kernel: KernelHandle;
  org: OrgService;
  work: WorkService;
  governance: Governance;
  skills: SkillService;
  memory: MemoryService;
  connectors: ConnectorGateway;
  browser: BrowserService;
  runtime: Runtime;
  registry: AdapterRegistry;
  /**
   * Re-scan the adapter plugin directory now and report what changed
   * (`conductor adapter rescan` / after `conductor adapter install`).
   */
  rescanAdapters?(): Promise<AdapterRescanResult>;
  utility: UtilityModel;
  embedder: Embedder;
  /** Claude Code / Codex CLI logins and stored long-lived credentials. */
  providerAuth?: ProviderAuthService;
  /** Models each adapter can run (model dropdowns). */
  models?: ModelCatalogService;
  /** Base URL of the local API, e.g. http://127.0.0.1:7420 */
  baseUrl(): string;
  /** Public base URL for links sent to humans (tunnel hostname when configured). */
  publicUrl(): string;
  version: string;
}

export interface DaemonConfig {
  host: string;
  port: number;
  /** Tunnel-reachable origin for share links (Tailscale / Cloudflare Tunnel). */
  publicUrl: string | null;
}

export const DEFAULT_PORT = 7420;
export const VERSION = '0.1.0';
