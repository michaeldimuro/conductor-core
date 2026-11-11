import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createServer } from 'node:net';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { createKernel, type KernelHandle } from '../../src/kernel/index.js';
import { browserProfiles } from '../../src/db/schema/index.js';
import { OWNER } from '../../src/contracts/types.js';
import { decryptJar } from '../../src/browser/crypto.js';
import type { Agent } from '../../src/contracts/rows.js';
import { BROWSER_TEST_TIMEOUT, createHarness, text, type Harness } from './harness.js';
import { SITE_PASSWORD, SITE_USER, startSite, type TestSite } from './site.js';

const T = BROWSER_TEST_TIMEOUT;

describe('browser persistence, leases and isolation', () => {
  let site: TestSite;
  let h: Harness;
  const extraKernels: KernelHandle[] = [];

  beforeAll(async () => {
    site = await startSite();
  });
  afterAll(() => site.close());
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.dispose();
    for (const k of extraKernels.splice(0)) k.close();
  });

  /** Log in through the tools only: username typed, password filled by reference. */
  async function login(agent: Agent, runId: string, path = '/simple-login'): Promise<void> {
    const slug = h.k.db.query.organizations.findFirst({ where: (o, { eq }) => eq(o.id, agent.orgId) }).sync()!.slug;
    await h.k.secrets.set(`org/${slug}/site/password`, SITE_PASSWORD);
    const ctx = h.ctx(agent, runId);
    expect(text(await h.call(ctx, 'navigate', { url: site.url(path) }))).toContain('Sign in');
    expect((await h.call(ctx, 'type', { selector: '#u', text: SITE_USER })).isError).toBeFalsy();
    expect((await h.call(ctx, 'fill_secret', { field: '#p', secret_ref: `org/${slug}/site/password` })).isError).toBeFalsy();
    const done = await h.call(ctx, 'click', { selector: '#go' });
    expect(text(done)).toContain('/account');
    expect(text(await h.call(ctx, 'extract', { kind: 'text' }))).toContain(`Welcome ${SITE_USER}`);
  }

  it('FR-12: a login survives endRun and a daemon restart (fresh service + kernel over the same home)', async () => {
    const org = seedOrg(h.k, 'Acme');
    const dept = seedDept(h.k, org.id);
    const ada = seedAgent(h.k, org.id, dept.id, 'Ada');

    const loginsBefore = site.state.logins;
    await login(ada, 'run_1');
    expect(site.state.logins).toBe(loginsBefore + 1);
    await h.svc.endRun('run_1');
    expect(h.svc.listProfiles(org.id)[0]).toMatchObject({ leasedRunId: null });
    await h.svc.shutdown();

    // "Restart": a brand-new kernel (new DB connection) and service instance over the same CONDUCTOR_HOME.
    const k2 = createKernel({ home: h.k.paths.home, clock: h.k.clock, secrets: h.k.secrets });
    extraKernels.push(k2);
    const svc2 = h.newService(k2);
    const ctx = h.ctx(ada, 'run_2');
    const r = await svc2.toolProvider().call(ctx, 'navigate', { url: site.url('/account') });
    expect(r.isError).toBeFalsy();
    expect(r.untrusted).toBe(true);
    expect(text(r)).toContain('/account');
    expect(text(await svc2.toolProvider().call(ctx, 'extract', { selector: 'h1' }))).toContain(`Welcome ${SITE_USER}`);
    expect(site.state.logins).toBe(loginsBefore + 1); // no re-login happened
    await svc2.endRun('run_2');
  }, T);

  it('keeps an encrypted cookie jar at rest and restores from it when the live cookie store is gone', async () => {
    const org = seedOrg(h.k, 'Acme');
    const dept = seedDept(h.k, org.id);
    const ada = seedAgent(h.k, org.id, dept.id, 'Ada');

    // A session cookie (no expiry) — Chromium itself would drop it on restart.
    await login(ada, 'run_1', '/simple-login?session=1');
    const loginsAfter = site.state.logins;
    await h.svc.endRun('run_1');

    const profile = h.svc.listProfiles(org.id)[0]!;
    const jarFile = join(profile.userDataDir, 'cookies.enc');
    expect(existsSync(jarFile)).toBe(true);
    const raw = readFileSync(jarFile);
    const key = await h.k.secrets.get('org/acme/browser/ada/cookie-key');
    expect(key).toBeTruthy();
    expect(profile.cookieVaultRef).toBe('org/acme/browser/ada/cookie-key');
    const state = JSON.parse(decryptJar(raw, key!)) as { cookies: Array<{ name: string; value: string; domain: string }> };
    const sid = state.cookies.find((c) => c.name === 'sid');
    expect(sid?.domain).toBe('127.0.0.1');
    // Not plaintext: neither the cookie value nor any JSON structure is visible in the file.
    for (const needle of [sid!.value, '"cookies"', 'sid', '127.0.0.1']) expect(raw.includes(Buffer.from(needle))).toBe(false);
    // The key lives only in the secret store, never next to the jar or in the DB.
    expect(raw.includes(Buffer.from(key!, 'base64'))).toBe(false);
    expect(JSON.stringify(h.k.db.select().from(browserProfiles).all())).not.toContain(key!);

    // Wipe Chromium's own profile data, keeping only the encrypted jar.
    for (const entry of readdirSync(profile.userDataDir)) {
      if (entry !== 'cookies.enc') rmSync(join(profile.userDataDir, entry), { recursive: true, force: true });
    }
    const svc2 = h.newService();
    const ctx = h.ctx(ada, 'run_2');
    const r = await svc2.toolProvider().call(ctx, 'navigate', { url: site.url('/account') });
    expect(text(r)).toContain('/account');
    expect(text(await svc2.toolProvider().call(ctx, 'extract', {}))).toContain(`Welcome ${SITE_USER}`);
    expect(site.state.logins).toBe(loginsAfter);

    // A jar that cannot be decrypted (key lost) is ignored rather than fatal: the agent is simply logged out.
    await svc2.endRun('run_2');
    await h.k.secrets.delete('org/acme/browser/ada/cookie-key');
    for (const entry of readdirSync(profile.userDataDir)) {
      if (entry !== 'cookies.enc') rmSync(join(profile.userDataDir, entry), { recursive: true, force: true });
    }
    const r3 = await svc2.toolProvider().call(h.ctx(ada, 'run_3'), 'navigate', { url: site.url('/account') });
    expect(r3.isError).toBeFalsy();
    expect(text(r3)).toContain('/login');
  }, T);

  it('leases a profile to one run at a time; endRun and recoverLeases free it', async () => {
    const org = seedOrg(h.k, 'Acme');
    const sales = seedDept(h.k, org.id, 'Sales');
    const sam = seedAgent(h.k, org.id, sales.id, 'Sam');
    const sue = seedAgent(h.k, org.id, sales.id, 'Sue');
    const shared = h.svc.createProfile(org.id, { name: 'Sales shared', deptId: sales.id }, OWNER);

    const first = await h.call(h.ctx(sam, 'run_sam'), 'navigate', { url: site.url('/help') });
    expect(first.isError).toBeFalsy();
    expect(h.svc.listProfiles(org.id)[0]).toMatchObject({ id: shared.id, leasedRunId: 'run_sam', leasedAt: h.k.clock.now() });

    // Second run (another member of the department sharing the profile) gets a clear tool error.
    const second = await h.call(h.ctx(sue, 'run_sue'), 'navigate', { url: site.url('/help') });
    expect(second.isError).toBe(true);
    expect(text(second)).toMatch(/profile in use by run run_sam/);
    // Same agent, different run: also refused.
    expect(text(await h.call(h.ctx(sam, 'run_sam_2'), 'snapshot'))).toMatch(/in use by run run_sam/);
    // The holder keeps working.
    expect(text(await h.call(h.ctx(sam, 'run_sam'), 'extract', {}))).toContain('Help center');

    await h.svc.endRun('run_sam');
    expect(h.svc.listProfiles(org.id)[0]?.leasedRunId).toBeNull();
    expect(text(await h.call(h.ctx(sue, 'run_sue'), 'navigate', { url: site.url('/help') }))).toContain('Help');
    await h.svc.endRun('run_sue');
    await h.svc.endRun('run_never_started'); // no-op

    // A lease left behind by a crashed daemon blocks until recovered.
    h.k.db.update(browserProfiles).set({ leasedRunId: 'run_crashed', leasedAt: 1 }).run();
    expect(text(await h.call(h.ctx(sam, 'run_sam_3'), 'snapshot'))).toMatch(/in use by run run_crashed/);
    h.svc.recoverLeases(['run_some_other_live_run']);
    expect((await h.call(h.ctx(sam, 'run_sam_3'), 'snapshot')).isError).toBeFalsy();
    // recoverLeases keeps the lease of a live run…
    h.svc.recoverLeases(['run_sam_3']);
    expect(h.svc.listProfiles(org.id)[0]?.leasedRunId).toBe('run_sam_3');
    // …and shutdown closes everything and releases it.
    await h.svc.shutdown();
    expect(h.svc.listProfiles(org.id)[0]?.leasedRunId).toBeNull();
    const audit = h.k.audit.query({ orgId: org.id }).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['browser.lease_acquired', 'browser.lease_released', 'browser.lease_recovered']));
  }, T);

  it('FR-2: logins never bleed across orgs (separate profiles, cookies and run identity)', async () => {
    const acme = seedOrg(h.k, 'Acme');
    const globex = seedOrg(h.k, 'Globex');
    const ada = seedAgent(h.k, acme.id, seedDept(h.k, acme.id).id, 'Ada');
    const eve = seedAgent(h.k, globex.id, seedDept(h.k, globex.id).id, 'Ada'); // same agent slug, other org

    await login(ada, 'run_acme');
    const other = await h.call(h.ctx(eve, 'run_globex'), 'navigate', { url: site.url('/account') });
    expect(text(other)).toContain('/login');
    expect(text(await h.call(h.ctx(eve, 'run_globex'), 'extract', {}))).not.toContain('Welcome');

    // A caller from another org cannot ride on a live run's browser, nor use an agent id from another org.
    const hijack = await h.call({ ...h.ctx(eve, 'run_acme') }, 'extract', {});
    expect(hijack.isError).toBe(true);
    expect(text(hijack)).not.toContain('Welcome');
    const foreign = await h.call({ ...h.ctx(eve, 'run_x'), agentId: ada.id }, 'snapshot');
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toMatch(/not found/);

    const dirs = [h.svc.listProfiles(acme.id)[0]!.userDataDir, h.svc.listProfiles(globex.id)[0]!.userDataDir];
    expect(dirs[0]).toContain(join('orgs', 'acme'));
    expect(dirs[1]).toContain(join('orgs', 'globex'));
  }, T);

  describe('external Chrome over CDP', () => {
    let external: Browser;
    let port: number;
    beforeAll(async () => {
      port = await new Promise<number>((resolve) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
          const p = (s.address() as { port: number }).port;
          s.close(() => resolve(p));
        });
      });
      external = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    }, T);
    afterAll(() => external.close());

    it('attaches to a running Chrome via the profile engine config and detaches without closing it', async () => {
      const org = seedOrg(h.k, 'Acme');
      const ada = seedAgent(h.k, org.id, seedDept(h.k, org.id).id, 'Ada');
      const create = h.svc.createProfile as (orgId: string, input: Record<string, unknown>, actor: typeof OWNER) => ReturnType<typeof h.svc.createProfile>;
      create(org.id, { name: 'My Chrome', agentId: ada.id, engine: { kind: 'cdp', endpoint: `http://127.0.0.1:${port}` } }, OWNER);

      const ctx = h.ctx(ada, 'run_cdp');
      const r = await h.call(ctx, 'navigate', { url: site.url('/help') });
      expect(r.isError).toBeFalsy();
      expect(text(await h.call(ctx, 'extract', {}))).toContain('Help center');
      await h.svc.endRun('run_cdp');
      expect(external.isConnected()).toBe(true);
      expect(h.svc.listProfiles(org.id)[0]?.leasedRunId).toBeNull();
    }, T);
  });
});
