import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestKernel, seedOrg, type TestKernel } from '../helpers/kernel.js';
import type { Organization } from '../../src/contracts/rows.js';
import type { ProviderBinding } from '../../src/contracts/types.js';
import { organizations } from '../../src/db/schema/index.js';
import {
  UTILITY_BACKEND_SETTING, UTILITY_LOCAL_SETTING, createUtilityModel, type LocalCliOptions,
} from '../../src/memory/index.js';
import { UTILITY_LOCAL_USAGE_SETTING } from '../../src/memory/utility-model.js';
import { getSetting, setSetting } from '../../src/memory/indexes.js';
import { sandboxAvailable } from '../../src/connectors/files/sandbox.js';
import { mockServer, type MockServer } from './helpers.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-utility-cli.mjs', import.meta.url));

interface Invocation {
  kind: string;
  probe?: boolean;
  argv: string[];
  prompt?: string;
  cwd?: string;
  cwdEntries?: string[];
  envKeys?: string[];
  apiKey?: string | null;
  homeReadable?: boolean | null;
  startedAt?: number;
  endedAt?: number;
}

describe('utility model through a local agent CLI', () => {
  let k: TestKernel;
  let org: Organization;
  let root: string;
  let recordFile: string;
  let seq = 0;

  beforeEach(() => {
    k = createTestKernel();
    org = seedOrg(k);
    root = mkdtempSync(join(tmpdir(), 'conductor-utility-cli-'));
    recordFile = join(root, 'record.jsonl');
  });
  afterEach(() => {
    k.dispose();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** An executable standing in for `claude` / `codex`. The mode is baked in: the CLI gets a minimal env. */
  const fake = (kind: 'claude' | 'codex', mode = 'normal', extra: Record<string, string> = {}): string => {
    const path = join(root, `${kind}-${mode}-${++seq}`);
    const env = { FAKE_KIND: kind, FAKE_MODE: mode, FAKE_RECORD: recordFile, ...extra };
    const exports = Object.entries(env).map(([key, value]) => `export ${key}='${value.replace(/'/g, `'\\''`)}'`).join('\n');
    writeFileSync(path, `#!/bin/sh\n${exports}\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const missing = (): string => join(root, 'not-installed');
  const records = (): Invocation[] =>
    existsSync(recordFile) ? readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Invocation) : [];
  const calls = (): Invocation[] => records().filter((r) => !r.probe);
  const budgets = () => ({ record: vi.fn() });
  const model = (localCli: LocalCliOptions, b = budgets()) => ({ utility: createUtilityModel(k, { budgets: b, localCli: { enabled: true, sandbox: false, ...localCli } }), budgets: b });
  const setOrg = (patch: { utilityModel?: ProviderBinding | null; defaultProvider?: ProviderBinding | null }) => k.db.update(organizations).set(patch).where(eq(organizations.id, org.id)).run();
  const flagValue = (argv: string[], name: string): string | undefined => argv[argv.indexOf(name) + 1];
  const req = { purpose: 'extract' as const, system: 'Extract durable facts.', prompt: 'Ada exported the Stripe balance report.', json: true };

  it('never touches a CLI under the test runner unless a test opts in', async () => {
    const utility = createUtilityModel(k, { localCli: { commands: { claude_local: fake('claude'), codex_local: fake('codex') } } });
    expect((await utility.status!(org.id)).backend).toBe('offline');
    expect((await utility.complete({ orgId: org.id, ...req })).offline).toBe(true);
    expect(records()).toEqual([]);
  });

  it('claude: one prompt in, JSON out — no tools, no MCP, no session, small model, empty cwd, no API key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-must-not-leak');
    const { utility, budgets: b } = model({ commands: { claude_local: fake('claude'), codex_local: missing() } });

    const status = await utility.status!(org.id);
    expect(status).toMatchObject({ backend: 'claude_local', model: 'haiku', subscription: true, localCalls: { today: 0, dailyCap: 200 } });
    expect(status.reason).toMatch(/no API key is stored.*logged in \(max\)/);

    const res = await utility.complete({ orgId: org.id, ...req });
    expect(res.offline).toBe(false);
    expect(res.json).toMatchObject({ summary: 'The export finished.', taskType: 'stripe-balance-export' });
    expect(res).toMatchObject({ tokensIn: 1000, tokensOut: 120, costUsd: 0 });

    const probes = records().filter((r) => r.probe);
    expect(probes).toHaveLength(1); // cached: status + complete share one login check
    expect(probes[0]?.argv).toEqual(['auth', 'status', '--json']);
    const [inv] = calls();
    expect(calls()).toHaveLength(1);
    expect(inv!.argv.slice(0, 9)).toEqual(['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence']);
    expect(flagValue(inv!.argv, '--model')).toBe('haiku');
    expect(flagValue(inv!.argv, '--system-prompt')).toContain('Extract durable facts.');
    expect(flagValue(inv!.argv, '--system-prompt')).toMatch(/no tools/);
    expect(inv!.argv).not.toContain('--mcp-config');
    expect(inv!.argv).not.toContain('--dangerously-skip-permissions');
    expect(inv!.argv).not.toContain(req.prompt); // the prompt travels on stdin, not in argv
    expect(inv!.prompt).toBe(req.prompt);
    expect(inv!.cwdEntries).toEqual([]);
    expect(inv!.cwd).toMatch(/conductor-run-/);
    expect(existsSync(inv!.cwd!)).toBe(false); // removed afterwards
    expect(inv!.apiKey).toBeNull();
    expect(inv!.envKeys).not.toContain('ANTHROPIC_API_KEY');

    // Subscription seat time, not metered spend.
    expect(b.record).toHaveBeenCalledTimes(1);
    expect(b.record.mock.calls[0]![0]).toMatchObject({ orgId: org.id, category: 'reflection', provider: 'claude_local', model: 'claude-haiku-fake', tokensIn: 1000, tokensOut: 120, costUsd: 0, subscription: true });
    expect((b.record.mock.calls[0]![0] as { seatSeconds: number }).seatSeconds).toBeGreaterThan(0);
    expect((await utility.status!(org.id)).localCalls).toEqual({ today: 1, dailyCap: 200 });
  });

  it('codex: exec --json, ephemeral, user config ignored, read-only, shell/apps/plugins off, prompt on stdin', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-must-not-leak');
    const { utility, budgets: b } = model({ commands: { claude_local: missing(), codex_local: fake('codex') } });
    expect(await utility.status!(org.id)).toMatchObject({ backend: 'codex_local', model: null, subscription: true });

    const res = await utility.complete({ orgId: org.id, ...req });
    expect(res.offline).toBe(false);
    expect(res.json).toMatchObject({ taskType: 'stripe-balance-export' });
    expect(res).toMatchObject({ tokensIn: 700, tokensOut: 90, costUsd: 0 });

    expect(records().find((r) => r.probe)?.argv).toEqual(['login', 'status']);
    const [inv] = calls();
    expect(inv!.argv.slice(0, 15)).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '-s', 'read-only', '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'plugins', '-C',
    ]);
    expect(inv!.argv[15]).toMatch(/conductor-run-/);
    expect(inv!.argv.slice(-3)).toEqual(['-c', 'model_reasoning_effort="low"', '-']);
    expect(inv!.argv).not.toContain('-m');
    expect(inv!.argv.join(' ')).not.toMatch(/danger|bypass|full-auto/);
    expect(inv!.prompt).toContain('# Instructions');
    expect(inv!.prompt).toContain('Extract durable facts.');
    expect(inv!.prompt!.endsWith(req.prompt)).toBe(true);
    expect(inv!.cwdEntries).toEqual([]);
    expect(inv!.apiKey).toBeNull();
    expect(b.record.mock.calls[0]![0]).toMatchObject({ provider: 'codex_local', costUsd: 0, subscription: true, tokensIn: 700, tokensOut: 90 });
  });

  describe('selection order', () => {
    let server: MockServer;
    beforeEach(async () => {
      server = await mockServer(() => [200, { content: [{ type: 'text', text: '{"summary":"from the API"}' }], usage: { input_tokens: 10, output_tokens: 5 } }]);
    });
    afterEach(() => server.close());

    it('a stored API key wins over an installed CLI; without the key the CLI is used', async () => {
      const { utility } = model({ commands: { claude_local: fake('claude'), codex_local: missing() } });
      setOrg({ defaultProvider: { adapter: 'claude_api', model: 'claude-big-model', authRef: 'anthropic-key', config: { baseUrl: server.url } } });

      // The binding names a key that is not stored: the CLI answers.
      expect((await utility.status!(org.id)).backend).toBe('claude_local');

      await k.secrets.set('anthropic-key', 'sk-ant-test');
      const status = await utility.status!(org.id);
      expect(status).toMatchObject({ backend: 'claude_api', subscription: false });
      expect(status.model).not.toBe('claude-big-model'); // background learning runs on the cheap default, not the agent's model
      const res = await utility.complete({ orgId: org.id, ...req });
      expect(res.json).toEqual({ summary: 'from the API' });
      expect(server.requests).toHaveLength(1);
      expect(calls()).toHaveLength(0);
    });

    it('an explicit choice wins: the utility.backend setting, and above it the organization binding', async () => {
      await k.secrets.set('anthropic-key', 'sk-ant-test');
      setOrg({ defaultProvider: { adapter: 'claude_api', authRef: 'anthropic-key', config: { baseUrl: server.url } } });
      const { utility } = model({ commands: { claude_local: fake('claude'), codex_local: fake('codex') } });
      expect((await utility.status!(org.id)).backend).toBe('claude_api');

      setSetting(k.db, UTILITY_BACKEND_SETTING, 'codex_local', k.clock.now());
      expect(await utility.status!(org.id)).toMatchObject({ backend: 'codex_local', reason: expect.stringMatching(/explicitly selected/) });

      setSetting(k.db, UTILITY_BACKEND_SETTING, 'offline', k.clock.now());
      expect(await utility.status!(org.id)).toMatchObject({ backend: 'offline', reason: expect.stringMatching(/utility\.backend/) });
      expect((await utility.complete({ orgId: org.id, ...req })).offline).toBe(true);

      // The org's own binding beats the install setting, and carries its model.
      setOrg({ utilityModel: { adapter: 'claude_local', model: 'sonnet' } });
      expect(await utility.status!(org.id)).toMatchObject({ backend: 'claude_local', model: 'sonnet' });
      await utility.complete({ orgId: org.id, ...req });
      expect(flagValue(calls()[0]!.argv, '--model')).toBe('sonnet');
      expect(server.requests).toHaveLength(0);
    });

    it('prefers the CLI the org already runs its agents on; a logged-out or missing CLI falls through, down to offline', async () => {
      const commands = { claude_local: fake('claude'), codex_local: fake('codex') };
      setOrg({ defaultProvider: { adapter: 'codex_local' } });
      expect((await model({ commands }).utility.status!(org.id)).backend).toBe('codex_local');
      setOrg({ defaultProvider: null });
      expect((await model({ commands }).utility.status!(org.id)).backend).toBe('claude_local');

      expect((await model({ commands: { claude_local: fake('claude', 'logged_out'), codex_local: fake('codex') } }).utility.status!(org.id)).backend).toBe('codex_local');

      const none = model({ commands: { claude_local: fake('claude', 'logged_out'), codex_local: missing() } });
      const status = await none.utility.status!(org.id);
      expect(status.backend).toBe('offline');
      expect(status.reason).toMatch(/claude CLI is installed but not logged in/);
      expect(status.reason).toMatch(/not-installed is not installed/);
      expect((await none.utility.complete({ orgId: org.id, ...req })).offline).toBe(true);
      expect(calls()).toHaveLength(0);
      expect(none.budgets.record).not.toHaveBeenCalled();
    });
  });

  it('kills a CLI that does not answer in time and falls back to the heuristics', async () => {
    const { utility, budgets: b } = model({ commands: { claude_local: fake('claude', 'hang'), codex_local: missing() }, timeoutMs: 400 });
    const started = Date.now();
    const res = await utility.complete({ orgId: org.id, ...req });
    expect(res.offline).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(calls()).toHaveLength(1);
    expect(b.record).not.toHaveBeenCalled();
  });

  it('the utility.local timeout setting overrides the default', async () => {
    setSetting(k.db, UTILITY_LOCAL_SETTING, { timeoutMs: 1000, claudeModel: 'claude-small-custom' }, k.clock.now());
    const { utility } = model({ commands: { claude_local: fake('claude', 'hang'), codex_local: missing() } });
    expect((await utility.status!(org.id)).model).toBe('claude-small-custom');
    const started = Date.now();
    expect((await utility.complete({ orgId: org.id, ...req })).offline).toBe(true);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(flagValue(calls()[0]!.argv, '--model')).toBe('claude-small-custom');
  });

  it('kills a CLI that prints more than the output cap', async () => {
    const { utility } = model({ commands: { claude_local: fake('claude', 'flood'), codex_local: missing() }, maxOutputBytes: 100_000, timeoutMs: 20_000 });
    const started = Date.now();
    expect((await utility.complete({ orgId: org.id, ...req })).offline).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('a CLI error or a lost login answers offline; the lost login is re-probed next time', async () => {
    const failing = model({ commands: { claude_local: fake('claude', 'error'), codex_local: missing() } });
    expect((await failing.utility.complete({ orgId: org.id, ...req })).offline).toBe(true);
    expect(failing.budgets.record).not.toHaveBeenCalled();

    const codexFailing = model({ commands: { claude_local: missing(), codex_local: fake('codex', 'error') } });
    expect((await codexFailing.utility.complete({ orgId: org.id, ...req })).offline).toBe(true);

    const lost = model({ commands: { claude_local: fake('claude', 'auth_error'), codex_local: missing() } });
    expect((await lost.utility.complete({ orgId: org.id, ...req })).offline).toBe(true);
    const probesBefore = records().filter((r) => r.probe && r.kind === 'claude').length;
    await lost.utility.status!(org.id);
    expect(records().filter((r) => r.probe && r.kind === 'claude').length).toBe(probesBefore + 1);
  });

  it('runs one CLI call at a time', async () => {
    const { utility } = model({ commands: { claude_local: fake('claude', 'slow'), codex_local: missing() } });
    const results = await Promise.all([1, 2, 3].map((n) => utility.complete({ orgId: org.id, ...req, prompt: `prompt ${n}` })));
    expect(results.every((r) => !r.offline)).toBe(true);
    const done = calls().sort((a, b) => a.startedAt! - b.startedAt!);
    expect(done.map((c) => c.prompt).sort()).toEqual(['prompt 1', 'prompt 2', 'prompt 3']);
    for (let i = 1; i < done.length; i++) expect(done[i]!.startedAt!).toBeGreaterThanOrEqual(done[i - 1]!.endedAt!);
  });

  it('caps local calls per day (setting), then answers offline until the next day; 0 turns the backend off', async () => {
    setSetting(k.db, UTILITY_LOCAL_SETTING, { dailyCalls: 2 }, k.clock.now());
    const { utility, budgets: b } = model({ commands: { claude_local: fake('claude'), codex_local: missing() } });

    const burst = await Promise.all([1, 2, 3].map(() => utility.complete({ orgId: org.id, ...req })));
    expect(burst.filter((r) => r.offline)).toHaveLength(1); // a queued call cannot overshoot the cap
    expect(calls()).toHaveLength(2);
    expect(b.record).toHaveBeenCalledTimes(2);
    expect(getSetting(k.db, UTILITY_LOCAL_USAGE_SETTING)).toMatchObject({ calls: 2 });

    const capped = await utility.status!(org.id);
    expect(capped).toMatchObject({ backend: 'offline', localCalls: { today: 2, dailyCap: 2 } });
    expect(capped.reason).toMatch(/daily call cap \(2\)/);
    expect((await utility.complete({ orgId: org.id, ...req })).offline).toBe(true);
    expect(calls()).toHaveLength(2);

    k.clock.advance(25 * 3_600_000);
    expect(await utility.status!(org.id)).toMatchObject({ backend: 'claude_local', localCalls: { today: 0, dailyCap: 2 } });
    expect((await utility.complete({ orgId: org.id, ...req })).offline).toBe(false);

    setSetting(k.db, UTILITY_LOCAL_SETTING, { dailyCalls: 0 }, k.clock.now());
    expect(await utility.status!(org.id)).toMatchObject({ backend: 'offline', reason: expect.stringMatching(/dailyCalls is 0/) });
  });

  it.runIf(sandboxAvailable())('runs the CLI inside the process sandbox: Conductor\'s home is unreadable', async () => {
    const secret = join(k.paths.home, 'utility-cli-probe.txt');
    writeFileSync(secret, 'vault');
    const { utility } = model({ sandbox: true, commands: { claude_local: fake('claude', 'normal', { FAKE_PROBE_READ: secret }), codex_local: missing() } });
    const res = await utility.complete({ orgId: org.id, ...req });
    expect(res.offline).toBe(false);
    expect(calls()[0]!.homeReadable).toBe(false);

    // Control: the same read succeeds without the sandbox.
    const open = model({ sandbox: false, commands: { claude_local: fake('claude', 'normal', { FAKE_PROBE_READ: secret }), codex_local: missing() } });
    await open.utility.complete({ orgId: org.id, ...req });
    expect(calls()[1]!.homeReadable).toBe(true);
  });
});
