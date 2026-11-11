import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { RESTART_BUDGET_MS, SHUTDOWN_BUDGET_MS, UI_REACHABLE_BUDGET_MS } from '../../src/daemon/lifecycle.js';
import { MemorySecretStore } from '../../src/kernel/index.js';
import { OWNER } from '../../src/contracts/types.js';

const MAIN = fileURLToPath(new URL('../../src/daemon/main.ts', import.meta.url));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "Reachable" = the API answers an authenticated status request. */
async function reachable(port: number, home: string): Promise<boolean> {
  try {
    const token = readFileSync(join(home, 'owner.token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

describe('FR-1: daemon start and stop times (in-process)', () => {
  let home: string;
  let daemon: DaemonHandle | null = null;
  const secrets = new MemorySecretStore();
  const start = async (port: number) =>
    (daemon = await startDaemon({ home, secrets, config: { port, host: '127.0.0.1' }, runtime: { tickMs: 0, systemJobs: false, powerAssertion: false } }));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'conductor-daemon-'));
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    rmSync(home, { recursive: true, force: true });
  });

  it('composes every service and has the API listening well inside the restart budget', async () => {
    const port = await freePort();
    const d = await start(port);
    expect(d.listeningMs).toBeLessThanOrEqual(d.startupMs);
    expect(d.startupMs).toBeLessThan(RESTART_BUDGET_MS);
    expect(d.startupMs).toBeLessThan(UI_REACHABLE_BUDGET_MS);
    expect(await reachable(port, home)).toBe(true);

    // The on-disk layout exists from the first start, and the home is private.
    for (const p of ['adapters', 'skills/global', 'orgs', 'backups', 'run/conductord.pid', 'owner.token']) expect(existsSync(join(home, p)), p).toBe(true);
    expect(statSync(home).mode & 0o077).toBe(0);
    expect(statSync(join(home, 'owner.token')).mode & 0o077).toBe(0);

    // A new org gets its own artifacts/ and transcripts/ next to the rest of its tree.
    const org = d.services.org.createOrg({ name: 'Layout Co', mission: 'm' }, OWNER);
    for (const p of ['artifacts', 'transcripts', 'skills', 'agents', 'browser-profiles']) expect(existsSync(join(home, 'orgs', org.slug, p)), p).toBe(true);

    const report = await d.stop();
    expect(report.withinBudget).toBe(true);
    expect(report.phases).toEqual({ gateways: 'done', api: 'done', services: 'done' });
    expect(existsSync(join(home, 'run', 'conductord.pid'))).toBe(false);
    expect(await reachable(port, home)).toBe(false);

    // Restart on the same home: existing orgs get their layout ensured again, still inside the budget.
    rmSync(join(home, 'orgs', org.slug, 'artifacts'), { recursive: true });
    daemon = null;
    const again = await start(port);
    expect(again.startupMs).toBeLessThan(RESTART_BUDGET_MS);
    expect(existsSync(join(home, 'orgs', org.slug, 'artifacts'))).toBe(true);
    expect(await reachable(port, home)).toBe(true);
  }, 60_000);

  it('stops inside the shutdown budget with a run in flight, and the run is not left orphaned', async () => {
    const port = await freePort();
    const d = await start(port);
    const s = d.services;
    const org = s.org.createOrg({ name: 'Busy Co', mission: 'm', defaultProvider: { adapter: 'process', config: { command: '/bin/sleep', args: ['120'] } }, budgetMonthlyUsd: 10 }, OWNER);
    const dept = s.org.createDept(org.id, { name: 'Ops' }, OWNER);
    const agent = s.org.hireAgent(org.id, { deptId: dept.id, name: 'Sam', role: 'Operator', autonomyLevel: 2 }, OWNER).agent!;
    const issue = s.work.createIssue(org.id, { title: 'Long task', body: 'sleep', assigneeAgentId: agent.id }, OWNER);

    const deadline = Date.now() + 20_000;
    while (s.runtime.status().running === 0) {
      await s.runtime.tick();
      if (Date.now() > deadline) throw new Error('the run never started');
      await sleep(50);
    }
    // Let the worker actually spawn its child before pulling the plug.
    await sleep(1500);

    const t0 = Date.now();
    const report = await d.stop();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(SHUTDOWN_BUDGET_MS);
    expect(report.withinBudget).toBe(true);

    // Restart: nothing is stuck "running", and the issue is workable again (resumed or released — FR-1).
    daemon = null;
    const again = await start(port);
    expect(again.startupMs).toBeLessThan(RESTART_BUDGET_MS);
    const runs = again.services.runtime.listRuns(org.id, {});
    expect(runs.length).toBeGreaterThan(0);
    const stuck = runs.filter((r) => r.status === 'running' && !again.services.runtime.isAlive(r.id));
    expect(stuck).toEqual([]);
    expect(['todo', 'in_progress', 'blocked', 'backlog']).toContain(again.services.work.getIssue(org.id, issue.id).status);
  }, 90_000);
});

describe('FR-1: the real conductord process', () => {
  let home: string;
  let child: ChildProcess | null = null;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'conductor-daemon-proc-'));
  });
  afterEach(() => {
    child?.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  });

  const launch = (port: number): { child: ChildProcess; exited: Promise<number | null>; log: () => string } => {
    let out = '';
    const c = spawn(process.execPath, ['--import', 'tsx', MAIN, '--serve'], {
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '',
        CONDUCTOR_HOME: home, CONDUCTOR_LOG_DIR: join(home, 'logs'), CONDUCTOR_PORT: String(port), CONDUCTOR_SECRETS: 'memory', CONDUCTOR_LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    c.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    child = c;
    return { child: c, exited: new Promise((r) => c.once('exit', (code) => r(code))), log: () => out };
  };

  const untilReachable = async (port: number, budgetMs: number): Promise<number> => {
    const t0 = Date.now();
    while (!(await reachable(port, home))) {
      if (Date.now() - t0 > budgetMs) throw new Error(`not reachable within ${budgetMs} ms`);
      await sleep(50);
    }
    return Date.now() - t0;
  };

  it('is reachable < 30 s after launch, exits 0 on SIGTERM inside the budget, and is back < 15 s after a kill', async () => {
    const port = await freePort();
    const first = launch(port);
    const coldMs = await untilReachable(port, UI_REACHABLE_BUDGET_MS);
    expect(coldMs).toBeLessThan(UI_REACHABLE_BUDGET_MS);
    expect(first.log()).toContain('conductord ready');
    expect(first.log()).not.toContain('SECURITY WARNING');

    // Requested stop: clean exit code (launchd's KeepAlive={SuccessfulExit:false} must NOT restart it), in budget.
    const t0 = Date.now();
    first.child.kill('SIGTERM');
    expect(await first.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(SHUTDOWN_BUDGET_MS);

    // Crash: SIGKILL, then what launchd does — start it again. Kill-to-reachable must fit the restart budget.
    const second = launch(port);
    await untilReachable(port, UI_REACHABLE_BUDGET_MS);
    const killedAt = Date.now();
    second.child.kill('SIGKILL');
    await second.exited;
    const third = launch(port);
    await untilReachable(port, RESTART_BUDGET_MS);
    expect(Date.now() - killedAt).toBeLessThan(RESTART_BUDGET_MS);
    third.child.kill('SIGTERM');
    expect(await third.exited).toBe(0);
  }, 120_000);
});
