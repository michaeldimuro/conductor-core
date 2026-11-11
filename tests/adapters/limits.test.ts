import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterRegistry, AgentAdapter, RunContext } from '../../src/contracts/adapter.js';
import { createAdapterRegistry } from '../../src/adapters/index.js';
import { collect, createSandbox, makeCtx, pidAlive, RUN_TOKEN, wait, type Sandbox } from './helpers/context.js';
import { startTestGateway, type TestGateway } from './helpers/mcp-server.js';
import { ANTHROPIC_TEST_KEY, OPENAI_TEST_KEY, startMockProviders, type MockProviders } from './helpers/mock-providers.js';

let gateway: TestGateway;
let providers: MockProviders;
let registry: AdapterRegistry;
let sandbox: Sandbox;

const adapter = (id: string): AgentAdapter => registry.get(id) as AgentAdapter;
const claudeApi = (over: Partial<RunContext> = {}): RunContext =>
  makeCtx(gateway, sandbox, { config: { baseURL: providers.anthropicBaseURL, maxRetries: 0 }, secrets: { apiKey: ANTHROPIC_TEST_KEY }, ...over });
const openaiApi = (over: Partial<RunContext> = {}): RunContext =>
  makeCtx(gateway, sandbox, { model: 'gpt-5.2', config: { baseURL: providers.openaiBaseURL, maxRetries: 0 }, secrets: { apiKey: OPENAI_TEST_KEY }, ...over });
const claudeTmpDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('conductor-claude-'));

beforeAll(async () => {
  gateway = await startTestGateway(RUN_TOKEN);
  providers = await startMockProviders();
});
afterAll(async () => {
  await gateway.close();
  await providers.close();
});
beforeEach(() => {
  sandbox = createSandbox();
  registry = createAdapterRegistry({ pluginDir: join(sandbox.root, 'adapters') });
  providers.reset();
  gateway.calls.length = 0;
});
afterEach(() => sandbox.dispose());

describe('runaway-loop controls: max steps', () => {
  it.each([
    ['claude_api', () => ((providers.anthropic.mode = 'loop'), claudeApi({ maxSteps: 3 }))],
    ['openai_api', () => ((providers.openai.mode = 'loop'), openaiApi({ maxSteps: 3 }))],
  ])('%s stops after maxSteps model requests', async (id, build) => {
    const c = collect();
    const result = await adapter(id).run(build(), c.onEvent);
    expect(result.outcome).toBe('max_steps');
    expect(result.steps).toBe(3);
    expect(result.error).toBeUndefined();
    expect(gateway.calls).toHaveLength(3);
    expect(c.ofType('usage')).toHaveLength(3);
    expect(c.ofType('status').some((s) => s.status.includes('step limit'))).toBe(true);
  });

  it('claude_local passes --max-turns and maps error_max_turns', async () => {
    const ctx = makeCtx(gateway, sandbox, {
      maxSteps: 4,
      config: { command: sandbox.bin('fake-claude.mjs'), env: { FAKE_MODE: 'max_turns', FAKE_RECORD: sandbox.recordFile } },
    });
    const result = await adapter('claude_local').run(ctx, collect().onEvent);
    expect(result.outcome).toBe('max_steps');
    expect(result.steps).toBe(4);
    const rec = sandbox.readRecord<{ argv: string[] }>();
    expect(rec.argv[rec.argv.indexOf('--max-turns') + 1]).toBe('4');
  });

  it('codex_local and process kill the child once it exceeds maxSteps tool calls', async () => {
    const codex = await adapter('codex_local').run(
      makeCtx(gateway, sandbox, { maxSteps: 3, config: { command: sandbox.bin('fake-codex.mjs'), env: { FAKE_MODE: 'many_tools' } } }),
      collect().onEvent,
    );
    expect(codex.outcome).toBe('max_steps');
    expect(codex.steps).toBeGreaterThanOrEqual(3);
    const proc = await adapter('process').run(
      makeCtx(gateway, sandbox, { maxSteps: 3, config: { command: sandbox.bin('fake-agent.mjs'), output: 'jsonl', env: { FAKE_MODE: 'many_tools' } } }),
      collect().onEvent,
    );
    expect(proc.outcome).toBe('max_steps');
  });
});

