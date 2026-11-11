import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Organization } from '../contracts/rows.js';
import type { AdapterRegistry } from '../contracts/adapter.js';
import type { ProviderBinding } from '../contracts/types.js';
import type { WorkerJob } from '../contracts/services.js';

export const DEFAULT_BINDING: ProviderBinding = { adapter: 'claude_local' };

/** Conventional secret refs tried when a binding names no `authRef`. */
const DEFAULT_KEY_REFS: Record<string, (orgSlug: string) => string[]> = {
  claude_api: (o) => [`org/${o}/anthropic-api-key`, 'conductor/anthropic-api-key'],
  openai_api: (o) => [`org/${o}/openai-api-key`, 'conductor/openai-api-key'],
};

/** Adapters that cannot run without an API key. */
const KEY_REQUIRED = new Set(['claude_api', 'openai_api']);

/** Adapters whose CLI discovers skills natively from the workspace. */
export const NATIVE_SKILL_ADAPTERS = new Set(['claude_local', 'codex_local']);

export function effectiveBinding(agent: Agent, org: Organization): ProviderBinding {
  const b = agent.providerBinding ?? org.defaultProvider ?? DEFAULT_BINDING;
  return { ...b, model: agent.model ?? b.model };
}

export type ResolvedChain = WorkerJob['chain'];

/**
 * Turn a binding (primary + fallback chain) into the secret-resolved chain a
 * worker executes. Entries whose adapter is not installed, or that need an API
 * key that is not in the secret store, are dropped (and reported in `skipped`).
 */
export async function resolveChain(
  k: Kernel,
  registry: AdapterRegistry,
  binding: ProviderBinding,
  orgSlug: string,
): Promise<{ chain: ResolvedChain; skipped: string[] }> {
  const entries: Array<Omit<ProviderBinding, 'fallback'>> = [binding, ...(binding.fallback ?? [])];
  const chain: ResolvedChain = [];
  const skipped: string[] = [];

  for (const e of entries) {
    if (!registry.get(e.adapter)) {
      skipped.push(`${e.adapter}: adapter not installed`);
      continue;
    }
    const secrets: Record<string, string> = {};
    const refs = e.authRef ? [e.authRef] : (DEFAULT_KEY_REFS[e.adapter]?.(orgSlug) ?? []);
    for (const ref of refs) {
      const v = await k.secrets.get(ref).catch(() => null);
      if (v) {
        secrets.apiKey = v;
        break;
      }
    }
    if (KEY_REQUIRED.has(e.adapter) && !secrets.apiKey) {
      skipped.push(`${e.adapter}: no API key in secret store (${refs.join(' or ') || 'no authRef'})`);
      continue;
    }
    chain.push({ adapterId: e.adapter, model: e.model ?? null, config: e.config ?? {}, secrets });
  }
  return { chain, skipped };
}
