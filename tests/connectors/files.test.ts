import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createConnectorGateway, createFilesToolProvider } from '../../src/connectors/index.js';
import { buildSandboxProfile, sandboxAvailable } from '../../src/connectors/files/sandbox.js';
import type { ConnectorGateway } from '../../src/contracts/services.js';
import type { ToolCallContext } from '../../src/contracts/tools.js';
import type { Agent } from '../../src/contracts/rows.js';
import { organizations } from '../../src/db/schema/index.js';
import { fakeApprovals, fakeOrg, listen, runCtx, textOf } from './helpers.js';

describe('conductor-files builtin', () => {
  let k: TestKernel;
  let gw: ConnectorGateway;
  let approvals: ReturnType<typeof fakeApprovals>;
  let agent: Agent;
  let ctx: ToolCallContext;
  let workspace: string;
  let outside: string;
  const call = (tool: string, args: Record<string, unknown>, c: ToolCallContext = ctx) => gw.callTool(c, `conductor-files__${tool}`, args);

  beforeEach(() => {
    k = createTestKernel();
    approvals = fakeApprovals(k);
    gw = createConnectorGateway(k, { approvals, org: fakeOrg(k) });
    gw.registerBuiltin(createFilesToolProvider(k));
    const org = seedOrg(k);
    agent = seedAgent(k, org.id, seedDept(k, org.id).id, 'Ada', { autonomyLevel: 2 });
    workspace = join(k.paths.home, 'workspace');
    mkdirSync(workspace);
    outside = mkdtempSync(join(tmpdir(), 'conductor-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
    ctx = runCtx(k, agent, { workspacePath: workspace });
  });
  afterEach(async () => {
    await gw.close();
    rmSync(outside, { recursive: true, force: true });
    k.dispose();
  });

  it('is available to every agent and reads, writes, lists and searches inside the workspace', async () => {
    const tools = await gw.listTools(ctx);
    expect(Object.fromEntries(tools.map((t) => [t.name, t.risk]))).toEqual({
      'conductor-files__read_file': 'read', 'conductor-files__write_file': 'write', 'conductor-files__list_dir': 'read',
      'conductor-files__search_files': 'read', 'conductor-files__run_command': 'high',
    });
    expect(textOf(await call('write_file', { path: 'notes/todo.md', content: 'buy milk\ncall Alice\n' }))).toContain('Wrote 20 bytes to notes/todo.md');
    await call('write_file', { path: 'notes/todo.md', content: 'ship it\n', append: true });
    expect(textOf(await call('read_file', { path: 'notes/todo.md' }))).toBe('buy milk\ncall Alice\nship it\n');
    expect(textOf(await call('read_file', { path: 'notes/todo.md', offset: 2, limit: 1 }))).toBe('call Alice');
    // An absolute path inside the workspace is accepted.
    expect(textOf(await call('read_file', { path: join(workspace, 'notes', 'todo.md') }))).toContain('buy milk');
    expect(JSON.parse(textOf(await call('list_dir', {})))).toMatchObject({ path: '.', entries: [{ name: 'notes', type: 'dir' }] });
    expect(JSON.parse(textOf(await call('list_dir', { path: 'notes' }))).entries).toEqual([{ name: 'todo.md', type: 'file', size: 28 }]);
    writeFileSync(join(workspace, 'other.txt'), 'nothing here\nALICE again\n');
    expect(textOf(await call('search_files', { query: 'alice' })).split('\n')).toEqual(['notes/todo.md:2: call Alice', 'other.txt:2: ALICE again']);
    expect(textOf(await call('search_files', { query: '^ship', regex: true, glob: '*.md' }))).toBe('notes/todo.md:3: ship it');
    expect(textOf(await call('search_files', { query: 'zebra' }))).toBe('No matches.');
    // File tools return internal content: the run is not marked as having ingested untrusted input.
    expect((await call('read_file', { path: 'other.txt' })).untrusted).toBeFalsy();
  });

  it('confines every path to the workspace', async () => {
    for (const path of ['../outside.txt', '../../etc/passwd', '/etc/passwd', join(outside, 'secret.txt'), 'notes/../../x']) {
      for (const [tool, args] of [['read_file', { path }], ['write_file', { path, content: 'x' }], ['list_dir', { path }], ['search_files', { query: 'x', path }]] as const) {
        const r = await call(tool, args);
        expect(r.isError, `${tool} ${path}`).toBe(true);
        expect(textOf(r), `${tool} ${path}`).toMatch(/escapes/);
      }
    }
    expect(existsSync(join(k.paths.home, 'outside.txt'))).toBe(false);
    expect((await call('read_file', { path: 'missing.txt' })).isError).toBe(true);
    expect((await call('read_file', {})).isError).toBe(true);
    expect((await call('write_file', { path: '.', content: 'x' })).isError).toBe(true);
    const noWorkspace = await call('list_dir', {}, runCtx(k, agent, { workspacePath: join(k.paths.home, 'does-not-exist') }));
    expect(textOf(noWorkspace)).toMatch(/no workspace/);
  });

  it('rejects symlink escapes (file links, directory links and dangling links)', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
    symlinkSync(outside, join(workspace, 'linkdir'));
    symlinkSync(join(outside, 'not-yet.txt'), join(workspace, 'dangling.txt'));
    mkdirSync(join(workspace, 'real'));
    writeFileSync(join(workspace, 'real', 'in.txt'), 'inside');
    symlinkSync(join(workspace, 'real'), join(workspace, 'inner-link'));

    for (const path of ['link.txt', 'linkdir/secret.txt', 'dangling.txt']) {
      const r = await call('read_file', { path });
      expect(r.isError, path).toBe(true);
      expect(textOf(r)).not.toContain('TOP SECRET');
    }
    for (const path of ['link.txt', 'linkdir/new.txt', 'dangling.txt', 'linkdir/sub/new.txt']) {
      expect((await call('write_file', { path, content: 'pwned' })).isError, path).toBe(true);
    }
    expect((await call('list_dir', { path: 'linkdir' })).isError).toBe(true);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET');
    expect(existsSync(join(outside, 'not-yet.txt'))).toBe(false);
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
    // Search never follows links out of the workspace; links that stay inside are fine.
    expect(textOf(await call('search_files', { query: 'TOP SECRET' }))).toBe('No matches.');
    expect(textOf(await call('read_file', { path: 'inner-link/in.txt' }))).toBe('inside');
  });

  it('builds a deny-by-default sandbox profile', () => {
    const closed = buildSandboxProfile({ workspace: '/w s/"x"', tmp: '/private/tmp/t', network: false });
    expect(closed).toContain('(deny default)');
    expect(closed).toContain('(subpath "/w s/\\"x\\"")');
    expect(closed).not.toContain('network');
    expect(closed).not.toMatch(/subpath "\/Users"|subpath "\/Volumes"|subpath "\/private\/var\/folders"/);
    const open = buildSandboxProfile({ workspace: '/w', tmp: '/t', network: true });
    expect(open).toContain('(allow network-outbound)');
    expect(open).not.toContain('network-inbound');
  });

  describe.runIf(sandboxAvailable())('run_command under sandbox-exec', () => {
    const run = (command: string, extra: Record<string, unknown> = {}, c: ToolCallContext = ctx) => call('run_command', { command, ...extra }, c);

    it('is Ask-first for supervised agents and runs for autonomous ones', async () => {
      const supervised = runCtx(k, agent, { workspacePath: workspace, autonomyLevel: 1 });
      expect(textOf(await run('echo hi', {}, supervised))).toMatch(/Approval required/);
      expect(approvals.all()[0]).toMatchObject({ kind: 'tool_call', payload: { tool: 'conductor-files__run_command', risk: 'high' } });
      expect(textOf(await run('echo hi'))).toMatch(/exit code: 0\nstdout:\nhi/);
    });

    it('runs in the workspace with a minimal environment and can write there', async () => {
      process.env.CONDUCTOR_TEST_DAEMON_SECRET = 'daemon-secret-value';
      try {
        const r = await run('pwd; echo "home=$HOME"; env | grep -c CONDUCTOR; echo data > made.txt; mkdir -p sub && cd sub && pwd; echo t > "$TMPDIR/scratch" && cat "$TMPDIR/scratch"');
        const out = textOf(r);
        const real = realpathSync(workspace);
        expect(out).toContain(`${real}\nhome=${real}\n0\n${real}/sub\nt`);
        expect(out).not.toContain('daemon-secret-value');
        expect(readFileSync(join(workspace, 'made.txt'), 'utf8')).toBe('data\n');
        expect(textOf(await run('pwd', { cwd: 'sub' }))).toContain(`${real}/sub`);
        expect((await run('pwd', { cwd: '../..' })).isError).toBe(true);
      } finally {
        delete process.env.CONDUCTOR_TEST_DAEMON_SECRET;
      }
    });

    it('cannot write or read outside the workspace', async () => {
      const target = join(outside, 'pwned.txt');
      const home = join(k.paths.home, 'pwned.txt');
      const r = await run(`echo x > '${target}'; echo "rc1=$?"; echo x > '${home}'; echo "rc2=$?"; cat '${join(outside, 'secret.txt')}'; echo "rc3=$?"; echo x > ../pwned.txt; echo "rc4=$?"`);
      const out = textOf(r);
      expect(out).toMatch(/rc1=1/);
      expect(out).toMatch(/rc2=1/);
      expect(out).toMatch(/rc3=1/);
      expect(out).toMatch(/rc4=1/);
      expect(out).not.toContain('TOP SECRET');
      expect(existsSync(target)).toBe(false);
      expect(existsSync(home)).toBe(false);
      // A symlink out of the workspace does not help a sandboxed command either.
      symlinkSync(outside, join(workspace, 'out'));
      await run('echo x > out/via-link.txt');
      expect(existsSync(join(outside, 'via-link.txt'))).toBe(false);
    });

    it('denies network access unless the org has a network allowlist', async () => {
      const hits: string[] = [];
      const server = await listen((req, res) => {
        hits.push(req.url ?? '');
        res.end('pong');
      });
      try {
        const cmd = `curl -s -m 5 ${server.origin}/ping; echo "rc=$?"`;
        const denied = textOf(await run(cmd));
        expect(denied).not.toContain('pong');
        expect(denied).toMatch(/rc=[1-9]/);
        expect(hits).toEqual([]);

        k.db.update(organizations).set({ policies: { networkAllowlist: ['127.0.0.1'] } }).where(eq(organizations.id, ctx.orgId)).run();
        const allowed = textOf(await run(cmd));
        expect(allowed).toContain('pong');
        expect(hits).toEqual(['/ping']);
      } finally {
        await server.close();
      }
    });

    it('enforces the timeout and caps output', async () => {
      const slow = await run('echo started; sleep 30', { timeoutMs: 400 });
      expect(slow.isError).toBe(true);
      expect(textOf(slow)).toMatch(/timed out after 400 ms/);
      const loud = textOf(await run('head -c 300000 /dev/zero | tr "\\0" a'));
      expect(loud).toContain('[output truncated at 64000 bytes]');
      expect(loud.length).toBeLessThan(70_000);
      const failing = await run('echo oops >&2; exit 3');
      expect(failing.isError).toBe(true);
      expect(textOf(failing)).toMatch(/exit code: 3[\s\S]*stderr:\noops/);
    });
  });
});
