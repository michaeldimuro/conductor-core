import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { AdapterCapabilities, AdapterManifest, AdapterRescanResult, AgentAdapter, RescannableAdapterRegistry } from '../contracts/adapter.js';
import { resolveInside } from '../shared/paths.js';
import type { Logger } from '../shared/util.js';
import { ClaudeApiAdapter, claudeApiConfigJsonSchema } from './builtin/claude-api.js';
import { ClaudeLocalAdapter, claudeLocalConfigJsonSchema } from './builtin/claude-local.js';
import { CodexLocalAdapter, codexLocalConfigJsonSchema } from './builtin/codex-local.js';
import { HttpAdapter, httpConfigJsonSchema } from './builtin/http.js';
import { OpenAIApiAdapter, openaiApiConfigJsonSchema } from './builtin/openai-api.js';
import { ProcessAdapter, processConfigJsonSchema } from './builtin/process.js';

export const MANIFEST_FILE = 'conductor-adapter.json';

const capabilitiesSchema = z.object({
  tools: z.boolean(),
  mcp: z.boolean(),
  resume: z.boolean(),
  vision: z.boolean(),
  browser: z.enum(['native', 'via_mcp']),
});

/** Validation for `conductor-adapter.json` (the `AdapterManifest` contract). */
export const adapterManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/, 'id must be lower-case letters, digits, "_" or "-"'),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(64),
  entry: z
    .string()
    .min(1)
    .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p) && !p.includes('\0'), 'entry must be a relative path'),
  configSchema: z.record(z.string(), z.unknown()),
  capabilities: capabilitiesSchema,
  secretName: z.string().min(1).max(64).optional(),
});

interface Entry {
  adapter: AgentAdapter;
  name: string;
  capabilities: AdapterCapabilities;
  configSchema: Record<string, unknown>;
  builtin: boolean;
}

function isAdapter(v: unknown): v is AgentAdapter {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === 'string' &&
    typeof a.capabilities === 'function' &&
    typeof a.testConnection === 'function' &&
    typeof a.run === 'function' &&
    typeof a.cancel === 'function'
  );
}

function builtins(): Entry[] {
  const make = (adapter: AgentAdapter, name: string, configSchema: Record<string, unknown>): Entry => ({
    adapter,
    name,
    capabilities: adapter.capabilities(),
    configSchema,
    builtin: true,
  });
  return [
    make(new ClaudeApiAdapter(), 'Claude API', claudeApiConfigJsonSchema),
    make(new OpenAIApiAdapter(), 'OpenAI API', openaiApiConfigJsonSchema),
    make(new ClaudeLocalAdapter(), 'Claude Code (local CLI)', claudeLocalConfigJsonSchema),
    make(new CodexLocalAdapter(), 'Codex (local CLI)', codexLocalConfigJsonSchema),
    make(new ProcessAdapter(), 'Process (any command)', processConfigJsonSchema),
    make(new HttpAdapter(), 'HTTP (any webhook)', httpConfigJsonSchema),
  ];
}

/** Plugin folders: `<pluginDir>/<pkg>/` and, for scoped packages, `<pluginDir>/@scope/<pkg>/`. */
function pluginFolders(pluginDir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(pluginDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(pluginDir, e.name);
    if (e.name.startsWith('.') || e.name === 'node_modules' || !isDir(dir)) continue;
    if (e.name.startsWith('@')) {
      for (const inner of readdirSync(dir).sort()) {
        const nested = join(dir, inner);
        if (!inner.startsWith('.') && isDir(nested)) out.push(nested);
      }
    } else {
      out.push(dir);
    }
  }
  return out;
}

