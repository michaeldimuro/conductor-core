import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterManifest } from '../../src/contracts/adapter.js';
import { createAdapterRegistry, PRICE_TABLE, priceFor, runChain } from '../../src/adapters/index.js';
import { defineAdapter, findPrice, parsePricingOverrides, sanitizeToolName } from '../../src/adapters/sdk.js';
import type { Logger } from '../../src/shared/util.js';
import { collect, createSandbox, makeCtx, RUN_TOKEN, type Sandbox } from './helpers/context.js';
import { startTestGateway, type TestGateway } from './helpers/mcp-server.js';

let gateway: TestGateway;
let sandbox: Sandbox;
let pluginDir: string;

beforeAll(async () => {
  gateway = await startTestGateway(RUN_TOKEN);
});
afterAll(() => gateway.close());
beforeEach(() => {
  sandbox = createSandbox();
  pluginDir = join(sandbox.root, 'adapters');
  mkdirSync(pluginDir);
});
afterEach(() => sandbox.dispose());

const manifest = (over: Partial<AdapterManifest> = {}): AdapterManifest => ({
  id: 'echo_agent',
  name: 'Echo Agent',
  version: '1.2.3',
  entry: 'index.mjs',
  configSchema: { type: 'object', properties: { shout: { type: 'boolean' } } },
  capabilities: { tools: false, mcp: false, resume: false, vision: false, browser: 'via_mcp' },
  secretName: 'apiKey',
  ...over,
});

