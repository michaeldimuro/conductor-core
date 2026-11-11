import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunContext, RunEvent } from '../../src/contracts/adapter.js';
import { conductorPackageRoot, createAdapterRegistry, linkAdapterSdk, runChain } from '../../src/adapters/index.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const EXAMPLE = join(REPO, 'examples', 'adapters', 'echo-adapter');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { name: string; exports: Record<string, { types: string; default: string } | string>; files: string[] };
const sdkExport = pkg.exports['./adapters/sdk'] as { types: string; default: string };
/** The SDK export points at the build output; these checks need `npm run build` to have run. */
const built = existsSync(join(REPO, sdkExport.default));

let root: string;
let pluginDir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-plugins-')));
  pluginDir = join(root, 'adapters');
  mkdirSync(pluginDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  runId: 'run_plugin_1', orgId: 'org_t', agentId: 'agent_t', issueId: null, systemPrompt: '', prompt: 'hello from a plugin', model: null,
  config: {}, secrets: { apiKey: 'sk-plugin-secret-value-000' }, skills: [], mcpEndpoints: [], workspacePath: root, budgetCapUsd: null, maxSteps: 5,
  maxWallMs: 10_000, runToken: 'run-token-plugin-test-000000', apiBaseUrl: 'http://127.0.0.1:1/api', ...over,
});

const plain = (id: string): string => `export default () => ({
  id: ${JSON.stringify(id)},
  capabilities: () => ({ tools: false, mcp: false, resume: false, vision: false, browser: 'via_mcp' }),
  testConnection: async () => ({ ok: true }),
  run: async (ctx) => ({ outcome: 'completed', finalText: ctx.prompt, steps: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 } }),
  cancel: async () => {},
});`;
const manifest = (id: string) => ({
  id, name: id, version: '1.0.0', entry: 'index.mjs', configSchema: {},
  capabilities: { tools: false, mcp: false, resume: false, vision: false, browser: 'via_mcp' },
});
function drop(folder: string, id: string): void {
  mkdirSync(join(pluginDir, folder), { recursive: true });
  writeFileSync(join(pluginDir, folder, 'index.mjs'), plain(id));
  writeFileSync(join(pluginDir, folder, 'conductor-adapter.json'), JSON.stringify(manifest(id)));
}

describe('FR-7: adapters install into a running registry', () => {
  it('rescan() loads a plugin dropped after startup and reports what changed', async () => {
    const registry = createAdapterRegistry({ pluginDir });
    expect(await registry.rescan()).toEqual({ loaded: [], added: [], removed: [], skipped: [] });

    drop('first', 'first_agent');
    expect(await registry.rescan()).toEqual({ loaded: ['first_agent'], added: ['first_agent'], removed: [], skipped: [] });
    expect(registry.get('first_agent')?.id).toBe('first_agent');

    drop('second', 'second_agent');
    mkdirSync(join(pluginDir, 'broken'));
    writeFileSync(join(pluginDir, 'broken', 'conductor-adapter.json'), '{ "id": "Bad Id" }');
    rmSync(join(pluginDir, 'first'), { recursive: true });
    const res = await registry.rescan();
    expect(res.loaded).toEqual(['second_agent']);
    expect(res.added).toEqual(['second_agent']);
    expect(res.removed).toEqual(['first_agent']);
    expect(res.skipped).toEqual([{ folder: join(pluginDir, 'broken'), error: expect.stringContaining('invalid manifest') }]);
    expect(registry.list().filter((a) => !a.builtin).map((a) => a.id)).toEqual(['second_agent']);
  });

  it('links the SDK next to the plugins and never scans or replaces a foreign node_modules entry', async () => {
    drop('first', 'first_agent');
    const registry = createAdapterRegistry({ pluginDir });
    const res = await registry.rescan();
    expect(res.skipped).toEqual([]);
    const link = join(pluginDir, 'node_modules', 'conductor');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(conductorPackageRoot()));
    expect(conductorPackageRoot()).toBe(REPO.replace(/\/$/, ''));

    // A real directory there belongs to the plugin author: left alone.
    rmSync(link);
    mkdirSync(link);
    writeFileSync(join(link, 'keep.txt'), 'mine');
    expect(linkAdapterSdk(pluginDir)).toBeNull();
    expect(readFileSync(join(link, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('the package exposes the adapter SDK (code + types) through `exports`', () => {
    expect(pkg.name).toBe('conductor');
    expect(sdkExport).toEqual({ types: './dist/adapters/sdk.d.ts', default: './dist/adapters/sdk.js' });
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'examples']));
  });

  it.skipIf(!built)('the built SDK entry and its type declarations exist where `exports` points', () => {
    expect(existsSync(join(REPO, sdkExport.default))).toBe(true);
    expect(existsSync(join(REPO, sdkExport.types))).toBe(true);
    expect(readFileSync(join(REPO, sdkExport.types), 'utf8')).toContain('defineAdapter');
  });

  it.skipIf(!built)('the example plugin installs from a plugin dir by copying its folder — no core change, no restart', async () => {
    const registry = createAdapterRegistry({ pluginDir });
    await registry.loadPlugins(); // daemon startup: nothing installed yet
    expect(registry.get('example_echo')).toBeUndefined();

    cpSync(EXAMPLE, join(pluginDir, 'echo-adapter'), { recursive: true });
    const res = await registry.rescan();
    expect(res).toEqual({ loaded: ['example_echo'], added: ['example_echo'], removed: [], skipped: [] });
    expect(registry.list().find((a) => a.id === 'example_echo')).toMatchObject({ name: 'Example: Echo', builtin: false });
    expect(await registry.get('example_echo')?.testConnection({ config: {}, secrets: {} })).toMatchObject({ ok: true, version: '1.0.0' });

    // It runs through the same chain as the built-ins, using the SDK it imported from 'conductor/adapters/sdk'.
    const events: RunEvent[] = [];
    const config = { prefix: 'echo: ', uppercase: true };
    const job = { adapterId: 'example_echo', ctx: ctx({ config }), chain: [{ adapterId: 'example_echo', model: null, config, secrets: {} }] };
    const result = await runChain(registry, job, (e) => events.push(e));
    expect(result).toMatchObject({ outcome: 'completed', finalText: 'echo: HELLO FROM A PLUGIN', adapterId: 'example_echo', steps: 1 });
    expect(events.some((e) => e.type === 'text' && e.text === 'echo: HELLO FROM A PLUGIN')).toBe(true);

    const empty = await runChain(registry, { ...job, ctx: ctx({ prompt: '  ', config }) }, () => {});
    expect(empty).toMatchObject({ outcome: 'failed', error: { kind: 'invalid_request' } });
  });
});
