import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Kernel, UtilityModel, UtilityModelStatus } from '../contracts/kernel.js';
import type { BudgetService } from '../contracts/services.js';
import type { ProviderBinding } from '../contracts/types.js';
import { organizations } from '../db/schema/index.js';
import { errorMessage } from '../shared/errors.js';
import { getSetting, setSetting } from './indexes.js';
import { offlineComplete } from './offline.js';
import { parseJsonLoose } from './text.js';
import {
  DEFAULT_ANTHROPIC_UTILITY_MODEL, DEFAULT_OPENAI_UTILITY_MODEL, JSON_INSTRUCTION, callAnthropic, callOpenAI, costOf, describeFailure,
  type Request, type Response, type Usage,
} from './utility-api.js';
import {
  CliError, DEFAULT_CLI_COMMAND, DEFAULT_CLI_MAX_OUTPUT_BYTES, DEFAULT_CLI_MODEL, DEFAULT_CLI_TIMEOUT_MS, LOCAL_CLIS, probeCli, runCliCompletion,
  type CliProbe, type LocalCli,
} from './utility-cli.js';

export { DEFAULT_ANTHROPIC_UTILITY_MODEL, DEFAULT_OPENAI_UTILITY_MODEL } from './utility-api.js';

/** Install-level setting: `auto` (default) | `offline` | `claude_local` | `codex_local`. An org's own `utility_model` binding wins over it. */
export const UTILITY_BACKEND_SETTING = 'utility.backend';
/** Install-level setting: `{ dailyCalls?, timeoutMs?, claudeModel?, codexModel? }` for the local-CLI backend. `dailyCalls: 0` turns it off. */
export const UTILITY_LOCAL_SETTING = 'utility.local';
/** Internal counter: `{ day, calls }` of local-CLI utility calls (the subscription is per machine, so the cap is install-wide). */
export const UTILITY_LOCAL_USAGE_SETTING = 'utility.local.usage';
/** Background learning may make this many local-CLI calls per day unless `utility.local.dailyCalls` says otherwise. */
export const DEFAULT_LOCAL_DAILY_CALLS = 200;
/** Calls waiting for the single CLI slot; beyond this the caller gets the offline heuristic instead of queueing. */
const MAX_QUEUED = 16;
const PROBE_TTL_OK_MS = 10 * 60_000;
const PROBE_TTL_FAIL_MS = 2 * 60_000;

const backendSettingSchema = z.enum(['auto', 'offline', 'claude_local', 'codex_local']);
const localSettingSchema = z.object({
  dailyCalls: z.number().int().min(0).max(100_000).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  claudeModel: z.string().trim().min(1).max(120).optional(),
  codexModel: z.string().trim().min(1).max(120).optional(),
});

type ApiAdapter = 'claude_api' | 'openai_api';
const isApi = (adapter: string | undefined): adapter is ApiAdapter => adapter === 'claude_api' || adapter === 'openai_api';
const isLocal = (adapter: string | undefined): adapter is LocalCli => adapter === 'claude_local' || adapter === 'codex_local';

export interface LocalCliOptions {
  /**
   * Whether an installed, logged-in CLI may be used. Defaults to on — except under the test runner,
   * where nothing may ever reach the developer's real CLI login unless a test opts in with fakes.
   */
  enabled?: boolean;
  /** CLI binaries (name on PATH or absolute path). */
  commands?: Partial<Record<LocalCli, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** `false` skips the process sandbox. */
  sandbox?: boolean;
}

export interface UtilityModelDeps {
  budgets?: Pick<BudgetService, 'record'>;
  localCli?: LocalCliOptions;
}

type Plan =
  | { backend: ApiAdapter; binding: ProviderBinding; apiKey: string; model: string; reason: string }
  | { backend: LocalCli; command: string; model: string | null; effort?: string; sandbox: boolean; reason: string }
  | { backend: 'offline'; reason: string; capped?: boolean };

const localDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * The org's cheap utility model (reflection, memory extraction, skill drafting, eval judging,
 * consolidation, the weekly review).
 *
 * Backend selection, per call:
 *   1. explicit — the org's `utility_model` binding, else the `utility.backend` setting;
 *   2. an API key that is stored — the utility binding's, else the default provider's (cheap model);
 *   3. a local agent CLI that is installed and logged in (`claude_local`, `codex_local`): one prompt,
 *      no tools, sandboxed, one call at a time, capped per day so learning cannot eat the subscription;
 *   4. the deterministic offline heuristics.
 * A refusal or failure of the chosen backend answers from the heuristics (`offline: true`), so the
 * learning loop never depends on the network.
 */
export function createUtilityModel(kernel: Kernel, deps: UtilityModelDeps = {}): UtilityModel {
  const cli = deps.localCli ?? {};
  const cliEnabled = cli.enabled ?? !process.env.VITEST;
  const probes = new Map<string, { at: number; probe: CliProbe }>();
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;

  const commandOf = (kind: LocalCli, binding?: ProviderBinding | null): string => {
    const fromBinding = binding?.adapter === kind && typeof binding.config?.command === 'string' ? binding.config.command : undefined;
    return fromBinding || cli.commands?.[kind] || DEFAULT_CLI_COMMAND[kind];
  };

  const inFlight = new Map<string, Promise<CliProbe>>();
  /** Login state of a CLI, cached; concurrent callers share one probe process. */
  const probe = (kind: LocalCli, command: string): Promise<CliProbe> => {
    const key = `${kind}:${command}`;
    const hit = probes.get(key);
    if (hit && Date.now() - hit.at < (hit.probe.ok ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS)) return Promise.resolve(hit.probe);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const started = probeCli(kind, command)
      .catch((e: unknown): CliProbe => ({ ok: false, detail: errorMessage(e) }))
      .then((result) => {
        probes.set(key, { at: Date.now(), probe: result });
        inFlight.delete(key);
        return result;
      });
    inFlight.set(key, started);
    return started;
  };

  const localSettings = (): z.infer<typeof localSettingSchema> => {
    const parsed = localSettingSchema.safeParse(getSetting(kernel.db, UTILITY_LOCAL_SETTING) ?? {});
    return parsed.success ? parsed.data : {};
  };
  const dailyCap = (): number => localSettings().dailyCalls ?? DEFAULT_LOCAL_DAILY_CALLS;
  const callsToday = (): number => {
    const usage = getSetting(kernel.db, UTILITY_LOCAL_USAGE_SETTING) as { day?: unknown; calls?: unknown } | null;
    return usage && usage.day === localDay(kernel.clock.now()) && typeof usage.calls === 'number' ? usage.calls : 0;
  };
  /** Take one call out of today's allowance; false when it is used up. */
  const takeCall = (): boolean => {
    const used = callsToday();
    if (used >= dailyCap()) return false;
    setSetting(kernel.db, UTILITY_LOCAL_USAGE_SETTING, { day: localDay(kernel.clock.now()), calls: used + 1 }, kernel.clock.now());
    return true;
  };

  async function resolve(orgId: string): Promise<Plan> {
    const org = kernel.db.select({ utilityModel: organizations.utilityModel, defaultProvider: organizations.defaultProvider }).from(organizations).where(eq(organizations.id, orgId)).get();
    const utility = org?.utilityModel ?? null;
    const fallbackNotes: string[] = [];
    const setting = backendSettingSchema.safeParse(getSetting(kernel.db, UTILITY_BACKEND_SETTING) ?? 'auto');
    const installChoice = setting.success ? setting.data : 'auto';

    // 1. Explicit: the org's binding, else the install setting.
    if (!utility && installChoice === 'offline') return { backend: 'offline', reason: 'turned off by the utility.backend setting' };
    const explicitLocal: LocalCli | null = isLocal(utility?.adapter) ? utility.adapter : !utility && isLocal(installChoice) ? installChoice : null;
    if (utility && !isApi(utility.adapter) && !isLocal(utility.adapter)) fallbackNotes.push(`utility model adapter "${utility.adapter}" is not supported`);

    // 2. A stored API key: the utility binding's own, else the default provider's (always on a cheap model).
    if (!explicitLocal) {
      const candidates: Array<{ binding: ProviderBinding; own: boolean }> = [];
      if (utility && isApi(utility.adapter)) candidates.push({ binding: utility, own: true });
      const provider = org?.defaultProvider ?? null;
      for (const b of provider ? [provider, ...(provider.fallback ?? [])] : []) if (isApi(b.adapter)) candidates.push({ binding: b, own: false });
      for (const { binding, own } of candidates) {
        if (!isApi(binding.adapter)) continue;
        const apiKey = binding.authRef ? await kernel.secrets.get(binding.authRef) : null;
        if (!apiKey) {
          if (own) fallbackNotes.push('the utility model binding has no stored API key');
          continue;
        }
        const model = (own ? binding.model : undefined) ?? (binding.adapter === 'claude_api' ? DEFAULT_ANTHROPIC_UTILITY_MODEL : DEFAULT_OPENAI_UTILITY_MODEL);
        return { backend: binding.adapter, binding, apiKey, model, reason: own ? 'the organization\'s utility model binding' : 'the default provider\'s stored API key' };
      }
    }

    // 3. A local CLI that is installed and logged in.
    if (!cliEnabled) return { backend: 'offline', reason: [...fallbackNotes, 'no API key is stored and the local CLI backend is disabled'].join('; ') };
    const cap = dailyCap();
    if (cap <= 0) return { backend: 'offline', reason: [...fallbackNotes, 'no API key is stored and utility.local.dailyCalls is 0'].join('; ') };
    const preferred: LocalCli[] = explicitLocal ? [explicitLocal] : isLocal(org?.defaultProvider?.adapter) ? [org.defaultProvider.adapter] : [];
    const order = [...new Set<LocalCli>([...preferred, ...LOCAL_CLIS])];
    const tuning = localSettings();
    for (const kind of order) {
      const binding = utility?.adapter === kind ? utility : org?.defaultProvider?.adapter === kind ? org.defaultProvider : null;
      const command = commandOf(kind, binding);
      const state = await probe(kind, command);
      if (!state.ok) {
        fallbackNotes.push(state.detail);
        continue;
      }
      if (callsToday() >= cap) {
        return { backend: 'offline', capped: true, reason: `the local CLI's daily call cap (${cap}) is used up; offline heuristics until tomorrow` };
      }
      const explicitModel = utility?.adapter === kind ? utility.model : undefined;
      const model = explicitModel ?? (kind === 'claude_local' ? tuning.claudeModel : tuning.codexModel) ?? DEFAULT_CLI_MODEL[kind];
      const effort = utility?.adapter === kind && typeof utility.config?.effort === 'string' ? utility.config.effort : undefined;
      const optedOut = utility?.adapter === kind && utility.config?.sandbox === false;
      return {
        backend: kind, command, model, ...(effort ? { effort } : {}), sandbox: cli.sandbox !== false && !optedOut,
        reason: [explicitLocal === kind ? 'explicitly selected' : 'no API key is stored', state.detail].join('; '),
      };
    }
    return { backend: 'offline', reason: [...fallbackNotes, 'no API key is stored and no local CLI is logged in'].join('; ') };
  }

  /** One CLI call at a time, install-wide. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    if (queued >= MAX_QUEUED) return Promise.reject(new CliError('failed', 'too many utility calls are already waiting for the local CLI'));
    queued++;
    const run = tail.then(fn, fn).finally(() => {
      queued--;
    });
    tail = run.catch(() => undefined);
    return run;
  }

  function record(req: Request, entry: { provider: string; model: string | null; tokensIn: number; tokensOut: number; costUsd: number; subscription?: boolean; seatSeconds?: number }): void {
    try {
      deps.budgets?.record({ orgId: req.orgId, category: 'reflection', ...entry });
    } catch (e) {
      kernel.log.warn({ err: errorMessage(e) }, 'failed to record utility model spend');
    }
  }

  async function viaApi(plan: Extract<Plan, { backend: ApiAdapter }>, req: Request): Promise<Response> {
    const { binding, model } = plan;
    let usage: Usage | null;
    try {
      usage = plan.backend === 'claude_api' ? await callAnthropic(binding, plan.apiKey, model, req) : await callOpenAI(binding, plan.apiKey, model, req);
    } catch (e) {
      kernel.log.warn({ orgId: req.orgId, purpose: req.purpose, model, ...describeFailure(e), err: errorMessage(e) }, 'utility model call failed; using offline heuristic');
      return offlineComplete(req);
    }
    if (usage === null) {
      kernel.log.warn({ orgId: req.orgId, purpose: req.purpose, model }, 'utility model declined; using offline heuristic');
      return offlineComplete(req);
    }
    const costUsd = costOf(binding, model, usage.tokensIn, usage.tokensOut);
    record(req, { provider: plan.backend, model, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd });
    return { text: usage.text, json: req.json ? parseJsonLoose(usage.text) : null, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd, offline: false };
  }

  async function viaCli(plan: Extract<Plan, { backend: LocalCli }>, req: Request): Promise<Response> {
    const system = [req.system, req.json ? JSON_INSTRUCTION : undefined].filter((s): s is string => Boolean(s)).join('\n\n');
    try {
      const done = await serial(async () => {
        // Counted when the call actually starts, so a queue never overshoots the cap.
        if (!takeCall()) throw new CliError('failed', 'daily call cap reached');
        return runCliCompletion(plan.backend, {
          command: plan.command, model: plan.model, system, prompt: req.prompt, effort: plan.effort, sandbox: plan.sandbox,
          timeoutMs: localSettings().timeoutMs ?? cli.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
          maxOutputBytes: cli.maxOutputBytes ?? DEFAULT_CLI_MAX_OUTPUT_BYTES,
          conductorHome: kernel.paths.home,
        });
      });
      // Seat time on the owner's login: no metered cost, but it shows in the ledger.
      record(req, { provider: plan.backend, model: done.model, tokensIn: done.tokensIn, tokensOut: done.tokensOut, costUsd: 0, subscription: true, seatSeconds: done.seatSeconds });
      return { text: done.text, json: req.json ? parseJsonLoose(done.text) : null, tokensIn: done.tokensIn, tokensOut: done.tokensOut, costUsd: 0, offline: false };
    } catch (e) {
      const kind = e instanceof CliError ? e.kind : 'other';
      // A CLI that vanished or lost its login is re-probed on the next call instead of being retried blindly.
      if (kind === 'auth' || kind === 'not_found') probes.delete(`${plan.backend}:${plan.command}`);
      kernel.log.warn({ orgId: req.orgId, purpose: req.purpose, backend: plan.backend, kind, err: errorMessage(e) }, 'local CLI utility call failed; using offline heuristic');
      return offlineComplete(req);
    }
  }

  return {
    async complete(req: Request): Promise<Response> {
      const plan = await resolve(req.orgId);
      if (plan.backend === 'offline') return offlineComplete(req);
      return 'apiKey' in plan ? viaApi(plan, req) : viaCli(plan, req);
    },

    async status(orgId: string): Promise<UtilityModelStatus> {
      const plan = await resolve(orgId);
      const localCalls = { today: callsToday(), dailyCap: dailyCap() };
      if (plan.backend === 'offline') return { backend: 'offline', model: null, subscription: false, reason: plan.reason, ...(plan.capped ? { localCalls } : {}) };
      if ('apiKey' in plan) return { backend: plan.backend, model: plan.model, subscription: false, reason: plan.reason };
      return { backend: plan.backend, model: plan.model, subscription: true, reason: plan.reason, localCalls };
    },
  };
}