/** A third-party adapter as its author would ship it: plain ESM, no imports from Conductor core. */
const adapterSource = (id: string, marker?: string): string => `
${marker ? `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded');` : ''}
const cancelled = new Set();
export default () => ({
  id: ${JSON.stringify(id)},
  capabilities: () => ({ tools: false, mcp: false, resume: false, vision: false, browser: 'via_mcp' }),
  testConnection: async () => ({ ok: true, version: '1.2.3' }),
  async run(ctx, onEvent) {
    const text = ctx.config.shout ? ctx.prompt.toUpperCase() : ctx.prompt;
    onEvent({ type: 'text', text });
    onEvent({ type: 'usage', tokensIn: 7, tokensOut: 3, costUsd: 0.001 });
    return { outcome: 'completed', finalText: text, steps: 1, usage: { tokensIn: 7, tokensOut: 3, costUsd: 0.001, subscription: false, seatSeconds: 0 } };
  },
  cancel: async (runId) => { cancelled.add(runId); },
});
`;

function install(folder: string, m: unknown, files: Record<string, string> = {}): string {
  const dir = join(pluginDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'conductor-adapter.json'), typeof m === 'string' ? m : JSON.stringify(m));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function spyLog(): { log: Logger; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const info = vi.fn();
  return { log: { warn, info } as unknown as Logger, warn, info };
}

describe('FR-7: third-party adapters install without core changes', () => {
  it('discovers a plugin from its manifest, lists it and runs it through the chain', async () => {
    install('echo-adapter', manifest(), { 'index.mjs': adapterSource('echo_agent') });
    const { log, info } = spyLog();
    const registry = createAdapterRegistry({ pluginDir, log });
    expect(registry.get('echo_agent')).toBeUndefined();

    await registry.loadPlugins();
    const listed = registry.list().find((a) => a.id === 'echo_agent');
    expect(listed).toEqual({
      id: 'echo_agent',
      name: 'Echo Agent',
      builtin: false,
      configSchema: manifest().configSchema,
      capabilities: manifest().capabilities,
    });
    expect(registry.list()).toHaveLength(7);
    expect(info).toHaveBeenCalledTimes(1);

    const ctx = makeCtx(gateway, sandbox, { prompt: 'hello plugin', config: { shout: true } });
    const c = collect();
    const result = await runChain(registry, { adapterId: 'echo_agent', ctx, chain: [{ adapterId: 'echo_agent', model: null, config: { shout: true }, secrets: {} }] }, c.onEvent);
    expect(result).toMatchObject({ outcome: 'completed', finalText: 'HELLO PLUGIN', adapterId: 'echo_agent', usage: { tokensIn: 7, costUsd: 0.001 } });
    expect(c.ofType('text')[0]?.text).toBe('HELLO PLUGIN');
    expect(await registry.get('echo_agent')?.testConnection({ config: {}, secrets: {} })).toMatchObject({ ok: true });
  });

  it('accepts an entry in a subfolder, a scoped package and an adapter object export; rescans pick up removals', async () => {
    install('nested', manifest({ id: 'nested_agent', entry: 'dist/main.mjs' }), { 'dist/main.mjs': adapterSource('nested_agent') });
    install('@acme/agent', manifest({ id: 'acme_agent' }), {
      'index.mjs': `export default { id: 'acme_agent', capabilities: () => ({}), testConnection: async () => ({ ok: true }), run: async () => ({}), cancel: async () => {} };`,
    });
    const registry = createAdapterRegistry({ pluginDir });
    await registry.loadPlugins();
    expect(registry.get('nested_agent')?.id).toBe('nested_agent');
    expect(registry.get('acme_agent')?.id).toBe('acme_agent');

    rmSync(join(pluginDir, 'nested'), { recursive: true });
    await registry.loadPlugins();
    expect(registry.get('nested_agent')).toBeUndefined();
    expect(registry.get('acme_agent')).toBeDefined();
    expect(registry.get('claude_api')).toBeDefined();
  });

  it('rejects a manifest whose entry escapes the plugin folder (never imports it)', async () => {
    const marker = join(sandbox.root, 'outside-was-imported');
    writeFileSync(join(sandbox.root, 'outside.mjs'), adapterSource('evil_agent', marker));
    install('evil', manifest({ id: 'evil_agent', entry: '../../outside.mjs' }));
    install('evil-abs', { ...manifest({ id: 'evil_abs' }), entry: join(sandbox.root, 'outside.mjs') });
    // Lexically inside the folder, but a symlink to a file outside it.
    const linkDir = install('evil-link', manifest({ id: 'evil_link', entry: 'link.mjs' }));
    symlinkSync(join(sandbox.root, 'outside.mjs'), join(linkDir, 'link.mjs'));
    install('good', manifest(), { 'index.mjs': adapterSource('echo_agent') });

    const { log, warn } = spyLog();
    const registry = createAdapterRegistry({ pluginDir, log });
    await expect(registry.loadPlugins()).resolves.toBeUndefined();

    expect(registry.get('evil_agent')).toBeUndefined();
    expect(registry.get('evil_abs')).toBeUndefined();
    expect(registry.get('evil_link')).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
    const reasons = warn.mock.calls.map((call) => String((call[0] as { err: string }).err)).join(' | ');
    expect(reasons).toMatch(/escapes/);
    expect(reasons).toMatch(/relative path/);
    // One bad plugin never blocks a good one.
    expect(registry.get('echo_agent')).toBeDefined();
  });

  it('skips broken plugins without failing: bad JSON, bad schema, missing entry, wrong export, id clashes', async () => {
    install('bad-json', '{ not json');
    install('bad-schema', { id: 'Bad Id!', name: 'x' });
    install('no-entry', manifest({ id: 'no_entry' }));
    install('wrong-export', manifest({ id: 'wrong_export' }), { 'index.mjs': 'export default { hello: 1 };' });
    install('throws', manifest({ id: 'throws_agent' }), { 'index.mjs': 'throw new Error("import blew up");' });
    install('id-mismatch', manifest({ id: 'declared_id' }), { 'index.mjs': adapterSource('other_id') });
    install('shadow-builtin', manifest({ id: 'claude_api' }), { 'index.mjs': adapterSource('claude_api') });
    install('dup-1', manifest({ id: 'dup_agent' }), { 'index.mjs': adapterSource('dup_agent') });
    install('dup-2', manifest({ id: 'dup_agent' }), { 'index.mjs': adapterSource('dup_agent') });
    mkdirSync(join(pluginDir, 'not-a-plugin'));

    const { log, warn } = spyLog();
    const registry = createAdapterRegistry({ pluginDir, log });
    await registry.loadPlugins();
    expect(warn).toHaveBeenCalledTimes(8);
    expect(registry.list().filter((a) => !a.builtin).map((a) => a.id)).toEqual(['dup_agent']);
    // The built-in is untouched by the plugin that tried to shadow it.
    expect(registry.list().find((a) => a.id === 'claude_api')?.builtin).toBe(true);
  });

  it('tolerates a plugin directory that does not exist', async () => {
    const registry = createAdapterRegistry({ pluginDir: join(sandbox.root, 'nope') });
    await expect(registry.loadPlugins()).resolves.toBeUndefined();
    expect(registry.list()).toHaveLength(6);
  });

  it('exposes an SDK surface for adapter authors', () => {
    const a = defineAdapter({
      id: 'typed',
      capabilities: () => ({ tools: false, mcp: false, resume: false, vision: false, browser: 'via_mcp' as const }),
      testConnection: async () => ({ ok: true }),
      run: async () => ({ outcome: 'completed' as const, finalText: '', steps: 0, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 } }),
      cancel: async () => {},
    });
    expect(a.id).toBe('typed');
    expect(sanitizeToolName('gmail.send message!')).toBe('gmail_send_message_');
    expect(sanitizeToolName('a.b', new Set(['a_b']))).not.toBe('a_b');
    const long = sanitizeToolName('x'.repeat(100));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('pricing', () => {
  it('prices current Anthropic models per MTok including cache reads and writes', () => {
    expect(PRICE_TABLE['claude-fable-5-2']).toMatchObject({ input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 });
    expect(PRICE_TABLE['claude-opus-5-5']).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(PRICE_TABLE['claude-sonnet-5-5']).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(PRICE_TABLE['claude-haiku-5-5']).toMatchObject({ input: 0.1, output: 0.5 });
    const m = 1_000_000;
    expect(priceFor('claude-opus-5-5', { inputTokens: m, outputTokens: m, cacheReadTokens: m, cacheWriteTokens: m })).toBeCloseTo(4 + 20 + 0.2 + 5, 6);
    expect(priceFor('claude-sonnet-5-5', { inputTokens: 1500, outputTokens: 300 })).toBeCloseTo(0.006, 8);
    // Haiku 5.5 switches to its long-context rates above 100K prompt tokens.
    expect(priceFor('claude-haiku-5-5', { inputTokens: 50_000, outputTokens: 1000 })).toBeCloseTo(0.0055, 8);
    expect(priceFor('claude-haiku-5-5', { inputTokens: 200_000, outputTokens: 1000 })).toBeCloseTo(0.1025, 8);
  });

  it('resolves dated / prefixed ids, reports unknown models and honours overrides', () => {
    expect(findPrice('gpt-5.2-2025-12-11')).toBe(PRICE_TABLE['gpt-5.2']);
    expect(findPrice('anthropic.claude-opus-5-5')).toBe(PRICE_TABLE['claude-opus-5-5']);
    expect(findPrice('gpt-5-mini')).toBe(PRICE_TABLE['gpt-5-mini']);
    expect(findPrice('some-local-model')).toBeUndefined();
    expect(priceFor('some-local-model', { inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);
    expect(priceFor(null, { inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);

    const flat = parsePricingOverrides({ input: 1, output: 2, cacheRead: 0.5 });
    expect(priceFor('some-local-model', { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 }, flat)).toBeCloseTo(3.5, 8);
    expect(priceFor('claude-opus-5-5', { inputTokens: 1e6, outputTokens: 0 }, flat)).toBe(1);
    const perModel = parsePricingOverrides({ 'claude-opus-5-5': { input: 9, output: 9 } });
    expect(priceFor('claude-opus-5-5', { inputTokens: 1e6, outputTokens: 0 }, perModel)).toBe(9);
    expect(priceFor('claude-sonnet-5-5', { inputTokens: 1e6, outputTokens: 0 }, perModel)).toBe(2);
    expect(parsePricingOverrides(undefined)).toBeUndefined();
    expect(() => parsePricingOverrides({ input: -1, output: 1 })).toThrow(/config.pricing/);
    expect(() => parsePricingOverrides('cheap')).toThrow(/config.pricing/);
  });
});
