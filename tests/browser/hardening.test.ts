import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import type { DomainEvents } from '../../src/shared/events.js';
import { sha256 } from '../../src/shared/util.js';
import { plaintextStores } from '../../src/browser/at-rest.js';
import { opVault, readOnePassword } from '../../src/browser/onepassword.js';
import { BROWSER_TEST_TIMEOUT, createHarness, SHARE_BASE, text, type Harness } from './harness.js';
import { SITE_PASSWORD, SITE_USER, startSite, type TestSite } from './site.js';

const T = BROWSER_TEST_TIMEOUT;
const OP_SECRET = 'op-Sup3r-s3cret-value';

/** A stand-in `op` binary: behaviour is chosen by the FAKE_OP_MODE file next to it. */
function fakeOp(dir: string): { bin: string; mode(m: 'ok' | 'locked' | 'missing' | 'empty'): void; calls(): string[] } {
  const bin = join(dir, 'fake-op');
  const modeFile = join(dir, 'fake-op.mode');
  const log = join(dir, 'fake-op.log');
  writeFileSync(modeFile, 'ok');
  writeFileSync(log, '');
  writeFileSync(bin, `#!/bin/sh
echo "$*" >> "${log}"
mode=$(cat "${modeFile}")
if [ "$1" != "read" ] || [ "$2" != "--no-newline" ]; then echo "unexpected arguments" >&2; exit 2; fi
case "$mode" in
  locked) echo "[ERROR] 2026/01/01 00:00:00 you are not currently signed in. Please run \\\`op signin\\\`" >&2; exit 1 ;;
  missing) echo "[ERROR] 2026/01/01 00:00:00 \\"nope\\" isn't an item in the \\"Agents\\" vault" >&2; exit 1 ;;
  empty) exit 0 ;;
esac
case "$3" in
  "op://Agents/Site Login/password") printf '%s' '${SITE_PASSWORD}' ;;
  "op://Agents/token/credential") printf '%s' '${OP_SECRET}' ;;
  *) echo "[ERROR] could not find item" >&2; exit 1 ;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, mode: (m) => writeFileSync(modeFile, m), calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

describe('browser hardening: settings, takeover re-issue, 1Password, encryption at rest', () => {
  let site: TestSite;
  let h: Harness;
  let org: Organization;
  let ada: Agent;

  beforeAll(async () => {
    site = await startSite();
  });
  afterAll(() => site.close());
  beforeEach(() => {
    h = createHarness();
    org = seedOrg(h.k, 'Acme');
    ada = seedAgent(h.k, org.id, seedDept(h.k, org.id).id, 'Ada');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.dispose();
  });

  it('stores engine, headed mode and the 1Password vault allowlist per profile, org-scoped', () => {
    const p = h.svc.createProfile(org.id, { name: 'Ada browser', agentId: ada.id }, OWNER);
    expect(h.svc.profileSettings(org.id, p.id)).toEqual({ engine: { kind: 'chromium' }, headed: null, onePasswordVaults: [] });

    h.svc.updateProfile(org.id, p.id, { headed: true, onePasswordVaults: ['Agents'] }, OWNER);
    expect(h.svc.profileSettings(org.id, p.id)).toEqual({ engine: { kind: 'chromium' }, headed: true, onePasswordVaults: ['Agents'] });
    // A partial patch keeps the other settings.
    h.svc.updateProfile(org.id, p.id, { engine: { kind: 'channel', channel: 'chrome' } }, OWNER);
    expect(h.svc.profileSettings(org.id, p.id)).toEqual({ engine: { kind: 'channel', channel: 'chrome' }, headed: true, onePasswordVaults: ['Agents'] });
    h.svc.updateProfile(org.id, p.id, { headed: null }, OWNER);
    expect(h.svc.profileSettings(org.id, p.id).headed).toBeNull();

    // Engine and headed mode are columns of the profile row.
    expect(h.svc.listProfiles(org.id)[0]).toMatchObject({ engine: 'channel:chrome', headed: null });

    // A profile created before the column existed (bare engine object in the side file) still reads…
    h.svc.updateProfile(org.id, p.id, { engine: { kind: 'chromium' } }, OWNER);
    writeFileSync(join(p.userDataDir, 'conductor-engine.json'), JSON.stringify({ kind: 'cdp', endpoint: 'http://127.0.0.1:9222' }));
    expect(h.svc.profileSettings(org.id, p.id)).toEqual({ engine: { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' }, headed: null, onePasswordVaults: [] });
    // …and an explicit choice replaces it for good.
    h.svc.updateProfile(org.id, p.id, { engine: { kind: 'chromium' } }, OWNER);
    expect(h.svc.profileSettings(org.id, p.id).engine).toEqual({ kind: 'chromium' });
    h.svc.updateProfile(org.id, p.id, { engine: { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' } }, OWNER);
    expect(h.svc.listProfiles(org.id)[0]?.engine).toBe('cdp:http://127.0.0.1:9222');

    expect(() => h.svc.updateProfile(org.id, p.id, { engine: { kind: 'cdp', endpoint: 'http://10.0.0.5:9222' } }, OWNER)).toThrow(/localhost/);
    expect(() => h.svc.updateProfile(org.id, p.id, { onePasswordVaults: ['a/b'] }, OWNER)).toThrow(/vault/);
    const globex = seedOrg(h.k, 'Globex');
    expect(() => h.svc.profileSettings(globex.id, p.id)).toThrow(/not found/);
    const created = h.svc.createProfile(org.id, { name: 'Headed', headed: true, engine: { kind: 'chromium' } }, OWNER);
    expect(h.svc.profileSettings(org.id, created.id).headed).toBe(true);
  });

  it('launches headed when the profile asks for it, whatever the daemon default is', async () => {
    const real = chromium.launchPersistentContext.bind(chromium);
    const asked: Array<boolean | undefined> = [];
    // Record what the engine requested, but never open a window on the machine running the tests.
    vi.spyOn(chromium, 'launchPersistentContext').mockImplementation((dir, options) => {
      asked.push(options?.headless);
      return real(dir, { ...options, headless: true });
    });
    const p = h.svc.ensureProfile(org.id, ada.id);
    expect((await h.call(h.ctx(ada, 'run_default'), 'navigate', { url: site.url('/help') })).isError).toBeFalsy();
    await h.svc.endRun('run_default');
    h.svc.updateProfile(org.id, p.id, { headed: true }, OWNER);
    expect((await h.call(h.ctx(ada, 'run_headed'), 'navigate', { url: site.url('/help') })).isError).toBeFalsy();
    await h.svc.endRun('run_headed');
    h.svc.updateProfile(org.id, p.id, { headed: false }, OWNER);
    const headedDaemon = h.newService(h.k, { headless: false });
    expect((await headedDaemon.toolProvider().call(h.ctx(ada, 'run_forced_headless'), 'navigate', { url: site.url('/help') })).isError).toBeFalsy();
    await headedDaemon.endRun('run_forced_headless');
    expect(asked).toEqual([true, false, true]);
  }, T);

  it('re-issues a fresh single-use takeover link for the owner and invalidates the previous one', async () => {
    const notifications: Array<DomainEvents['notification']> = [];
    h.k.bus.on('notification', (n) => void notifications.push(n));
    const ctx = h.ctx(ada, 'run_1');
    await h.call(ctx, 'navigate', { url: site.url('/account') });
    const pending = h.call(ctx, 'request_human', { reason: 'Log in please' });
    await vi.waitFor(() => expect(notifications).toHaveLength(1), { timeout: 20_000 });
    const tokenOf = (link: string) => link.slice(`${SHARE_BASE}/takeover/`.length);
    const first = tokenOf(notifications[0]!.link!);
    const [session] = h.svc.listSessions(org.id);
    const expiresAt = session!.expiresAt;

    // Another org cannot mint a link for this session; an unknown id is not found either.
    const globex = seedOrg(h.k, 'Globex');
    await expect(h.svc.reissueShare(globex.id, session!.id, OWNER)).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.svc.reissueShare(org.id, 'bs_nope', OWNER)).rejects.toMatchObject({ code: 'not_found' });

    h.k.clock.advance(60_000);
    const again = await h.svc.reissueShare(org.id, session!.id, OWNER);
    const second = tokenOf(again.shareUrl);
    expect(again.shareUrl).toMatch(new RegExp(`^${SHARE_BASE}/takeover/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));
    expect(second).toBe(again.token);
    expect(second).not.toBe(first);
    expect(again.session).toMatchObject({ id: session!.id, status: 'pending', viewerId: null, expiresAt, tokenHash: sha256(second) });
    // Only the hash is stored, and the audit trail names the re-issue without the token.
    expect(JSON.stringify(h.k.sqlite.prepare('select * from browser_sessions').all())).not.toContain(second);
    const audit = h.k.audit.query({ orgId: org.id, action: 'browser.takeover_link_reissued' });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(second.split('.')[0]);

    // The old link is dead; the new one is single-use.
    expect(() => h.svc.claimShare(first, 'phone-1')).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(h.svc.claimShare(second, 'laptop-1')).toMatchObject({ status: 'active', viewerId: 'laptop-1' });
    expect(() => h.svc.claimShare(second, 'phone-1')).toThrow(expect.objectContaining({ code: 'forbidden' }));

    // Claimed by a device the owner lost: a re-issue drops that viewer and waits for a new one.
    const third = await h.svc.reissueShare(org.id, session!.id, OWNER);
    expect(third.session).toMatchObject({ status: 'pending', viewerId: null, claimedAt: null });
    await expect(h.svc.attachViewer(session!.id, 'laptop-1', { sendFrame: () => {}, onClose: () => {} })).rejects.toMatchObject({ code: 'forbidden' });
    expect(() => h.svc.claimShare(second, 'laptop-1')).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(h.svc.claimShare(third.token, 'desk-1')).toMatchObject({ status: 'active', viewerId: 'desk-1' });

    await h.svc.handBack(session!.id, 'desk-1');
    expect((await pending).isError).toBeFalsy();
    // Once handed back there is nothing to take over.
    await expect(h.svc.reissueShare(org.id, session!.id, OWNER)).rejects.toMatchObject({ code: 'conflict' });
  }, T);

  it('does not re-issue a link for an expired takeover', async () => {
    const ctx = h.ctx(ada, 'run_1');
    await h.call(ctx, 'navigate', { url: site.url('/help') });
    const pending = h.call(ctx, 'request_human', { reason: 'Captcha' });
    await vi.waitFor(() => expect(h.svc.listSessions(org.id)).toHaveLength(1), { timeout: 20_000 });
    const [session] = h.svc.listSessions(org.id);
    h.k.clock.advance(15 * 60_000 + 1);
    await expect(h.svc.reissueShare(org.id, session!.id, OWNER)).rejects.toMatchObject({ code: 'conflict' });
    expect(h.svc.listSessions(org.id)[0]?.status).toBe('expired');
    expect((await pending).isError).toBe(true);
  }, T);

  describe('1Password (fake `op` binary)', () => {
    it('reads through `op read`, classifies failures and never echoes stderr or the value', async () => {
      const op = fakeOp(h.k.paths.home);
      expect(opVault('op://Agents/Site Login/password')).toBe('Agents');
      expect(opVault('op://Agents/only-two')).toBeNull();
      expect(opVault('org/acme/x')).toBeNull();
      await expect(readOnePassword('op://Agents/token/credential', { bin: op.bin })).resolves.toBe(OP_SECRET);
      expect(op.calls()).toEqual(['read --no-newline op://Agents/token/credential']);
      op.mode('locked');
      await expect(readOnePassword('op://Agents/token/credential', { bin: op.bin })).rejects.toThrow(/locked or not signed in/);
      op.mode('missing');
      await expect(readOnePassword('op://Agents/nope/credential', { bin: op.bin })).rejects.toThrow(/no item or field/);
      op.mode('empty');
      await expect(readOnePassword('op://Agents/token/credential', { bin: op.bin })).rejects.toThrow(/empty value/);
      await expect(readOnePassword('op://Agents/token/credential', { bin: join(h.k.paths.home, 'absent-op') })).rejects.toThrow(/not installed/);
      await expect(readOnePassword('not-a-reference', { bin: op.bin })).rejects.toMatchObject({ code: 'validation' });
    });

    it('fill_secret fills from an allowed vault or a stored op:// reference, and fails closed otherwise', async () => {
      const op = fakeOp(h.k.paths.home);
      const svc = h.newService(h.k, { opBin: op.bin });
      const profile = svc.ensureProfile(org.id, ada.id);
      const ctx = h.ctx(ada, 'run_op');
      const outputs: string[] = [];
      const run = async (tool: string, args: Record<string, unknown> = {}) => {
        const r = await svc.toolProvider().call(ctx, tool, args);
        outputs.push(JSON.stringify(r.content));
        return r;
      };
      await run('navigate', { url: site.url('/echo-form') });

      // A direct reference is refused until the owner allows the vault on this profile.
      const denied = await run('fill_secret', { field: '#p', secret_ref: 'op://Agents/Site Login/password' });
      expect(denied.isError).toBe(true);
      expect(text(denied)).toMatch(/vault "Agents" is not allowed for this browser profile/);
      expect(op.calls()).toHaveLength(0);

      svc.updateProfile(org.id, profile.id, { onePasswordVaults: ['agents'] }, OWNER);
      const direct = await run('fill_secret', { field: '#p', secret_ref: 'op://Agents/Site Login/password' });
      expect(direct.isError).toBeFalsy();
      expect(JSON.parse(text(direct))).toEqual({ filled: true, field: '#p', secret_ref: 'op://Agents/Site Login/password' });
      // A vault that was not allowed stays closed.
      expect(text(await run('fill_secret', { field: '#t', secret_ref: 'op://Private/bank/password' }))).toMatch(/vault "Private" is not allowed/);

      // Indirect: the org secret holds a 1Password reference instead of the value.
      await h.k.secrets.set('org/acme/site/token', 'op://Agents/token/credential');
      expect((await run('fill_secret', { field: '#t', secret_ref: 'org/acme/site/token' })).isError).toBeFalsy();
      expect(text(await run('extract', { kind: 'attribute', selector: '#t', attribute: 'value' }))).toBe('[REDACTED]');
      await run('click', { selector: '#go' });
      expect(site.state.lastEcho).toBe(SITE_PASSWORD);
      expect(text(await run('extract', { selector: '#echo' }))).toBe('You sent [REDACTED] and [REDACTED]');

      // Locked, missing item, and no CLI at all: clear errors, nothing typed.
      await run('navigate', { url: site.url('/echo-form') });
      op.mode('locked');
      const locked = await run('fill_secret', { field: '#p', secret_ref: 'op://Agents/Site Login/password' });
      expect(locked.isError).toBe(true);
      expect(text(locked)).toMatch(/1Password is locked or not signed in/);
      op.mode('missing');
      expect(text(await run('fill_secret', { field: '#p', secret_ref: 'org/acme/site/token' }))).toMatch(/no item or field/);
      // Nothing was typed: the text field is still empty (a password field always reads back redacted).
      expect(text(await run('extract', { kind: 'attribute', selector: '#t', attribute: 'value' }))).toBe('');

      const noCli = h.newService(h.k); // harness default: an `op` path that does not exist
      await svc.endRun('run_op');
      const ctx2 = h.ctx(ada, 'run_op_2');
      await noCli.toolProvider().call(ctx2, 'navigate', { url: site.url('/echo-form') });
      const missing = await noCli.toolProvider().call(ctx2, 'fill_secret', { field: '#p', secret_ref: 'op://Agents/Site Login/password' });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toMatch(/1Password CLI \(`op`\) is not installed/);

      const everything = `${outputs.join('\n')}\n${JSON.stringify(missing.content)}\n${JSON.stringify(h.k.audit.query({ orgId: org.id, limit: 1000 }))}`;
      for (const secret of [SITE_PASSWORD, OP_SECRET, 'not currently signed in']) expect(everything).not.toContain(secret);
      const fills = h.k.audit.query({ orgId: org.id, action: 'browser.secret_filled' });
      expect(fills.map((f) => f.data?.secretRef).sort()).toEqual(['op://Agents/Site Login/password', 'org/acme/site/token']);
      const refusals = h.k.audit.query({ orgId: org.id, action: 'browser.secret_refused' }).map((r) => r.data?.why);
      expect(refusals).toEqual(expect.arrayContaining(['1password vault not allowed for this profile', '1password unavailable']));
    }, T);
  });

  it('keeps no plaintext cookie or storage stores at rest; the login is restored from the encrypted jar', async () => {
    await h.k.secrets.set('org/acme/site/password', SITE_PASSWORD);
    const ctx = h.ctx(ada, 'run_1');
    await h.call(ctx, 'navigate', { url: site.url('/simple-login') });
    await h.call(ctx, 'type', { selector: '#u', text: SITE_USER });
    await h.call(ctx, 'fill_secret', { field: '#p', secret_ref: 'org/acme/site/password' });
    expect(text(await h.call(ctx, 'click', { selector: '#go' }))).toContain('/account');
    const logins = site.state.logins;
    const profile = h.svc.listProfiles(org.id)[0]!;

    // While the session is live Chromium has its own (plaintext) cookie store on disk.
    expect(plaintextStores(profile.userDataDir).length).toBeGreaterThan(0);
    await h.svc.endRun('run_1');

    // At rest: the encrypted jar and nothing Chromium could read a login from.
    expect(plaintextStores(profile.userDataDir)).toEqual([]);
    expect(existsSync(join(profile.userDataDir, 'cookies.enc'))).toBe(true);
    const def = join(profile.userDataDir, 'Default');
    for (const store of ['Cookies', join('Network', 'Cookies'), 'Local Storage', 'Session Storage', 'IndexedDB', 'Login Data', 'Web Data']) {
      expect(existsSync(join(def, store)), store).toBe(false);
    }
    const key = (await h.k.secrets.get('org/acme/browser/ada/cookie-key'))!;
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    for (const file of walk(profile.userDataDir)) {
      if (statSync(file).size > 20 * 1024 * 1024) continue;
      expect(readFileSync(file).includes(Buffer.from(key, 'base64')), file).toBe(false);
    }

    // The next run (a fresh service, as after a daemon restart) is still logged in.
    const svc2 = h.newService();
    const ctx2 = h.ctx(ada, 'run_2');
    expect(text(await svc2.toolProvider().call(ctx2, 'navigate', { url: site.url('/account') }))).toContain('/account');
    expect(text(await svc2.toolProvider().call(ctx2, 'extract', { selector: 'h1' }))).toContain(`Welcome ${SITE_USER}`);
    expect(site.state.logins).toBe(logins);
    await svc2.endRun('run_2');
    expect(plaintextStores(profile.userDataDir)).toEqual([]);
  }, T);
});
