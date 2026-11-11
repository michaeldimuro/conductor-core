import { describe, expect, it, vi } from 'vitest';
import type { DoctorResponse } from '../../src/api/types.js';
import type { ExecResult } from '../../src/cli/index.js';
import { HOME, LOGS, agent, goal, harness, issue, org } from './harness.js';

const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const health = () => vi.fn(async () => ({ status: 'ok' as const, version: '0.1.0', uptimeMs: 65_000 }));
const BUILD = '/fake/project/dist/daemon/main.js';
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

describe('install', () => {
  it('writes the LaunchAgent without loading it (--no-load)', async () => {
    const h = harness({ files: { [BUILD]: '' }, client: { health: health() } });
    const r = await h.run('install', '--no-load');
    expect(r.code).toBe(0);
    expect(h.launchd.install).toHaveBeenCalledWith({ home: HOME, entry: BUILD, nodePath: '/fake/bin/node', logDir: LOGS, port: undefined, load: false });
    expect(r.stdout).toContain('LaunchAgent written to /fake/home/Library/LaunchAgents/ai.conductor.daemon.plist');
    expect(r.stdout).toContain('Not loaded (--no-load)');
    expect(r.stdout).toContain('launchctl bootstrap gui/$(id -u)');
    expect(h.client.health).not.toHaveBeenCalled();
    expect(h.dirs.has(HOME)).toBe(true);
  });

  it('loads the agent, waits for /healthz and prints the UI URL and next steps', async () => {
    const healthFn = vi.fn().mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused()).mockResolvedValue({ status: 'ok', version: '0.1.0', uptimeMs: 100 });
    const h = harness({ files: { [BUILD]: '' }, client: { health: healthFn } });
    const r = await h.run('install', '--port', '7500');
    expect(r.code).toBe(0);
    expect(h.launchd.install).toHaveBeenCalledWith(expect.objectContaining({ port: 7500, load: true }));
    expect(healthFn).toHaveBeenCalledTimes(3);
    expect(h.clientOptions.at(-1)).toEqual({ baseUrl: 'http://127.0.0.1:7500', token: null });
    expect(r.stdout).toContain('daemon 0.1.0 is up after 1s — UI: http://127.0.0.1:7500');
    expect(r.stdout).toContain('conductor quickstart');
    // The non-default port is remembered for later commands.
    expect(JSON.parse(h.files.get(`${HOME}/cli.json`)!)).toEqual({ url: 'http://127.0.0.1:7500' });
  });

  it('fails with log pointers when the daemon is not up within 30 s (FR-1)', async () => {
    const h = harness({ files: { [BUILD]: '' }, client: { health: vi.fn(async () => { throw refused(); }) } });
    const r = await h.run('install');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('did not answer at http://127.0.0.1:7420 within 30 s');
    expect(r.stderr).toContain(`${LOGS}/conductord.err.log`);
    expect((h.client.health as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(50);
  });

  it('falls back to the tsx dev entry with a warning, or tells the user to build', async () => {
    const dev = harness({ files: { '/fake/project/bin/conductord.mjs': '', '/fake/project/src/daemon/main.ts': '' } });
    const r = await dev.run('--json', 'install', '--no-load');
    expect(dev.launchd.install).toHaveBeenCalledWith(expect.objectContaining({ entry: '/fake/project/bin/conductord.mjs' }));
    expect(r.json()).toMatchObject({ devEntry: true, loaded: false, ready: false, url: 'http://127.0.0.1:7420' });
    expect((await dev.run('install', '--no-load')).stderr).toContain('npm run build');

    const none = harness();
    const n = await none.run('install');
    expect(n.code).toBe(1);
    expect(n.stderr).toContain(`No daemon build found at ${BUILD}`);
    expect(n.stderr).toContain('npm run build');
    expect(none.launchd.install).not.toHaveBeenCalled();
  });

  it('--headless prints the LaunchDaemon plist and sudo steps without installing anything', async () => {
    const h = harness({ files: { [BUILD]: '' } });
    const r = await h.run('install', '--headless');
    expect(r.code).toBe(0);
    expect(h.launchd.install).not.toHaveBeenCalled();
    expect(h.launchd.headless).toHaveBeenCalledWith({ program: '/usr/local/bin/conductord', home: HOME, logDir: LOGS, userName: 'tester', vaultKeyFile: `${HOME}/vault.key` });
    expect(r.stdout).toContain('<plist>');
    expect(r.stderr).toContain('sudo launchctl bootstrap system /Library/LaunchDaemons/ai.conductor.daemon.headless.plist');
    expect(r.stderr).toContain('sudo tee /usr/local/bin/conductord');
    expect(r.stderr).toContain(`${HOME}/vault.key`);

    const out = await h.run('install', '--headless', '--out', '/tmp/headless.plist');
    expect(h.files.get('/tmp/headless.plist')).toContain('<plist>');
    expect(out.stderr).toContain('sudo install -m 644 -o root -g wheel \'/tmp/headless.plist\'');
    const j = (await h.run('--json', 'install', '--headless')).json() as { plist: string; steps: string[] };
    expect(j.plist).toContain('<plist>');
    expect(j.steps.length).toBeGreaterThan(3);
  });
});

describe('uninstall, restart, status', () => {
  it('uninstalls and keeps the data', async () => {
    const h = harness();
    const r = await h.run('uninstall');
    expect(h.launchd.uninstall).toHaveBeenCalled();
    expect(r.stdout).toContain(`Your data is still in ${HOME}`);
  });

  it('restarts through launchd and waits for health', async () => {
    const h = harness({ client: { health: health() } });
    const r = await h.run('restart');
    expect(h.launchd.restart).toHaveBeenCalled();
    expect(r.stdout).toContain('daemon 0.1.0 is back');

    const broken = harness();
    broken.launchd.restart.mockRejectedValueOnce(new Error('Could not find service "ai.conductor.daemon" in domain for uid: 501'));
    const b = await broken.run('restart');
    expect(b.code).toBe(1);
    expect(b.stderr).toContain('launchd could not restart the daemon');
    expect(b.stderr).toContain('conductor install');
  });

  it('reports launchd state plus the daemon summary', async () => {
    const status = vi.fn(async () => ({
      version: '0.1.0', publicUrl: 'https://mac.ts.net', runtime: { running: 2, queued: 1, perOrg: {}, perProvider: {}, uptimeMs: 65_000 },
      killSwitch: { global: false, orgs: ['org_1'] }, counts: { orgs: 2, agents: 9, pendingApprovals: 3 },
    }));
    const h = harness({ client: { health: health(), status } });
    const r = await h.run('status');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/launchd:\s+running \(pid 4242\)/);
    expect(r.stdout).toMatch(/daemon:\s+up 1m, v0\.1\.0/);
    expect(r.stdout).toMatch(/runs:\s+2 running, 1 queued/);
    expect(r.stdout).toMatch(/approvals:\s+3 pending/);
    expect(r.stdout).toMatch(/kill switch:\s+engaged for 1 org\(s\)/);
    expect((await h.run('--json', 'status')).json()).toMatchObject({ reachable: true, launchd: { pid: 4242 }, status: { counts: { agents: 9 } } });
  });

  it('exits 1 with a hint when the daemon is down', async () => {
    const h = harness({ client: { health: vi.fn(async () => { throw refused(); }) }, launchdStatus: { installed: false, loaded: false, pid: null } });
    const r = await h.run('status');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/launchd:\s+not installed/);
    expect(r.stdout).toMatch(/daemon:\s+unreachable at http:\/\/127\.0\.0\.1:7420/);
    expect(r.stderr).toContain('conductor install');
  });
});

