import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessSupervisor } from '../../src/runtime/supervisor.js';
import type { WorkerJob } from '../../src/contracts/services.js';
import type { RunEvent } from '../../src/contracts/adapter.js';
import { createLogger } from '../../src/shared/util.js';

/** Real forked worker processes: the crash-containment boundary of the daemon. */
describe('ProcessSupervisor', () => {
  let root: string;
  let pluginDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-sup-'));
    pluginDir = join(root, 'adapters');
    mkdirSync(pluginDir);
    mkdirSync(join(root, 'ws'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const job = (adapterId: string, config: Record<string, unknown>, over: Partial<WorkerJob['ctx']> = {}): WorkerJob => {
    const ctx: WorkerJob['ctx'] = {
      runId: `run_${adapterId}`, orgId: 'org_1', agentId: 'agt_1', issueId: null, systemPrompt: 'sys', prompt: 'say hello',
      model: null, config, secrets: {}, skills: [], mcpEndpoints: [], workspacePath: join(root, 'ws'), budgetCapUsd: null,
      maxSteps: 10, maxWallMs: 20_000, runToken: 'cnd_run_test', apiBaseUrl: 'http://127.0.0.1:1', ...over,
    };
    return { adapterId, ctx, chain: [{ adapterId, model: null, config, secrets: {} }] };
  };

  const plugin = (id: string, body: string) => {
    const dir = join(pluginDir, id);
    mkdirSync(dir);
    writeFileSync(join(dir, 'conductor-adapter.json'), JSON.stringify({
      id, name: id, version: '1.0.0', entry: 'index.mjs', configSchema: { type: 'object' },
      capabilities: { tools: false, mcp: false, resume: false, vision: false, browser: 'via_mcp' },
    }));
    writeFileSync(join(dir, 'index.mjs'), `export default () => ({ id: ${JSON.stringify(id)},
      capabilities: () => ({ tools: false, mcp: false, resume: false, vision: false, browser: 'via_mcp' }),
      testConnection: async () => ({ ok: true }), cancel: async () => {},
      async run(ctx, onEvent) { ${body} } });`);
  };

  const sup = () => new ProcessSupervisor({ pluginDir, log: createLogger('test', 'silent') });

  it('runs an adapter in a child process and streams events and the result back', async () => {
    const events: RunEvent[] = [];
    const handle = sup().start(job('process', { command: '/bin/sh', args: ['-c', 'cat > /dev/null; echo hello from the child'] }), (e) => events.push(e));
    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.pid).not.toBe(process.pid);
    const result = await handle.done;
    expect(result).toMatchObject({ outcome: 'completed', adapterId: 'process' });
    expect(result.finalText).toContain('hello from the child');
  }, 30_000);

  it('contains a crashing agent: the worker dies, the daemon gets a failed result', async () => {
    plugin('crasher', 'process.exit(7);');
    const result = await sup().start(job('crasher', {}), () => {}).done;
    expect(result.outcome).toBe('failed');
    expect(result.error?.message).toMatch(/worker crashed \(code 7/);
  }, 30_000);

  it('loads third-party plugin adapters inside the worker', async () => {
    plugin('echo', `onEvent({ type: 'text', text: ctx.prompt });
      return { outcome: 'completed', finalText: 'echo: ' + ctx.prompt, steps: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0, subscription: false, seatSeconds: 0 } };`);
    const events: RunEvent[] = [];
    const result = await sup().start(job('echo', {}), (e) => events.push(e)).done;
    expect(result.finalText).toBe('echo: say hello');
    expect(events).toContainEqual({ type: 'text', text: 'say hello' });
  }, 30_000);

  it('cancels a running worker', async () => {
    const handle = sup().start(job('process', { command: '/bin/sleep', args: ['60'] }), () => {});
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    await handle.cancel('test');
    const result = await handle.done;
    expect(result.outcome).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it('never passes secrets through argv or the environment', async () => {
    plugin('leakcheck', `const leaked = JSON.stringify(process.argv).includes('s3cr3t-value') || JSON.stringify(process.env).includes('s3cr3t-value');
      return { outcome: 'completed', finalText: leaked ? 'LEAKED' : 'clean:' + ctx.secrets.apiKey.length, steps: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 } };`);
    const j = job('leakcheck', {});
    j.ctx.secrets = { apiKey: 's3cr3t-value' };
    j.chain[0]!.secrets = { apiKey: 's3cr3t-value' };
    const result = await sup().start(j, () => {}).done;
    expect(result.finalText).toBe('clean:12');
  }, 30_000);
});
