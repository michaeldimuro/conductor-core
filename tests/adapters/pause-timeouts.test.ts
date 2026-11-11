import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterRegistry, AgentAdapter, RunContext, RunEvent, RunResult } from '../../src/contracts/adapter.js';
import type { WorkerJob } from '../../src/contracts/services.js';
import { runChain } from '../../src/adapters/chain.js';
import { ActiveRuns, pauseRunClock, resumeRunClock, RunPauseClock, withRun } from '../../src/adapters/shared/guard.js';
import { CLI_MCP_STARTUP_TIMEOUT_MS, GUARD_BOUND_TIMEOUT_MS, HUMAN_WAIT_ALLOWANCE_MS, McpToolset, cliToolTimeoutMs } from '../../src/adapters/shared/mcp-tools.js';
import { runMcpToolLoop, type ModelTurn, type ToolLoopDriver } from '../../src/adapters/shared/tool-loop.js';
import { buildCodexMcpOverrides } from '../../src/adapters/builtin/codex-local.js';
import { claudeMcpEnv } from '../../src/adapters/builtin/claude-local.js';

const usage = { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 };
const HOUR = 3_600_000;

let seq = 0;
function ctxOf(over: Partial<RunContext> = {}): RunContext {
  return {
    runId: `run_pause_${++seq}`, orgId: 'org_t', agentId: 'agt_t', issueId: null, systemPrompt: '', prompt: 'go', model: null, config: {}, secrets: {},
    skills: [], mcpEndpoints: [{ name: 'conductor', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer run-token-abcdefghijklmnop' } }],
    workspacePath: '/tmp', budgetCapUsd: null, maxSteps: 10, maxWallMs: 60_000, runToken: 'run-token-abcdefghijklmnop', apiBaseUrl: 'http://127.0.0.1:1',
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RunPauseClock', () => {
  it('adds up the time a run spent paused, across pauses, and starts paused when the run already is', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const clock = new RunPauseClock('run_clock_1');
    vi.advanceTimersByTime(1000);
    expect(clock.pausedMs()).toBe(0);
    pauseRunClock('run_clock_1');
    vi.advanceTimersByTime(5000);
    expect(clock.pausedMs()).toBe(5000); // an ongoing pause counts
    resumeRunClock('run_clock_1');
    vi.advanceTimersByTime(2000);
    pauseRunClock('run_clock_1');
    vi.advanceTimersByTime(3000);
    const late = new RunPauseClock('run_clock_1');
    expect(late.paused).toBe(true);
    resumeRunClock('run_clock_1');
    expect(clock.pausedMs()).toBe(8000);
    expect(late.pausedMs()).toBe(0);
    clock.dispose();
    late.dispose();
    pauseRunClock('run_clock_1'); // disposed clocks are no longer reached
    vi.advanceTimersByTime(1000);
    resumeRunClock('run_clock_1');
    expect(clock.pausedMs()).toBe(8000);
  });
});

describe('fallback chain: wall time left ignores paused time', () => {
  /** primary: sits `pausedMs` paused + `activeMs` working, then fails with a rate limit; fallback: records the wall time it is given. */
  function chainWith(pausedMs: number, activeMs: number): { registry: AdapterRegistry; job: WorkerJob; given: number[] } {
    const given: number[] = [];
    const adapter = (id: string, run: (ctx: RunContext) => Promise<RunResult>): AgentAdapter => ({
      id, capabilities: () => ({ tools: true, mcp: true, resume: false, vision: false, browser: 'via_mcp' }),
      testConnection: async () => ({ ok: true }), run: (ctx) => run(ctx), cancel: async () => {},
    });
    const adapters: Record<string, AgentAdapter> = {
      primary: adapter('primary', async (ctx) => {
        vi.advanceTimersByTime(activeMs);
        if (pausedMs > 0) {
          pauseRunClock(ctx.runId);
          vi.advanceTimersByTime(pausedMs); // a human holds the browser
          resumeRunClock(ctx.runId);
        }
        return { outcome: 'failed', finalText: '', usage, steps: 1, error: { kind: 'rate_limit', message: '429' } };
      }),
      fallback: adapter('fallback', async (ctx) => {
        given.push(ctx.maxWallMs);
        return { outcome: 'completed', finalText: 'ok', usage, steps: 1 };
      }),
    };
    const registry: AdapterRegistry = { get: (id) => adapters[id], list: () => [], loadPlugins: async () => {} };
    const chain: WorkerJob['chain'] = [
      { adapterId: 'primary', model: null, config: {}, secrets: {} },
      { adapterId: 'fallback', model: null, config: {}, secrets: {} },
    ];
    return { registry, job: { adapterId: 'primary', ctx: ctxOf({ maxWallMs: 60_000 }), chain }, given };
  }

  it('gives the fallback the full remaining wall time after a takeover longer than the whole limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { registry, job, given } = chainWith(2 * HOUR, 10_000);
    const result = await runChain(registry, job, () => {});
    expect(result).toMatchObject({ outcome: 'completed', adapterId: 'fallback' });
    expect(given).toEqual([50_000]); // 60 s limit − 10 s actually worked; the two paused hours are not the run's
  });

  it('still times out when the wall time was really used up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { registry, job, given } = chainWith(0, 61_000);
    const result = await runChain(registry, job, () => {});
    expect(result.outcome).toBe('timeout');
    expect(given).toEqual([]);
  });
});

