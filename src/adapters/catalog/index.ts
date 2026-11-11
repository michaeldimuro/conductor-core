import type { AdapterRegistry } from '../../contracts/adapter.js';
import type { SecretStore } from '../../contracts/kernel.js';
import { defaultCredentialRefs, type ModelCatalog, type ModelCatalogService, type ModelCatalogSource, type ModelOption } from '../../contracts/providers.js';
import { notFound } from '../../shared/errors.js';
import type { Logger } from '../../shared/util.js';
import { CLAUDE_API_DEFAULT_MODEL } from '../builtin/claude-api.js';
import { OPENAI_API_DEFAULT_MODEL } from '../builtin/openai-api.js';
import { execCli, type CliExec } from '../shared/cli-exec.js';
import {
  anthropicModels, builtinModels, claudeAliasOptions, codexConfiguredModel, openaiModels, parseClaudeHelp, parseCodexCatalog, type Fetch,
} from './sources.js';

export interface ModelCatalogDeps {
  registry: AdapterRegistry;
  secrets: SecretStore;
  log: Logger;
  exec?: CliExec;
  fetch?: Fetch;
  /** Cache lifetime (default 10 minutes). */
  ttlMs?: number;
  now?: () => number;
  /** Codex config lookup (tests). */
  codexConfiguredModel?: () => string | null;
}

/** Claude Code effort levels, used when the installed CLI's help does not list them. */
const CLAUDE_EFFORTS_FALLBACK = ['low', 'medium', 'high', 'xhigh', 'max'];
const OPENAI_EFFORTS = ['minimal', 'low', 'medium', 'high'];

/**
 * The models each adapter can run, from the most authoritative source available:
 * the installed CLI's own catalog (`codex debug models`, `claude --help` aliases),
 * the provider's models API when a key is stored, the adapter's own `listModels`,
 * then Conductor's built-in price table. Results are cached per adapter and key.
 */
