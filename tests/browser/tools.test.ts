import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { BROWSER_TEST_TIMEOUT, createHarness, text, type Harness } from './harness.js';
import { SITE_PASSWORD, startSite, type TestSite } from './site.js';

const T = BROWSER_TEST_TIMEOUT;

describe('conductor-browser tools', () => {
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
    ada = seedAgent(h.k, org.id, seedDept(h.k, org.id).id, 'Ada', { autonomyLevel: 2 });
  });
  afterEach(() => h.dispose());

  const profileId = () => h.svc.ensureProfile(org.id, ada.id).id;

  it('snapshot gives stable refs the other tools accept; read output is marked untrusted', async () => {
    const ctx = h.ctx(ada, 'run_1');
    await h.call(ctx, 'navigate', { url: site.url('/links') });
    const snap = await h.call(ctx, 'snapshot');
    expect(snap.untrusted).toBe(true);
    const tree = text(snap);
    expect(tree).toContain(`url: ${site.url('/links')}`);
    const linkRef = /link "Internal help" \[ref=(e\d+)\]/.exec(tree)?.[1];
    const selectRef = /combobox "Plan" \[ref=(e\d+)\]/.exec(tree)?.[1];
    expect(linkRef).toBeTruthy();
    expect(selectRef).toBeTruthy();

    const selected = await h.call(ctx, 'select', { ref: selectRef, values: ['Pro'] });
    expect(text(selected)).toContain('"pro"');
    expect(text(await h.call(ctx, 'extract', { kind: 'attribute', selector: '#plan', attribute: 'value' }))).toContain('pro');

    const tables = await h.call(ctx, 'extract', { kind: 'tables' });
    expect(JSON.parse(text(tables))).toEqual([[['Plan', 'Price'], ['Basic', '$5'], ['Pro', '$20']]]);
    expect(tables.untrusted).toBe(true);
    const links = JSON.parse(text(await h.call(ctx, 'extract', { kind: 'links' }))) as Array<{ text: string; href: string }>;
    expect(links).toContainEqual({ text: 'Internal help', href: site.url('/help') });
    expect(JSON.parse(text(await h.call(ctx, 'extract', { kind: 'attribute', selector: 'a', attribute: 'id', all: true })))).toEqual(['in', 'out', 'dl', 'blank']);

    const clicked = await h.call(ctx, 'click', { ref: linkRef });
    expect(clicked.untrusted).toBe(true);
    expect(JSON.parse(text(clicked))).toMatchObject({ clicked: true, url: site.url('/help'), title: 'Help' });

    // A stale ref and bad arguments are tool errors, not crashes.
    const stale = await h.call(ctx, 'extract', { ref: 'e9999', kind: 'attribute', attribute: 'id' });
    expect(stale.isError).toBe(true);
    const bad = await h.call(ctx, 'click', { ref: 'not-a-ref' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/invalid arguments for click/);
    expect(text(await h.call(ctx, 'click', {}))).toMatch(/ref.*selector/);
    expect((await h.call(ctx, 'navigate', { url: site.url('/help'), bogus: 1 })).isError).toBe(true);
    await expect(h.call(ctx, 'no_such_tool')).rejects.toThrow(/not found/);
  }, T);

  it('screenshot returns MCP image content; tabs list / new / switch / close', async () => {
    const ctx = h.ctx(ada, 'run_1');
    await h.call(ctx, 'navigate', { url: site.url('/links') });
    const shot = await h.call(ctx, 'screenshot');
    const img = shot.content.find((c) => c.type === 'image');
    expect(img).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from((img as { data: string }).data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(shot.untrusted).toBe(true);
    const jpeg = (await h.call(ctx, 'screenshot', { selector: '#prices', format: 'jpeg' })).content.find((c) => c.type === 'image');
    expect(jpeg).toMatchObject({ mimeType: 'image/jpeg' });

    const opened = JSON.parse(text(await h.call(ctx, 'tabs', { action: 'new', url: site.url('/help') }))) as { tabs: Array<{ index: number; url: string; active: boolean }> };
    expect(opened.tabs).toEqual([
      expect.objectContaining({ index: 0, url: site.url('/links'), active: false }),
      expect.objectContaining({ index: 1, url: site.url('/help'), active: true }),
    ]);
    await h.call(ctx, 'tabs', { action: 'switch', index: 0 });
    expect(text(await h.call(ctx, 'extract', { selector: '#in' }))).toContain('Internal help');
    // A target=_blank link opens a tab and the agent follows it.
    expect(JSON.parse(text(await h.call(ctx, 'click', { selector: '#blank' })))).toMatchObject({ url: site.url('/help') });
    const closed = JSON.parse(text(await h.call(ctx, 'tabs', { action: 'close' }))) as { tabs: unknown[] };
    expect(closed.tabs).toHaveLength(2);
    expect((await h.call(ctx, 'tabs', { action: 'switch', index: 7 })).isError).toBe(true);
  }, T);

  it('enforces the per-profile domain allowlist on every navigation', async () => {
    h.svc.updateProfile(org.id, profileId(), { domainAllowlist: ['127.0.0.1'] }, OWNER);
    const ctx = h.ctx(ada, 'run_1');

    const off = await h.call(ctx, 'navigate', { url: site.altUrl('/help') });
    expect(off.isError).toBe(true);
    expect(text(off)).toMatch(/localhost is not on this browser profile's domain allowlist/);
    for (const url of ['file:///etc/passwd', 'chrome://version', 'javascript:alert(1)']) {
      const r = await h.call(ctx, 'navigate', { url });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/only http\(s\)/);
    }

    expect((await h.call(ctx, 'navigate', { url: site.url('/links') })).isError).toBeFalsy();
    // A link that leaves the allowlist: the request is blocked and the click reports it.
    const out = await h.call(ctx, 'click', { selector: '#out' });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/navigation blocked: localhost/);
    expect(text(await h.call(ctx, 'extract', {}))).not.toContain('Help center');
    // A server-side redirect off the list is blocked too.
    await h.call(ctx, 'navigate', { url: site.url('/links') });
    const redirected = await h.call(ctx, 'navigate', { url: site.url('/redirect-out') });
    expect(redirected.isError).toBe(true);
    expect(text(redirected)).toMatch(/navigation blocked/);
    expect(text(await h.call(ctx, 'extract', {}))).not.toContain('Help center');
    // New tabs and URL downloads obey it as well.
    expect(text(await h.call(ctx, 'tabs', { action: 'new', url: site.altUrl('/help') }))).toMatch(/not on this browser profile's domain allowlist/);
    expect(text(await h.call(ctx, 'download', { url: site.altUrl('/file.txt') }))).toMatch(/not on this browser profile's domain allowlist/);
    expect(h.k.audit.query({ orgId: org.id, action: 'browser.navigation_blocked' }).length).toBeGreaterThanOrEqual(3);

    // An allowlist added mid-run takes effect on the next call (the tab is parked off the foreign page).
    await h.svc.endRun('run_1');
    h.svc.updateProfile(org.id, profileId(), { domainAllowlist: [] }, OWNER);
    const ctx2 = h.ctx(ada, 'run_2');
    expect((await h.call(ctx2, 'navigate', { url: site.altUrl('/help') })).isError).toBeFalsy();
    h.svc.updateProfile(org.id, profileId(), { domainAllowlist: ['*.example.com'] }, OWNER);
    const parked = await h.call(ctx2, 'extract', {});
    expect(parked.isError).toBe(true);
    expect(text(parked)).toMatch(/navigation blocked: localhost/);
  }, T);

  it('requires an approval before a pay/submit click on a sensitive domain and proceeds exactly once', async () => {
    h.svc.updateProfile(org.id, profileId(), { sensitiveDomains: ['localhost'] }, OWNER);
    const ctx = h.ctx(ada, 'run_1', { issueId: 'iss_1' });
    const paidBefore = site.state.paid;
    await h.call(ctx, 'navigate', { url: site.altUrl('/pay') });

    const first = await h.call(ctx, 'click', { selector: '#pay' });
    expect(JSON.parse(text(first))).toMatchObject({ status: 'approval_required' });
    expect(site.state.paid).toBe(paidBefore);
    expect(h.approvals.all).toHaveLength(1);
    const approval = h.approvals.all[0]!;
    expect(approval).toMatchObject({ kind: 'browser_action', status: 'pending', requesterAgentId: ada.id, runId: 'run_1', issueId: 'iss_1' });
    expect(approval.title).toBe('Click "Pay now" on localhost');
    expect(approval.payload).toMatchObject({ host: 'localhost', action: 'click', element: { tag: 'button', text: 'Pay now', submitsForm: true } });
    expect(approval.payload.matchKey).toMatch(/^[0-9a-f]{64}$/);

    // Retrying while pending neither clicks nor files a duplicate.
    expect(JSON.parse(text(await h.call(ctx, 'click', { selector: '#pay' })))).toMatchObject({ status: 'approval_pending', approvalId: approval.id });
    expect(h.approvals.all).toHaveLength(1);
    expect(site.state.paid).toBe(paidBefore);

    h.approvals.decide(org.id, approval.id, 'approved', OWNER);
    const done = await h.call(ctx, 'click', { selector: '#pay' });
    expect(done.isError).toBeFalsy();
    expect(JSON.parse(text(done))).toMatchObject({ clicked: true, title: 'Paid' });
    expect(site.state.paid).toBe(paidBefore + 1);
    expect(approval.consumedAt).not.toBeNull();

    // The approval was single-use: the same click needs a new one.
    await h.call(ctx, 'navigate', { url: site.altUrl('/pay') });
    expect(JSON.parse(text(await h.call(ctx, 'click', { selector: '#pay' })))).toMatchObject({ status: 'approval_required' });
    expect(site.state.paid).toBe(paidBefore + 1);
    expect(h.approvals.all).toHaveLength(2);
    // A denial is final for this run.
    h.approvals.decide(org.id, h.approvals.all[1]!.id, 'denied', OWNER, 'too expensive');
    const denied = await h.call(ctx, 'click', { selector: '#pay' });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/approval_denied[\s\S]*too expensive/);
    expect(h.approvals.all).toHaveLength(2);
    expect(site.state.paid).toBe(paidBefore + 1);

    // Ordinary clicks on the sensitive domain, and the same button on a non-sensitive host, are not gated.
    expect(JSON.parse(text(await h.call(ctx, 'click', { selector: '#help' })))).toMatchObject({ clicked: true, title: 'Help' });
    await h.call(ctx, 'navigate', { url: site.url('/pay') });
    expect(JSON.parse(text(await h.call(ctx, 'click', { selector: '#pay' })))).toMatchObject({ clicked: true, title: 'Paid' });
    expect(site.state.paid).toBe(paidBefore + 2);
    expect(h.approvals.all).toHaveLength(2);

    const actions = h.k.audit.query({ orgId: org.id }).map((a) => a.action);
    expect(actions.filter((a) => a === 'browser.approval_requested')).toHaveLength(2);
    expect(actions.filter((a) => a === 'browser.approval_consumed')).toHaveLength(1);
  }, T);

  it('gates evaluate by autonomy level and by approval on sensitive domains', async () => {
    h.svc.updateProfile(org.id, profileId(), { sensitiveDomains: ['localhost'] }, OWNER);
    const low = h.ctx(ada, 'run_1', { autonomyLevel: 1 });
    const provider = h.svc.toolProvider();
    expect((await provider.tools(low)).map((t) => t.name)).not.toContain('evaluate');
    const refused = await h.call(low, 'evaluate', { script: '1 + 1' });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/autonomy level 2/);
    expect(h.svc.listProfiles(org.id)[0]?.leasedRunId ?? null).toBeNull(); // refused before any browser work

    const ctx = h.ctx(ada, 'run_1');
    expect((await provider.tools(ctx)).find((t) => t.name === 'evaluate')?.risk).toBe('high');
    await h.call(ctx, 'navigate', { url: site.url('/links') });
    const ok = await h.call(ctx, 'evaluate', { script: '() => document.querySelectorAll("a").length' });
    expect(JSON.parse(text(ok))).toMatchObject({ result: 4 });
    expect(ok.untrusted).toBe(true);
    expect(JSON.parse(text(await h.call(ctx, 'evaluate', { selector: '#in', script: '(el) => el.id' })))).toMatchObject({ result: 'in' });

    await h.call(ctx, 'navigate', { url: site.altUrl('/pay') });
    const gated = await h.call(ctx, 'evaluate', { script: 'document.forms[0].submit()' });
    expect(JSON.parse(text(gated))).toMatchObject({ status: 'approval_required' });
    expect(h.approvals.all[0]?.payload).toMatchObject({ action: 'evaluate', host: 'localhost' });
    const paid = site.state.paid;
    h.approvals.decide(org.id, h.approvals.all[0]!.id, 'approved', OWNER);
    expect((await h.call(ctx, 'evaluate', { script: 'document.forms[0].submit()' })).isError).toBeFalsy();
    expect(site.state.paid).toBe(paid + 1);
    // A different script is a different action.
    await h.call(ctx, 'navigate', { url: site.altUrl('/pay') });
    expect(JSON.parse(text(await h.call(ctx, 'evaluate', { script: 'document.title' })))).toMatchObject({ status: 'approval_required' });
  }, T);

  it('fill_secret fills by reference: the value never reaches tool output or the audit log', async () => {
    const pinRef = 'org/acme/site/pin';
    await h.k.secrets.set('org/acme/site/password', SITE_PASSWORD);
    await h.k.secrets.set(pinRef, 'tok-9f8e7d6c5b4a');
    await h.k.secrets.set('org/globex/site/password', 'globex-password-1');
    await h.k.secrets.set('conductor/share-signing-key', 'c2lnbmluZy1rZXktc2lnbmluZy1rZXktc2lnbmluZy1rZXk=');
    const ctx = h.ctx(ada, 'run_1');
    const outputs: string[] = [];
    const run = async (tool: string, args: Record<string, unknown> = {}) => {
      const r = await h.call(ctx, tool, args);
      outputs.push(JSON.stringify(r.content.filter((c) => c.type === 'text')));
      return r;
    };

    await run('navigate', { url: site.url('/echo-form') });
    const snap = text(await run('snapshot'));
    const passRef = /textbox "Password" \[ref=(e\d+)\]/.exec(snap)?.[1];
    expect(passRef).toBeTruthy();

    const filled = await run('fill_secret', { field: passRef, secret_ref: 'org/acme/site/password' });
    expect(filled.isError).toBeFalsy();
    expect(JSON.parse(text(filled))).toEqual({ filled: true, field: passRef, secret_ref: 'org/acme/site/password' });
    expect((await run('fill_secret', { field: '#t', secret_ref: pinRef })).isError).toBeFalsy();

    // Every way of reading the page back.
    expect(text(await run('snapshot'))).toContain('[REDACTED]');
    await run('extract', {});
    expect(text(await run('extract', { selector: '#mirror' }))).toBe('mirror: [REDACTED]');
    expect(text(await run('extract', { kind: 'attribute', selector: '#p', attribute: 'value' }))).toBe('[REDACTED]');
    expect(text(await run('extract', { kind: 'attribute', selector: 'input', attribute: 'value', all: true }))).not.toContain('tok-');
    await run('evaluate', { script: '() => [document.querySelector("#p").value, document.querySelector("#t").value, encodeURIComponent(document.querySelector("#p").value)]' });
    await run('evaluate', { selector: '#p', script: '(el) => ({ html: el.outerHTML, v: el.value })' });
    const shot = await run('screenshot');
    expect(shot.content.some((c) => c.type === 'image')).toBe(true);
    // An error that would echo the value is scrubbed as well.
    await run('evaluate', { script: '() => { throw new Error("leak " + document.querySelector("#p").value) }' });

    // The site really received the secret, and its echo of it is redacted on the next page too.
    const sent = await run('click', { selector: '#go' });
    expect(JSON.parse(text(sent))).toMatchObject({ title: 'Echoed' });
    expect(site.state.lastEcho).toBe(SITE_PASSWORD);
    expect(text(await run('extract', { selector: '#echo' }))).toBe('You sent [REDACTED] and [REDACTED]');
    await run('snapshot');

    // Refs outside the caller's org namespace are refused — other orgs, install-level keys, the cookie vault key.
    await run('navigate', { url: site.url('/echo-form') });
    for (const ref of ['org/globex/site/password', 'conductor/share-signing-key', 'org/acme/browser/ada/cookie-key', 'org/acme/../globex/site/password', 'site/password']) {
      const r = await run('fill_secret', { field: '#p', secret_ref: ref });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/not available to this organization/);
    }
    expect(text(await run('fill_secret', { field: '#p', secret_ref: 'org/acme/site/missing' }))).toMatch(/was not found/);
    expect(text(await run('extract', { kind: 'attribute', selector: '#p', attribute: 'value' }))).toBe('[REDACTED]');
    expect(JSON.parse(text(await run('evaluate', { script: '() => document.querySelector("#p").value.length' })))).toMatchObject({ result: 0 });

    const everything = outputs.join('\n');
    for (const secret of [SITE_PASSWORD, encodeURIComponent(SITE_PASSWORD), 'Tr0ub4dor', 'tok-9f8e7d6c5b4a', 'globex-password-1']) {
      expect(everything).not.toContain(secret);
    }
    const audit = JSON.stringify(h.k.audit.query({ orgId: org.id, limit: 1000 }));
    for (const secret of [SITE_PASSWORD, 'Tr0ub4dor', 'tok-9f8e7d6c5b4a', 'globex-password-1']) expect(audit).not.toContain(secret);
    const fills = h.k.audit.query({ orgId: org.id, action: 'browser.secret_filled' });
    expect(fills).toHaveLength(2);
    expect(fills.map((f) => f.data?.secretRef).sort()).toEqual(['org/acme/site/password', pinRef]);
    expect(fills[0]?.data).toMatchObject({ host: '127.0.0.1' });
    expect(h.k.audit.query({ orgId: org.id, action: 'browser.secret_refused' })).toHaveLength(6);
    expect(JSON.stringify(h.approvals.all)).not.toContain('Tr0ub4dor');
  }, T);

  it('confines upload and download paths to the run workspace', async () => {
    const ctx = h.ctx(ada, 'run_1');
    const ws = ctx.workspacePath;
    const outside = join(dirname(ws), 'outside-secret.txt');
    writeFileSync(outside, 'TOP SECRET');
    writeFileSync(join(ws, 'notes.txt'), 'hello from the workspace');
    symlinkSync(outside, join(ws, 'link.txt'));
    symlinkSync(dirname(ws), join(ws, 'linkdir'));
    mkdirSync(join(ws, 'sub'));

    await h.call(ctx, 'navigate', { url: site.url('/upload') });
    for (const p of ['../outside-secret.txt', outside, 'link.txt', 'linkdir/outside-secret.txt', 'sub', 'missing.txt', '/etc/hosts']) {
      const r = await h.call(ctx, 'upload', { selector: '#f', paths: [p] });
      expect(r.isError, p).toBe(true);
      expect(text(r), p).toMatch(/path escapes root|not a file in the run workspace/);
    }
    expect(text(await h.call(ctx, 'extract', { selector: '#picked' }))).toBe('');
    const up = await h.call(ctx, 'upload', { selector: '#f', paths: ['notes.txt'] });
    expect(up.isError).toBeFalsy();
    expect(text(await h.call(ctx, 'extract', { selector: '#picked' }))).toBe('notes.txt: hello from the workspace');

    // Downloads: by URL (default and explicit destination) and by clicking the link.
    const byUrl = await h.call(ctx, 'download', { url: site.url('/file.txt') });
    expect(JSON.parse(text(byUrl))).toMatchObject({ saved: join('downloads', 'report.txt'), bytes: 25 });
    expect(readFileSync(join(ws, 'downloads', 'report.txt'), 'utf8')).toBe('quarterly report contents');
    expect(JSON.parse(text(await h.call(ctx, 'download', { url: site.url('/file.txt'), path: 'reports/q3.txt' })))).toMatchObject({ saved: join('reports', 'q3.txt') });
    await h.call(ctx, 'navigate', { url: site.url('/links') });
    const byClick = await h.call(ctx, 'download', { selector: '#dl', path: 'clicked.txt' });
    expect(JSON.parse(text(byClick))).toMatchObject({ saved: 'clicked.txt', suggestedFilename: 'report.txt' });
    expect(readFileSync(join(ws, 'clicked.txt'), 'utf8')).toBe('quarterly report contents');

    for (const p of ['../evil.txt', join(dirname(ws), 'evil.txt'), 'linkdir/evil.txt', 'link.txt', 'sub']) {
      const r = await h.call(ctx, 'download', { url: site.url('/file.txt'), path: p });
      expect(r.isError, p).toBe(true);
      expect(text(r), p).toMatch(/path escapes root|destination is a directory/);
    }
    expect(existsSync(join(dirname(ws), 'evil.txt'))).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('TOP SECRET');
    expect((await h.call(ctx, 'download', { url: site.url('/nope') })).isError).toBe(true);
  }, T);
});
