import { describe, expect, it, vi } from 'vitest';
import type { BrowserProfileDto, BrowserSessionDto, DoctorResponse, Gateway, Playbook, Project } from '../../src/api/types.js';
import { claudeLogin, codexLogin } from '../../src/cli/provider-login.js';
import { agent, dept, goal, harness, org } from './harness.js';

const ENV = { CONDUCTOR_ORG: 'acme' };
const T0 = 1_699_999_000_000;
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });

const profile = (p: Partial<BrowserProfileDto> = {}): BrowserProfileDto => ({
  id: 'bpr_1', orgId: 'org_1', agentId: 'agt_riley', slug: 'riley', name: 'Riley browser', domainAllowlist: [], sensitiveDomains: [], leasedRunId: null, leasedAt: null,
  engine: { kind: 'chromium' }, headed: null, onePasswordVaults: [], createdAt: T0, updatedAt: T0, ...p,
} as BrowserProfileDto);
const session = (p: Partial<BrowserSessionDto> = {}): BrowserSessionDto => ({
  id: 'bse_1', orgId: 'org_1', agentId: 'agt_riley', runId: 'run_1', profileId: 'bpr_1', reason: 'Log in to the bank', status: 'pending', claimedAt: null, endedAt: null,
  expiresAt: 1_700_000_000_000 + 600_000, createdAt: T0, ...p,
} as BrowserSessionDto);

