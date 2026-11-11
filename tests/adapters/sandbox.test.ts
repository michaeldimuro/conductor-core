import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunContext, RunEvent } from '../../src/contracts/adapter.js';
import { ProcessAdapter } from '../../src/adapters/index.js';
import { findExecutable, minimalEnv, runProcess } from '../../src/adapters/shared/proc.js';
import {
  agentSandbox, buildAgentSandboxProfile, inferConductorHome, planSandbox, RUN_TMP_PREFIX, sandboxAvailability,
} from '../../src/adapters/shared/sandbox.js';
import { codexSandbox } from '../../src/adapters/shared/sandbox-codex.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const available = sandboxAvailability().ok;

/** A fake Conductor home in the PRD layout, with the things an agent must never reach. */
interface Fixture {
  root: string;
  home: string;
  workspace: string;
  token: string;
  otherOrgFile: string;
  /** A path that is neither workspace, temp nor Conductor home. */
  outside: string;
  ctx(over?: Partial<RunContext>): RunContext;
}

let fx: Fixture;
let seq = 0;

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-sbxtest-')));
  const home = join(root, 'conductor-home');
  const workspace = join(home, 'orgs', 'acme', 'agents', 'ada', 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(home, 'orgs', 'globex'), { recursive: true });
  mkdirSync(join(home, 'adapters'), { recursive: true });
  const token = join(home, 'owner.token');
  writeFileSync(token, 'ctok_owner_SECRET_VALUE\n', { mode: 0o600 });
  writeFileSync(join(home, 'conductor.db'), 'sqlite-bytes');
  const otherOrgFile = join(home, 'orgs', 'globex', 'notes.txt');
  writeFileSync(otherOrgFile, 'globex-private');
  const outside = join(REPO, 'node_modules', `.conductor-sandbox-probe-${process.pid}-${++seq}.txt`);
  fx = {
    root, home, workspace, token, otherOrgFile, outside,
    ctx: (over = {}) => ({
      runId: `run_sbx_${seq}`, orgId: 'org_a', agentId: 'agent_a', issueId: null, systemPrompt: '', prompt: 'go', model: null,
      config: {}, secrets: {}, skills: [], mcpEndpoints: [], workspacePath: workspace, budgetCapUsd: null, maxSteps: 5, maxWallMs: 15_000,
      runToken: 'run-token-sandbox-test-000000', apiBaseUrl: 'http://127.0.0.1:1/api', ...over,
    }),
  };
});
afterEach(() => {
  rmSync(fx.root, { recursive: true, force: true });
  rmSync(fx.outside, { force: true });
});

/** Run a shell script through the real `process` adapter and return its stdout lines + events. */
async function runScript(script: string, over: Partial<RunContext> = {}) {
  const events: RunEvent[] = [];
  const ctx = fx.ctx(over);
  const result = await new ProcessAdapter().run({ ...ctx, config: { command: '/bin/sh', args: ['-c', script], ...ctx.config } }, (e) => events.push(e));
  const sandbox = events.flatMap((e) => (e.type === 'status' && e.sandbox ? [e.sandbox] : []))[0];
  return { result, events, sandbox, out: result.finalText };
}

const PROBE = (f: Fixture) => `
echo written > in-workspace.txt && echo "workspace-write:ok"
cat "${f.token}" >/dev/null 2>&1 && echo "token-read:LEAK" || echo "token-read:denied"
cat "${join(f.home, 'conductor.db')}" >/dev/null 2>&1 && echo "db-read:LEAK" || echo "db-read:denied"
cat "${f.otherOrgFile}" >/dev/null 2>&1 && echo "other-org-read:LEAK" || echo "other-org-read:denied"
ls "${join(f.home, 'orgs')}" >/dev/null 2>&1 && echo "orgs-list:LEAK" || echo "orgs-list:denied"
(echo x > "${f.outside}") 2>/dev/null && echo "outside-write:LEAK" || echo "outside-write:denied"
(echo x > "${join(f.home, 'adapters', 'evil.mjs')}") 2>/dev/null && echo "plugin-write:LEAK" || echo "plugin-write:denied"
(echo x > "$TMPDIR/sbx-probe-$$" && rm -f "$TMPDIR/sbx-probe-$$") 2>/dev/null && echo "tmp-write:ok" || echo "tmp-write:denied"
true
`;

