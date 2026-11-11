import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServices } from '../../src/daemon/compose.js';
import { MemorySecretStore } from '../../src/kernel/index.js';
import { createApiServer, type ApiServer } from '../../src/api/index.js';
import type { Agent, Issue, Organization, Page, Skill } from '../../src/api/types.js';
import { defaultDeps, runCli, type CliDeps } from '../../src/cli/index.js';

/**
 * The real CLI code (real ConductorClient, real filesystem) against the real
 * API over the daemon's composition root on an ephemeral port.
 */
describe('conductor CLI end to end', () => {
  let home: string;
  let services: Awaited<ReturnType<typeof createServices>>;
  let api: ApiServer;
  let url: string;
  let ownerToken: string;
  const real = defaultDeps();

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'conductor-cli-e2e-'));
    services = await createServices({ home, secrets: new MemorySecretStore(), config: { port: 0 }, runtime: { powerAssertion: false } });
    api = await createApiServer(services, { uiDir: join(home, 'no-ui') });
    await api.listen('127.0.0.1', 0);
    url = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
    // The file the CLI authenticates with: `<home>/owner.token`, written by the token service.
    const file = services.governance.tokens.ownerTokenFile();
    expect(file).toBe(join(home, 'owner.token'));
    ownerToken = readFileSync(file, 'utf8').trim();
  });

  afterAll(async () => {
    await api?.close();
    await services?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const deps: CliDeps = {
      ...real,
      stdout: (t) => void (stdout += t),
      stderr: (t) => void (stderr += t),
      env: {},
      isTTY: false,
      stdinIsTTY: false,
      readStdin: async () => 'sk-e2e-secret-value',
    };
    const code = await runCli(['--home', home, '--url', url, ...argv], deps);
    return { code, stdout, stderr };
  }
  const json = async <T,>(...argv: string[]): Promise<T> => {
    const r = await cli('--json', ...argv);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    return JSON.parse(r.stdout) as T;
  };

  it('drives org → agents → issue → approvals → skills → memory through the real API', async () => {
    const created = await cli('org', 'create', 'Acme Rockets', '--template', 'saas-startup', '--mission', 'Reusable rockets', '--budget', '50');
    expect(created.stderr).toBe('');
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/created Acme Rockets \(acme-rockets\) from saas-startup: \d+ agents/);
    // The first org becomes the default, stored in <home>/cli.json — later commands need no --org.
    expect(JSON.parse(readFileSync(join(home, 'cli.json'), 'utf8'))).toEqual({ defaultOrg: 'acme-rockets' });

    const orgRow = await json<Organization>('org', 'show');
    expect(orgRow).toMatchObject({ slug: 'acme-rockets', mission: 'Reusable rockets', budgetMonthlyUsd: 50 });

    const agents = await json<Agent[]>('agent', 'list');
    expect(agents.length).toBeGreaterThan(3);
    const assignee = agents.find((a) => a.reportsTo !== null) ?? agents[0]!;
    const table = await cli('agent', 'list');
    expect(table.stdout.split('\n')[0]).toMatch(/^SLUG\s+NAME\s+ROLE\s+DEPT/);
    expect(table.stdout).toContain(assignee.slug);
    expect((await cli('agent', 'chart')).stdout).toContain('└─');

    const made = await cli('issue', 'create', 'Design the landing page', '--assign', assignee.slug, '--priority', '1', '--expected-output', 'A mockup', '--type', 'design');
    expect(made.stderr).toBe('');
    expect(made.code).toBe(0);
    expect(made.stdout).toMatch(/created ACME-ROCKETS-1: Design the landing page/);

    const page = await json<Page<Issue>>('issue', 'list', '--assignee', assignee.name);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ number: 1, title: 'Design the landing page', assigneeAgentId: assignee.id, priority: 1, expectedOutput: 'A mockup', taskType: 'design', orgId: orgRow.id });
    const listed = await cli('issue', 'list');
    expect(listed.stdout).toMatch(new RegExp(`ACME-ROCKETS-1\\s+\\w+\\s+P1\\s+${assignee.slug}\\s+Design the landing page`));

    expect((await cli('issue', 'comment', 'ACME-ROCKETS-1', 'Please', 'keep it minimal')).code).toBe(0);
    const shown = await cli('issue', 'show', '#1');
    expect(shown.stdout).toContain('ACME-ROCKETS-1  Design the landing page');
    expect(shown.stdout).toContain('Please keep it minimal');

    expect(await json<unknown[]>('approvals', 'list')).toEqual([]);
    expect((await cli('approvals', 'list')).stdout).toContain('inbox zero');

    const skills = await json<Skill[]>('skills', 'list');
    expect(Array.isArray(skills)).toBe(true);
    expect((await cli('skills', 'list')).code).toBe(0);

    const hits = await json<unknown[]>('memory', 'search', 'landing', 'page', '--agent', assignee.slug);
    expect(Array.isArray(hits)).toBe(true);
    expect((await cli('memory', 'search', 'landing page')).code).toBe(0);
  });

  it('keeps organizations isolated and resolves the org per command', async () => {
    expect((await cli('org', 'create', 'Globex')).code).toBe(0);
    const other = await json<Page<Issue>>('--org', 'globex', 'issue', 'list', '--all');
    expect(other.items).toEqual([]);
    const missing = await cli('--org', 'globex', 'issue', 'show', '1');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/not found/i);
    // The default org is unchanged by creating a second one.
    expect((await json<Page<Issue>>('issue', 'list')).items).toHaveLength(1);
    expect((await cli('org', 'list')).stdout).toMatch(/^\*\s+acme-rockets/m);
  });

  it('writes secrets without echoing them and reads system state', async () => {
    const set = await cli('secret', 'set', 'conductor/anthropic-api-key');
    expect(set.code).toBe(0);
    expect(set.stdout + set.stderr).not.toContain('sk-e2e-secret-value');
    expect(await services.kernel.secrets.get('conductor/anthropic-api-key')).toBe('sk-e2e-secret-value');
    expect((await cli('secret', 'has', 'conductor/anthropic-api-key')).code).toBe(0);
    expect((await cli('secret', 'has', 'conductor/absent')).code).toBe(1);

    const status = await cli('--json', 'status');
    expect(JSON.parse(status.stdout)).toMatchObject({ reachable: true, status: { counts: { orgs: 2 } } });
    expect((await cli('config', 'get')).stdout).toContain('daemon.public_url');
    expect((await cli('adapter', 'list')).stdout).toContain('claude_local');
    expect((await cli('budget')).code).toBe(0);
  });

  it('reports auth and connectivity problems against a real server', async () => {
    const bad = join(home, 'elsewhere');
    const noToken = await runWith(['--home', bad, '--url', url, 'org', 'list']);
    expect(noToken.code).toBe(1);
    expect(noToken.stderr).toContain(`No owner token found at ${join(bad, 'owner.token')}`);

    const forged = mkdtempSync(join(tmpdir(), 'conductor-cli-e2e-forged-'));
    try {
      writeFileSync(join(forged, 'owner.token'), 'cnd_owner_this-token-was-never-issued-000000\n');
      const rejected = await runWith(['--home', forged, '--url', url, 'org', 'list']);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain('rejected the owner token');
      expect(rejected.stderr).not.toContain(ownerToken);
    } finally {
      rmSync(forged, { recursive: true, force: true });
    }

    const down = await runWith(['--home', home, '--url', 'http://127.0.0.1:1', 'org', 'list']);
    expect(down.code).toBe(1);
    expect(down.stderr).toContain('Cannot reach the Conductor daemon at http://127.0.0.1:1');
  });

  async function runWith(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const code = await runCli(argv, { ...real, stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t), env: {}, isTTY: false, stdinIsTTY: false });
    return { code, stdout, stderr };
  }
});
