import type { AdapterRegistry, ResolvedSkillRef } from '../contracts/adapter.js';
import type { OrgService, WorkService } from '../contracts/org-work.js';
import type { BrowserService, ConnectorGateway, Governance, MemoryService, SkillService } from '../contracts/services.js';
import type { RunTrigger } from '../db/schema/index.js';
import type { Supervisor } from './supervisor.js';

export interface RuntimeDeps {
  org: OrgService;
  work: WorkService;
  governance: Governance;
  skills: SkillService & { loadedSkills?(runId: string): string[] };
  memory: MemoryService;
  connectors: Pick<ConnectorGateway, 'snapshot' | 'endRun'>;
  /** Late-bound (the browser service itself depends on RunControl). */
  browser?: Pick<BrowserService, 'endRun' | 'recoverLeases'>;
  registry: AdapterRegistry;
  /** Base URL the daemon's API is reachable at from local child processes, e.g. http://127.0.0.1:7420 */
  baseUrl: () => string;
  /** Override the run supervisor (tests use the in-process one). */
  supervisor?: Supervisor;
  options?: RuntimeOptions;
}

export interface RuntimeOptions {
  tickMs?: number;
  maxGlobalRuns?: number;
  /** Concurrent runs per adapter id (rate limits / local CLI seats). */
  providerLimits?: Record<string, number>;
  /** Hold a caffeinate power assertion while runs are active (macOS). */
  powerAssertion?: boolean;
  /** Schedule nightly dream/backup, weekly review, digest, skill retirement. */
  systemJobs?: boolean;
  /** Consecutive failed runs on an issue before it is blocked and escalated. */
  failureEscalationThreshold?: number;
}

export const DEFAULT_PROVIDER_LIMITS: Record<string, number> = {
  claude_local: 2,
  codex_local: 2,
  claude_api: 4,
  openai_api: 4,
  process: 4,
  http: 8,
};

export interface RunRequest {
  orgId: string;
  agentId: string;
  trigger: RunTrigger;
  /** Pin the run to this issue (assignment / manual / resume). */
  issueId?: string | null;
  /**
   * loop  — the heartbeat loop (inbox → checkout → execute → report → reflect)
   * chat  — one conversational turn, no checkout
   * eval  — sandboxed skill-eval replay: no connectors, temp workspace, no reflection
   */
  mode?: 'loop' | 'chat' | 'eval';
  prompt?: string;
  triggerNote?: string;
  resumeSessionId?: string;
  /** eval mode: the exact skill set to expose. */
  evalSkills?: ResolvedSkillRef[];
}

export interface RunSummary {
  runId: string | null;
  outcome: string;
  finalText: string;
  /** Adapter that actually ran. */
  provider: string | null;
  costUsd: number;
  steps: number;
  tokens: number;
  wallMs: number;
  /** Why no run happened (paused, over budget, kill switch, no work…). */
  skipped?: string;
}
