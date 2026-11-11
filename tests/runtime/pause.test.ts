import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createHarness, type Harness } from './harness.js';
import { RunGuard, pauseRunClock, resumeRunClock } from '../../src/adapters/shared/guard.js';
import { ProcessSupervisor } from '../../src/runtime/supervisor.js';
import { PAUSE_TOKEN_HORIZON_MS, RUN_TOKEN_GRACE_MS } from '../../src/runtime/pause.js';
import type { WorkerJob } from '../../src/contracts/services.js';
import { apiTokens } from '../../src/db/schema/index.js';
import { OWNER } from '../../src/contracts/types.js';
import { createLogger } from '../../src/shared/util.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('pause stops the run clocks', () => {
  it('RunGuard: paused time does not count against the wall limit', async () => {
    const guard = new RunGuard('run_guard_1', 200);
    try {
      await sleep(60);
      expect(pauseRunClock('run_guard_1')).toBe(1);
      const left = guard.remainingMs();
      await sleep(400); // twice the whole limit, spent paused
      expect(guard.reason).toBeNull();
      expect(guard.signal.aborted).toBe(false);
      expect(guard.remainingMs()).toBe(left); // frozen
      expect(guard.elapsedSeconds()).toBeLessThan(0.2);
      resumeRunClock('run_guard_1');
      await sleep(40);
      expect(guard.reason).toBeNull(); // still has what was left
      await sleep(left + 80);
      expect(guard.reason).toBe('timeout');
    } finally {
      guard.dispose();
    }
  });

  it('RunGuard: a guard created while its run is paused starts with a stopped clock', async () => {
    pauseRunClock('run_guard_2');
    const guard = new RunGuard('run_guard_2', 50);
    try {
      await sleep(150);
      expect(guard.reason).toBeNull();
      resumeRunClock('run_guard_2');
      await sleep(150);
      expect(guard.reason).toBe('timeout');
    } finally {
      guard.dispose();
    }
  });

  describe('ProcessSupervisor (real worker process)', () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'conductor-pause-'));
      mkdirSync(join(root, 'adapters'));
      mkdirSync(join(root, 'ws'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const job = (runId: string, seconds: number, maxWallMs: number): WorkerJob => {
      const config = { command: '/bin/sh', args: ['-c', `cat > /dev/null; sleep ${seconds}; echo finished`] };
      return {
        adapterId: 'process',
        chain: [{ adapterId: 'process', model: null, config, secrets: {} }],
        ctx: {
          runId, orgId: 'org_1', agentId: 'agt_1', issueId: null, systemPrompt: 'sys', prompt: 'go', model: null, config, secrets: {},
          skills: [], mcpEndpoints: [], workspacePath: join(root, 'ws'), budgetCapUsd: null, maxSteps: 10, maxWallMs,
          runToken: 'cnd_run_test', apiBaseUrl: 'http://127.0.0.1:1',
        },
      };
    };
    const sup = () => new ProcessSupervisor({ pluginDir: join(root, 'adapters'), log: createLogger('test', 'silent') });

    it('times out a run that is never paused (control)', async () => {
      const result = await sup().start(job('run_ctl', 6, 2500), () => {}).done;
      expect(result.outcome).toBe('timeout');
    }, 30_000);

    it('a run paused over IPC outlives its wall limit by the paused time and completes', { retry: 2, timeout: 30_000 }, async () => {
      const handle = sup().start(job('run_paused', 6, 2500), () => {});
      await sleep(1200); // worker booted, adapter running
      handle.pause!();
      await sleep(4000); // well past the 2.5 s wall limit, all of it paused
      handle.resume!();
      const result = await handle.done;
      expect(result.outcome).toBe('completed');
      expect(result.finalText).toContain('finished');
    });
  });

  describe('runtime', () => {
    let h: Harness;
    beforeEach(async () => {
      h = await createHarness();
    });
    afterEach(() => h.dispose());

    const tokenExpiry = (runId: string) => h.k.db.select().from(apiTokens).where(eq(apiTokens.runId, runId)).get()!.expiresAt!;

    it('suspends the supervisor clocks while paused and restarts them on resume', async () => {
      h.work.createIssue(h.acme.id, { title: 'Needs login', assigneeAgentId: h.ada.id }, OWNER);
      const order: string[] = [];
      h.script = async (ctx) => {
        // The guard of a real adapter would live in the worker; here it lives in-process.
        const guard = new RunGuard(ctx.runId, 120);
        try {
          await sleep(5);
          h.runtime.pauseRun(ctx.runId, 'needs_human');
          order.push(`paused:${guard.paused}`);
          await sleep(300);
          order.push(`alive:${guard.reason === null}`);
          h.runtime.resumeRun(ctx.runId);
          order.push(`resumed:${!guard.paused}`);
        } finally {
          guard.dispose();
        }
      };
      await h.drain();
      expect(order).toEqual(['paused:true', 'alive:true', 'resumed:true']);
      const audit = h.k.audit.query({ orgId: h.acme.id, action: 'run.resumed' });
      expect((audit[0]!.data as { pausedForMs: number }).pausedForMs).toBeGreaterThanOrEqual(290);
    });

    it('extends the run token across the pause through TokenService.extendRunToken', async () => {
      const extend = vi.fn();
      h.governance.tokens.extendRunToken = extend;
      h.work.createIssue(h.acme.id, { title: 'Needs login', assigneeAgentId: h.ada.id }, OWNER);
      let issuedTtl = 0;
      h.script = (ctx) => {
        issuedTtl = tokenExpiry(ctx.runId) - h.k.clock.now();
        h.runtime.pauseRun(ctx.runId, 'needs_human');
        h.runtime.resumeRun(ctx.runId);
      };
      await h.drain();
      const maxWall = h.ada.maxWallMs;
      expect(issuedTtl).toBe(maxWall + RUN_TOKEN_GRACE_MS); // no blanket allowance when it can be extended
      expect(extend).toHaveBeenCalledTimes(2);
      const [onPause, onResume] = extend.mock.calls as Array<[string, number]>;
      expect(onPause![0]).toBe(h.calls[0]!.runId);
      expect(onPause![1]).toBeGreaterThan(PAUSE_TOKEN_HORIZON_MS); // alive for the whole pause
      expect(onResume![1]).toBeLessThanOrEqual(maxWall + RUN_TOKEN_GRACE_MS); // back to what the run has left
      expect(onResume![1]).toBeGreaterThan(maxWall + RUN_TOKEN_GRACE_MS - 5_000);
    });

    it('falls back to a token with a pause allowance when the token service cannot extend', async () => {
      // A token service without the optional method (older or third-party implementation).
      (h.governance.tokens as { extendRunToken?: unknown }).extendRunToken = undefined;
      h.work.createIssue(h.acme.id, { title: 'Work', assigneeAgentId: h.ada.id }, OWNER);
      let ttl = 0;
      h.script = (ctx) => {
        ttl = tokenExpiry(ctx.runId) - h.k.clock.now();
      };
      await h.drain();
      expect(ttl).toBe(h.ada.maxWallMs + RUN_TOKEN_GRACE_MS + PAUSE_TOKEN_HORIZON_MS);
      // …and it is revoked the moment the run ends, allowance or not.
      expect(h.governance.tokens.verify(h.calls[0]!.runToken)).toBeNull();
    });
  });
});