describe('open and pair', () => {
  const login = { code: 'c0de', url: 'http://127.0.0.1:7420/auth/local?code=c0de', remoteUrl: 'https://mac.ts.net/auth/local?code=c0de', expiresAt: 1_700_000_120_000 };

  it('mints a login code and opens the browser', async () => {
    const createLoginCode = vi.fn(async () => login);
    const h = harness({ client: { createLoginCode }, exec: (cmd) => (cmd === 'open' ? ok('') : undefined) });
    const r = await h.run('open');
    expect(createLoginCode).toHaveBeenCalledWith({ label: 'browser' });
    expect(h.execCalls).toEqual([{ command: 'open', args: [login.url] }]);
    expect(r.stdout).toContain('opened http://127.0.0.1:7420');
    expect(r.stdout).not.toContain('c0de');

    const p = await h.run('open', '--print');
    expect(p.stdout.trim()).toBe(login.url);

    const noBrowser = harness({ client: { createLoginCode } });
    const n = await noBrowser.run('open');
    expect(n.code).toBe(1);
    expect(n.stderr).toContain('conductor open --print');
  });

  it('prints a remote pairing URL and code', async () => {
    const createLoginCode = vi.fn(async () => login);
    const h = harness({ client: { createLoginCode } });
    const r = await h.run('pair', '--label', 'iPhone', '--days', '7');
    expect(createLoginCode).toHaveBeenCalledWith({ label: 'iPhone', ttlMs: 7 * 86_400_000 });
    expect(r.stdout).toContain('https://mac.ts.net/auth/local?code=c0de');
    expect(r.stdout).toMatch(/code:\s+c0de/);
    expect(r.stderr).toBe('');

    const local = harness({ client: { createLoginCode: vi.fn(async () => ({ ...login, remoteUrl: login.url })) } });
    const l = await local.run('pair');
    expect(l.stderr).toContain('no public URL is configured');
    expect((await local.run('--json', 'pair')).json()).toMatchObject({ code: 'c0de', remoteReachable: false });
  });
});

