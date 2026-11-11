import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterErrorKind, AdapterRegistry, AgentAdapter, RunContext, RunOutcome, RunResult } from '../../src/contracts/adapter.js';
import type { WorkerJob } from '../../src/contracts/services.js';
import { cancelRun, createAdapterRegistry, runChain } from '../../src/adapters/index.js';
import { collect, createSandbox, makeCtx, REFERENCE_ANSWER, RUN_TOKEN, wait, type Sandbox } from './helpers/context.js';
import { startTestGateway, type TestGateway } from './helpers/mcp-server.js';
import { ANTHROPIC_TEST_KEY, OPENAI_TEST_KEY, startMockProviders, type MockProviders } from './helpers/mock-providers.js';

let gateway: TestGateway;
let providers: MockProviders;
let registry: AdapterRegistry;
let sandbox: Sandbox;

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

/** claude_api (primary) -> openai_api (fallback), both pointed at the mock providers. */
function apiJob(): WorkerJob {
  const chain: WorkerJob['chain'] = [
    { adapterId: 'claude_api', model: 'claude-sonnet-5-5', config: { baseURL: providers.anthropicBaseURL, maxRetries: 0 }, secrets: { apiKey: ANTHROPIC_TEST_KEY } },
    { adapterId: 'openai_api', model: 'gpt-5.2', config: { baseURL: providers.openaiBaseURL, maxRetries: 0 }, secrets: { apiKey: OPENAI_TEST_KEY } },
  ];
  const first = chain[0] as WorkerJob['chain'][number];
  return { adapterId: 'claude_api', ctx: makeCtx(gateway, sandbox, { model: first.model, config: first.config, secrets: first.secrets }), chain };
}

describe('runChain with real adapters', () => {
  it('runs the primary binding when it works', async () => {
    const c = collect();
    const result = await runChain(registry, apiJob(), c.onEvent);
    expect(result).toMatchObject({ outcome: 'completed', adapterId: 'claude_api', model: 'claude-sonnet-5-5' });
    expect(result.finalText).toContain(REFERENCE_ANSWER);
    expect(providers.openai.requests).toHaveLength(0);
    expect(c.ofType('status').some((s) => s.status.startsWith('fallback'))).toBe(false);
  });

  it.each<[string, number, AdapterErrorKind]>([
    ['rate limit', 429, 'rate_limit'],
    ['auth failure', 401, 'auth'],
    ['outage', 500, 'outage'],
    ['overload', 529, 'outage'],
  ])('falls back on %s and emits a status event for the switch', async (_label, status, kind) => {
    providers.anthropic.mode = { status };
    const c = collect();
    const result = await runChain(registry, apiJob(), c.onEvent);
    expect(result).toMatchObject({ outcome: 'completed', adapterId: 'openai_api', model: 'gpt-5.2' });
    expect(result.finalText).toContain(REFERENCE_ANSWER);
    expect(result.usage.tokensIn).toBe(2000);
    expect(c.ofType('error')[0]).toMatchObject({ kind, retryable: kind !== 'auth' });
    const switches = c.ofType('status').filter((s) => s.status.startsWith('fallback'));
    expect(switches).toHaveLength(1);
    expect(switches[0]?.status).toContain(`claude_api (claude-sonnet-5-5) failed with ${kind}; switching to openai_api (gpt-5.2)`);
    // Neither binding's key, nor the run token, appears in what was emitted.
    expect(c.json()).not.toContain(ANTHROPIC_TEST_KEY);
    expect(c.json()).not.toContain(OPENAI_TEST_KEY);
    expect(c.json()).not.toContain(RUN_TOKEN);
  });

  it('falls back when the bound key is rejected', async () => {
    const job = apiJob();
    (job.chain[0] as WorkerJob['chain'][number]).secrets = { apiKey: 'sk-ant-revoked-key-0000000000' };
    const result = await runChain(registry, job, collect().onEvent);
    expect(result).toMatchObject({ outcome: 'completed', adapterId: 'openai_api' });
  });

  it('does NOT fall back on invalid_request', async () => {
    providers.anthropic.mode = { status: 400 };
    const c = collect();
    const result = await runChain(registry, apiJob(), c.onEvent);
    expect(result).toMatchObject({ outcome: 'failed', adapterId: 'claude_api', error: { kind: 'invalid_request' } });
    expect(providers.openai.requests).toHaveLength(0);
    expect(c.ofType('status').some((s) => s.status.startsWith('fallback'))).toBe(false);
  });

  it('does NOT fall back on max_steps, timeout or budget', async () => {
    providers.anthropic.mode = 'loop';
    const steps = apiJob();
    steps.ctx.maxSteps = 2;
    expect(await runChain(registry, steps, collect().onEvent)).toMatchObject({ outcome: 'max_steps', adapterId: 'claude_api' });

    providers.anthropic.usage = { input: 5_000_000, output: 0, cacheRead: 0 };
    const budget = apiJob();
    budget.ctx.budgetCapUsd = 1;
    expect(await runChain(registry, budget, collect().onEvent)).toMatchObject({ outcome: 'budget', adapterId: 'claude_api' });

    providers.anthropic.mode = 'slow';
    const slow = apiJob();
    slow.ctx.maxWallMs = 300;
    expect(await runChain(registry, slow, collect().onEvent)).toMatchObject({ outcome: 'timeout', adapterId: 'claude_api' });
    expect(providers.openai.requests).toHaveLength(0);
  });

  it('a local CLI rate limit falls back to an API binding (claude_local -> claude_api)', async () => {
    const chain: WorkerJob['chain'] = [
      { adapterId: 'claude_local', model: null, config: { command: sandbox.bin('fake-claude.mjs'), env: { FAKE_MODE: 'rate_limit' } }, secrets: {} },
      { adapterId: 'claude_api', model: null, config: { baseURL: providers.anthropicBaseURL, maxRetries: 0 }, secrets: { apiKey: ANTHROPIC_TEST_KEY } },
    ];
    const ctx = makeCtx(gateway, sandbox, { config: chain[0]?.config, resumeSessionId: 'sess-cli-only' });
    const c = collect();
    const result = await runChain(registry, { adapterId: 'claude_local', ctx, chain }, c.onEvent);
    expect(result).toMatchObject({ outcome: 'completed', adapterId: 'claude_api' });
    // The API attempt is metered, so the combined result is no longer a pure subscription run.
    expect(result.usage.subscription).toBe(false);
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(result.usage.seatSeconds).toBeGreaterThan(0);
    expect(c.ofType('error')[0]).toMatchObject({ kind: 'rate_limit' });
  });

  it('cancelRun stops the active attempt and prevents any fallback', async () => {
    providers.anthropic.mode = 'slow';
    const job = apiJob();
    const running = runChain(registry, job, collect().onEvent);
    await wait(200);
    await cancelRun(registry, job.ctx.runId);
    const result = await running;
    expect(result).toMatchObject({ outcome: 'cancelled', adapterId: 'claude_api' });
    expect(providers.openai.requests).toHaveLength(0);
    await expect(cancelRun(registry, 'run_never_started')).resolves.toBeUndefined();
  });
});

