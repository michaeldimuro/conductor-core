import { randomUUID } from 'node:crypto';
import type { Kernel } from '../contracts/kernel.js';
import type { EvalRunner, RuntimeService } from '../contracts/services.js';
import type { RunEvent } from '../contracts/adapter.js';
import type { Run } from '../contracts/rows.js';
import { SYSTEM } from '../contracts/types.js';
import type { JobKind } from '../db/schema/index.js';
import { ConductorError, notFound } from '../shared/errors.js';
import { JobQueue } from './jobs.js';
import { RunJournal } from './journal.js';
import { ChatHistory } from './chat-history.js';
import { RunExecutor } from './executor.js';
import { Scheduler, type JobHandler } from './scheduler.js';
import { ProcessSupervisor } from './supervisor.js';
import { recoverInFlight } from './recovery.js';
import { registerSystemJobs, PowerAssertion } from './system-jobs.js';
import { startOtelExport } from './otel.js';
import { keepPausedTokensAlive, pauseActive, resumeActive } from './pause.js';
import { preflight } from './preflight.js';
import type { RunRequest, RunSummary, RuntimeDeps } from './types.js';

export interface Runtime extends RuntimeService, EvalRunner {
  /** Plug in handlers for job kinds owned by other contexts (e.g. webhook_out). */
  registerJobHandler(kind: JobKind, handler: JobHandler): void;
  enqueue: JobQueue['enqueue'];
  /** Run one scheduling pass now (tests; the daemon ticks on a timer). */
  tick(): Promise<void>;
  /** Resolve when every dispatched job has settled (tests). */
  idle(): Promise<void>;
  bindBrowser(browser: NonNullable<RuntimeDeps['browser']>): void;
}

/**
 * The runtime: scheduler + heartbeat loop + run supervision + crash recovery.
 * "The top row of the daemon decides what runs and when."
 */
