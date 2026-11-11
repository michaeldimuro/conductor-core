import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import { decryptJar, encryptJar, mintShareToken, newKey, verifyShareToken } from '../../src/browser/crypto.js';
import { checkNavigation, hostMatches, isUrlAllowed, normalizePatterns } from '../../src/browser/domains.js';
import { looksLikeCommit } from '../../src/browser/sensitive.js';
import type { ElementDescriptor } from '../../src/browser/page-scripts.js';
import { ProfileStore } from '../../src/browser/profiles.js';
import { toolDefs } from '../../src/browser/tool-defs.js';
import { createHarness, orgLookup, type Harness } from './harness.js';

describe('browser profiles', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => h.dispose());

  it('creates one persistent profile per agent on demand, under the org directory', () => {
    const org = seedOrg(h.k, 'Acme');
    const dept = seedDept(h.k, org.id);
    const ada = seedAgent(h.k, org.id, dept.id, 'Ada');
    const bob = seedAgent(h.k, org.id, dept.id, 'Bob');

    const p = h.svc.ensureProfile(org.id, ada.id);
    expect(p).toMatchObject({ orgId: org.id, agentId: ada.id, slug: 'ada', leasedRunId: null, domainAllowlist: [], sensitiveDomains: [] });
    expect(p.userDataDir).toBe(join(h.k.paths.home, 'orgs', 'acme', 'browser-profiles', 'ada'));
    expect(p.cookieVaultRef).toBe('org/acme/browser/ada/cookie-key');
    expect(h.svc.ensureProfile(org.id, ada.id).id).toBe(p.id);
    expect(h.svc.ensureProfile(org.id, bob.id).id).not.toBe(p.id);
    expect(h.svc.listProfiles(org.id)).toHaveLength(2);
    expect(h.k.audit.query({ orgId: org.id, action: 'browser.profile_created' })).toHaveLength(2);
  });

  it('lets a department share one profile; an agent with its own profile keeps it', () => {
    const org = seedOrg(h.k, 'Acme');
    const sales = seedDept(h.k, org.id, 'Sales');
    const eng = seedDept(h.k, org.id, 'Engineering');
    const s1 = seedAgent(h.k, org.id, sales.id, 'Sam');
    const s2 = seedAgent(h.k, org.id, sales.id, 'Sue');
    const own = seedAgent(h.k, org.id, sales.id, 'Solo');
    const e1 = seedAgent(h.k, org.id, eng.id, 'Eve');

    const shared = h.svc.createProfile(org.id, { name: 'Sales LinkedIn', deptId: sales.id, domainAllowlist: ['*.LinkedIn.com', 'linkedin.com'] }, OWNER);
    const solo = h.svc.createProfile(org.id, { name: 'Solo private', agentId: own.id }, OWNER);
    expect(shared).toMatchObject({ deptId: sales.id, agentId: null, slug: 'sales-linkedin', domainAllowlist: ['*.linkedin.com', 'linkedin.com'] });

    expect(h.svc.ensureProfile(org.id, s1.id).id).toBe(shared.id);
    expect(h.svc.ensureProfile(org.id, s2.id).id).toBe(shared.id);
    expect(h.svc.ensureProfile(org.id, own.id).id).toBe(solo.id);
    // Another department does not inherit it.
    expect(h.svc.ensureProfile(org.id, e1.id)).toMatchObject({ agentId: e1.id, deptId: null });
  });

  it('never crosses orgs: ids from another org behave as not found', () => {
    const a = seedOrg(h.k, 'Acme');
    const b = seedOrg(h.k, 'Globex');
    const deptA = seedDept(h.k, a.id);
    const deptB = seedDept(h.k, b.id);
    const ada = seedAgent(h.k, a.id, deptA.id, 'Ada');
    const zed = seedAgent(h.k, b.id, deptB.id, 'Ada'); // same slug in another org

    const pa = h.svc.ensureProfile(a.id, ada.id);
    const pb = h.svc.ensureProfile(b.id, zed.id);
    expect(pb.id).not.toBe(pa.id);
    expect(pb.userDataDir).toContain(join('orgs', 'globex'));
    expect(pa.userDataDir).not.toBe(pb.userDataDir);
    expect(h.svc.listProfiles(b.id).map((p) => p.id)).toEqual([pb.id]);

    expect(() => h.svc.ensureProfile(b.id, ada.id)).toThrow(/not found/);
    expect(() => h.svc.updateProfile(b.id, pa.id, { name: 'stolen' }, OWNER)).toThrow(/not found/);
    expect(() => h.svc.createProfile(b.id, { name: 'x', agentId: ada.id }, OWNER)).toThrow(/not found/);
    expect(() => h.svc.createProfile(b.id, { name: 'x', deptId: deptA.id }, OWNER)).toThrow(/not found/);
    expect(h.svc.listProfiles(a.id)[0]?.name).toBe('Ada');

    // A profile id pinned on an agent row is ignored when it belongs to another org.
    const store = new ProfileStore(h.k, {
      ...orgLookup(h.k),
      getAgent: (orgId, agentId) => ({ ...orgLookup(h.k).getAgent(orgId, agentId), browserProfileId: pa.id }),
    });
    expect(store.ensure(b.id, zed.id).id).toBe(pb.id);
    expect(() => store.acquireLease(b.id, pa.id, 'run_x')).toThrow(/not found/);
  });

  it('validates input, audits updates and refuses duplicate names', () => {
    const org = seedOrg(h.k, 'Acme');
    const dept = seedDept(h.k, org.id);
    const ada = seedAgent(h.k, org.id, dept.id, 'Ada');
    const p = h.svc.ensureProfile(org.id, ada.id);

    expect(() => h.svc.createProfile(org.id, { name: '' }, OWNER)).toThrow(/browser profile/);
    expect(() => h.svc.createProfile(org.id, { name: 'Bad', domainAllowlist: ['https://example.com/x'] }, OWNER)).toThrow(/hostname pattern/);
    expect(() => h.svc.createProfile(org.id, { name: 'Bad', sensitiveDomains: ['*'] }, OWNER)).toThrow(/hostname pattern/);
    expect(() => h.svc.createProfile(org.id, { name: 'Ada' }, OWNER)).toThrow(/already exists/);
    expect(() => h.svc.createProfile(org.id, { name: '../../etc' }, OWNER)).not.toThrow(); // slugified, stays inside the org dir
    expect(h.svc.listProfiles(org.id).every((x) => x.userDataDir.startsWith(join(h.k.paths.home, 'orgs', 'acme', 'browser-profiles')))).toBe(true);

    const updated = h.svc.updateProfile(org.id, p.id, { name: 'Ada main', domainAllowlist: ['Docs.Example.com'], sensitiveDomains: ['*.bank.example'] }, OWNER);
    expect(updated).toMatchObject({ name: 'Ada main', slug: 'ada', domainAllowlist: ['docs.example.com'], sensitiveDomains: ['*.bank.example'] });
    const [audit] = h.k.audit.query({ orgId: org.id, action: 'browser.profile_updated' });
    expect(audit).toMatchObject({ entityId: p.id, actor: { kind: 'human', id: 'owner' } });
    expect(audit?.data?.previous).toMatchObject({ name: 'Ada', domainAllowlist: [] });
    expect(() => h.svc.updateProfile(org.id, 'bp_missing', { name: 'x' }, OWNER)).toThrow(/not found/);
  });

  it('stores the engine choice (bundled Chromium, installed Chrome channel, or CDP on loopback only)', () => {
    const org = seedOrg(h.k, 'Acme');
    const store = new ProfileStore(h.k, orgLookup(h.k));
    const chrome = store.create(org.id, { name: 'Real Chrome', engine: { kind: 'channel', channel: 'chrome' } }, OWNER);
    expect(store.engine(chrome)).toEqual({ kind: 'channel', channel: 'chrome' });
    expect(existsSync(join(chrome.userDataDir, 'conductor-engine.json'))).toBe(true);
    const plain = store.create(org.id, { name: 'Plain' }, OWNER);
    expect(store.engine(plain)).toEqual({ kind: 'chromium' });
    store.update(org.id, plain.id, { engine: { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' } }, OWNER);
    expect(store.engine(plain)).toEqual({ kind: 'cdp', endpoint: 'http://127.0.0.1:9222' });
    expect(() => store.update(org.id, plain.id, { engine: { kind: 'cdp', endpoint: 'http://evil.example:9222' } }, OWNER)).toThrow(/localhost/);
  });

  it('leases a profile to one run at a time and recovers leases of dead runs', () => {
    const org = seedOrg(h.k, 'Acme');
    const dept = seedDept(h.k, org.id);
    const ada = seedAgent(h.k, org.id, dept.id, 'Ada');
    const store = new ProfileStore(h.k, orgLookup(h.k));
    const p = store.ensure(org.id, ada.id);

    store.acquireLease(org.id, p.id, 'run_1');
    store.acquireLease(org.id, p.id, 'run_1'); // re-entrant for the holder
    expect(() => store.acquireLease(org.id, p.id, 'run_2')).toThrow(/in use by run run_1/);
    expect(store.get(org.id, p.id)).toMatchObject({ leasedRunId: 'run_1', leasedAt: h.k.clock.now() });

    store.releaseLease(org.id, p.id, 'run_2'); // not the holder: no effect
    expect(store.get(org.id, p.id).leasedRunId).toBe('run_1');

    h.svc.recoverLeases(['run_1']);
    expect(store.get(org.id, p.id).leasedRunId).toBe('run_1');
    h.svc.recoverLeases(['run_other']);
    expect(store.get(org.id, p.id)).toMatchObject({ leasedRunId: null, leasedAt: null });
    expect(h.k.audit.query({ orgId: org.id, action: 'browser.lease_recovered' })[0]?.data).toEqual({ deadRunId: 'run_1' });
    store.acquireLease(org.id, p.id, 'run_2');
  });
});

describe('browser units', () => {
  it('matches hostname patterns exactly or by wildcard subdomain', () => {
    expect(hostMatches('app.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatches('a.b.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatches('example.com', ['*.example.com'])).toBe(false);
    expect(hostMatches('evilexample.com', ['*.example.com'])).toBe(false);
    expect(hostMatches('example.com.evil.io', ['example.com', '*.example.com'])).toBe(false);
    expect(hostMatches('EXAMPLE.com', ['example.com'])).toBe(true);
    expect(normalizePatterns([' Example.COM ', 'example.com', '*.x.io', '127.0.0.1'], 'f')).toEqual(['example.com', '*.x.io', '127.0.0.1']);
    for (const bad of ['', '*', '*.', 'a b', 'http://x.com', 'x.com/path', '*.*.com', '-x.com']) {
      expect(() => normalizePatterns([bad], 'f')).toThrow();
    }
  });

  it('only lets http(s) URLs on the allowlist through', () => {
    expect(checkNavigation('https://docs.example.com/a?b=1', ['*.example.com'])).toMatchObject({ ok: true, host: 'docs.example.com' });
    expect(checkNavigation('https://other.com/', ['*.example.com'])).toMatchObject({ ok: false });
    expect(checkNavigation('https://anything.io/', [])).toMatchObject({ ok: true });
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,hi', 'not a url']) {
      expect(checkNavigation(bad, []).ok).toBe(false);
    }
    expect(isUrlAllowed('about:blank', ['example.com'])).toBe(true);
    expect(isUrlAllowed('https://x.io/', ['example.com'])).toBe(false);
  });

  it('encrypts the cookie jar with AES-256-GCM and rejects a wrong key or tampering', () => {
    const key = newKey();
    const plain = JSON.stringify({ cookies: [{ name: 'sid', value: 'super-secret-session' }] });
    const enc = encryptJar(plain, key);
    expect(enc.includes(Buffer.from('super-secret-session'))).toBe(false);
    expect(enc.includes(Buffer.from('cookies'))).toBe(false);
    expect(decryptJar(enc, key)).toBe(plain);
    expect(encryptJar(plain, key).equals(enc)).toBe(false); // fresh IV every time
    expect(() => decryptJar(enc, newKey())).toThrow();
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => decryptJar(tampered, key)).toThrow();
    expect(() => decryptJar(Buffer.from('plain text file'), key)).toThrow(/cookie jar/);
  });

  it('signs share tokens with HMAC', () => {
    const key = newKey();
    const token = mintShareToken(key);
    expect(verifyShareToken(token, key)).toBe(true);
    expect(verifyShareToken(token, newKey())).toBe(false);
    const [nonce, sig] = token.split('.') as [string, string];
    expect(verifyShareToken(`${nonce}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, key)).toBe(false);
    expect(verifyShareToken(`${nonce.slice(0, -1)}${nonce.endsWith('A') ? 'B' : 'A'}.${sig}`, key)).toBe(false);
    expect(verifyShareToken(nonce, key)).toBe(false);
    expect(verifyShareToken('', key)).toBe(false);
  });

  it('recognises submit / purchase / send style elements', () => {
    const el = (over: Partial<ElementDescriptor>): ElementDescriptor => ({
      tag: 'div', type: '', role: '', text: '', name: '', id: '', label: '', submits: false, inForm: false, formAction: null, href: null, ...over,
    });
    expect(looksLikeCommit(el({ tag: 'button', type: 'submit', text: 'Next', submits: true, inForm: true }))).toBe(true);
    expect(looksLikeCommit(el({ tag: 'button', type: 'button', text: 'Pay now' }))).toBe(true);
    expect(looksLikeCommit(el({ tag: 'a', text: 'Confirm purchase' }))).toBe(true);
    expect(looksLikeCommit(el({ tag: 'div', role: 'button', id: 'send-btn' }))).toBe(true);
    expect(looksLikeCommit(el({ tag: 'a', text: 'Help' }))).toBe(false);
    expect(looksLikeCommit(el({ tag: 'button', type: 'button', text: 'Show details' }))).toBe(false);
    expect(looksLikeCommit(el({ tag: 'input', type: 'text', name: 'payee' }))).toBe(false);
    expect(looksLikeCommit(el({ tag: 'p', text: 'pay' }))).toBe(false);
  });

  it('exposes accurate tool definitions and hides evaluate below autonomy 2', () => {
    const defs = toolDefs(2);
    expect(defs.map((d) => d.name)).toEqual([
      'navigate', 'snapshot', 'click', 'type', 'select', 'screenshot', 'extract', 'download', 'upload', 'tabs', 'evaluate', 'fill_secret', 'request_human',
    ]);
    const risk = Object.fromEntries(defs.map((d) => [d.name, d.risk]));
    expect(risk).toMatchObject({
      navigate: 'external_read', snapshot: 'external_read', screenshot: 'external_read', extract: 'external_read',
      click: 'external_write', type: 'external_write', select: 'external_write', upload: 'external_write', evaluate: 'high',
    });
    for (const d of defs) {
      expect(d.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(d.description.length).toBeGreaterThan(10);
    }
    const byName = Object.fromEntries(defs.map((d) => [d.name, d.inputSchema as { required?: string[]; properties: Record<string, unknown> }]));
    expect(byName.navigate?.required).toEqual(['url']);
    expect(byName.fill_secret?.required).toEqual(['field', 'secret_ref']);
    expect(byName.request_human?.required).toEqual(['reason']);
    expect(Object.keys(byName.click?.properties ?? {})).toEqual(expect.arrayContaining(['ref', 'selector']));
    expect(toolDefs(1).map((d) => d.name)).not.toContain('evaluate');
  });
});