describe('tool loop: a tool call held up by a paused run does not time out', () => {
  it('passes no deadline of its own to the MCP client and survives a pause longer than the wall time', async () => {
    const timeouts: Array<number | undefined> = [];
    const ctx = ctxOf({ maxWallMs: 150 });
    const toolset = {
      tools: [],
      get: () => ({ name: 'request_human', originalName: 'conductor-browser__request_human', endpoint: 'conductor', description: '', inputSchema: {} }),
      call: async (_name: string, _args: unknown, opts: { signal?: AbortSignal; timeoutMs?: number }) => {
        timeouts.push(opts.timeoutMs);
        pauseRunClock(ctx.runId); // the gateway pauses the run while the human works…
        await new Promise((r) => setTimeout(r, 400)); // …for longer than the run's whole wall time
        resumeRunClock(ctx.runId);
        if (opts.signal?.aborted) throw new Error('aborted');
        return { name: 'conductor-browser__request_human', text: 'human finished', images: [], isError: false };
      },
      close: async () => {},
    };
    vi.spyOn(McpToolset, 'connect').mockResolvedValue(toolset as unknown as McpToolset);

    const turns: ModelTurn[] = [
      { text: '', toolCalls: [{ id: 'c1', name: 'request_human', input: { reason: 'captcha' } }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'all done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const seen: string[] = [];
    const driver: ToolLoopDriver = {
      model: 'test-model',
      start: () => {},
      turn: async (results) => {
        seen.push(...results.map((r) => r.text));
        return turns.shift()!;
      },
    };
    const events: RunEvent[] = [];
    const result = await withRun(new ActiveRuns(), ctx, (e) => events.push(e), { metered: false }, (env) => runMcpToolLoop(env, driver));

    expect(result).toMatchObject({ outcome: 'completed', finalText: 'all done' });
    expect(seen).toEqual(['human finished']);
    expect(timeouts).toEqual([GUARD_BOUND_TIMEOUT_MS]);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: false, output: 'human finished' });
  });

  it('the wall clock still ends a tool call that runs past it while NOT paused', async () => {
    const ctx = ctxOf({ maxWallMs: 100 });
    const toolset = {
      tools: [], get: () => undefined, close: async () => {},
      call: (_n: string, _a: unknown, opts: { signal?: AbortSignal }) =>
        new Promise((_res, rej) => opts.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    };
    vi.spyOn(McpToolset, 'connect').mockResolvedValue(toolset as unknown as McpToolset);
    const driver: ToolLoopDriver = {
      model: 'test-model', start: () => {},
      turn: async () => ({ text: '', toolCalls: [{ id: 'c1', name: 'slow', input: {} }], usage: { inputTokens: 1, outputTokens: 1 } }),
    };
    const result = await withRun(new ActiveRuns(), ctx, () => {}, { metered: false }, (env) => runMcpToolLoop(env, driver));
    expect(result.outcome).toBe('timeout');
  });
});

describe('local CLIs: MCP timeouts cover a human takeover', () => {
  it('sizes the tool timeout to the run wall time plus the takeover allowance', () => {
    expect(cliToolTimeoutMs(30 * 60_000)).toBe(30 * 60_000 + HUMAN_WAIT_ALLOWANCE_MS);
    expect(cliToolTimeoutMs(0)).toBe(60_000 + HUMAN_WAIT_ALLOWANCE_MS);
    expect(cliToolTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(GUARD_BOUND_TIMEOUT_MS);
  });

  it('codex_local sets startup_timeout_sec and tool_timeout_sec on every gateway server', () => {
    const ctx = ctxOf({ maxWallMs: 30 * 60_000 });
    const { args } = buildCodexMcpOverrides(ctx, 'approve');
    const overrides = Object.fromEntries(args.filter((a) => a !== '-c').map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
    expect(overrides['mcp_servers.conductor.startup_timeout_sec']).toBe(String(CLI_MCP_STARTUP_TIMEOUT_MS / 1000));
    expect(overrides['mcp_servers.conductor.tool_timeout_sec']).toBe(String((30 * 60_000 + HUMAN_WAIT_ALLOWANCE_MS) / 1000));
    expect(Number(overrides['mcp_servers.conductor.tool_timeout_sec'])).toBeGreaterThan(24 * 3600);
    // The existing keys are untouched.
    expect(overrides['mcp_servers.conductor.url']).toBe('"http://127.0.0.1:1/mcp"');
    expect(overrides['mcp_servers.conductor.default_tools_approval_mode']).toBe('"approve"');
    expect(args.join(' ')).not.toContain('run-token-abcdefghijklmnop');
  });

  it('claude_local passes MCP_TIMEOUT / MCP_TOOL_TIMEOUT (milliseconds) in the CLI environment', () => {
    expect(claudeMcpEnv({ maxWallMs: 30 * 60_000 })).toEqual({
      MCP_TIMEOUT: String(CLI_MCP_STARTUP_TIMEOUT_MS),
      MCP_TOOL_TIMEOUT: String(30 * 60_000 + HUMAN_WAIT_ALLOWANCE_MS),
    });
  });
});
