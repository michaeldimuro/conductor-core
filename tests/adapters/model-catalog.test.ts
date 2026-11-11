import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createModelCatalog } from '../../src/adapters/catalog/index.js';
import { parseClaudeHelp, parseCodexCatalog } from '../../src/adapters/catalog/sources.js';
import type { AdapterRegistry, AgentAdapter } from '../../src/contracts/adapter.js';
import type { CliExec, CliExecResult } from '../../src/adapters/shared/cli-exec.js';
import { MemorySecretStore } from '../../src/kernel/index.js';

const log = { debug() {}, info() {}, warn() {}, error() {} } as never;
const ok = (stdout: string): CliExecResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const missing: CliExecResult = { code: null, stdout: '', stderr: '', timedOut: false, spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) };

/** Help text as Claude Code 2.1 prints it (wrapped columns). */
const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  -n, --name <name>                     Set a display name for this session`;

const CODEX_MODELS = JSON.stringify({ models: [
  { slug: 'gpt-b', display_name: 'GPT B', priority: 2, visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'ultra' }], context_window: 400000 },
  { slug: 'gpt-a', display_name: 'GPT A', priority: 1, visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }] },
  { slug: 'gpt-secret', display_name: 'Hidden', priority: 3, visibility: 'hide' },
] });

function registry(extra: Record<string, Partial<AgentAdapter>> = {}): AdapterRegistry {
  const ids = ['claude_local', 'codex_local', 'claude_api', 'openai_api', 'process', 'http', ...Object.keys(extra)];
  return { get: (id: string) => (ids.includes(id) ? ({ id, ...extra[id] } as AgentAdapter) : undefined), list: () => [], loadPlugins: async () => {} } as unknown as AdapterRegistry;
}

describe('model catalog parsers', () => {
  it('reads aliases and effort levels from claude --help', () => {
    expect(parseClaudeHelp(CLAUDE_HELP)).toEqual({ aliases: ['fable', 'opus', 'sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(parseClaudeHelp('nothing useful')).toEqual({ aliases: [], efforts: [] });
  });

  it('reads codex debug models, ordered by priority, with per-model reasoning levels', () => {
    expect(parseCodexCatalog(CODEX_MODELS)).toEqual([
      { id: 'gpt-a', label: 'GPT A', kind: 'model', efforts: ['low'], defaultEffort: 'low' },
      { id: 'gpt-b', label: 'GPT B', kind: 'model', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'medium', contextWindow: 400000 },
      { id: 'gpt-secret', label: 'Hidden', kind: 'model', hidden: true },
    ]);
  });
});

describe('model catalog service', () => {
  it('claude_local: CLI aliases first, then pinned ids; effort lives in config.effort', async () => {
    const exec: CliExec = vi.fn(async () => ok(CLAUDE_HELP));
    const c = createModelCatalog({ registry: registry(), secrets: new MemorySecretStore(), log, exec });
    const cat = await c.list('claude_local');
    expect(cat.models.slice(0, 3).map((m) => [m.id, m.kind])).toEqual([['fable', 'alias'], ['opus', 'alias'], ['sonnet', 'alias']]);
    expect(cat.models.length).toBeGreaterThan(3);
    expect(cat.models[3]!.kind).toBe('model');
    expect(cat).toMatchObject({ effortKey: 'effort', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], allowCustom: true, sources: ['cli', 'builtin'] });
  });

  it('codex_local: the CLI catalog and the user\'s configured default model', async () => {
    const exec: CliExec = vi.fn(async () => ok(CODEX_MODELS));
    const c = createModelCatalog({ registry: registry(), secrets: new MemorySecretStore(), log, exec, codexConfiguredModel: () => 'gpt-b' });
    const cat = await c.list('codex_local');
    expect(cat.models.map((m) => m.id)).toEqual(['gpt-a', 'gpt-b', 'gpt-secret']);
    expect(cat).toMatchObject({ effortKey: 'reasoningEffort', defaultModel: 'gpt-b', sources: ['cli'] });
    expect(exec).toHaveBeenCalledWith('codex', ['debug', 'models'], expect.anything());
  });

  it('falls back to the built-in list (with a note) when the CLI is missing', async () => {
    const c = createModelCatalog({ registry: registry(), secrets: new MemorySecretStore(), log, exec: async () => missing, codexConfiguredModel: () => null });
    const cat = await c.list('codex_local');
    expect(cat.sources).toEqual(['builtin']);
    expect(cat.models.length).toBeGreaterThan(0);
    expect(cat.notes.join(' ')).toMatch(/codex CLI not found/);
  });

  it('caches per adapter and re-fetches on refresh', async () => {
    let t = 0;
    const exec = vi.fn(async () => ok(CODEX_MODELS));
    const c = createModelCatalog({ registry: registry(), secrets: new MemorySecretStore(), log, exec, now: () => t, ttlMs: 1000, codexConfiguredModel: () => null });
    await c.list('codex_local');
    await c.list('codex_local');
    expect(exec).toHaveBeenCalledTimes(1);
    await c.list('codex_local', { refresh: true });
    t = 5000;
    await c.list('codex_local');
    expect(exec).toHaveBeenCalledTimes(3);
    // A login/logout changes what the CLI offers: invalidation forces the next read through.
    c.invalidate('claude_local');
    await c.list('codex_local');
    expect(exec).toHaveBeenCalledTimes(3);
    c.invalidate('codex_local');
    await c.list('codex_local');
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('API adapters list live models with the stored key (org-scoped ref first), never sending it elsewhere', async () => {
    const seen: Array<{ url: string; key: string | undefined }> = [];
    const srv = createServer((req, res) => {
      seen.push({ url: req.url ?? '', key: (req.headers['x-api-key'] as string | undefined) ?? req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-api-key']) res.end(JSON.stringify({ data: [{ id: 'claude-new-9', display_name: 'Claude New 9' }] }));
      else res.end(JSON.stringify({ data: [{ id: 'gpt-x', created: 2 }, { id: 'text-embedding-9', created: 3 }, { id: 'gpt-y-realtime', created: 4 }, { id: 'o9', created: 1 }] }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const secrets = new MemorySecretStore();
    await secrets.set('org/acme/anthropic-api-key', 'sk-ant-org');
    await secrets.set('conductor/anthropic-api-key', 'sk-ant-global');
    await secrets.set('conductor/openai-api-key', 'sk-openai');
    const viaLocal: typeof fetch = (url, init) => fetch(String(url).replace(/^https:\/\/api\.(anthropic|openai)\.com/, base), init);
    try {
      const c = createModelCatalog({ registry: registry(), secrets, log, fetch: viaLocal, exec: async () => missing });
      const claude = await c.list('claude_api', { orgSlug: 'acme' });
      expect(claude).toMatchObject({ sources: ['api'], defaultModel: 'claude-opus-5-5', effortKey: 'effort' });
      expect(claude.models).toEqual([{ id: 'claude-new-9', label: 'Claude New 9 (claude-new-9)', kind: 'model' }]);
      const openai = await c.list('openai_api');
      expect(openai.models.map((m) => m.id)).toEqual(['gpt-x', 'o9']);
      expect(seen).toEqual([{ url: '/v1/models?limit=100', key: 'sk-ant-org' }, { url: '/v1/models', key: 'Bearer sk-openai' }]);
      // claude_local also lists the API's pinned ids when an Anthropic key is stored.
      const local = await c.list('claude_local', { orgSlug: 'acme' });
      expect(local.models.map((m) => m.id)).toContain('claude-new-9');
    } finally {
      srv.close();
    }
  });

  it('plugins publish their own list; process/http have none; unknown adapters are not found', async () => {
    const c = createModelCatalog({
      registry: registry({ my_plugin: { listModels: async () => [{ id: 'm1', label: 'Model One', kind: 'model' }] } }),
      secrets: new MemorySecretStore(), log, exec: async () => missing,
    });
    expect((await c.list('my_plugin')).models).toEqual([{ id: 'm1', label: 'Model One', kind: 'model' }]);
    expect(await c.list('process')).toMatchObject({ models: [], allowCustom: true, sources: ['none'] });
    await expect(c.list('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