describe.skipIf(!available)('agent process sandbox (real sandbox-exec)', () => {
  it('confines a process-adapter child: workspace writable, Conductor home unreadable, nothing writable outside', async () => {
    const { result, out, sandbox } = await runScript(PROBE(fx));
    expect(result.outcome).toBe('completed');
    expect(out).toContain('workspace-write:ok');
    expect(readFileSync(join(fx.workspace, 'in-workspace.txt'), 'utf8')).toBe('written\n');
    expect(out).toContain('token-read:denied');
    expect(out).toContain('db-read:denied');
    expect(out).toContain('other-org-read:denied');
    expect(out).toContain('orgs-list:denied');
    expect(out).toContain('outside-write:denied');
    expect(out).toContain('plugin-write:denied');
    expect(out).toContain('tmp-write:ok');
    expect(out).not.toContain('LEAK');
    expect(existsSync(fx.outside)).toBe(false);
    expect(existsSync(join(fx.home, 'adapters', 'evil.mjs'))).toBe(false);
    // The run's events say how it was confined.
    expect(sandbox).toMatchObject({ enabled: true, network: 'on' });
    expect(sandbox?.writable).toContain(fx.workspace);
  });

  it('`config.sandbox: false` is an explicit opt-out, visible in the events', async () => {
    const { out, sandbox } = await runScript(`cat "${fx.token}"`, { config: { sandbox: false } });
    expect(out).toContain('ctok_owner_SECRET_VALUE');
    expect(sandbox).toEqual({ enabled: false, reason: expect.stringContaining('sandbox = false') });
  });

  it('fails closed on a malformed sandbox setting', async () => {
    const { result } = await runScript('echo should-not-run', { config: { sandbox: 'off' } });
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatchObject({ kind: 'invalid_request', message: expect.stringContaining('config.sandbox') });
    expect(result.finalText).not.toContain('should-not-run');
  });

  it('takes the Conductor home from the run context and never unlocks it through a workspace that contains it', async () => {
    // A (mis)configured project workspace that is an ANCESTOR of the Conductor home.
    const { out } = await runScript(`cat "${fx.token}" 2>/dev/null && echo LEAK || echo denied; echo x > ok.txt && echo wrote`, {
      workspacePath: fx.root, sandbox: { conductorHome: fx.home },
    });
    expect(out).toContain('denied');
    expect(out).toContain('wrote');
    expect(out).not.toContain('LEAK');
  });

  it('lets the child read its assigned skill folders even though they live in the Conductor home', async () => {
    const skillDir = join(fx.home, 'orgs', 'acme', 'skills', 'deploy');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), 'skill-body');
    const skill = { id: 's1', name: 'deploy', description: 'd', path: skillDir, scope: 'org' as const, version: 1, hasScripts: true };
    const { out } = await runScript(`cat "${join(skillDir, 'SKILL.md')}"; (echo x > "${join(skillDir, 'SKILL.md')}") 2>/dev/null && echo SKILL-WRITE-LEAK || echo skill-write-denied`, { skills: [skill] });
    expect(out).toContain('skill-body');
    expect(out).toContain('skill-write-denied');
  });

  it('honours a loopback-only network policy from the binding or the run context', async () => {
    const server: Server = createServer((_req, res) => res.end('local-ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    // 192.0.2.1 is TEST-NET-1: never routable, so an unsandboxed attempt can only time out.
    const script = `
const net = require('node:net');
const http = require('node:http');
http.get('http://127.0.0.1:${port}/', (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
  console.log('loopback:' + b);
  const s = net.connect({ host: '192.0.2.1', port: 9 });
  const t = setTimeout(() => { console.log('remote:timeout'); s.destroy(); }, 1500);
  s.on('connect', () => { clearTimeout(t); console.log('remote:CONNECTED'); s.destroy(); });
  s.on('error', (e) => { clearTimeout(t); console.log('remote:' + e.code); });
}); }).on('error', (e) => console.log('loopback-error:' + e.code));`;
    try {
      for (const over of [{ config: { sandbox: { network: 'local' } } }, { sandbox: { network: 'local' as const } }]) {
        const events: RunEvent[] = [];
        const ctx = fx.ctx(over);
        const result = await new ProcessAdapter().run({ ...ctx, config: { command: process.execPath, args: ['-e', script], ...ctx.config } }, (e) => events.push(e));
        expect(result.finalText).toContain('loopback:local-ok');
        expect(result.finalText).toContain('remote:EPERM');
        expect(events.find((e) => e.type === 'status' && e.sandbox)).toMatchObject({ sandbox: { enabled: true, network: 'local' } });
      }
    } finally {
      server.close();
    }
  });

  it('hides other runs\' private temp dirs (they hold run tokens) but not this run\'s own', async () => {
    const tmp = realpathSync(tmpdir());
    const own = mkdtempSync(join(tmp, RUN_TMP_PREFIX));
    const other = mkdtempSync(join(tmp, RUN_TMP_PREFIX));
    writeFileSync(join(own, 'mcp.json'), 'own-token');
    writeFileSync(join(other, 'mcp.json'), 'other-token');
    try {
      const spec = planSandbox(fx.ctx(), { cli: 'claude', privateTmp: [own] }).spec;
      let out = '';
      await runProcess({
        command: '/bin/sh', args: ['-c', `cat "${join(own, 'mcp.json')}"; echo; cat "${join(other, 'mcp.json')}" 2>/dev/null && echo LEAK || echo other-denied`],
        cwd: fx.workspace, env: minimalEnv(), sandbox: spec ?? undefined, onStdoutLine: (l) => (out += `${l}\n`),
      });
      expect(out).toContain('own-token');
      expect(out).toContain('other-denied');
      expect(out).not.toContain('LEAK');
    } finally {
      rmSync(own, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('keeps the "command not found" contract under the sandbox', async () => {
    const spec = planSandbox(fx.ctx()).spec ?? undefined;
    const exit = await runProcess({ command: 'definitely-not-a-real-command-xyz', args: [], cwd: fx.workspace, env: minimalEnv(), sandbox: spec });
    expect(exit.spawnError?.code).toBe('ENOENT');
  });

  // Version only — never a prompt. Proves the real CLIs still start under their profile.
  for (const cli of ['claude', 'codex'] as const) {
    it.skipIf(!findExecutable(cli))(`the real ${cli} CLI still starts under its sandbox profile (--version)`, async () => {
      const spec = planSandbox(fx.ctx(), { cli, env: process.env }).spec ?? undefined;
      expect(spec).toBeDefined();
      let out = '';
      const exit = await runProcess({ command: cli, args: ['--version'], cwd: fx.workspace, env: minimalEnv({}, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']), sandbox: spec, onStdoutLine: (l) => (out += l) });
      expect(exit.stderr).not.toMatch(/sandbox|not permitted/i);
      expect(exit.code).toBe(0);
      expect(out).toMatch(/\d+\.\d+/);
    });
  }
});

describe('sandbox planning', () => {
  it('falls back gracefully, with a warning and an event field, when sandbox-exec is unavailable', async () => {
    const events: RunEvent[] = [];
    const warnings: string[] = [];
    const ctx = fx.ctx();
    const spec = agentSandbox(ctx, (e) => events.push(e), { exec: '/nonexistent/sandbox-exec', warn: (m) => warnings.push(m) });
    expect(spec).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/UNSANDBOXED/);
    expect(warnings[0]).toContain(ctx.runId);
    expect(events).toEqual([{ type: 'status', status: expect.stringContaining('OFF (fallback)'), sandbox: { enabled: false, fallback: true, reason: expect.stringContaining('not found') } }]);
    // The run itself still works, just unsandboxed.
    let out = '';
    const exit = await runProcess({ command: '/bin/echo', args: ['still-runs'], cwd: fx.workspace, env: minimalEnv(), sandbox: spec, onStdoutLine: (l) => (out += l) });
    expect(exit.code).toBe(0);
    expect(out).toBe('still-runs');
  });

  it('infers the Conductor home from the PRD workspace layout', () => {
    expect(inferConductorHome('/Users/x/.conductor/orgs/acme/agents/ada/workspace')).toBe('/Users/x/.conductor');
    expect(inferConductorHome('/Users/x/.conductor/orgs/acme/agents/ada/workspace/sub/dir')).toBe('/Users/x/.conductor');
    expect(inferConductorHome('/Users/x/code/project')).toBeNull();
  });

  it.skipIf(!available)('gives each provider CLI its own state and login, and nothing else', () => {
    const env = { HOME: '/Users/tester', TMPDIR: '/private/var/folders/aa/bb/T' };
    const claude = planSandbox(fx.ctx(), { cli: 'claude', env });
    const codex = planSandbox(fx.ctx(), { cli: 'codex', env: { ...env, CODEX_HOME: '/Users/tester/alt-codex' } });
    const proc = planSandbox(fx.ctx(), { env });
    const [allowC, denyC] = [claude.spec!.profile.split('\n')[3]!, claude.spec!.profile.split('\n').filter((l) => l.startsWith('(deny file-read*')).join('\n')];
    expect(allowC).toContain('"/Users/tester/.claude"');
    expect(allowC).toContain('"/Users/tester/Library/Keychains"');
    expect(allowC).toContain('"/private/var/folders/aa/bb/C"');
    expect(claude.spec!.profile).toContain('(allow file-write* (regex #"^/Users/tester/\\.claude\\.json"))');
    expect(denyC).toContain('"/Users/tester/.codex"');
    expect(denyC).toContain('"/Users/tester/.ssh"');
    expect(denyC).toContain('"/Users/tester/.aws"');
    expect(denyC).toContain(`"${fx.home}"`);
    expect(denyC).toContain('"/Users/tester/.conductor"');

    expect(codex.spec!.profile.split('\n')[3]).toContain('"/Users/tester/alt-codex"');
    expect(codex.spec!.profile).toContain('"/Users/tester/.claude"');
    expect(codex.spec!.profile.split('\n')[3]).not.toContain('.claude');

    // An arbitrary command gets no CLI state and no Keychain.
    const allowP = proc.spec!.profile.split('\n')[3]!;
    expect(allowP).not.toContain('Keychains');
    expect(allowP).not.toContain('.claude');
    expect(proc.spec!.profile.split('\n').filter((l) => l.startsWith('(deny')).join('\n')).toContain('"/Users/tester/Library/Keychains"');
  });

  it.skipIf(!available)('applies binding allowances but refuses any inside the Conductor home', () => {
    const plan = planSandbox(fx.ctx({ config: { sandbox: { allowWrite: ['~/.npm', join(fx.home, 'adapters')], allowRead: ['~/.ssh/known_hosts', fx.token] } } }), { env: { HOME: '/Users/tester' } });
    const lines = plan.spec!.profile.split('\n');
    expect(lines[3]).toContain('"/Users/tester/.npm"');
    expect(lines[3]).not.toContain(join(fx.home, 'adapters'));
    expect(lines.at(-1)).toContain('"/Users/tester/.ssh/known_hosts"');
    expect(lines.at(-1)).not.toContain('owner.token');
    // The rest of ~/.ssh stays denied.
    expect(plan.spec!.profile).toContain('(subpath "/Users/tester/.ssh")');
    expect(plan.warnings).toHaveLength(2);
  });

  it('quotes hostile path characters in the profile', () => {
    const profile = buildAgentSandboxProfile({ workspace: '/w/a"b\\c', conductorHomes: [], writePaths: [], denyReadPaths: [], network: 'on' });
    expect(profile).toContain('(subpath "/w/a\\"b\\\\c")');
  });
});

describe.skipIf(!available)('codex_local process sandbox', () => {
  const base = ['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '-'];
  const run = (args: string[], config: Record<string, unknown> = {}) => {
    const events: RunEvent[] = [];
    const out = codexSandbox(fx.ctx({ config }), (e) => events.push(e), args, { env: { HOME: '/Users/tester' } });
    return { ...out, reports: events.flatMap((e) => (e.type === 'status' && e.sandbox ? [e.sandbox] : [])) };
  };

  it('wraps Codex and turns its own seatbelt off, because profiles do not nest', () => {
    const r = run(base);
    expect(r.sandbox?.profile).toContain('"/Users/tester/.codex"');
    expect(r.args).toEqual(['exec', '--json', '-c', 'sandbox_mode="danger-full-access"', '-']);
    expect(r.reports).toEqual([expect.objectContaining({ enabled: true })]);
  });

  it('keeps Codex\'s stricter read-only sandbox instead of wrapping', () => {
    const args = ['exec', '--json', '-c', 'sandbox_mode="read-only"', '-'];
    const r = run(args);
    expect(r.sandbox).toBeUndefined();
    expect(r.args).toEqual(args);
    expect(r.reports).toEqual([{ enabled: false, reason: expect.stringContaining('read-only') }]);
  });

  it('`processSandbox: false` opts out and leaves Codex\'s own sandbox untouched (`sandbox` is Codex\'s mode on this adapter)', () => {
    const r = run(base, { sandbox: 'workspace-write', processSandbox: false });
    expect(r.sandbox).toBeUndefined();
    expect(r.args).toEqual(base);
    expect(r.reports).toEqual([{ enabled: false, reason: expect.stringContaining('sandbox = false') }]);
  });

  it('does not touch the args when Codex already runs without its own sandbox', () => {
    const args = ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-'];
    const r = run(args);
    expect(r.sandbox).toBeDefined();
    expect(r.args).toEqual(args);
  });
});