export function createModelCatalog(deps: ModelCatalogDeps): ModelCatalogService {
  const exec = deps.exec ?? execCli;
  const ttl = deps.ttlMs ?? 10 * 60_000;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: ModelCatalog }>();

  const firstSecret = async (refs: string[]): Promise<string | null> => {
    for (const ref of refs) {
      const v = await deps.secrets.get(ref).catch(() => null);
      if (v) return v;
    }
    return null;
  };

  const catalog = (adapterId: string, c: Partial<ModelCatalog>): ModelCatalog => ({
    adapterId, models: [], efforts: [], effortKey: null, allowCustom: true, defaultModel: null, sources: [], notes: [], fetchedAt: now(), ...c,
  });

  /** Merge lists, keeping the first occurrence of each id (earlier sources win). */
  const merge = (...lists: ModelOption[][]): ModelOption[] => {
    const seen = new Set<string>();
    const out: ModelOption[] = [];
    for (const list of lists) {
      for (const m of list) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
      }
    }
    return out;
  };

  async function viaApi(vendor: 'anthropic' | 'openai', key: string | null, baseURL: string | undefined, notes: string[], sources: ModelCatalogSource[]): Promise<ModelOption[]> {
    if (!key) return [];
    try {
      const list = vendor === 'anthropic' ? await anthropicModels(key, { baseURL, fetch: deps.fetch }) : await openaiModels(key, { baseURL, fetch: deps.fetch });
      sources.push('api');
      return list;
    } catch (err) {
      notes.push(`${vendor === 'anthropic' ? 'Anthropic' : 'OpenAI'} models API unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async function claudeLocal(key: string | null): Promise<ModelCatalog> {
    const notes: string[] = [];
    const sources: ModelCatalogSource[] = [];
    const help = await exec('claude', ['--help'], { timeoutMs: 10_000 });
    let aliases: ModelOption[] = [];
    let efforts = CLAUDE_EFFORTS_FALLBACK;
    if (help.spawnError || help.code !== 0) notes.push(help.spawnError ? 'claude CLI not found: install Claude Code to run claude_local' : 'claude --help failed; showing built-in options');
    else {
      const parsed = parseClaudeHelp(help.stdout);
      aliases = claudeAliasOptions(parsed.aliases);
      if (parsed.efforts.length) efforts = parsed.efforts;
      if (aliases.length) sources.push('cli');
    }
    const api = await viaApi('anthropic', key, undefined, notes, sources);
    // Claude Code also takes a model's full name: offer pinned ids after the aliases.
    const pinned = api.length ? [] : builtinModels('anthropic').map((m) => ({ ...m, description: 'Pinned model id (from Conductor\'s price table)' }));
    if (pinned.length) sources.push('builtin');
    return catalog('claude_local', {
      models: merge(aliases, api, pinned),
      efforts, effortKey: 'effort', defaultModel: null, sources, notes,
    });
  }

  async function codexLocal(): Promise<ModelCatalog> {
    const notes: string[] = [];
    const sources: ModelCatalogSource[] = [];
    let models: ModelOption[] = [];
    const r = await exec('codex', ['debug', 'models'], { timeoutMs: 20_000 });
    if (r.spawnError) notes.push('codex CLI not found: install the Codex CLI to run codex_local');
    else if (r.code !== 0 || r.timedOut) notes.push('codex debug models failed; showing built-in options');
    else {
      try {
        models = parseCodexCatalog(r.stdout);
        if (models.length) sources.push('cli');
      } catch {
        notes.push('codex debug models returned unreadable output');
      }
    }
    if (!models.length) {
      models = builtinModels('openai');
      sources.push('builtin');
    }
    const configured = (deps.codexConfiguredModel ?? codexConfiguredModel)();
    return catalog('codex_local', { models, efforts: [], effortKey: 'reasoningEffort', defaultModel: configured, sources, notes });
  }

  async function api(adapterId: 'claude_api' | 'openai_api', key: string | null, baseURL: string | undefined): Promise<ModelCatalog> {
    const vendor = adapterId === 'claude_api' ? 'anthropic' : 'openai';
    const notes: string[] = [];
    const sources: ModelCatalogSource[] = [];
    if (!key) notes.push(`No ${vendor === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key stored; showing Conductor's built-in list.`);
    const live = await viaApi(vendor, key, baseURL, notes, sources);
    if (!live.length) sources.push('builtin');
    return catalog(adapterId, {
      models: live.length ? live : builtinModels(vendor),
      efforts: vendor === 'anthropic' ? CLAUDE_EFFORTS_FALLBACK : OPENAI_EFFORTS,
      effortKey: vendor === 'anthropic' ? 'effort' : 'reasoningEffort',
      defaultModel: vendor === 'anthropic' ? CLAUDE_API_DEFAULT_MODEL : OPENAI_API_DEFAULT_MODEL,
      sources, notes,
    });
  }

  async function plugin(adapterId: string, key: string | null): Promise<ModelCatalog> {
    const adapter = deps.registry.get(adapterId);
    if (!adapter?.listModels) return catalog(adapterId, { sources: ['none'], notes: ['This adapter does not publish a model list; enter a model id.'] });
    try {
      const models = await adapter.listModels({ config: {}, secrets: key ? { apiKey: key } : {} });
      return catalog(adapterId, { models, sources: ['adapter'] });
    } catch (err) {
      return catalog(adapterId, { sources: ['none'], notes: [`The adapter's model list failed: ${err instanceof Error ? err.message : String(err)}`] });
    }
  }

  return {
    invalidate(adapterId) {
      for (const key of [...cache.keys()]) if (!adapterId || key.startsWith(`${adapterId}|`)) cache.delete(key);
    },
    async list(adapterId, opts = {}) {
      if (!deps.registry.get(adapterId)) throw notFound('adapter', adapterId);
      const vendorAdapter = adapterId === 'claude_local' ? 'claude_api' : adapterId === 'codex_local' ? 'openai_api' : adapterId;
      const refs = opts.authRef ? [opts.authRef] : defaultCredentialRefs(vendorAdapter, 'api_key', opts.orgSlug ?? null);
      const key = refs.length ? await firstSecret(refs) : null;
      // Keyed by the ref that resolved, never by the key itself.
      const cacheKey = `${adapterId}|${key ? refs.join(',') : '-'}`;
      const hit = cache.get(cacheKey);
      if (hit && !opts.refresh && now() - hit.at < ttl) return hit.value;
      let value: ModelCatalog;
      if (adapterId === 'claude_local') value = await claudeLocal(key);
      else if (adapterId === 'codex_local') value = await codexLocal();
      else if (adapterId === 'claude_api' || adapterId === 'openai_api') value = await api(adapterId, key, undefined);
      else if (adapterId === 'process' || adapterId === 'http') value = catalog(adapterId, { sources: ['none'], notes: ['The model is whatever your process or endpoint uses; leave empty or enter an id it understands.'] });
      else value = await plugin(adapterId, key);
      cache.set(cacheKey, { at: now(), value });
      deps.log.debug({ adapterId, models: value.models.length, sources: value.sources }, 'model catalog refreshed');
      return value;
    },
  };
}