describe('runaway-loop controls: wall time', () => {
  it.each([
    ['claude_api', () => ((providers.anthropic.mode = 'slow'), claudeApi({ maxWallMs: 300 }))],
    ['openai_api', () => ((providers.openai.mode = 'slow'), openaiApi({ maxWallMs: 300 }))],
  ])('%s times out an unanswered request', async (id, build) => {
    const started = Date.now();
    const result = await adapter(id).run(build(), collect().onEvent);
    expect(result.outcome).toBe('timeout');
    expect(result.error).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('claude_local kills the whole process group on timeout and removes the temp MCP config', async () => {
    const before = claudeTmpDirs();
    const pidFile = join(sandbox.root, 'pids.json');
    const ctx = makeCtx(gateway, sandbox, {
      maxWallMs: 1200,
      config: { command: sandbox.bin('fake-claude.mjs'), env: { FAKE_MODE: 'hang', FAKE_PIDFILE: pidFile, FAKE_RECORD: sandbox.recordFile } },
    });
    const result = await adapter('claude_local').run(ctx, collect().onEvent);
    expect(result.outcome).toBe('timeout');
    expect(result.usage.subscription).toBe(true);
    expect(result.usage.seatSeconds).toBeGreaterThan(1);

    // The fake ignores SIGTERM and has a grandchild: both must be gone (SIGKILL to the group).
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; child: number };
    await wait(100);
    expect(pidAlive(pids.pid)).toBe(false);
    expect(pidAlive(pids.child)).toBe(false);
    expect(existsSync(sandbox.readRecord<{ mcpConfigPath: string }>().mcpConfigPath)).toBe(false);
    expect(claudeTmpDirs()).toEqual(before);
  });

  it('codex_local, process and http time out', async () => {
    const codex = await adapter('codex_local').run(
      makeCtx(gateway, sandbox, { maxWallMs: 400, config: { command: sandbox.bin('fake-codex.mjs'), env: { FAKE_MODE: 'hang' } } }),
      collect().onEvent,
    );
    expect(codex.outcome).toBe('timeout');
    const proc = await adapter('process').run(
      makeCtx(gateway, sandbox, { maxWallMs: 400, config: { command: sandbox.bin('fake-agent.mjs'), env: { FAKE_MODE: 'hang' } } }),
      collect().onEvent,
    );
    expect(proc.outcome).toBe('timeout');
    // The slow mock provider route never answers: reuse it as a hung webhook.
    providers.anthropic.mode = 'slow';
    const http = await adapter('http').run(
      makeCtx(gateway, sandbox, { maxWallMs: 300, secrets: { apiKey: 'unused-webhook-key-000' }, config: { url: `${providers.anthropicBaseURL}/v1/messages`, headers: { 'x-api-key': ANTHROPIC_TEST_KEY } } }),
      collect().onEvent,
    );
    expect(http.outcome).toBe('timeout');
  });
});

describe('budget cap', () => {
  it.each([
    ['claude_api', () => ((providers.anthropic.mode = 'loop'), (providers.anthropic.usage = { input: 1_000_000, output: 0, cacheRead: 0 }), claudeApi({ budgetCapUsd: 5 }))],
    ['openai_api', () => ((providers.openai.mode = 'loop'), (providers.openai.usage = { input: 2_000_000, output: 0, cacheRead: 0 }), openaiApi({ budgetCapUsd: 5 }))],
  ])('%s stops with outcome budget once metered cost exceeds the cap', async (id, build) => {
    const c = collect();
    const result = await adapter(id).run(build(), c.onEvent);
    // claude-opus-5-5: $4 per 1M-token turn; gpt-5.2: $3.50 per 2M-token turn. Both cross $5 on turn two.
    expect(result.outcome).toBe('budget');
    expect(result.steps).toBe(2);
    expect(result.usage.costUsd).toBeGreaterThan(5);
    expect(result.error).toBeUndefined();
    expect(gateway.calls).toHaveLength(1);
    expect(c.ofType('status').some((s) => s.status.includes('budget'))).toBe(true);
  });

  it('metered adapters refuse to start with no budget left; pricing overrides are applied', async () => {
    const spent = await adapter('claude_api').run(claudeApi({ budgetCapUsd: 0 }), collect().onEvent);
    expect(spent).toMatchObject({ outcome: 'budget', steps: 0 });
    expect(providers.anthropic.requests).toHaveLength(0);

    const ctx = claudeApi();
    ctx.config = { ...ctx.config, pricing: { input: 100, output: 1000 } };
    const custom = await adapter('claude_api').run(ctx, collect().onEvent);
    expect(custom.usage.costUsd).toBeCloseTo(2 * ((1000 * 100 + 50 * 1000) / 1e6), 8);

    const bad = claudeApi();
    bad.config = { ...bad.config, pricing: { input: 'free' } };
    expect(await adapter('claude_api').run(bad, collect().onEvent)).toMatchObject({ outcome: 'failed', error: { kind: 'invalid_request' } });
  });

  it('claude_local on an API key is stopped when its estimated spend passes the cap; a subscription run is not', async () => {
    const env = { FAKE_MODE: 'spend' };
    const metered = await adapter('claude_local').run(
      makeCtx(gateway, sandbox, { budgetCapUsd: 10, secrets: { apiKey: ANTHROPIC_TEST_KEY }, config: { command: sandbox.bin('fake-claude.mjs'), env } }),
      collect().onEvent,
    );
    expect(metered.outcome).toBe('budget');
    expect(metered.usage.costUsd).toBeGreaterThan(10);
    expect(metered.usage.subscription).toBe(false);

    const sub = await adapter('claude_local').run(
      makeCtx(gateway, sandbox, { budgetCapUsd: 0, maxWallMs: 600, config: { command: sandbox.bin('fake-claude.mjs'), env } }),
      collect().onEvent,
    );
    // $0 marginal cost never trips the cap; this run simply hit its wall-clock limit instead.
    expect(sub.outcome).toBe('timeout');
    expect(sub.usage).toMatchObject({ costUsd: 0, subscription: true });
  });

  it('process stops when reported cost passes the cap', async () => {
    const result = await adapter('process').run(
      makeCtx(gateway, sandbox, { budgetCapUsd: 3, config: { command: sandbox.bin('fake-agent.mjs'), output: 'jsonl', env: { FAKE_MODE: 'spend' } } }),
      collect().onEvent,
    );
    expect(result.outcome).toBe('budget');
    expect(result.usage.costUsd).toBeGreaterThan(3);
  });
});

describe('cancel', () => {
  it.each([
    ['claude_api', () => ((providers.anthropic.mode = 'slow'), claudeApi())],
    ['openai_api', () => ((providers.openai.mode = 'slow'), openaiApi())],
    ['codex_local', () => makeCtx(gateway, sandbox, { config: { command: sandbox.bin('fake-codex.mjs'), env: { FAKE_MODE: 'hang' } } })],
    ['process', () => makeCtx(gateway, sandbox, { config: { command: sandbox.bin('fake-agent.mjs'), env: { FAKE_MODE: 'hang' } } })],
  ])('%s: cancel(runId) ends the run as cancelled', async (id, build) => {
    const ctx = build();
    const c = collect();
    const running = adapter(id).run(ctx, c.onEvent);
    await wait(250);
    await adapter(id).cancel(ctx.runId);
    const result = await running;
    expect(result.outcome).toBe('cancelled');
    expect(result.error).toBeUndefined();
    expect(c.ofType('error')).toHaveLength(0);
    // Cancelling something that is not running is a no-op.
    await expect(adapter(id).cancel(ctx.runId)).resolves.toBeUndefined();
    await expect(adapter(id).cancel('run_unknown')).resolves.toBeUndefined();
  });

  it('claude_local: cancel kills the process group and deletes the MCP config', async () => {
    const pidFile = join(sandbox.root, 'pids.json');
    const ctx = makeCtx(gateway, sandbox, {
      config: { command: sandbox.bin('fake-claude.mjs'), env: { FAKE_MODE: 'hang', FAKE_PIDFILE: pidFile, FAKE_RECORD: sandbox.recordFile } },
    });
    const running = adapter('claude_local').run(ctx, collect().onEvent);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await wait(50);
    const rec = sandbox.readRecord<{ mcpConfigPath: string }>();
    expect(existsSync(rec.mcpConfigPath)).toBe(true);
    await adapter('claude_local').cancel(ctx.runId);
    const result = await running;
    expect(result.outcome).toBe('cancelled');
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; child: number };
    await wait(100);
    expect(pidAlive(pids.pid)).toBe(false);
    expect(pidAlive(pids.child)).toBe(false);
    expect(existsSync(rec.mcpConfigPath)).toBe(false);
  });

  it('rejects a second concurrent run with the same id', async () => {
    providers.anthropic.mode = 'slow';
    const ctx = claudeApi({ maxWallMs: 600 });
    const first = adapter('claude_api').run(ctx, collect().onEvent);
    const second = await adapter('claude_api').run(ctx, collect().onEvent);
    expect(second).toMatchObject({ outcome: 'failed', error: { kind: 'invalid_request' } });
    expect((await first).outcome).toBe('timeout');
  });
});
