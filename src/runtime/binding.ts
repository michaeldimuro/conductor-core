import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Organization } from '../contracts/rows.js';
import type { AdapterRegistry } from '../contracts/adapter.js';
import type { ProviderBinding } from '../contracts/types.js';
import type { WorkerJob } from '../contracts/services.js';
import { defaultCredentialRefs } from '../contracts/providers.js';

export const DEFAULT_BINDING: ProviderBinding = { adapter: 'claude_local' };

/** Conventional secret refs tried when a binding names no `authRef`. */
const DEFAULT_KEY_REFS: Record<string, (orgSlug: string) => string[]> = {
  claude_api: (o) => [`org/${o}/anthropic-api-key`, 'conductor/anthropic-api-key'],
  openai_api: (o) => [`org/${o}/openai-api-key`, 'conductor/openai-api-key'],
};

/** Adapters that cannot run without an API key. */
const KEY_REQUIRED = new Set(['claude_api', 'openai_api']);

/** Local CLI adapters whose binding may pick `auth: login | token | api_key`. */
const LOCAL_CLI_ADAPTERS = new Set(['claude_local', 'codex_local']);

/** Which secret a binding needs, under which name the adapter reads it, and whether it is mandatory. */
function credentialPlan(e: Omit<ProviderBinding, 'fallback'>, orgSlug: string): { refs: string[]; secretName: 'apiKey' | 'oauthToken'; required: boolean; error?: string } {
  if (LOCAL_CLI_ADAPTERS.has(e.adapter) && e.auth && e.auth !== 'login') {
    if (e.auth === 'token' && e.adapter !== 'claude_local') return { refs: [], secretName: 'oauthToken', required: true, error: `auth "token" is only supported by claude_local` };
    const refs = e.authRef ? [e.authRef] : defaultCredentialRefs(e.adapter, e.auth, orgSlug);
    return { refs, secretName: e.auth === 'token' ? 'oauthToken' : 'apiKey', required: true };
  }
  // `login` (or no auth): an explicit authRef still means "meter this local CLI on that key" (older bindings).
  const refs = e.authRef ? [e.authRef] : (DEFAULT_KEY_REFS[e.adapter]?.(orgSlug) ?? []);
  return { refs, secretName: 'apiKey', required: KEY_REQUIRED.has(e.adapter) };
}

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
    const plan = credentialPlan(e, orgSlug);
    if (plan.error) {
      skipped.push(`${e.adapter}: ${plan.error}`);
      continue;
    }
    const secrets: Record<string, string> = {};
    for (const ref of plan.refs) {
      const v = await k.secrets.get(ref).catch(() => null);
      if (v) {
        secrets[plan.secretName] = v;
        break;
      }
    }
    if (plan.required && !secrets[plan.secretName]) {
      const what = plan.secretName === 'oauthToken' ? 'long-lived Claude token' : 'API key';
      skipped.push(`${e.adapter}: no ${what} in secret store (${plan.refs.join(' or ') || 'no authRef'})`);
      continue;
    }
    chain.push({ adapterId: e.adapter, model: e.model ?? null, config: e.config ?? {}, secrets });
  }
  return { chain, skipped };
}