describe('doctor', () => {
  const doc = (p: Partial<DoctorResponse> = {}): DoctorResponse => ({
    version: '0.1.0', home: HOME, baseUrl: 'http://127.0.0.1:7420', publicUrl: 'http://127.0.0.1:7420', publicUrlConfigured: false, secretStore: { reachable: true },
    adapters: [], runtime: { running: 0, queued: 0, perOrg: {}, perProvider: {}, uptimeMs: 1 }, killSwitch: { global: false }, ...p,
  });
  const tailscaleJson = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.64.0.7'] } });
  const layout = [HOME, `${HOME}/adapters`, `${HOME}/skills/global`, `${HOME}/orgs`, `${HOME}/backups`, `${HOME}/run`, LOGS];

  it('renders a mixed pass/fail checklist with fix hints and exits 1', async () => {
    const h = harness({
      launchdStatus: { installed: true, loaded: true, pid: null, lastExitCode: 78 },
      chromium: null,
      dirs: layout.slice(0, 3),
      client: {
        health: health(),
        doctor: vi.fn(async () => doc({ secretStore: { reachable: false, detail: 'User interaction is not allowed.' } })),
        secretExists: vi.fn(async (ref: string) => ({ ref, exists: ref === 'conductor/anthropic-api-key' })),
        testAdapter: vi.fn(async () => ({ ok: false, detail: 'auth: invalid x-api-key' })),
        getSetting: vi.fn(async (key: string) => ({ key, value: null })),
      },
      exec: (cmd, args) => {
        if (cmd === 'claude') return ok('2.1.0 (Claude Code)\n');
        if (cmd === 'git') return ok('git version 2.50.1\n');
        if (cmd === 'tailscale' && args[0] === 'status') return ok(tailscaleJson);
        if (cmd === 'tailscale') return ok('{}');
        return undefined;
      },
    });
    const r = await h.run('doctor');
    expect(r.code).toBe(1);
    const line = (label: string) => r.stdout.split('\n').find((l) => l.includes(label)) ?? '';
    expect(line('Node.js')).toMatch(/^✓ Node\.js\s+v22\.11\.0/);
    expect(line('launchd agent')).toMatch(/^✓/);
    expect(line('launchd state')).toMatch(/^✗ launchd state\s+loaded but not running \(last exit code 78\)/);
    expect(line('daemon ')).toMatch(/^✓ daemon\s+v0\.1\.0 at http:\/\/127\.0\.0\.1:7420, up 1m/);
    expect(line('owner token')).toMatch(/^✓/);
    expect(line('secret store')).not.toMatch(/^✓/);
    expect(line('secret store')).toMatch(/^✗ secret store\s+User interaction is not allowed\./);
    expect(r.stdout).toContain('security unlock-keychain');
    expect(line('claude CLI')).toMatch(/^✓ claude CLI\s+2\.1\.0 \(Claude Code\) \(claude_local/);
    expect(line('codex CLI')).toMatch(/^! codex CLI\s+not installed/);
    expect(line('Anthropic API key')).toMatch(/^✗ Anthropic API key\s+conductor\/anthropic-api-key: auth: invalid x-api-key/);
    expect(line('OpenAI API key')).toMatch(/^! OpenAI API key\s+none stored/);
    expect(line('Playwright Chromium')).toMatch(/^! Playwright Chromium\s+not installed/);
    expect(r.stdout).toContain('npx playwright install chromium');
    expect(line('git ')).toMatch(/^✓ git\s+git version 2\.50\.1/);
    expect(line('Tailscale ')).toMatch(/^✓ Tailscale\s+mac\.tail1234\.ts\.net \(100\.64\.0\.7\)/);
    expect(line('Tailscale serve')).toMatch(/^! Tailscale serve/);
    expect(r.stdout).toContain('tailscale serve --bg 7420');
    expect(line('Cloudflare Tunnel')).toMatch(/^- Cloudflare Tunnel\s+cloudflared not installed/);
    expect(line('public URL')).toMatch(/^! public URL\s+daemon\.public_url is not set/);
    expect(line('disk layout')).toMatch(/^✗ disk layout\s+missing or not writable: .*\/orgs/);
    expect(r.stdout).toContain('→ conductor doctor --fix');
    expect(r.stdout).toMatch(/4 problems, 5 warnings/);
    // Read-only without --fix.
    expect(h.client.putSetting).not.toHaveBeenCalled();
    expect(h.dirs.has(`${HOME}/orgs`)).toBe(false);
  });

  it('--fix creates directories and sets the public URL from Tailscale', async () => {
    const putSetting = vi.fn(async (key: string, value: unknown) => ({ key, value }));
    const h = harness({
      dirs: [HOME],
      client: {
        health: health(), doctor: vi.fn(async () => doc()), putSetting,
        secretExists: vi.fn(async (ref: string) => ({ ref, exists: false })),
        getSetting: vi.fn(async (key: string) => ({ key, value: null })),
      },
      exec: (cmd, args) => {
        if (cmd === 'claude' || cmd === 'codex') return ok('1.0.0\n');
        if (cmd === 'git') return ok('git version 2.50.1\n');
        if (cmd === 'tailscale' && args[0] === 'status') return ok(tailscaleJson);
        if (cmd === 'tailscale') return ok(JSON.stringify({ Web: { 'mac.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7420' } } } } }));
        return undefined;
      },
    });
    const r = await h.run('doctor', '--fix');
    expect(r.code).toBe(0);
    expect(putSetting).toHaveBeenCalledWith('daemon.public_url', 'https://mac.tail1234.ts.net');
    for (const d of layout) expect(h.dirs.has(d)).toBe(true);
    expect(r.stdout).toMatch(/✓ public URL\s+set daemon\.public_url = https:\/\/mac\.tail1234\.ts\.net\s+\(fixed\)/);
    expect(r.stdout).toContain('apply it: conductor restart');
    expect(r.stdout).toMatch(/✓ Tailscale serve\s+https:\/\/mac\.tail1234\.ts\.net → 127\.0\.0\.1:7420/);
    expect(r.stdout).toMatch(/✓ disk layout\s+created .*\(fixed\)/);
    expect(r.stdout).toMatch(/ready, with \d+ warnings?/);
  });

  it('does not overwrite a configured public URL and tests org bindings', async () => {
    const putSetting = vi.fn();
    const h = harness({
      dirs: layout, env: { CONDUCTOR_ORG: 'acme' },
      client: {
        health: health(), putSetting,
        doctor: vi.fn(async (q?: { orgId?: string }) => doc({
          publicUrl: 'https://conductor.example.com', publicUrlConfigured: true,
          ...(q?.orgId ? { bindings: [{ source: 'org-default', adapter: 'claude_local', model: null, health: { ok: true, detail: 'CLI present' } }, { source: 'agent:sam', adapter: 'openai_api', model: 'gpt-5', health: { ok: false, detail: 'auth: bad key' } }] } : {}),
        })),
        secretExists: vi.fn(async (ref: string) => ({ ref, exists: false })),
        getSetting: vi.fn(async (key: string) => ({ key, value: 'https://conductor.example.com' })),
      },
      exec: (cmd) => (cmd === 'claude' ? ok('2.1.0\n') : cmd === 'git' ? ok('git version 2\n') : cmd === 'cloudflared' ? ok('cloudflared version 2026.1.2\n') : undefined),
    });
    const r = await h.run('--json', 'doctor', '--fix');
    const body = r.json() as { ok: boolean; failed: number; checks: Array<{ id: string; status: string; detail: string }> };
    const by = (id: string) => body.checks.find((c) => c.id === id)!;
    expect(putSetting).not.toHaveBeenCalled();
    expect(by('tunnel.public_url')).toMatchObject({ status: 'ok', detail: 'https://conductor.example.com' });
    expect(by('tunnel.tailscale').status).toBe('skip');
    expect(by('tunnel.cloudflared').status).toBe('ok');
    expect(by('binding.org-default').status).toBe('ok');
    expect(by('binding.agent:sam')).toMatchObject({ status: 'fail', detail: 'openai_api:gpt-5 — auth: bad key' });
    expect(h.client.secretExists).toHaveBeenCalledWith('org/acme/anthropic-api-key');
    expect(body.ok).toBe(false);
    expect(r.code).toBe(1);
  });

  it('still reports local checks when the daemon is down, and flags an old Node', async () => {
    const h = harness({
      nodeVersion: '20.9.0', dirs: layout, launchdStatus: { installed: false, loaded: false, pid: null }, token: null,
      client: { health: vi.fn(async () => { throw refused(); }) },
      exec: (cmd) => (cmd === 'git' ? ok('git version 2\n') : undefined),
    });
    const r = await h.run('doctor');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/✗ Node\.js\s+v20\.9\.0 is too old/);
    expect(r.stdout).toMatch(/✗ daemon\s+not reachable at http:\/\/127\.0\.0\.1:7420/);
    expect(r.stdout).toMatch(/- secret store\s+not checked \(daemon unreachable\)/);
    expect(r.stdout).toMatch(/✗ usable provider\s+no provider is ready/);
    expect(r.stdout).toMatch(/! Tailscale\s+not installed/);
    expect(r.stdout).toMatch(/✓ disk layout/);
  });
});

