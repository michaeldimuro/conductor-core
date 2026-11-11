import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelOption } from '../../contracts/providers.js';
import { PRICE_TABLE } from '../pricing.js';
import { stripAnsi } from '../shared/cli-exec.js';

/* ── Claude Code CLI ───────────────────────────────────────────────────── */

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * `claude --help` documents the model aliases it accepts ("an alias for the latest model (e.g.
 * 'fable', 'opus', or 'sonnet') or a model's full name") and the `--effort` levels. Parsing the
 * installed CLI's own help keeps the dropdown current without a hardcoded list.
 */
export function parseClaudeHelp(help: string): { aliases: string[]; efforts: string[] } {
  const flat = stripAnsi(help).replace(/\s+/g, ' ');
  const modelDesc = /--model <[^>]+>(.*?)(?= -[-a-zA-Z],? |$)/.exec(flat)?.[1] ?? '';
  const aliases = [...new Set([...modelDesc.matchAll(/'([a-z][a-z0-9.-]{1,30})'/g)].map((m) => m[1]!))];
  const effortDesc = /--effort <[^>]+>(.*?)(?= -[-a-zA-Z],? |$)/.exec(flat)?.[1] ?? '';
  const list = /\(([a-z]+(?:,\s*[a-z]+)+)\)/.exec(effortDesc)?.[1] ?? '';
  const efforts = list ? list.split(/,\s*/).filter(Boolean) : [];
  return { aliases, efforts };
}

export function claudeAliasOptions(aliases: string[]): ModelOption[] {
  return aliases.map((a) => ({ id: a, label: `${titleCase(a)} (latest)`, description: `Claude Code alias: always the newest ${titleCase(a)} model`, kind: 'alias' as const }));
}

/* ── Codex CLI ─────────────────────────────────────────────────────────── */

interface CodexModel {
  slug?: unknown; display_name?: unknown; description?: unknown; visibility?: unknown; priority?: unknown;
  default_reasoning_level?: unknown; supported_reasoning_levels?: unknown; context_window?: unknown;
}

/** `codex debug models`: the CLI's own catalog (`{ models: [...] }`) with per-model reasoning levels. */
export function parseCodexCatalog(json: string): ModelOption[] {
  const parsed = JSON.parse(json) as { models?: unknown };
  const list = Array.isArray(parsed.models) ? (parsed.models as CodexModel[]) : [];
  return list
    .filter((m): m is CodexModel & { slug: string } => typeof m.slug === 'string' && m.slug.length > 0)
    .sort((a, b) => (typeof a.priority === 'number' ? a.priority : 1e9) - (typeof b.priority === 'number' ? b.priority : 1e9))
    .map((m) => {
      const efforts = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((r) => (r && typeof r === 'object' ? (r as { effort?: unknown }).effort : r)).filter((e): e is string => typeof e === 'string')
        : [];
      return {
        id: m.slug,
        label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug,
        kind: 'model' as const,
        ...(typeof m.description === 'string' && m.description ? { description: m.description.slice(0, 300) } : {}),
        ...(efforts.length ? { efforts } : {}),
        ...(typeof m.default_reasoning_level === 'string' ? { defaultEffort: m.default_reasoning_level } : {}),
        ...(typeof m.context_window === 'number' ? { contextWindow: m.context_window } : {}),
        ...(m.visibility === 'hide' ? { hidden: true } : {}),
      };
    });
}

/** The `model = "…"` the user configured for Codex (`$CODEX_HOME/config.toml`), if any. Read-only. */
export function codexConfiguredModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.CODEX_HOME || join(homedir(), '.codex');
  try {
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    // Top-level key only: stop at the first table header.
    const top = toml.split(/^\s*\[/m)[0] ?? '';
    return /^\s*model\s*=\s*"([^"\n]{1,100})"/m.exec(top)?.[1] ?? null;
  } catch {
    return null;
  }
}

/* ── Provider APIs (when a key is stored) ──────────────────────────────── */

export type Fetch = typeof fetch;

/** `GET /v1/models` on the Anthropic API. */
export async function anthropicModels(apiKey: string, opts: { baseURL?: string; fetch?: Fetch } = {}): Promise<ModelOption[]> {
  const base = (opts.baseURL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const res = await (opts.fetch ?? fetch)(`${base}/v1/models?limit=100`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Anthropic models API answered ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown; display_name?: unknown }> };
  return (body.data ?? [])
    .filter((m): m is { id: string; display_name?: unknown } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, label: typeof m.display_name === 'string' && m.display_name ? `${m.display_name} (${m.id})` : m.id, kind: 'model' as const }));
}

const OPENAI_NOT_AGENTIC = /(audio|realtime|transcribe|tts|image|dall-e|embedding|whisper|moderation|search|instruct|babbage|davinci)/i;

/** `GET /models` on the OpenAI API, limited to text models an agent loop can drive. */
export async function openaiModels(apiKey: string, opts: { baseURL?: string; fetch?: Fetch } = {}): Promise<ModelOption[]> {
  const base = (opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await (opts.fetch ?? fetch)(`${base}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OpenAI models API answered ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown; created?: unknown }> };
  return (body.data ?? [])
    .filter((m): m is { id: string; created?: unknown } => typeof m.id === 'string' && /^(gpt-|o\d|chatgpt-|codex)/i.test(m.id) && !OPENAI_NOT_AGENTIC.test(m.id))
    .sort((a, b) => (typeof b.created === 'number' ? b.created : 0) - (typeof a.created === 'number' ? a.created : 0))
    .map((m) => ({ id: m.id, label: m.id, kind: 'model' as const }));
}

/** Offline fallback: the model ids Conductor has prices for (may lag behind the provider). */
export function builtinModels(vendor: 'anthropic' | 'openai'): ModelOption[] {
  const re = vendor === 'anthropic' ? /^claude-/ : /^(gpt-|o\d|codex)/;
  return Object.keys(PRICE_TABLE)
    .filter((id) => re.test(id))
    .map((id) => ({ id, label: id, kind: 'model' as const }));
}