describe('browser profiles and takeovers', () => {
  it('lists profiles with engine and window mode', async () => {
    const h = harness({ env: ENV, client: { listBrowserProfiles: vi.fn(async () => [profile(), profile({ id: 'bpr_2', slug: 'ops', name: 'Ops', agentId: null, engine: { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' }, headed: true })]), listAgents: vi.fn(async () => [agent()]) } });
    const r = await h.run('browser', 'profiles');
    expect(r.stdout).toMatch(/riley\s+Riley browser\s+riley\s+bundled Chromium\s+daemon default/);
    expect(r.stdout).toMatch(/ops\s+Ops\s+shared\s+running Chrome at http:\/\/127\.0\.0\.1:9222\s+headed/);
  });

  it('sets engine, headed mode and 1Password vaults on a profile', async () => {
    const updateBrowserProfile = vi.fn(async (_o: string, _id: string, patch: object) => profile({ ...patch } as Partial<BrowserProfileDto>));
    const h = harness({ env: ENV, client: { listBrowserProfiles: vi.fn(async () => [profile()]), updateBrowserProfile } });
    const r = await h.run('browser', 'profile-set', 'riley', '--engine', 'chrome', '--headed', '--op-vault', 'Work,Shared');
    expect(r.code).toBe(0);
    expect(updateBrowserProfile).toHaveBeenCalledWith('acme', 'bpr_1', { engine: { kind: 'channel', channel: 'chrome' }, headed: true, onePasswordVaults: ['Work', 'Shared'] });
    expect(r.stdout).toMatch(/engine:\s+installed chrome/);

    await h.run('browser', 'profile-set', 'riley', '--cdp-endpoint', 'http://127.0.0.1:9222', '--default-window', '--op-vault', 'none');
    expect(updateBrowserProfile).toHaveBeenLastCalledWith('acme', 'bpr_1', { engine: { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' }, headed: null, onePasswordVaults: [] });

    expect((await h.run('browser', 'profile-set', 'riley')).code).toBe(2);
    expect((await h.run('browser', 'profile-set', 'riley', '--engine', 'cdp')).code).toBe(2);
    expect((await h.run('browser', 'profile-set', 'riley', '--engine', 'firefox')).code).toBe(2);
    expect((await h.run('browser', 'profile-set', 'riley', '--headed', '--headless')).code).toBe(2);
    expect(updateBrowserProfile).toHaveBeenCalledTimes(2);
  });

  it('re-issues a takeover link for the only waiting session', async () => {
    const takeoverLink = vi.fn(async () => ({ sessionId: 'bse_1', url: 'https://mac.example/takeover/tok_new', path: '/takeover/tok_new', expiresAt: 1_700_000_000_000 + 600_000 }));
    const h = harness({ env: ENV, client: { listBrowserSessions: vi.fn(async () => [session(), session({ id: 'bse_0', status: 'handed_back' })]), takeoverLink, listAgents: vi.fn(async () => [agent()]) } });
    const r = await h.run('browser', 'takeover');
    expect(takeoverLink).toHaveBeenCalledWith('acme', 'bse_1');
    expect(r.stdout).toContain('https://mac.example/takeover/tok_new');
    expect(r.stdout).toMatch(/works once, expires in 10m/);

    const list = await h.run('browser', 'takeovers');
    expect(list.stdout).toMatch(/bse_1\s+riley\s+pending\s+Log in to the bank/);
    expect(list.stdout).not.toContain('bse_0');
  });

  it('refuses when nothing is waiting and asks which when several are', async () => {
    const takeoverLink = vi.fn();
    const none = harness({ env: ENV, client: { listBrowserSessions: vi.fn(async () => [session({ status: 'handed_back' })]), takeoverLink } });
    const r = await none.run('browser', 'takeover');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No agent is waiting');
    const many = harness({ env: ENV, client: { listBrowserSessions: vi.fn(async () => [session(), session({ id: 'bse_2', reason: 'Solve the CAPTCHA' })]), takeoverLink } });
    const m = await many.run('browser', 'takeover');
    expect(m.code).toBe(2);
    expect(m.stderr).toContain('bse_2');
    expect(takeoverLink).not.toHaveBeenCalled();
  });
});

describe('gateway pairing', () => {
  const gw = { id: 'gw_1', orgId: null, kind: 'telegram', name: 'My bot', config: {}, authRef: 'conductor/telegram-bot-token', status: 'active', lastError: null, createdAt: T0, updatedAt: T0 } as unknown as Gateway;

  it('mints a pairing code by gateway name and explains what to do with it', async () => {
    const gatewayPairingCode = vi.fn(async () => ({ code: '482913' }));
    const h = harness({ client: { listGateways: vi.fn(async () => [gw]), gatewayPairingCode } });
    const r = await h.run('gateway', 'pair', 'My bot');
    expect(gatewayPairingCode).toHaveBeenCalledWith('gw_1');
    expect(r.stdout).toContain('Pairing code for My bot (telegram): 482913');
    expect(r.stdout).toContain('/pair 482913');
    expect((await h.run('--json', 'gateway', 'pair', 'gw_1')).json()).toEqual({ gatewayId: 'gw_1', kind: 'telegram', code: '482913' });
  });

  it('shows live gateway status', async () => {
    const h = harness({ client: { listGateways: vi.fn(async () => [gw]), gatewayStatus: vi.fn(async () => [{ id: 'gw_1', kind: 'telegram', status: 'error', lastError: '401 Unauthorized' }]) } });
    expect((await h.run('gateway', 'status')).stdout).toMatch(/My bot\s+telegram\s+error\s+401 Unauthorized\s+gw_1/);
  });
});

describe('memory backend', () => {
  it('shows, sets and clears the per-org external backend', async () => {
    const status = { kind: 'mem0' as const, authRef: 'org/acme/mem0-api-key', ready: false };
    const putMemoryBackend = vi.fn(async () => ({ backend: status }));
    const clearMemoryBackend = vi.fn(async () => ({ backend: null }));
    const getMemoryBackend = vi.fn(async () => ({ backend: null as typeof status | null }));
    const h = harness({ env: ENV, client: { getMemoryBackend, putMemoryBackend, clearMemoryBackend } });
    expect((await h.run('memory', 'backend', 'show')).stdout).toContain('local memory only');

    const r = await h.run('memory', 'backend', 'set', 'mem0', '--secret-ref', 'org/acme/mem0-api-key', '--base-url', 'https://mem0.internal', '--option', 'workspace=acme');
    expect(putMemoryBackend).toHaveBeenCalledWith('acme', { kind: 'mem0', authRef: 'org/acme/mem0-api-key', baseUrl: 'https://mem0.internal', options: { workspace: 'acme' } });
    expect(r.stdout).toContain('conductor secret set org/acme/mem0-api-key');

    getMemoryBackend.mockResolvedValue({ backend: status });
    expect((await h.run('memory', 'backend', 'show')).stdout).toMatch(/backend:\s+mem0/);
    expect((await h.run('memory', 'backend', 'set', 'pinecone', '--secret-ref', 'org/acme/k')).code).toBe(2);
    expect((await h.run('memory', 'backend', 'set', 'zep', '--secret-ref', 'org/acme/k', '--option', 'broken')).code).toBe(2);
    await h.run('memory', 'backend', 'clear');
    expect(clearMemoryBackend).toHaveBeenCalledWith('acme');
  });
});

describe('lifecycle commands', () => {
  const project = { id: 'proj_1', orgId: 'org_1', goalId: null, name: 'Website', workspacePath: null, budgetUsd: null, status: 'active', createdAt: T0, updatedAt: T0 } as unknown as Project;
  const playbook = { id: 'pb_1', orgId: 'org_1', name: 'Launch', description: 'Ship it', process: 'sequential', managerAgentId: null, steps: [{ title: 'Draft' }], createdAt: T0, updatedAt: T0 } as unknown as Playbook;

  it('unarchives an org and archives or restores a department', async () => {
    const unarchiveOrg = vi.fn(async () => org());
    const archiveDepartment = vi.fn(async () => dept({ status: 'archived' }));
    const unarchiveDepartment = vi.fn(async () => dept());
    const h = harness({ env: ENV, client: { unarchiveOrg, archiveDepartment, unarchiveDepartment, listDepartments: vi.fn(async () => [dept()]) } });
    expect((await h.run('org', 'unarchive', 'acme')).stdout).toContain('restored acme');
    expect(unarchiveOrg).toHaveBeenCalledWith('acme');
    expect((await h.run('dept', 'archive', 'engineering')).stdout).toContain('archived department Engineering');
    expect(archiveDepartment).toHaveBeenCalledWith('acme', 'dept_eng');
    await h.run('dept', 'unarchive', 'engineering');
    expect(unarchiveDepartment).toHaveBeenCalledWith('acme', 'dept_eng');
  });

  it('deletes a goal', async () => {
    const deleteGoal = vi.fn(async () => ({ ok: true as const }));
    const h = harness({ env: ENV, client: { deleteGoal, listGoals: vi.fn(async () => [goal()]) } });
    expect((await h.run('goal', 'delete', 'goal_1')).stdout).toContain('deleted goal "Reach 100 customers"');
    expect(deleteGoal).toHaveBeenCalledWith('acme', 'goal_1');
  });

  it('updates a project, clearing nullable fields with "none"', async () => {
    const updateProject = vi.fn(async () => ({ ...project, name: 'Site' }));
    const h = harness({ env: ENV, client: { updateProject, listProjects: vi.fn(async () => [project]), listGoals: vi.fn(async () => [goal()]) } });
    await h.run('project', 'update', 'Website', '--name', 'Site', '--goal', 'goal_1', '--budget', '250', '--workspace', 'none', '--status', 'archived');
    expect(updateProject).toHaveBeenCalledWith('acme', 'proj_1', { name: 'Site', goalId: 'goal_1', workspacePath: null, budgetUsd: 250, status: 'archived' });
    await h.run('project', 'update', 'Website', '--budget', 'none');
    expect(updateProject).toHaveBeenLastCalledWith('acme', 'proj_1', { budgetUsd: null });
    expect((await h.run('project', 'update', 'Website')).code).toBe(2);
    expect((await h.run('project', 'list')).stdout).toMatch(/Website\s+active/);
  });

  it('updates a playbook from a steps file and deletes it', async () => {
    const updatePlaybook = vi.fn(async () => ({ ...playbook, name: 'Launch v2' }));
    const deletePlaybook = vi.fn(async () => ({ ok: true as const }));
    const steps = [{ title: 'Draft' }, { title: 'Review' }];
    const h = harness({ env: ENV, files: { '/tmp/steps.json': JSON.stringify(steps), '/tmp/bad.json': '{nope' }, client: { updatePlaybook, deletePlaybook, listPlaybooks: vi.fn(async () => [playbook]), listAgents: vi.fn(async () => [agent()]) } });
    await h.run('playbook', 'update', 'Launch', '--name', 'Launch v2', '--process', 'hierarchical', '--manager', 'riley', '--steps-file', '/tmp/steps.json');
    expect(updatePlaybook).toHaveBeenCalledWith('acme', 'pb_1', { name: 'Launch v2', process: 'hierarchical', managerAgentId: 'agt_riley', steps });
    expect((await h.run('playbook', 'update', 'Launch', '--steps-file', '/tmp/bad.json')).code).toBe(2);
    expect((await h.run('playbook', 'update', 'Launch', '--steps-file', '/tmp/missing.json')).code).toBe(2);
    expect((await h.run('playbook', 'delete', 'Launch')).stdout).toContain('deleted playbook Launch');
    expect(deletePlaybook).toHaveBeenCalledWith('acme', 'pb_1');
    expect((await h.run('playbooks', 'list')).stdout).toMatch(/Launch\s+sequential\s+1/);
  });
});

describe('run now honesty', () => {
  it('says why no run started instead of claiming success', async () => {
    const runNow = vi.fn(async (): Promise<{ jobId: string; skipped: { code: string; reason: string; temporary: boolean } }> => ({ jobId: 'job_1', skipped: { code: 'no_work', reason: 'nothing to do: no open issues or unread messages', temporary: true } }));
    const h = harness({ env: ENV, client: { runAgent: runNow, listAgents: vi.fn(async () => [agent()]) } });
    const r = await h.run('run', 'now', 'riley');
    expect(r.stdout + r.stderr).toContain('nothing to do: no open issues or unread messages');
    expect(r.stdout).not.toContain('queued a run');

    runNow.mockResolvedValue({ jobId: 'job_2', skipped: { code: 'agent_paused', reason: 'agent is paused', temporary: false } });
    const p = await h.run('run', 'now', 'riley');
    expect(p.code).toBe(1);
    expect(p.stdout + p.stderr).toContain('agent is paused');
  });
});

describe('adapter test default key', () => {
  it('passes the chosen org so the daemon resolves the conventional key refs', async () => {
    const testAdapter = vi.fn(async () => ({ ok: true, detail: 'ok' }));
    const h = harness({ env: ENV, client: { testAdapter } });
    await h.run('adapter', 'test', 'claude_api');
    expect(testAdapter).toHaveBeenCalledWith('claude_api', { orgId: 'acme' });
    await h.run('adapter', 'test', 'claude_api', '--auth-ref', 'conductor/my-key');
    expect(testAdapter).toHaveBeenLastCalledWith('claude_api', { authRef: 'conductor/my-key' });
  });
});

describe('doctor: provider login and network exposure', () => {
  const exec = (table: Record<string, (args: string[]) => { code: number; stdout: string; stderr: string } | undefined>) => ({
    exec: async (command: string, args: string[]) => table[command]?.(args) ?? { code: 127, stdout: '', stderr: 'not found' },
  });

  it('reads claude auth status without leaking the account', async () => {
    const inDeps = exec({ claude: (a) => (a[0] === 'auth' ? ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com' })) : undefined) });
    const yes = await claudeLogin(inDeps as never);
    expect(yes.loggedIn).toBe('yes');
    expect(yes.detail).not.toContain('owner@example.com');
    const out = await claudeLogin(exec({ claude: () => ok(JSON.stringify({ loggedIn: false })) }) as never);
    expect(out.loggedIn).toBe('no');
    expect((await claudeLogin(exec({ claude: () => ok('2.1.0 (Claude Code)') }) as never)).loggedIn).toBe('unknown');
  });

  it('reads codex login status', async () => {
    expect((await codexLogin(exec({ codex: () => ok('Logged in using ChatGPT\n') }) as never)).loggedIn).toBe('yes');
    expect((await codexLogin(exec({ codex: () => ({ code: 1, stdout: '', stderr: 'Not logged in\n' }) }) as never)).loggedIn).toBe('no');
  });

  it('warns when a provider CLI is installed but signed out, and fails on a non-loopback bind', async () => {
    const doc: DoctorResponse = {
      version: '0.1.0', home: '/fake/home/.conductor', baseUrl: 'http://0.0.0.0:7420', publicUrl: 'http://0.0.0.0:7420', publicUrlConfigured: false,
      bind: { host: '0.0.0.0', loopback: false }, secretStore: { reachable: true },
      adapters: [{ id: 'claude_local', displayName: 'Claude Code', kind: 'local_cli' }] as unknown as DoctorResponse['adapters'],
      runtime: { running: 0, queued: 0 } as unknown as DoctorResponse['runtime'], killSwitch: { global: false },
    };
    const h = harness({
      client: { health: vi.fn(async () => ({ ok: true, version: '0.1.0', uptimeMs: 60_000 })), doctor: vi.fn(async () => doc), listOrgs: vi.fn(async () => []), getSetting: vi.fn(async () => ({ key: 'daemon.public_url', value: null })) },
      exec: (cmd, args) => {
        if (cmd === 'claude') return args[0] === 'auth' ? ok(JSON.stringify({ loggedIn: false })) : ok('2.1.0 (Claude Code)\n');
        if (cmd === 'git') return ok('git version 2.50.1\n');
        return undefined;
      },
    });
    const r = await h.run('--json', 'doctor');
    const body = r.json() as { checks: Array<{ id: string; status: string; detail: string; fix?: string }> };
    const exposure = body.checks.find((c) => /bind|exposure/.test(c.id));
    expect(exposure).toMatchObject({ status: 'fail' });
    expect(exposure!.detail).toContain('0.0.0.0');
    const claude = body.checks.find((c) => c.detail.includes('2.1.0'));
    expect(claude).toMatchObject({ status: 'warn' });
    expect(JSON.stringify(claude)).toMatch(/not (logged|signed) in/i);
    expect(h.execCalls.filter((c) => c.command === 'claude').every((c) => c.args.includes('--version') || c.args[0] === 'auth')).toBe(true);
  });
});