describe('quickstart', () => {
  const templates = [{ id: 'solo-operator', name: 'Solo', description: 'One generalist', departments: [] }, { id: 'saas-startup', name: 'SaaS startup', description: 'A lean software company', departments: [] }];
  const ceo = agent({ id: 'agt_ceo', slug: 'morgan', name: 'Morgan', role: 'Chief Executive Officer' });
  const mocks = () => ({
    health: health(),
    listOrgTemplates: vi.fn(async () => templates),
    createOrgFromTemplate: vi.fn(async () => org()),
    listAgents: vi.fn(async () => [agent(), ceo]),
    orgChart: vi.fn(async () => [{ agent: ceo, department: {}, isLead: true, reports: [] }]),
    createGoal: vi.fn(async (_o: string, input: { title: string }) => goal({ title: input.title })),
    createIssue: vi.fn(async (_o: string, input: { title: string }) => issue({ number: 1, title: input.title })),
    runAgent: vi.fn(async () => ({ jobId: 'job_1' })),
    secretExists: vi.fn(async (ref: string) => ({ ref, exists: false })),
  });

  it('goes from nothing to a running first issue with flags only', async () => {
    const m = mocks();
    const h = harness({ client: m, exec: (cmd) => (cmd === 'claude' ? ok('2.1.0 (Claude Code)\n') : undefined) });
    const r = await h.run('quickstart', '--name', 'Acme', '--goal', 'Reach 100 customers', '--issue', 'Draft the launch plan');
    expect(r.code).toBe(0);
    expect(m.createOrgFromTemplate).toHaveBeenCalledWith({ templateId: 'saas-startup', name: 'Acme', defaultProvider: { adapter: 'claude_local' } });
    expect(m.createGoal).toHaveBeenCalledWith('org_1', { title: 'Reach 100 customers', level: 'org' });
    expect(m.createIssue).toHaveBeenCalledWith('org_1', expect.objectContaining({ title: 'Draft the launch plan', goalId: 'goal_1', assigneeAgentId: 'agt_ceo', status: 'todo' }));
    expect(m.runAgent).toHaveBeenCalledWith('org_1', 'agt_ceo', { issueId: 'iss_1' });
    expect(JSON.parse(h.files.get(`${HOME}/cli.json`)!)).toEqual({ defaultOrg: 'acme' });
    expect(h.prompts).toEqual([]);
    expect(r.stdout).toContain('provider claude_local: found the claude CLI');
    expect(r.stdout).toContain('issue ACME-1 assigned to Morgan');
    expect(r.stdout).toContain('conductor logs -f --agent morgan');
    expect(r.stdout).toContain('conductor issue show 1');
  });

  it('prompts on a terminal and honours the answers', async () => {
    const m = mocks();
    const h = harness({ client: m, stdinIsTTY: true, answers: ['1', 'Solo Co', 'Help me ship', '', ''], exec: (cmd) => (cmd === 'codex' ? ok('codex-cli 0.1\n') : undefined) });
    const r = await h.run('quickstart', '--no-run');
    expect(r.code).toBe(0);
    expect(h.prompts.map((p) => p.question)).toEqual([
      'Template (number or id) [saas-startup]: ', 'Organization name: ', 'Mission (one sentence, optional): ', 'First goal for this org [Help me ship]: ',
      expect.stringMatching(/^First issue for Morgan \(Chief Executive Officer\) \[Write a short plan/),
    ]);
    expect(m.createOrgFromTemplate).toHaveBeenCalledWith({ templateId: 'solo-operator', name: 'Solo Co', mission: 'Help me ship', defaultProvider: { adapter: 'codex_local' } });
    expect(m.createGoal).toHaveBeenCalledWith('org_1', { title: 'Help me ship', level: 'org' });
    expect(m.runAgent).not.toHaveBeenCalled();
    expect(r.stdout).toContain('conductor run now morgan --issue 1');
  });

  it('falls back to a stored API key, and explains when no provider is ready', async () => {
    const m = mocks();
    m.secretExists = vi.fn(async (ref: string) => ({ ref, exists: ref === 'conductor/openai-api-key' }));
    const h = harness({ client: m });
    const r = await h.run('--json', 'quickstart', '--name', 'Acme', '--assign', 'riley');
    expect(m.createOrgFromTemplate).toHaveBeenCalledWith(expect.objectContaining({ defaultProvider: { adapter: 'openai_api', authRef: 'conductor/openai-api-key' } }));
    expect(r.json()).toMatchObject({ org: { slug: 'acme' }, provider: { adapter: 'openai_api' }, agent: { id: 'agt_riley' }, jobId: 'job_1' });

    const none = mocks();
    const n = await harness({ client: none }).run('quickstart', '--name', 'Acme');
    expect(n.code).toBe(1);
    expect(n.stderr).toContain('No provider is ready');
    expect(n.stderr).toContain('conductor secret set conductor/anthropic-api-key');
    expect(none.createOrgFromTemplate).not.toHaveBeenCalled();
  });

  it('needs a name when it cannot prompt, and a reachable daemon', async () => {
    const h = harness({ client: mocks(), exec: (cmd) => (cmd === 'claude' ? ok('2\n') : undefined) });
    const r = await h.run('quickstart', '--provider', 'claude_local');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--name');

    const down = harness({ client: { health: vi.fn(async () => { throw refused(); }) } });
    const d = await down.run('quickstart', '--name', 'Acme');
    expect(d.code).toBe(1);
    expect(d.stderr).toContain('Cannot reach the Conductor daemon');
    expect(d.stderr).toContain('conductor install');
  });
});
