import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApiServer } from '../../src/api/index.js';
import { attachmentContentType, contentDisposition } from '../../src/api/routes/attachments.js';
import { isLoopbackHost } from '../../src/api/http.js';
import { defaultKeyRefs } from '../../src/api/routes/system.js';
import { conflict, notFound } from '../../src/shared/errors.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Comment, Issue } from '../../src/contracts/rows.js';
import { createFake, createHarness, type Harness } from './fake-services.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = h.owner) =>
  h.api.app.inject({ method, url: `/api/v1${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe('takeover link re-issue (owner only)', () => {
  it('returns a fresh single-use link once, never caches it, and scopes the session to its org', async () => {
    const t = h.addTakeover('old-token');
    h.browser.reissueShare.mockImplementation(async (orgId, sessionId) => {
      if (orgId !== h.orgA.id || sessionId !== t.session.id) throw notFound('takeover session', sessionId);
      return { session: t.session, shareUrl: 'https://mac.tailnet.example/takeover/new.token', token: 'new.token' };
    });
    const res = await call('POST', `/orgs/${h.orgA.slug}/browser/sessions/${t.session.id}/share-link`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ sessionId: t.session.id, url: 'https://mac.tailnet.example/takeover/new.token', path: '/takeover/new.token', expiresAt: t.session.expiresAt });
    expect(h.browser.reissueShare).toHaveBeenCalledWith(h.orgA.id, t.session.id, OWNER);

    // Another org's path cannot reach the session; an ended session is a conflict.
    expect((await call('POST', `/orgs/${h.orgB.slug}/browser/sessions/${t.session.id}/share-link`)).statusCode).toBe(404);
    h.browser.reissueShare.mockRejectedValueOnce(conflict('this takeover is handed back; the agent has to ask again'));
    expect((await call('POST', `/orgs/${h.orgA.slug}/browser/sessions/${t.session.id}/share-link`)).statusCode).toBe(409);
  });

  it('refuses anonymous callers, run tokens and the takeover viewer cookie', async () => {
    const t = h.addTakeover('tok');
    const url = `/orgs/${h.orgA.slug}/browser/sessions/${t.session.id}/share-link`;
    expect((await call('POST', url, undefined, {})).statusCode).toBe(401);
    const run = h.startRun();
    expect((await call('POST', url, undefined, { authorization: `Bearer ${run.token}` })).statusCode).toBe(403);
    expect((await call('POST', url, undefined, { cookie: 'conductor_viewer=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).statusCode).toBe(401);
    expect(h.browser.reissueShare).not.toHaveBeenCalled();
  });
});

describe('browser profile engine and headed mode', () => {
  const row = { id: 'bp_1', orgId: '', slug: 'ada', name: 'Ada', agentId: null, deptId: null, domainAllowlist: [], sensitiveDomains: [], engine: 'bundled', headed: null };

  it('accepts engine, headed and 1Password vaults and returns them on the profile', async () => {
    const profile = { ...row, orgId: h.orgA.id };
    h.browser.listProfiles.mockReturnValue([profile] as never);
    h.browser.updateProfile.mockReturnValue(profile as never);
    h.browser.createProfile.mockReturnValue(profile as never);
    h.browser.profileSettings.mockReturnValue({ engine: { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' }, headed: true, onePasswordVaults: ['Agents'] });

    const patch = { engine: { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' }, headed: true, onePasswordVaults: ['Agents'] };
    const res = await call('PATCH', `/orgs/${h.orgA.slug}/browser/profiles/bp_1`, patch);
    expect(res.statusCode).toBe(200);
    expect(h.browser.updateProfile).toHaveBeenCalledWith(h.orgA.id, 'bp_1', patch, OWNER);
    expect(res.json()).toMatchObject({ id: 'bp_1', engine: { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' }, headed: true, onePasswordVaults: ['Agents'] });

    const created = await call('POST', `/orgs/${h.orgA.slug}/browser/profiles`, { name: 'My Chrome', engine: { kind: 'channel', channel: 'chrome' }, headed: null });
    expect(created.statusCode).toBe(200);
    expect(h.browser.createProfile).toHaveBeenCalledWith(h.orgA.id, { name: 'My Chrome', engine: { kind: 'channel', channel: 'chrome' }, headed: null }, OWNER);
    expect((await call('GET', `/orgs/${h.orgA.slug}/browser/profiles`)).json()[0]).toMatchObject({ headed: true, engine: { kind: 'cdp' } });
  });

  it('rejects malformed engines at the boundary', async () => {
    for (const bad of [{ engine: { kind: 'firefox' } }, { engine: { kind: 'channel', channel: 'safari' } }, { engine: { kind: 'cdp' } }, { headed: 'yes' }, { engine: 'cdp' }]) {
      expect((await call('PATCH', `/orgs/${h.orgA.slug}/browser/profiles/bp_1`, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(h.browser.updateProfile).not.toHaveBeenCalled();
  });
});

describe('memory backend per org', () => {
  it('stores settings["memory.backend.<orgId>"] with a secret ref only, reports readiness and clears', async () => {
    // This daemon build has no accessor on the memory service: the route owns the settings row.
    (h.memory as unknown as Record<string, unknown>).getExternalBackend = undefined;
    (h.memory as unknown as Record<string, unknown>).setExternalBackend = undefined;
    const url = `/orgs/${h.orgA.slug}/memory-backend`;
    expect((await call('GET', url)).json()).toEqual({ backend: null });

    const put = await call('PUT', url, { kind: 'mem0', authRef: 'org/acme/mem0-key' });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ backend: { kind: 'mem0', authRef: 'org/acme/mem0-key', ready: false } });
    const stored = h.kernel.sqlite.prepare('select value from settings where key = ?').get(`memory.backend.${h.orgA.id}`) as { value: string };
    expect(JSON.parse(stored.value)).toEqual({ kind: 'mem0', authRef: 'org/acme/mem0-key' });

    await h.kernel.secrets.set('org/acme/mem0-key', 'm0-secret-value');
    const got = await call('GET', url);
    expect(got.json()).toEqual({ backend: { kind: 'mem0', authRef: 'org/acme/mem0-key', ready: true } });
    expect(got.body).not.toContain('m0-secret-value');
    // Another org is unaffected.
    expect((await call('GET', `/orgs/${h.orgB.slug}/memory-backend`)).json()).toEqual({ backend: null });

    expect((await call('PUT', url, { kind: 'pinecone', authRef: 'org/acme/k' })).statusCode).toBe(400);
    expect((await call('PUT', url, { kind: 'zep', authRef: '../etc/passwd' })).statusCode).toBe(400);
    expect((await call('PUT', url, { kind: 'zep', authRef: 'org/acme/k', baseUrl: 'ftp://zep.example' })).statusCode).toBe(400);
    expect((await call('PUT', url, { kind: 'zep', authRef: 'org/acme/k', apiKey: 'sk-inline' })).statusCode).toBe(400);

    expect((await call('DELETE', url)).json()).toEqual({ backend: null });
    expect((await call('GET', url)).json()).toEqual({ backend: null });
    const audit = h.kernel.audit.query({ orgId: h.orgA.id, action: 'config.changed' });
    expect(audit.map((a) => a.entityId)).toEqual(expect.arrayContaining([`memory.backend.${h.orgA.id}`]));
    expect(JSON.stringify(audit)).not.toContain('m0-secret-value');
  });

  it('delegates to the memory service when it provides the accessors', async () => {
    const status = { kind: 'honcho' as const, authRef: 'org/acme/honcho', options: { workspace: 'acme' }, ready: true };
    h.memory.getExternalBackend!.mockResolvedValue(status);
    h.memory.setExternalBackend!.mockResolvedValue(status);
    expect((await call('GET', `/orgs/${h.orgA.slug}/memory-backend`)).json()).toEqual({ backend: status });
    const cfg = { kind: 'honcho', authRef: 'org/acme/honcho', options: { workspace: 'acme' } };
    expect((await call('PUT', `/orgs/${h.orgA.slug}/memory-backend`, cfg)).json()).toEqual({ backend: status });
    expect(h.memory.setExternalBackend).toHaveBeenCalledWith(h.orgA.id, cfg, OWNER);
    await call('DELETE', `/orgs/${h.orgA.slug}/memory-backend`);
    expect(h.memory.setExternalBackend).toHaveBeenLastCalledWith(h.orgA.id, null, OWNER);
  });
});

describe('lifecycle routes', () => {
  it('exposes unarchive, department archive, goal delete, project update and playbook update/delete', async () => {
    const o = h.orgA.slug;
    h.org.unarchiveOrg!.mockReturnValue({ ...h.orgA, status: 'active' });
    h.org.archiveDept!.mockReturnValue({ ...h.dept, status: 'archived' });
    h.org.unarchiveDept!.mockReturnValue({ ...h.dept, status: 'active' });
    expect((await call('POST', `/orgs/${o}/unarchive`)).json()).toMatchObject({ id: h.orgA.id, status: 'active' });
    expect(h.org.unarchiveOrg).toHaveBeenCalledWith(h.orgA.id, OWNER);
    expect((await call('POST', `/orgs/${o}/departments/${h.dept.id}/archive`)).json()).toMatchObject({ status: 'archived' });
    expect(h.org.archiveDept).toHaveBeenCalledWith(h.orgA.id, h.dept.id, OWNER);
    expect((await call('POST', `/orgs/${o}/departments/${h.dept.id}/unarchive`)).statusCode).toBe(200);

    expect((await call('DELETE', `/orgs/${o}/goals/goal_1`)).json()).toEqual({ ok: true });
    expect(h.work.deleteGoal).toHaveBeenCalledWith(h.orgA.id, 'goal_1', OWNER);
    h.work.updateProject!.mockReturnValue({ id: 'proj_1', name: 'Renamed' } as never);
    expect((await call('PATCH', `/orgs/${o}/projects/proj_1`, { name: 'Renamed', status: 'archived', budgetUsd: 50 })).json()).toMatchObject({ name: 'Renamed' });
    expect(h.work.updateProject).toHaveBeenCalledWith(h.orgA.id, 'proj_1', { name: 'Renamed', status: 'archived', budgetUsd: 50 }, OWNER);
    expect((await call('PATCH', `/orgs/${o}/projects/proj_1`, { status: 'deleted' })).statusCode).toBe(400);

    h.work.updatePlaybook!.mockReturnValue({ id: 'pb_1', name: 'Launch v2' } as never);
    expect((await call('PATCH', `/orgs/${o}/playbooks/pb_1`, { name: 'Launch v2' })).json()).toMatchObject({ name: 'Launch v2' });
    expect(h.work.updatePlaybook).toHaveBeenCalledWith(h.orgA.id, 'pb_1', { name: 'Launch v2' }, OWNER);
    expect((await call('PATCH', `/orgs/${o}/playbooks/pb_1`, { steps: [] })).statusCode).toBe(400);
    expect((await call('DELETE', `/orgs/${o}/playbooks/pb_1`)).json()).toEqual({ ok: true });
    expect(h.work.deletePlaybook).toHaveBeenCalledWith(h.orgA.id, 'pb_1', OWNER);
    expect((await call('DELETE', '/orgs/no-such-org/playbooks/pb_1')).statusCode).toBe(404);
  });

  it('answers 503 with a clear message when the service does not offer the operation', async () => {
    (h.org as unknown as Record<string, unknown>).unarchiveOrg = undefined;
    (h.work as unknown as Record<string, unknown>).deleteGoal = undefined;
    const res = await call('POST', `/orgs/${h.orgA.slug}/unarchive`);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/not supported by this daemon build/);
    expect((await call('DELETE', `/orgs/${h.orgA.slug}/goals/goal_1`)).statusCode).toBe(503);
  });
});

describe('comment attachment download', () => {
  let issue: Issue;
  let orgDir: string;
  const comment = (attachments: Comment['attachments']): Comment =>
    ({ id: 'cmt_1', orgId: h.orgA.id, issueId: issue.id, attachments, body: 'see attached' }) as unknown as Comment;
  const url = (index: number | string, org = h.orgA.slug, commentId = 'cmt_1') => `/orgs/${org}/issues/${issue.number}/comments/${commentId}/attachments/${index}`;

  beforeEach(() => {
    issue = h.work.createIssue(h.orgA.id, { title: 'Report' }, OWNER);
    orgDir = h.kernel.paths.org(h.orgA.slug);
    mkdirSync(join(orgDir, 'artifacts'), { recursive: true });
    mkdirSync(join(orgDir, 'browser-profiles', 'ada'), { recursive: true });
    mkdirSync(h.kernel.paths.org(h.orgB.slug), { recursive: true });
    writeFileSync(join(orgDir, 'artifacts', 'report.csv'), 'a,b\n1,2\n');
    writeFileSync(join(orgDir, 'artifacts', 'page.html'), '<script>alert(1)</script>');
    writeFileSync(join(orgDir, 'browser-profiles', 'ada', 'cookies.enc'), 'jar');
    writeFileSync(join(h.kernel.paths.org(h.orgB.slug), 'secret.txt'), 'globex only');
    writeFileSync(join(h.kernel.paths.home, 'owner.token'), 'cnd_owner_secret');
    symlinkSync(join(h.kernel.paths.home, 'owner.token'), join(orgDir, 'artifacts', 'link.txt'));
  });

  it('streams a file inside the org directory as a download with the right type', async () => {
    h.work.listComments.mockReturnValue([comment([
      { name: 'Q3 report — final.csv', path: join(orgDir, 'artifacts', 'report.csv') },
      { name: 'page.html', path: join(orgDir, 'artifacts', 'page.html'), mime: 'text/html' },
    ])]);
    const res = await call('GET', url(0));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('a,b\n1,2\n');
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="Q3 report _ final.csv"; filename*=UTF-8''Q3%20report%20%E2%80%94%20final.csv`);
    expect(res.headers['content-length']).toBe('8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // HTML is never rendered inline from the daemon's origin.
    const html = await call('GET', url(1));
    expect(html.headers['content-type']).toBe('text/html');
    expect(html.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('requires the owner and refuses paths that leave the org directory', async () => {
    h.work.listComments.mockReturnValue([comment([
      { name: 'token', path: join(h.kernel.paths.home, 'owner.token') },
      { name: 'other-org', path: join(h.kernel.paths.org(h.orgB.slug), 'secret.txt') },
      { name: 'traversal', path: join(orgDir, 'artifacts', '..', '..', h.orgB.slug, 'secret.txt') },
      { name: 'symlink', path: join(orgDir, 'artifacts', 'link.txt') },
      { name: 'jar', path: join(orgDir, 'browser-profiles', 'ada', 'cookies.enc') },
      { name: 'gone', path: join(orgDir, 'artifacts', 'missing.bin') },
      { name: 'dir', path: join(orgDir, 'artifacts') },
    ])]);
    for (const i of [0, 1, 2, 3, 4]) {
      const res = await call('GET', url(i));
      expect(res.statusCode, `attachment ${i}`).toBe(403);
      expect(res.body).not.toContain('cnd_owner_secret');
      expect(res.body).not.toContain('globex only');
    }
    expect((await call('GET', url(5))).statusCode).toBe(404);
    expect((await call('GET', url(6))).statusCode).toBe(404);
    expect((await call('GET', url(7))).statusCode).toBe(404);
    expect((await call('GET', url('x'))).statusCode).toBe(400);
    expect((await call('GET', url(0, h.orgA.slug, 'cmt_other'))).statusCode).toBe(404);
    expect((await call('GET', url(0, h.orgB.slug))).statusCode).toBe(404);
    expect((await call('GET', url(0), undefined, {})).statusCode).toBe(401);
    const run = h.startRun();
    expect((await call('GET', url(0), undefined, { authorization: `Bearer ${run.token}` })).statusCode).toBe(403);
  });

  it('derives content types and download names safely', () => {
    expect(attachmentContentType('a.PNG', '/x/a', undefined)).toBe('image/png');
    expect(attachmentContentType('blob', '/x/blob.pdf', undefined)).toBe('application/pdf');
    expect(attachmentContentType('blob', '/x/blob', 'text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
    expect(attachmentContentType('blob', '/x/blob', 'text/html\r\nSet-Cookie: x=1')).toBe('application/octet-stream');
    expect(contentDisposition('../../etc/pass"wd\r\n')).toBe(`attachment; filename="pass_wd"; filename*=UTF-8''pass%22wd`);
    expect(contentDisposition('')).toMatch(/filename="attachment"/);
  });
});

describe('run now, adapter test and bind address', () => {
  it('passes the skip reason through instead of a bare job id', async () => {
    const url = `/orgs/${h.orgA.slug}/agents/${h.agent.slug}/run`;
    expect((await call('POST', url, {})).json()).toEqual({ jobId: 'job_1' });
    h.runtime.runNow.mockResolvedValueOnce({ jobId: '', skipped: { code: 'kill_switch', reason: 'kill switch engaged', temporary: false } });
    expect((await call('POST', url, {})).json()).toEqual({ jobId: '', skipped: { code: 'kill_switch', reason: 'kill switch engaged', temporary: false } });
  });

  it('falls back to the conventional key refs when no authRef is given', async () => {
    expect(defaultKeyRefs('claude_api', 'acme')).toEqual(['org/acme/anthropic-api-key', 'conductor/anthropic-api-key']);
    expect(defaultKeyRefs('openai_api')).toEqual(['conductor/openai-api-key']);
    expect(defaultKeyRefs('claude_local', 'acme')).toEqual([]);

    const testConnection = vi.fn(async (cfg: { secrets: Record<string, string> }) => ({ ok: Boolean(cfg.secrets.apiKey), detail: cfg.secrets.apiKey ? 'key present' : 'no key' }));
    const fake = h.services.registry.get('fake')!;
    (h.services.registry as { get: (id: string) => unknown }).get = (id) => (id === 'claude_api' ? { ...fake, id: 'claude_api', testConnection } : id === 'fake' ? fake : undefined);

    expect((await call('POST', '/adapters/claude_api/test', {})).json()).toEqual({ ok: false, detail: 'no key' });
    await h.kernel.secrets.set('conductor/anthropic-api-key', 'sk-install-wide');
    expect((await call('POST', '/adapters/claude_api/test', {})).json().ok).toBe(true);
    expect(testConnection.mock.lastCall![0].secrets).toEqual({ apiKey: 'sk-install-wide' });
    // With an org, its own key wins over the install-wide one.
    await h.kernel.secrets.set('org/acme/anthropic-api-key', 'sk-acme');
    expect((await call('POST', '/adapters/claude_api/test', { orgId: 'acme' })).json().ok).toBe(true);
    expect(testConnection.mock.lastCall![0].secrets).toEqual({ apiKey: 'sk-acme' });
    expect((await call('POST', '/adapters/claude_api/test', { orgId: 'globex' })).json().ok).toBe(true);
    expect(testConnection.mock.lastCall![0].secrets).toEqual({ apiKey: 'sk-install-wide' });
    expect((await call('POST', '/adapters/claude_api/test', { orgId: 'no-such-org' })).statusCode).toBe(404);
    // An explicit ref is never silently replaced by a default.
    expect((await call('POST', '/adapters/claude_api/test', { authRef: 'org/acme/missing' })).json()).toEqual({ ok: false, detail: 'no secret stored under org/acme/missing' });
  });

  it('reports the bind address and warns loudly when it is not loopback', async () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.8.9.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    for (const host of ['0.0.0.0', '::', '192.168.1.20', '100.64.0.7', 'mac.local', '1270.0.0.1']) expect(isLoopbackHost(host), host).toBe(false);

    expect((await call('GET', '/status')).json().bind).toEqual({ host: '127.0.0.1', loopback: true });
    expect((await call('GET', '/doctor')).json().bind).toEqual({ host: '127.0.0.1', loopback: true });

    const fake = createFake();
    const warn = vi.spyOn(fake.kernel.log, 'warn');
    const api = await createApiServer(fake.services, { uiDir: '/nonexistent/conductor-ui' });
    try {
      // Stub the socket: this test must not open a port on every interface.
      const listen = vi.spyOn(api.app, 'listen').mockResolvedValue('http://0.0.0.0:0' as never);
      await api.listen('0.0.0.0', 7999);
      expect(listen).toHaveBeenCalledWith({ host: '0.0.0.0', port: 7999 });
      expect(warn).toHaveBeenCalledWith({ host: '0.0.0.0', port: 7999 }, expect.stringMatching(/SECURITY WARNING: Conductor is listening on 0\.0\.0\.0, not on loopback/));
      const headers = { authorization: `Bearer ${fake.ownerToken}` };
      expect((await api.app.inject({ method: 'GET', url: '/api/v1/status', headers })).json().bind).toEqual({ host: '0.0.0.0', loopback: false });
      expect((await api.app.inject({ method: 'GET', url: '/api/v1/doctor', headers })).json().bind).toEqual({ host: '0.0.0.0', loopback: false });
    } finally {
      await api.close();
      fake.dispose();
    }
    const quiet = vi.spyOn(h.kernel.log, 'warn');
    await h.listen();
    expect(quiet.mock.calls.filter((c) => String(c[1]).includes('SECURITY WARNING'))).toHaveLength(0);
  });
});
