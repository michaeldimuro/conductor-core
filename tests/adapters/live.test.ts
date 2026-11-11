import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../../src/adapters/index.js';
import { collect, createSandbox, makeCtx, REFERENCE_ANSWER, RUN_TOKEN, type Sandbox } from './helpers/context.js';
import { startTestGateway, type TestGateway } from './helpers/mcp-server.js';

/**
 * Opt-in smoke test against the REAL `claude` and `codex` CLIs using the
 * local logins (consumes subscription quota):
 *
 *   CONDUCTOR_LIVE=1 npx vitest run --config config/vitest.config.ts tests/adapters/live.test.ts
 */
const live = process.env.CONDUCTOR_LIVE === '1';

describe.skipIf(!live)('live smoke: local agent CLIs', () => {
  let gateway: TestGateway;
  let sandbox: Sandbox;

  beforeAll(async () => {
    gateway = await startTestGateway(RUN_TOKEN);
  });
  afterAll(() => gateway?.close());
  beforeEach(() => {
    sandbox = createSandbox();
    gateway.calls.length = 0;
  });
  afterEach(() => sandbox.dispose());

  it.each(['claude_local', 'codex_local'])(
    '%s completes the reference task through the gateway MCP tool',
    async (id) => {
      const registry = createAdapterRegistry({ pluginDir: join(sandbox.root, 'adapters') });
      const adapter = registry.get(id);
      if (!adapter) throw new Error(`${id} missing`);
      const health = await adapter.testConnection({ config: {}, secrets: {} });
      expect(health.ok, health.detail).toBe(true);

      const c = collect();
      const ctx = makeCtx(gateway, sandbox, {
        systemPrompt: 'You are a terse assistant. Use the conductor MCP tools when asked.',
        prompt: 'Call the lookup_code tool from the "conductor" MCP server with key "alpha", then reply with exactly the code it returned.',
        maxSteps: 8,
        maxWallMs: 180_000,
      });
      const result = await adapter.run(ctx, c.onEvent);

      expect(result.outcome, JSON.stringify(result.error ?? c.events.slice(-5))).toBe('completed');
      expect(result.finalText).toContain(REFERENCE_ANSWER);
      expect(gateway.calls).toContainEqual({ tool: 'lookup_code', args: { key: 'alpha' } });
      expect(result.sessionId).toBeTruthy();
      expect(result.usage.subscription).toBe(true);
      expect(result.usage.costUsd).toBe(0);
      expect(result.usage.tokensOut).toBeGreaterThan(0);
      expect(c.ofType('tool_call').length).toBeGreaterThan(0);
      expect(c.json()).not.toContain(RUN_TOKEN);
    },
    200_000,
  );
});
