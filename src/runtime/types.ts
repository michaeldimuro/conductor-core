import type { AdapterRegistry, ResolvedSkillRef } from '../contracts/adapter.js';
import type { OrgService, WorkService } from '../contracts/org-work.js';
import type { BrowserService, ConnectorGateway, Governance, MemoryService, RunSkip, SkillService } from '../contracts/services.js';
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
  /**
   * Chat and skill-eval runs share the global / org / provider limits with the
   * heartbeat loop, plus this many extra slots at each level so an owner can
   * still talk to a fully busy org. Default 1.
   */
  directHeadroom?: number;
  /** Concurrent chat turns across the daemon (default 4) and skill-eval runs (default 2). One of each per agent. */
  chatConcurrency?: number;
  evalConcurrency?: number;
  /** How long a chat turn / an eval run waits for a slot before giving up. Defaults: 15 s / 10 min. */
  chatWaitMs?: number;
  evalWaitMs?: number;
  /** Hourly allowance per agent for chat turns (default max(30, 3 x maxRunsPerHour)) and eval runs (default max(20, 2 x maxRunsPerHour)). */
  chatRunsPerHour?: number;
  evalRunsPerHour?: number;
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
  /** Provider session to resume. Honoured only when the run checks out the issue the session belonged to. */
  resumeSessionId?: string;
  /** Planning wake: decompose this goal into issues instead of working the inbox. */
  goalId?: string | null;
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
  /** Eval runs only: workspace-relative files present when the run ended. */
  files?: string[];
  /** Why no run happened (paused, over budget, kill switch, no work…). */
  skipped?: string;
  /** Structured form of `skipped`. */
  skip?: RunSkip;
}
