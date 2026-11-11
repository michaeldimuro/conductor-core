import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import type { BrowserInputEvent } from '../../src/contracts/services.js';
import type { DomainEvents } from '../../src/shared/events.js';
import { sha256 } from '../../src/shared/util.js';
import { BROWSER_TEST_TIMEOUT, createHarness, SHARE_BASE, text, type Harness } from './harness.js';
import { POS, SITE_MFA_CODE, SITE_PASSWORD, SITE_USER, startSite, type TestSite } from './site.js';

const T = BROWSER_TEST_TIMEOUT;
const TTL = 15 * 60_000;

interface Frame {
  data: string;
  meta: { width: number; height: number; url: string; title: string };
}

describe('remote takeover (human-in-the-loop auth)', () => {
  let site: TestSite;
  let h: Harness;
  let org: Organization;
  let ada: Agent;
  let notifications: Array<DomainEvents['notification']>;

  beforeAll(async () => {
    site = await startSite();
  });
  afterAll(() => site.close());
  beforeEach(() => {
    h = createHarness();
    org = seedOrg(h.k, 'Acme');
    ada = seedAgent(h.k, org.id, seedDept(h.k, org.id).id, 'Ada');
    notifications = [];
    h.k.bus.on('notification', (n) => void notifications.push(n));
  });
  afterEach(() => h.dispose());

  const tokenOf = (link: string) => link.slice(`${SHARE_BASE}/takeover/`.length);
  const forbidden = expect.objectContaining({ code: 'forbidden' });

  it('FR-13: agent hits a login wall, a human completes login + MFA through the share link, the run resumes logged in', async () => {
    const ctx = h.ctx(ada, 'run_1', { issueId: 'iss_42' });
    const requested: Array<DomainEvents['browser.human_requested']> = [];
    const handedBack: Array<DomainEvents['browser.handed_back']> = [];
    h.k.bus.on('browser.human_requested', (e) => void requested.push(e));
    h.k.bus.on('browser.handed_back', (e) => void handedBack.push(e));

    // The agent runs into the login wall.
    const wall = await h.call(ctx, 'navigate', { url: site.url('/account') });
    expect(text(wall)).toContain('/login');

    // request_human pauses the run and notifies the owner with a one-time link; the tool call stays pending.
    let settled = false;
    const pending = h.call(ctx, 'request_human', { reason: 'Login and MFA code needed for the account portal' }).finally(() => (settled = true));
    await vi.waitFor(() => expect(notifications).toHaveLength(1), { timeout: 20_000 });
    expect(h.runControl.paused).toEqual([['run_1', 'needs_human']]);
    const note = notifications[0]!;
    expect(note).toMatchObject({ orgId: org.id, kind: 'takeover', body: 'Login and MFA code needed for the account portal' });
    expect(note.title).toContain('Ada');
    expect(note.link).toMatch(new RegExp(`^${SHARE_BASE}/takeover/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));
    const token = tokenOf(note.link!);
    const [session] = h.svc.listSessions(org.id);
    expect(session).toMatchObject({ status: 'pending', runId: 'run_1', issueId: 'iss_42', agentId: ada.id, viewerId: null });
    expect(session!.expiresAt).toBe(h.k.clock.now() + TTL);
    expect(requested).toEqual([{ orgId: org.id, runId: 'run_1', sessionId: session!.id, reason: note.body }]);
    // Only the hash of the token is stored; the token itself is in neither the DB nor the audit log.
    expect(session!.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(h.k.sqlite.prepare('select * from browser_sessions').all())).not.toContain(token);
    expect(JSON.stringify(h.k.audit.query({ orgId: org.id }))).not.toContain(token.split('.')[0]);
    expect(await h.k.secrets.has('conductor/share-signing-key')).toBe(true);

    // The agent is input-locked from the moment it asked.
    const early = await h.call(ctx, 'snapshot');
    expect(early.isError).toBe(true);
    expect(text(early)).toMatch(/human has control/);

    // Tampered links are rejected; a viewer cannot attach before claiming.
    const [nonce, sig] = token.split('.') as [string, string];
    expect(() => h.svc.claimShare(`${nonce}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, 'phone-1')).toThrow(forbidden);
    expect(() => h.svc.claimShare(`${nonce.slice(0, -1)}${nonce.endsWith('A') ? 'B' : 'A'}.${sig}`, 'phone-1')).toThrow(forbidden);
    expect(() => h.svc.claimShare('garbage', 'phone-1')).toThrow(forbidden);
    await expect(h.svc.attachViewer(session!.id, 'phone-1', { sendFrame: () => {}, onClose: () => {} })).rejects.toMatchObject({ code: 'forbidden' });

    // First viewer claims (explicit device confirmation); any other viewer is refused.
    const claimed = h.svc.claimShare(token, 'phone-1');
    expect(claimed).toMatchObject({ id: session!.id, status: 'active', viewerId: 'phone-1', claimedAt: h.k.clock.now() });
    expect(() => h.svc.claimShare(token, 'laptop-2')).toThrow(forbidden);
    expect(h.svc.claimShare(token, 'phone-1').id).toBe(session!.id); // same device re-opening its link
    await expect(h.svc.attachViewer(session!.id, 'laptop-2', { sendFrame: () => {}, onClose: () => {} })).rejects.toMatchObject({ code: 'forbidden' });

    // Live view: JPEG frames of the active tab.
    const frames: Frame[] = [];
    const viewer = await h.svc.attachViewer(session!.id, 'phone-1', { sendFrame: (data, meta) => void frames.push({ data, meta }), onClose: () => {} });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 20_000 });
    const first = frames[0]!;
    expect(Buffer.from(first.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(first.meta).toMatchObject({ width: 1280, height: 800, title: 'Sign in' });
    expect(first.meta.url).toBe(site.url('/login'));

    // The agent stays locked out while the human has control.
    for (const [tool, args] of [['click', { selector: '#go' }], ['type', { selector: '#u', text: 'x' }], ['navigate', { url: site.url('/help') }], ['screenshot', {}]] as const) {
      const r = await h.call(ctx, tool, args);
      expect(r.isError, tool).toBe(true);
      expect(text(r), tool).toMatch(/human has control/);
    }
    expect(text(await h.call(ctx, 'request_human', { reason: 'again' }))).toMatch(/human has control/);
    expect(settled).toBe(false);

    // The human logs in purely through forwarded input events (coordinates are in frame space).
    const send = async (...events: BrowserInputEvent[]) => {
      for (const e of events) await viewer.input(e);
    };
    const onUrl = (part: string) => vi.waitFor(() => expect(frames.at(-1)!.meta.url).toContain(part), { timeout: 20_000, interval: 50 });
    await send(
      { type: 'mouse', action: 'move', ...POS.first },
      { type: 'mouse', action: 'down', ...POS.first },
      { type: 'mouse', action: 'up', ...POS.first },
      { type: 'text', text: SITE_USER },
      { type: 'key', action: 'press', key: 'Tab' },
      { type: 'text', text: SITE_PASSWORD },
      { type: 'key', action: 'press', key: 'Enter' },
    );
    await onUrl('/mfa');
    await send({ type: 'mouse', action: 'click', ...POS.first });
    // Typed key by key, with one typo corrected by Backspace.
    for (const key of [...SITE_MFA_CODE.slice(0, 3), '0', 'Backspace', ...SITE_MFA_CODE.slice(3)]) await send({ type: 'key', action: 'press', key });
    await send({ type: 'wheel', x: 600, y: 400, deltaX: 0, deltaY: 40 }, { type: 'mouse', action: 'click', ...POS.second });
    await onUrl('/account');
    expect(site.state.mfaPassed).toBe(1);
    await expect(viewer.input({ type: 'bogus' } as unknown as BrowserInputEvent)).rejects.toMatchObject({ code: 'validation' });

    // Only the claimed viewer can hand back.
    await expect(h.svc.handBack(session!.id, 'laptop-2')).rejects.toMatchObject({ code: 'forbidden' });
    expect(settled).toBe(false);
    expect(h.runControl.resumed).toEqual([]);
    await h.svc.handBack(session!.id, 'phone-1');

    // The pending tool call resolves, the run is resumed, and the agent carries on — no re-login.
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({ status: 'handed_back', url: site.url('/account'), title: 'Account' });
    expect(h.runControl.resumed).toEqual(['run_1']);
    expect(handedBack).toEqual([{ orgId: org.id, runId: 'run_1', sessionId: session!.id }]);
    expect(h.svc.listSessions(org.id, { status: 'handed_back' })[0]).toMatchObject({ id: session!.id, handedBackAt: h.k.clock.now() });

    const loginsBefore = site.state.logins;
    expect(text(await h.call(ctx, 'extract', { selector: 'h1' }))).toBe(`Welcome ${SITE_USER}`);
    await h.call(ctx, 'navigate', { url: site.url('/help') });
    expect(text(await h.call(ctx, 'navigate', { url: site.url('/account') }))).toContain('/account');
    expect(site.state.logins).toBe(loginsBefore);

    // The link and the viewer are dead after hand-back.
    expect(() => h.svc.claimShare(token, 'phone-1')).toThrow(forbidden);
    await expect(viewer.input({ type: 'text', text: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.svc.handBack(session!.id, 'phone-1')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.svc.attachViewer(session!.id, 'phone-1', { sendFrame: () => {}, onClose: () => {} })).rejects.toMatchObject({ code: 'forbidden' });

    // And the session cookies really are in the profile: a later run is still logged in.
    await h.svc.endRun('run_1');
    expect(text(await h.call(h.ctx(ada, 'run_2'), 'navigate', { url: site.url('/account') }))).toContain('/account');
    expect(site.state.logins).toBe(loginsBefore);

    const actions = h.k.audit.query({ orgId: org.id, limit: 500 }).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining([
      'browser.takeover_created', 'browser.takeover_claimed', 'browser.takeover_viewer_attached', 'browser.takeover_handed_back', 'browser.takeover_claim_rejected',
    ]));
    expect(JSON.stringify(h.k.audit.query({ limit: 1000 }))).not.toContain(SITE_PASSWORD);
  }, T);

  it('expires an unclaimed link after 15 minutes: the tool call errors, the run is resumed and the agent unlocked', async () => {
    const ctx = h.ctx(ada, 'run_1');
    await h.call(ctx, 'navigate', { url: site.url('/login') });
    const pending = h.call(ctx, 'request_human', { reason: 'MFA' });
    await vi.waitFor(() => expect(notifications).toHaveLength(1), { timeout: 20_000 });
    const token = tokenOf(notifications[0]!.link!);

    h.k.clock.advance(TTL - 1000);
    await new Promise((r) => setTimeout(r, 500));
    expect(h.svc.listSessions(org.id)[0]?.status).toBe('pending');
    h.k.clock.advance(1000);

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/expired/);
    expect(h.svc.listSessions(org.id)[0]?.status).toBe('expired');
    expect(h.runControl.paused).toEqual([['run_1', 'needs_human']]);
    expect(h.runControl.resumed).toEqual(['run_1']);
    expect(() => h.svc.claimShare(token, 'phone-1')).toThrow(forbidden);
    expect((await h.call(ctx, 'snapshot')).isError).toBeFalsy();
    expect(h.k.audit.query({ orgId: org.id, action: 'browser.takeover_expired' })).toHaveLength(1);
  }, T);

  it('rejects an expired link at claim time and cuts off a viewer whose session ran out', async () => {
    const created = await h.svc.createTakeover({ orgId: org.id, agentId: ada.id, runId: 'run_1', issueId: null, reason: 'CAPTCHA' });
    expect(created.shareUrl).toBe(`${SHARE_BASE}/takeover/${created.token}`);
    expect(created.session).toMatchObject({ status: 'pending', reason: 'CAPTCHA' });
    await expect(h.svc.createTakeover({ orgId: org.id, agentId: ada.id, runId: 'run_1', issueId: null, reason: 'again' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(h.svc.createTakeover({ orgId: org.id, agentId: ada.id, runId: 'run_9', issueId: null, reason: '' })).rejects.toMatchObject({ code: 'validation' });

    // Claimed in time, but never handed back.
    h.svc.claimShare(created.token, 'phone-1');
    const viewer = await h.svc.attachViewer(created.session.id, 'phone-1', { sendFrame: () => {}, onClose: () => {} });
    h.k.clock.advance(TTL);
    await vi.waitFor(() => expect(h.svc.listSessions(org.id)[0]?.status).toBe('expired'), { timeout: 10_000 });
    await expect(viewer.input({ type: 'text', text: 'late' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.svc.handBack(created.session.id, 'phone-1')).rejects.toMatchObject({ code: 'forbidden' });
    expect(() => h.svc.claimShare(created.token, 'phone-1')).toThrow(forbidden);

    // A fresh link that nobody opened in time is refused at claim.
    const second = await h.svc.createTakeover({ orgId: org.id, agentId: ada.id, runId: 'run_1', issueId: null, reason: 'CAPTCHA again' });
    h.k.clock.advance(TTL + 1);
    expect(() => h.svc.claimShare(second.token, 'phone-1')).toThrow(forbidden);
    // A token minted by another install (different signing key) is refused even though it is well-formed.
    const { mintShareToken, newKey } = await import('../../src/browser/crypto.js');
    expect(() => h.svc.claimShare(mintShareToken(newKey()), 'phone-1')).toThrow(forbidden);
  }, T);

  it('cancels the takeover when the run ends, enforces the allowlist on viewer navigation, and scopes sessions by org', async () => {
    const other = seedOrg(h.k, 'Globex');
    h.svc.updateProfile(org.id, h.svc.ensureProfile(org.id, ada.id).id, { domainAllowlist: ['127.0.0.1'] }, { kind: 'human', id: 'owner' });
    const ctx = h.ctx(ada, 'run_1');
    await h.call(ctx, 'navigate', { url: site.url('/login') });
    const pending = h.call(ctx, 'request_human', { reason: 'consent screen' });
    await vi.waitFor(() => expect(notifications).toHaveLength(1), { timeout: 20_000 });
    const session = h.svc.claimShare(tokenOf(notifications[0]!.link!), 'phone-1');
    expect(h.svc.listSessions(other.id)).toEqual([]);
    expect(h.svc.listSessions(org.id, { status: 'active' })).toHaveLength(1);

    const frames: Frame[] = [];
    let closeViewer: () => void = () => {};
    const viewer = await h.svc.attachViewer(session.id, 'phone-1', { sendFrame: (data, meta) => void frames.push({ data, meta }), onClose: (fn) => (closeViewer = fn) });
    await viewer.input({ type: 'navigate', url: site.url('/help') });
    await vi.waitFor(() => expect(frames.at(-1)?.meta.url).toBe(site.url('/help')), { timeout: 20_000 });
    await expect(viewer.input({ type: 'navigate', url: site.altUrl('/help') })).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(viewer.input({ type: 'navigate', url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'policy_denied' });

    // The socket closing detaches the viewer; the same device can re-attach.
    closeViewer();
    await vi.waitFor(() => expect(viewer.input({ type: 'text', text: 'x' })).rejects.toMatchObject({ code: 'forbidden' }));
    const again = await h.svc.attachViewer(session.id, 'phone-1', { sendFrame: () => {}, onClose: () => {} });
    await again.input({ type: 'mouse', action: 'move', x: 10, y: 10 });

    await h.svc.endRun('run_1');
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/cancelled/);
    expect(h.svc.listSessions(org.id)[0]?.status).toBe('cancelled');
    expect(h.runControl.resumed).toEqual([]); // the run is over; nothing to resume
    expect(h.svc.listProfiles(org.id)[0]?.leasedRunId).toBeNull();

    // Crash recovery marks sessions of dead runs cancelled.
    h.k.sqlite.prepare("update browser_sessions set status = 'active' where id = ?").run(session.id);
    h.svc.recoverLeases([]);
    expect(h.svc.listSessions(org.id)[0]?.status).toBe('cancelled');
  }, T);
});
