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
import { RunExecutor } from './executor.js';
import { Scheduler, type JobHandler } from './scheduler.js';
import { ProcessSupervisor } from './supervisor.js';
import { recoverInFlight } from './recovery.js';
import { registerSystemJobs, PowerAssertion } from './system-jobs.js';
import { startOtelExport } from './otel.js';
import type { RuntimeDeps } from './types.js';

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
  const queue = new JobQueue(k, `conductord-${process.pid}-${randomUUID().slice(0, 8)}`);
  const supervisor = d.supervisor ?? new ProcessSupervisor({ pluginDir: k.paths.adapters, log: k.log });
  const executor = new RunExecutor(k, d, journal, supervisor);
  const scheduler = new Scheduler(k, d, queue, executor);
  const power = new PowerAssertion(d.options?.powerAssertion ?? false);
  let minuteTimer: NodeJS.Timeout | null = null;
  const unsubs: Array<() => void> = [];

  registerSystemJobs(k, d, scheduler);

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
      };
      minuteTimer = setInterval(everyMinute, 60_000);
      minuteTimer.unref?.();
    },

    async stop() {
      if (minuteTimer) clearInterval(minuteTimer);
      for (const off of unsubs.splice(0)) off();
      // Graceful shutdown: end in-flight runs cleanly so their issues are released, not orphaned.
      await executor.cancelWhere(() => true, 'daemon shutting down');
      await scheduler.stop();
      power.set(false);
    },

    async runNow(orgId, agentId, opts = {}) {
      d.org.getAgent(orgId, agentId);
      const jobId = scheduler.wake(orgId, agentId, {
        trigger: opts.trigger ?? 'manual', issueId: opts.issueId ?? null, prompt: opts.prompt,
        triggerNote: 'The owner asked you to run now.',
      });
      return { jobId };
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
      const summary = await executor.execute({ orgId, agentId, trigger: 'chat', mode: 'chat', prompt: message, issueId: opts.issueId ?? null });
      if (!summary.runId) throw new ConductorError('unavailable', `agent cannot chat right now: ${summary.skipped ?? 'unknown'}`);
      if (summary.outcome !== 'completed' && !summary.finalText) {
        const run = journal.get(orgId, summary.runId);
        throw new ConductorError('unavailable', `chat run ${summary.outcome}: ${run.error ?? 'no reply'}`);
      }
      return { reply: summary.finalText, runId: summary.runId };
    },

    // ── RunControl ─────────────────────────────────────────────────────────
    pauseRun(runId, reason) {
      const a = activeOrThrow(runId);
      if (a.paused) return;
      a.paused = true;
      journal.update(runId, { status: 'paused' });
      if (a.issueId && a.checkedOut) {
        d.work.updateIssue(a.org.id, a.issueId, { status: 'blocked', blockedReason: reason }, SYSTEM);
      }
      k.audit.record({ orgId: a.org.id, actor: SYSTEM, action: 'run.paused', entityKind: 'run', entityId: runId, runId, issueId: a.issueId ?? undefined, data: { reason } });
      k.bus.emit('run.paused', { orgId: a.org.id, runId, reason });
    },

    resumeRun(runId) {
      const a = executor.active.get(runId);
      if (!a || !a.paused) return;
      a.paused = false;
      journal.update(runId, { status: 'running' });
      if (a.issueId && a.checkedOut) {
        const issue = d.work.findIssue(a.org.id, a.issueId);
        if (issue?.status === 'blocked') d.work.updateIssue(a.org.id, a.issueId, { status: 'in_progress', blockedReason: null }, SYSTEM);
      }
      k.audit.record({ orgId: a.org.id, actor: SYSTEM, action: 'run.resumed', entityKind: 'run', entityId: runId, runId, issueId: a.issueId ?? undefined });
      k.bus.emit('run.resumed', { orgId: a.org.id, runId });
    },

    isAlive: (runId) => executor.active.has(runId),

    // ── EvalRunner: sandboxed replay for the skill eval gate ───────────────
    async run(input) {
      const t0 = Date.now();
      const s = await executor.execute({
        orgId: input.orgId, agentId: input.agentId, trigger: 'system', mode: 'eval',
        prompt: input.prompt, evalSkills: input.skills, triggerNote: `skill eval: ${input.label}`,
      });
      if (!s.runId) throw new ConductorError('unavailable', `eval could not run: ${s.skipped ?? 'unknown'}`);
      const run = journal.get(input.orgId, s.runId);
      return {
        wallMs: Date.now() - t0,
        finalText: s.finalText,
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
    idle: () => scheduler.idle(),
    bindBrowser(browser) {
      d.browser = browser;
    },
  };

  return runtime;
}

export type { RuntimeDeps, RuntimeOptions, RunRequest, RunSummary } from './types.js';
export { InProcessSupervisor, ProcessSupervisor } from './supervisor.js';
export { buildDigest } from './system-jobs.js';