async function loadPlugin(folder: string): Promise<Entry> {
  const raw: unknown = JSON.parse(readFileSync(join(folder, MANIFEST_FILE), 'utf8'));
  const parsed = adapterManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`invalid manifest: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  const manifest: AdapterManifest = parsed.data;

  // The entry must live inside the plugin folder, lexically AND after resolving symlinks.
  const entryPath = resolveInside(folder, manifest.entry);
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) throw new Error(`entry not found: ${manifest.entry}`);
  const realFolder = realpathSync(folder);
  const realEntry = realpathSync(entryPath);
  if (!realEntry.startsWith(realFolder + sep)) throw new Error(`entry escapes the plugin folder: ${manifest.entry}`);

  // Cache-bust on mtime so a rescan picks up an updated plugin.
  const url = `${pathToFileURL(realEntry).href}?v=${Math.floor(statSync(realEntry).mtimeMs)}`;
  const mod = (await import(url)) as { default?: unknown };
  const exported = mod.default;
  const adapter: unknown = typeof exported === 'function' ? await (exported as () => unknown)() : exported;
  if (!isAdapter(adapter)) throw new Error('default export must be an AgentAdapter or a function returning one');
  if (adapter.id !== manifest.id) throw new Error(`adapter id "${adapter.id}" does not match manifest id "${manifest.id}"`);

  return { adapter, name: manifest.name, capabilities: manifest.capabilities, configSchema: manifest.configSchema, builtin: false };
}

/** Root of the running Conductor package (the folder with package.json), from src/ or dist/ alike. */
export function conductorPackageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
}

/**
 * Make `import ... from 'conductor/adapters/sdk'` resolvable from plugin
 * folders: `<pluginDir>/node_modules/conductor` → this package, whose
 * `exports` map serves the SDK. Node walks up from `<pluginDir>/<pkg>/` and
 * finds it, so a plugin needs no install step and no copy of the SDK.
 * Best effort: a plugin that imports nothing from Conductor works without it.
 */
export function linkAdapterSdk(pluginDir: string, packageRoot: string = conductorPackageRoot()): string | null {
  const link = join(pluginDir, 'node_modules', 'conductor');
  try {
    if (!existsSync(join(packageRoot, 'package.json'))) return null;
    let current: string | null = null;
    try {
      current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : '';
    } catch {
      current = null;
    }
    if (current === packageRoot) return link;
    // Only ever replace our own symlink; a real directory there was put by the plugin author.
    if (current === '') return null;
    if (current !== null) rmSync(link, { force: true });
    mkdirSync(join(pluginDir, 'node_modules'), { recursive: true });
    symlinkSync(packageRoot, link, 'dir');
    return link;
  } catch {
    return null;
  }
}

/**
 * The adapter registry: the six built-ins plus whatever plugin packages are
 * present in `pluginDir`. Installing a third-party adapter is dropping a
 * folder with a `conductor-adapter.json` there and calling `rescan()` (the
 * daemon also does that by itself when the directory changes) — no restart,
 * no core change.
 */
export function createAdapterRegistry(opts: { pluginDir: string; log?: Logger; linkSdk?: boolean }): RescannableAdapterRegistry {
  const entries = new Map<string, Entry>();
  for (const e of builtins()) entries.set(e.adapter.id, e);
  let scan: Promise<AdapterRescanResult> = Promise.resolve({ loaded: [], added: [], removed: [], skipped: [] });

  const rescan = async (): Promise<AdapterRescanResult> => {
    const found = new Map<string, Entry>();
    const skipped: AdapterRescanResult['skipped'] = [];
    const folders = pluginFolders(opts.pluginDir).filter((folder) => existsSync(join(folder, MANIFEST_FILE)));
    if (folders.length > 0 && opts.linkSdk !== false) linkAdapterSdk(opts.pluginDir);
    for (const folder of folders) {
      try {
        const entry = await loadPlugin(folder);
        const id = entry.adapter.id;
        if (entries.get(id)?.builtin) throw new Error(`id "${id}" is reserved by a built-in adapter`);
        if (found.has(id)) throw new Error(`duplicate adapter id "${id}"`);
        found.set(id, entry);
        opts.log?.info({ adapter: id, folder }, 'adapter plugin loaded');
      } catch (e) {
        // A bad plugin is skipped, never fatal.
        const error = e instanceof Error ? e.message : String(e);
        skipped.push({ folder, error });
        opts.log?.warn({ folder, err: error }, 'adapter plugin skipped');
      }
    }
    const before = new Set<string>();
    for (const [id, entry] of entries) {
      if (entry.builtin) continue;
      before.add(id);
      entries.delete(id);
    }
    for (const [id, entry] of found) entries.set(id, entry);
    return {
      loaded: [...found.keys()],
      added: [...found.keys()].filter((id) => !before.has(id)),
      removed: [...before].filter((id) => !found.has(id)),
      skipped,
    };
  };
  // Serialize scans so concurrent callers never interleave registry updates.
  const queued = (): Promise<AdapterRescanResult> => {
    scan = scan.then(rescan, rescan);
    return scan;
  };

  return {
    get: (id) => entries.get(id)?.adapter,
    list: () =>
      [...entries.values()].map((e) => ({
        id: e.adapter.id,
        name: e.name,
        capabilities: e.capabilities,
        configSchema: e.configSchema,
        builtin: e.builtin,
      })),
    loadPlugins: async () => {
      await queued();
    },
    rescan: queued,
  };
}