/* London-style: stub adapters behind the registry interface to pin down the chain's own rules. */

function stubRegistry(adapters: Record<string, AgentAdapter>): AdapterRegistry {
  return {
    get: (id) => adapters[id],
    list: () => Object.values(adapters).map((a) => ({ id: a.id, name: a.id, capabilities: a.capabilities(), configSchema: {}, builtin: false })),
    loadPlugins: async () => {},
  };
}

function stub(id: string, result: Partial<RunResult> & { outcome: RunOutcome }): AgentAdapter & { run: ReturnType<typeof vi.fn> } {
  const full: RunResult = {
    finalText: '',
    steps: 1,
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 },
    ...result,
  };
  return {
    id,
    capabilities: () => ({ tools: true, mcp: true, resume: false, vision: false, browser: 'via_mcp' }),
    testConnection: async () => ({ ok: true }),
    run: vi.fn(async () => full),
    cancel: vi.fn(async () => {}),
  };
}

const failure = (kind: AdapterErrorKind): Partial<RunResult> & { outcome: RunOutcome } => ({ outcome: 'failed', error: { kind, message: `${kind} happened` } });

function stubJob(ids: string[], over: Partial<RunContext> = {}): WorkerJob {
  const chain = ids.map((adapterId, i) => ({ adapterId, model: `model-${i}`, config: { n: i }, secrets: { apiKey: `secret-value-for-${adapterId}` } }));
  return { adapterId: ids[0] as string, ctx: makeCtx(gateway, sandbox, { resumeSessionId: 'sess-1', ...over }), chain };
}

