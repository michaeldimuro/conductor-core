import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveChain } from '../../src/runtime/binding.js';
import { claudeAuthEnv } from '../../src/adapters/builtin/claude-local.js';
import type { AdapterRegistry } from '../../src/contracts/adapter.js';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';

const registry = { get: (id: string) => ({ id }), list: () => [], loadPlugins: async () => {} } as unknown as AdapterRegistry;

describe('binding auth: which credential a local CLI run gets', () => {
  let k: TestKernel;
  beforeEach(() => {
    k = createTestKernel();
  });
  afterEach(() => k.dispose());

  it('login (default): no credential, the CLI uses its own login on this Mac', async () => {
    await k.secrets.set('conductor/anthropic-api-key', 'sk-ant-api-should-not-be-used');
    const { chain } = await resolveChain(k, registry, { adapter: 'claude_local', model: 'opus' }, 'acme');
    expect(chain).toEqual([{ adapterId: 'claude_local', model: 'opus', config: {}, secrets: {} }]);
  });

  it('token: the org-scoped long-lived Claude token wins over the global one', async () => {
    await k.secrets.set('conductor/claude-oauth-token', 'sk-ant-oat01-global');
    await k.secrets.set('org/acme/claude-oauth-token', 'sk-ant-oat01-acme');
    const { chain } = await resolveChain(k, registry, { adapter: 'claude_local', auth: 'token' }, 'acme');
    expect(chain[0]!.secrets).toEqual({ oauthToken: 'sk-ant-oat01-acme' });
    const other = await resolveChain(k, registry, { adapter: 'claude_local', auth: 'token' }, 'beta');
    expect(other.chain[0]!.secrets).toEqual({ oauthToken: 'sk-ant-oat01-global' });
  });

  it('api_key: a stored key, metered (Anthropic for Claude Code, OpenAI for Codex)', async () => {
    await k.secrets.set('conductor/anthropic-api-key', 'sk-ant-api');
    await k.secrets.set('org/acme/openai-api-key', 'sk-openai-acme');
    expect((await resolveChain(k, registry, { adapter: 'claude_local', auth: 'api_key' }, 'acme')).chain[0]!.secrets).toEqual({ apiKey: 'sk-ant-api' });
    expect((await resolveChain(k, registry, { adapter: 'codex_local', auth: 'api_key' }, 'acme')).chain[0]!.secrets).toEqual({ apiKey: 'sk-openai-acme' });
  });

  it('an explicit authRef overrides the conventional refs', async () => {
    await k.secrets.set('team/claude-token', 'sk-ant-oat01-team');
    expect((await resolveChain(k, registry, { adapter: 'claude_local', auth: 'token', authRef: 'team/claude-token' }, 'acme')).chain[0]!.secrets).toEqual({ oauthToken: 'sk-ant-oat01-team' });
  });

  it('a missing credential drops the link (so the fallback runs) and says why', async () => {
    const { chain, skipped } = await resolveChain(k, registry, { adapter: 'claude_local', auth: 'token', fallback: [{ adapter: 'codex_local' }] }, 'acme');
    expect(chain.map((c) => c.adapterId)).toEqual(['codex_local']);
    expect(skipped).toEqual(['claude_local: no long-lived Claude token in secret store (org/acme/claude-oauth-token or conductor/claude-oauth-token)']);
  });

  it('token is Claude-only', async () => {
    const { chain, skipped } = await resolveChain(k, registry, { adapter: 'codex_local', auth: 'token' }, 'acme');
    expect(chain).toEqual([]);
    expect(skipped[0]).toMatch(/only supported by claude_local/);
  });

  it('claude_local passes the token as CLAUDE_CODE_OAUTH_TOKEN, an API key as ANTHROPIC_API_KEY', () => {
    expect(claudeAuthEnv({})).toEqual({});
    expect(claudeAuthEnv({ oauthToken: 'sk-ant-oat01-x' })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' });
    expect(claudeAuthEnv({ apiKey: 'sk-ant-api', oauthToken: 'sk-ant-oat01-x' })).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api' });
  });
});