export function createRuntime(kernel: Kernel, deps: RuntimeDeps): Runtime {
  const k = kernel;
  const d = deps;
  const startedAt = k.clock.now();
  const journal = new RunJournal(k);
  const history = new ChatHistory(k);
  const queue = new JobQueue(k, `conductord-${process.pid}-${randomUUID().slice(0, 8)}`);
  const supervisor = d.supervisor ?? new ProcessSupervisor({ pluginDir: k.paths.adapters, log: k.log });
  const executor = new RunExecutor(k, d, journal, supervisor);
  const scheduler = new Scheduler(k, d, queue, executor);
  const power = new PowerAssertion(d.options?.powerAssertion ?? false);
  let minuteTimer: NodeJS.Timeout | null = null;
  const unsubs: Array<() => void> = [];

  const systemJobs = registerSystemJobs(k, d, scheduler);

  // Step 8 — Reflect: queued after every real loop run.
  executor.onFinished = (run: Run, mode) => {
    power.set(executor.active.size > 0);
    if (mode !== 'loop' || run.outcome === 'no_work' || run.outcome === 'crashed') return;
    const skillIds = usedSkillIds(run);
    queue.enqueue({ kind: 'reflect', orgId: run.orgId, agentId: run.agentId, payload: { runId: run.id, skillIds }, dedupeKey: `reflect:${run.id}`, maxAttempts: 2 });
  };

  /** Skills the run actually loaded: via conductor-skills, or natively (Claude Code `Skill` tool). */
  function usedSkillIds(run: Run): string[] {
    const snap = run.capabilitySnapshot?.skills ?? [];
    const ids = new Set(d.skills.loadedSkills?.(run.id) ?? []);
    if (snap.length) {
      for (const { event } of journal.events(run.orgId, run.id)) {
        if (event.type !== 'tool_call') continue;
        const input = (event.input ?? {}) as Record<string, unknown>;
        const named = [input.skill, input.name, input.command].filter((v): v is string => typeof v === 'string');
        if (!/skill/i.test(event.name)) continue;
        for (const s of snap) if (named.some((n) => n === s.name || n.endsWith(`:${s.name}`))) ids.add(s.id);
      }
    }
    return [...ids];
  }

  /** One chat run. `recallHint` is the operator's own words, so memory recall is not skewed by replayed history. */
  async function chatTurn(orgId: string, agentId: string, prompt: string, recallHint: string, issueId: string | null): Promise<{ reply: string; runId: string }> {
    const summary = await executeDirect('chat', { orgId, agentId, trigger: 'chat', prompt, recallHint, issueId });
    if (!summary.runId) throw new ConductorError('unavailable', `agent cannot chat right now: ${summary.skipped ?? 'unknown'}`);
    if (summary.outcome !== 'completed' && !summary.finalText) {
      const run = journal.get(orgId, summary.runId);
      throw new ConductorError('unavailable', `chat run ${summary.outcome}: ${run.error ?? 'no reply'}`);
    }
    return { reply: summary.finalText, runId: summary.runId };
  }

  /**
   * Chat turns and skill evals do not go through the job queue, so they take
   * their concurrency slot here: same global / org / provider limits as the
   * loop (plus a small headroom), one chat and one eval per agent, and a
   * bounded wait for a slot.
   */
  async function executeDirect(mode: 'chat' | 'eval', req: RunRequest): Promise<RunSummary> {
    const org = d.org.getOrg(req.orgId);
    const agent = d.org.getAgent(req.orgId, req.agentId);
    const waitMs = mode === 'chat' ? (d.options?.chatWaitMs ?? 15_000) : (d.options?.evalWaitMs ?? 10 * 60_000);
    const slot = await scheduler.admission.acquireDirect(org, agent, mode, waitMs);
    if ('blocked' in slot) {
      k.audit.record({ orgId: org.id, actor: SYSTEM, action: 'run.capacity_refused', entityKind: 'agent', entityId: agent.id, data: { mode, reason: slot.blocked } });
      return {
        runId: null, outcome: 'skipped', finalText: '', provider: null, costUsd: 0, steps: 0, tokens: 0, wallMs: 0,
        skipped: slot.blocked, skip: { code: 'capacity', reason: slot.blocked, temporary: true },
      };
    }
    try {
      return await executor.execute({ ...req, mode });
    } finally {
      slot.release();
    }
  }

  function activeOrThrow(runId: string) {
    const a = executor.active.get(runId);
    if (!a) throw notFound('active run', runId);
    return a;
  }

  const runtime: Runtime = {
    async start() {
      recoverInFlight(k, d, journal, scheduler);
      unsubs.push(k.bus.on('run.started', () => power.set(true)));
      unsubs.push(startOtelExport(k, journal));
      scheduler.start();
      const everyMinute = () => {
        try {
          const g = d.governance as typeof d.governance & { expireApprovals?: () => unknown };
          g.expireApprovals?.();
        } catch (err) {
          k.log.warn({ err }, 'approval expiry failed');
        }
        keepPausedTokensAlive(k, d, executor.active.values());
      };
      minuteTimer = setInterval(everyMinute, 60_000);
      minuteTimer.unref?.();
    },

    async stop() {
      if (minuteTimer) clearInterval(minuteTimer);
      for (const off of unsubs.splice(0)) off();
      systemJobs.dispose();
      // Graceful shutdown: end in-flight runs cleanly so their issues are released, not orphaned.
      await executor.cancelWhere(() => true, 'daemon shutting down');
      await scheduler.stop();
      await executor.evalGateway.close();
      power.set(false);
    },

    async runNow(orgId, agentId, opts = {}) {
      d.org.getAgent(orgId, agentId);
      const trigger = opts.trigger ?? 'manual';
      // Tell the caller now if this wake cannot run, and why — instead of a job id that silently does nothing.
      const pinned = opts.issueId ? d.work.findIssue(orgId, opts.issueId) : null;
      const pre = preflight(k, d, journal, { orgId, agentId, mode: 'loop', projectId: pinned?.projectId ?? null });
      const skipped = pre.ok ? undefined : pre.skip;
      if (skipped && !skipped.temporary) {
        k.bus.emit('run.skipped', { orgId, agentId, jobId: null, trigger, code: skipped.code, reason: skipped.reason, deferredUntil: null });
        return { jobId: '', skipped };
      }
      // A temporary cause keeps the wake queued: it runs when the cause clears.
      const jobId = scheduler.wake(orgId, agentId, {
        trigger, issueId: opts.issueId ?? null, prompt: opts.prompt,
        triggerNote: 'The owner asked you to run now.',
      });
      return skipped ? { jobId, skipped } : { jobId };
    },

    async cancelRun(orgId, runId, reason = 'cancelled by owner') {
      const run = journal.get(orgId, runId);
      const live = await executor.cancel(run.id, reason);
      if (!live && ['queued', 'running', 'paused'].includes(run.status)) {
        // Journaled as in flight but not live in this process: settle it.
        journal.finish(run.id, { status: 'cancelled', outcome: 'cancelled', error: reason });
        d.work.releaseAllForRun(orgId, run.id, 'todo');
      }
      k.audit.record({ orgId, actor: SYSTEM, action: 'run.cancelled', entityKind: 'run', entityId: runId, runId, data: { reason } });
    },

    getRun: (orgId, runId) => journal.get(orgId, runId),
    listRuns: (orgId, filter) => journal.list(orgId, filter),
    transcript: (orgId, runId, opts) => journal.events(orgId, runId, opts?.afterSeq ?? 0) as Array<{ seq: number; ts: number; event: RunEvent }>,
    toolContext: (runId) => executor.toolContext(runId),
    syncSchedules: () => scheduler.syncSchedules(),

    status() {
      const c = scheduler.counts();
      return { running: executor.active.size, queued: queue.counts().pending, perOrg: c.perOrg, perProvider: c.perProvider, uptimeMs: k.clock.now() - startedAt };
    },

    async chat(orgId, agentId, message, opts = {}) {
      if (!opts.history) return chatTurn(orgId, agentId, message, message, opts.issueId ?? null);
      // The UI conversation: keep both sides and replay the recent turns into the next one.
      const agent = d.org.getAgent(orgId, agentId);
      const prior = history.list(orgId, agentId, { limit: 40 });
      const mine = history.append(orgId, agentId, { role: 'user', body: message });
      k.bus.emit('chat.message', { orgId, agentId, messageId: mine.id, role: 'user' });
      try {
        const res = await chatTurn(orgId, agentId, history.prompt(prior, message, agent.name), message, opts.issueId ?? null);
        const reply = history.append(orgId, agentId, { role: 'agent', body: res.reply, runId: res.runId });
        k.bus.emit('chat.message', { orgId, agentId, messageId: reply.id, role: 'agent' });
        return { ...res, messageId: reply.id };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const failed = history.append(orgId, agentId, { role: 'agent', body: '', error: reason });
        k.bus.emit('chat.message', { orgId, agentId, messageId: failed.id, role: 'agent' });
        throw err;
      }
    },

    chatHistory(orgId, agentId, opts = {}) {
      d.org.getAgent(orgId, agentId);
      return history.list(orgId, agentId, opts);
    },

    clearChat(orgId, agentId) {
      d.org.getAgent(orgId, agentId);
      history.clear(orgId, agentId);
    },

    // ── RunControl ─────────────────────────────────────────────────────────
    pauseRun(runId, reason) {
      pauseActive(k, d, journal, activeOrThrow(runId), reason);
    },

    resumeRun(runId) {
      const a = executor.active.get(runId);
      if (a) resumeActive(k, d, journal, a);
    },

    isAlive: (runId) => executor.active.has(runId),

    // ── EvalRunner: sandboxed replay for the skill eval gate ───────────────
    async run(input) {
      const t0 = Date.now();
      const s = await executeDirect('eval', {
        orgId: input.orgId, agentId: input.agentId, trigger: 'system',
        prompt: input.prompt, evalSkills: input.skills, triggerNote: `skill eval: ${input.label}`,
      });
      if (!s.runId) throw new ConductorError('unavailable', `eval could not run: ${s.skipped ?? 'unknown'}`);
      const run = journal.get(input.orgId, s.runId);
      return {
        wallMs: Date.now() - t0,
        finalText: s.finalText,
        ...(s.files ? { files: s.files } : {}),
        result: {
          outcome: s.outcome as 'completed', finalText: s.finalText, steps: run.steps, sessionId: run.sessionId ?? undefined,
          usage: { tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd, subscription: run.subscription, seatSeconds: run.seatSeconds },
          ...(run.error ? { error: { kind: 'other' as const, message: run.error } } : {}),
        },
      };
    },

    registerJobHandler: (kind, handler) => scheduler.registerHandler(kind, handler),
    enqueue: (input) => queue.enqueue(input),
    tick: () => scheduler.tick(),
    idle: async () => {
      await scheduler.idle();
      await systemJobs.idle();
    },
    bindBrowser(browser) {
      d.browser = browser;
    },
  };

  return runtime;
}

export type { RuntimeDeps, RuntimeOptions, RunRequest, RunSummary } from './types.js';
export { InProcessSupervisor, ProcessSupervisor } from './supervisor.js';
export { buildDigest } from './system-jobs.js';