describe('runChain rules (stub adapters)', () => {
  it('accumulates usage and steps across attempts and narrows budget for later attempts', async () => {
    const a = stub('a', { ...failure('rate_limit'), steps: 2, usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.4, subscription: true, seatSeconds: 7 } });
    const b = stub('b', { ...failure('outage'), steps: 1, usage: { tokensIn: 50, tokensOut: 5, costUsd: 0.1, subscription: false, seatSeconds: 0 } });
    const cc = stub('c', { outcome: 'completed', finalText: 'done', sessionId: 's-c', steps: 3, usage: { tokensIn: 1000, tokensOut: 200, costUsd: 0.25, subscription: false, seatSeconds: 0 } });
    const c = collect();
    const result = await runChain(stubRegistry({ a, b, c: cc }), stubJob(['a', 'b', 'c'], { budgetCapUsd: 2, maxSteps: 10 }), c.onEvent);

    expect(result).toMatchObject({ outcome: 'completed', finalText: 'done', adapterId: 'c', model: 'model-2', sessionId: 's-c', steps: 6 });
    expect(result.usage).toEqual({ tokensIn: 1150, tokensOut: 215, costUsd: 0.75, subscription: false, seatSeconds: 7 });
    expect(c.ofType('status').filter((s) => s.status.startsWith('fallback'))).toHaveLength(2);

    const ctxA = a.run.mock.calls[0]?.[0] as RunContext;
    const ctxB = b.run.mock.calls[0]?.[0] as RunContext;
    const ctxC = cc.run.mock.calls[0]?.[0] as RunContext;
    expect(ctxA).toMatchObject({ model: 'model-0', config: { n: 0 }, secrets: { apiKey: 'secret-value-for-a' }, budgetCapUsd: 2, maxSteps: 10, resumeSessionId: 'sess-1' });
    expect(ctxB).toMatchObject({ model: 'model-1', config: { n: 1 }, secrets: { apiKey: 'secret-value-for-b' }, maxSteps: 8 });
    expect(ctxB.budgetCapUsd).toBeCloseTo(1.6, 8);
    expect(ctxC.budgetCapUsd).toBeCloseTo(1.5, 8);
    // A provider session id is meaningless to a different adapter.
    expect(ctxB.resumeSessionId).toBeUndefined();
    expect(ctxC.maxWallMs).toBeLessThanOrEqual(ctxA.maxWallMs);
  });

  it.each<[string, Partial<RunResult> & { outcome: RunOutcome }]>([
    ['invalid_request', failure('invalid_request')],
    ['other', failure('other')],
    ['cancelled', { outcome: 'cancelled' }],
    ['max_steps', { outcome: 'max_steps' }],
    ['timeout', { outcome: 'timeout' }],
    ['budget', { outcome: 'budget' }],
    ['completed', { outcome: 'completed' }],
  ])('%s is final: the fallback is never tried', async (_label, first) => {
    const a = stub('a', first);
    const b = stub('b', { outcome: 'completed' });
    const result = await runChain(stubRegistry({ a, b }), stubJob(['a', 'b']), collect().onEvent);
    expect(result.outcome).toBe(first.outcome);
    expect(result.adapterId).toBe('a');
    expect(b.run).not.toHaveBeenCalled();
  });

  it('returns the last failure when every binding fails, and skips adapters that are not installed', async () => {
    const a = stub('a', failure('auth'));
    const b = stub('b', failure('rate_limit'));
    const c = collect();
    const result = await runChain(stubRegistry({ a, b }), stubJob(['a', 'missing', 'b']), c.onEvent);
    expect(result).toMatchObject({ outcome: 'failed', adapterId: 'b', error: { kind: 'rate_limit' } });
    expect(c.ofType('status').filter((s) => s.status.startsWith('fallback'))).toHaveLength(2);
    expect(c.ofType('error').some((e) => e.message.includes('"missing" is not installed'))).toBe(true);
  });

  it('contains an adapter that throws, masks secrets it leaks, and uses job.ctx when the chain is empty', async () => {
    const thrower = stub('a', { outcome: 'completed' });
    thrower.run.mockImplementation(async (_ctx: RunContext, onEvent: (e: { type: 'text'; text: string }) => void) => {
      onEvent({ type: 'text', text: 'leaking secret-value-for-a here' });
      throw new Error('kaboom with secret-value-for-a');
    });
    const c = collect();
    const result = await runChain(stubRegistry({ a: thrower }), stubJob(['a']), c.onEvent);
    expect(result).toMatchObject({ outcome: 'failed', error: { kind: 'other', message: 'kaboom with [REDACTED]' } });
    expect(c.json()).not.toContain('secret-value-for-a');

    const solo = stub('solo', { outcome: 'completed', finalText: 'ok' });
    const job: WorkerJob = { adapterId: 'solo', ctx: makeCtx(gateway, sandbox, { model: 'm', config: { x: 1 } }), chain: [] };
    expect(await runChain(stubRegistry({ solo }), job, collect().onEvent)).toMatchObject({ outcome: 'completed', adapterId: 'solo', model: 'm' });
    expect(solo.run.mock.calls[0]?.[0]).toMatchObject({ model: 'm', config: { x: 1 } });
  });
});
