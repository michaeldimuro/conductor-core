import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './fake-services.js';
import { ConductorError } from '../../src/shared/errors.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Skill } from '../../src/contracts/rows.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  h.api.app.inject({ method, url: `/api/v1${url}`, headers: h.owner, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe('system', () => {
  it('reports status with runtime, kill switch and counts', async () => {
    const res = await call('GET', '/status');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: '0.0.0-test',
      runtime: { running: 0, uptimeMs: 1234 },
      killSwitch: { global: false, orgs: [] },
      counts: { orgs: 2, agents: 2, pendingApprovals: 0 },
    });
  });

  it('engages and releases the global and per-org kill switches', async () => {
    expect((await call('POST', '/kill-switch')).json()).toEqual({ engaged: true });
    expect((await call('GET', '/status')).json().killSwitch.global).toBe(true);
    expect((await call('DELETE', '/kill-switch')).json()).toEqual({ engaged: false });

    expect((await call('POST', `/orgs/${h.orgA.slug}/kill-switch`)).json()).toEqual({ engaged: true });
    expect((await call('GET', '/status')).json().killSwitch.orgs).toEqual([h.orgA.id]);
    expect((await call('DELETE', `/orgs/${h.orgA.id}/kill-switch`)).json()).toEqual({ engaged: false });
  });

  it('exposes only allow-listed settings and validates their values', async () => {
    expect((await call('GET', '/settings/daemon.public_url')).json()).toEqual({ key: 'daemon.public_url', value: null });
    const put = await call('PUT', '/settings/daemon.public_url', { value: 'https://mac.tailnet.example' });
    expect(put.statusCode).toBe(200);
    expect((await call('GET', '/settings/daemon.public_url')).json().value).toBe('https://mac.tailnet.example');
    expect((await call('PUT', '/settings/embeddings.provider', { value: 'openai' })).statusCode).toBe(200);

    expect((await call('PUT', '/settings/daemon.public_url', { value: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await call('PUT', '/settings/embeddings.provider', { value: 'skynet' })).statusCode).toBe(400);
    expect((await call('GET', '/settings/kill_switch.global')).statusCode).toBe(404);
    expect((await call('PUT', '/settings/kill_switch.global', { value: true })).statusCode).toBe(404);
  });

  it('gives the doctor adapters, secret-store reachability and binding checks', async () => {
    const plain = await call('GET', '/doctor');
    expect(plain.json()).toMatchObject({ secretStore: { reachable: true }, adapters: [{ id: 'fake' }], publicUrlConfigured: false });
    expect(plain.json().bindings).toBeUndefined();

    await h.kernel.secrets.set('org/acme/key', 'sk-test-key-value');
    h.org.getOrgBySlug.mockImplementation((slug) => (slug === 'acme' ? { ...h.orgA, defaultProvider: { adapter: 'fake', model: 'm1', authRef: 'org/acme/key' } } : null));
    const withOrg = await call('GET', '/doctor?orgId=acme');
    expect(withOrg.json().bindings).toEqual([{ source: 'org-default', adapter: 'fake', model: 'm1', health: { ok: true, detail: 'key present' } }]);
    expect(withOrg.body).not.toContain('sk-test-key-value');
  });

  it('tests an ad-hoc adapter binding, resolving the key by reference', async () => {
    await h.kernel.secrets.set('k1', 'sk-test-key-value');
    expect((await call('POST', '/adapters/fake/test', { authRef: 'k1' })).json()).toEqual({ ok: true, detail: 'key present' });
    expect((await call('POST', '/adapters/fake/test', { authRef: 'missing' })).json().ok).toBe(false);
    expect((await call('POST', '/adapters/nope/test', {})).statusCode).toBe(404);
    expect((await call('GET', '/adapters')).json()[0].id).toBe('fake');
  });
});

describe('secrets are write-only', () => {
  it('stores, reports existence, deletes — and never returns or audits a value', async () => {
    const value = 'super-secret-value-12345';
    const put = await call('PUT', '/secrets/org/acme/stripe-key', { value });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ref: 'org/acme/stripe-key', exists: true });
    expect(await h.kernel.secrets.get('org/acme/stripe-key')).toBe(value);

    const get = await call('GET', '/secrets/org/acme/stripe-key');
    expect(get.json()).toEqual({ ref: 'org/acme/stripe-key', exists: true });
    expect(put.body + get.body).not.toContain(value);
    expect(JSON.stringify(h.kernel.audit.query({ limit: 1000 }))).not.toContain(value);
    expect(h.kernel.audit.query({ action: 'secret.set' })).toHaveLength(1);

    expect((await call('GET', '/secrets/org%2Facme%2Fstripe-key')).json().exists).toBe(true);
    expect((await call('DELETE', '/secrets/org/acme/stripe-key')).json()).toEqual({ ref: 'org/acme/stripe-key', exists: false });
    expect((await call('GET', '/secrets/org/acme/stripe-key')).json().exists).toBe(false);
  });

  it('validates refs and bodies', async () => {
    expect((await call('PUT', '/secrets/bad%20ref', { value: 'x' })).statusCode).toBe(400);
    expect((await call('PUT', '/secrets/ok-ref', {})).statusCode).toBe(400);
    expect((await call('PUT', '/secrets/ok-ref', { value: 'x', extra: 1 })).statusCode).toBe(400);
  });
});

describe('orgs, departments, agents', () => {
  it('resolves orgs by id or slug and 404s unknown ones on every org-scoped path', async () => {
    expect((await call('GET', `/orgs/${h.orgA.id}`)).json().slug).toBe('acme');
    expect((await call('GET', '/orgs/acme')).json().id).toBe(h.orgA.id);
    for (const url of ['/orgs/nope', '/orgs/nope/issues', '/orgs/org_missing/agents', '/orgs/nope/skills', '/orgs/nope/webhooks', '/orgs/nope/activity', '/orgs/nope/budget/summary']) {
      const res = await call('GET', url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });

  it('creates orgs (also from a template) as the OWNER and validates input', async () => {
    const created = await call('POST', '/orgs', { name: 'Initech', mission: 'TPS reports' });
    expect(created.statusCode).toBe(200);
    expect(h.org.createOrg).toHaveBeenCalledWith({ name: 'Initech', mission: 'TPS reports' }, OWNER);

    expect((await call('GET', '/org-templates')).json()[0].id).toBe('startup');
    await call('POST', '/orgs/from-template', { templateId: 'startup', name: 'Hooli' });
    expect(h.org.createFromTemplate).toHaveBeenCalledWith('startup', { name: 'Hooli' }, OWNER);

    const bad = await call('POST', '/orgs', { name: '', bogus: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation');
    expect(bad.json().error.details.issues.length).toBeGreaterThan(0);
    expect((await call('POST', '/orgs/import', { name: 'X', bundle: { format: 'wrong' } })).statusCode).toBe(400);
  });

  it('hires, pauses and addresses agents by id or slug, never across orgs', async () => {
    const hired = await call('POST', `/orgs/${h.orgA.id}/agents`, { deptId: h.dept.id, name: 'Grace', role: 'Analyst' });
    expect(hired.json().agent.name).toBe('Grace');
    expect((await call('GET', `/orgs/acme/agents/ada`)).json().id).toBe(h.agent.id);
    expect((await call('POST', `/orgs/acme/agents/${h.agent.id}/pause`, { reason: 'holiday' })).json().status).toBe('paused');
    expect(h.org.pauseAgent).toHaveBeenCalledWith(h.orgA.id, h.agent.id, 'holiday', OWNER);

    // Globex's agent addressed through Acme behaves as not found.
    expect((await call('GET', `/orgs/acme/agents/${h.agentB.id}`)).statusCode).toBe(404);
    expect((await call('POST', `/orgs/acme/agents/${h.agentB.id}/run`)).statusCode).toBe(404);
    expect(h.runtime.runNow).not.toHaveBeenCalled();
  });

  it('runs and chats with an agent through the runtime', async () => {
    const run = await call('POST', '/orgs/acme/agents/ada/run', { prompt: 'check the inbox' });
    expect(run.json()).toEqual({ jobId: 'job_1' });
    expect(h.runtime.runNow).toHaveBeenCalledWith(h.orgA.id, h.agent.id, { issueId: null, prompt: 'check the inbox', trigger: 'manual' });
    const chat = await call('POST', '/orgs/acme/agents/ada/chat', { message: 'hi' });
    expect(chat.json()).toEqual({ reply: 'echo: hi', runId: 'run_chat' });
    expect((await call('POST', '/orgs/acme/agents/ada/chat', {})).statusCode).toBe(400);
  });

  it('reads and writes MEMORY.md and the scorecard via the memory service', async () => {
    expect((await call('GET', '/orgs/acme/agents/ada/memory-doc')).json()).toEqual({ content: '# MEMORY' });
    await call('PUT', '/orgs/acme/agents/ada/memory-doc', { content: '# Rules' });
    expect(h.memory.setProfileDoc).toHaveBeenCalledWith(h.orgA.id, h.agent.id, '# Rules', OWNER);
    await call('GET', '/orgs/acme/agents/ada/scorecard?days=30');
    expect(h.memory.scorecard).toHaveBeenCalledWith(h.orgA.id, h.agent.id, { days: 30 });
    expect((await call('GET', '/orgs/acme/agents/ada/scorecard?days=0')).statusCode).toBe(400);
  });
});

describe('issues', () => {
  it('creates, reads by number, updates and paginates', async () => {
    for (let i = 1; i <= 5; i++) await call('POST', '/orgs/acme/issues', { title: `Issue ${i}` });
    expect((await call('GET', '/orgs/acme/issues/3')).json().title).toBe('Issue 3');
    expect((await call('PATCH', '/orgs/acme/issues/3', { status: 'done' })).json().status).toBe('done');

    const p1 = (await call('GET', '/orgs/acme/issues?limit=2')).json();
    expect(p1).toMatchObject({ limit: 2, offset: 0, nextOffset: 2 });
    expect(p1.items.map((i: { number: number }) => i.number)).toEqual([1, 2]);
    const p3 = (await call('GET', '/orgs/acme/issues?limit=2&offset=4')).json();
    expect(p3.items).toHaveLength(1);
    expect(p3.nextOffset).toBeNull();

    const filtered = (await call('GET', '/orgs/acme/issues?status=done,cancelled')).json();
    expect(filtered.items.map((i: { number: number }) => i.number)).toEqual([3]);
    expect(h.work.listIssues).toHaveBeenLastCalledWith(h.orgA.id, { status: ['done', 'cancelled'], limit: 101, offset: 0 });
  });

  it('validates queries and bodies', async () => {
    expect((await call('GET', '/orgs/acme/issues?limit=100000')).statusCode).toBe(400);
    expect((await call('GET', '/orgs/acme/issues?status=nonsense')).statusCode).toBe(400);
    expect((await call('POST', '/orgs/acme/issues', { title: 'x', priority: 'high' })).statusCode).toBe(400);
    expect((await call('POST', '/orgs/acme/issues', { body: 'no title' })).statusCode).toBe(400);
    const malformed = await h.api.app.inject({ method: 'POST', url: '/api/v1/orgs/acme/issues', headers: { ...h.owner, 'content-type': 'application/json' }, payload: '{not json' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('validation');
  });

  it("does not find another org's issue", async () => {
    await call('POST', '/orgs/acme/issues', { title: 'Acme only' });
    const id = h.issues[0]!.id;
    expect((await call('GET', `/orgs/globex/issues/${id}`)).statusCode).toBe(404);
    expect((await call('POST', `/orgs/globex/issues/${id}/comments`, { body: 'hi' })).statusCode).toBe(404);
    expect(h.work.addComment).not.toHaveBeenCalled();
  });

  it('forwards assign / escalate / review / comments to the work service', async () => {
    await call('POST', '/orgs/acme/issues', { title: 'T' });
    const id = h.issues[0]!.id;
    await call('POST', `/orgs/acme/issues/${id}/assign`, { agentId: h.agent.id });
    expect(h.work.assign).toHaveBeenCalledWith(h.orgA.id, id, h.agent.id, OWNER);
    await call('POST', `/orgs/acme/issues/1/review`, { outcome: 'rejected', note: 'redo' });
    expect(h.work.review).toHaveBeenCalledWith(h.orgA.id, id, 'rejected', 'redo', OWNER);
    await call('POST', `/orgs/acme/issues/1/comments`, { body: 'looks good' });
    expect(h.work.addComment).toHaveBeenCalledWith(h.orgA.id, id, { body: 'looks good' }, OWNER);
    expect((await call('POST', `/orgs/acme/issues/1/escalate`, {})).statusCode).toBe(400);
  });
});

describe('error mapping', () => {
  it('maps ConductorError to its HTTP status and envelope', async () => {
    h.work.createGoal.mockImplementation(() => {
      throw new ConductorError('conflict', 'goal already exists', { title: 'Grow' });
    });
    const res = await call('POST', '/orgs/acme/goals', { title: 'Grow' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'conflict', message: 'goal already exists', details: { title: 'Grow' } } });

    h.work.goalTree.mockImplementation(() => {
      throw new ConductorError('budget_exceeded', 'over budget');
    });
    expect((await call('GET', '/orgs/acme/goals/tree')).statusCode).toBe(402);
  });

  it('hides the message of unexpected errors', async () => {
    h.work.listProjects.mockImplementation(() => {
      throw new Error('SQLITE_CORRUPT: /Users/owner/.conductor/conductor.db');
    });
    const res = await call('GET', '/orgs/acme/projects');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'internal error' } });
  });
});

describe('runs, approvals, budgets, activity', () => {
  it('serves runs and transcripts, org-scoped', async () => {
    const run = h.startRun();
    expect((await call('GET', '/orgs/acme/runs')).json()).toHaveLength(1);
    expect((await call('GET', `/orgs/acme/runs/${run.runId}`)).json().id).toBe(run.runId);
    expect((await call('GET', `/orgs/globex/runs/${run.runId}`)).statusCode).toBe(404);
    const tr = await call('GET', `/orgs/acme/runs/${run.runId}/transcript?afterSeq=7`);
    expect(tr.json()[0].seq).toBe(8);
    await call('POST', `/orgs/acme/runs/${run.runId}/cancel`, { reason: 'stop' });
    expect(h.runtime.cancelRun).toHaveBeenCalledWith(h.orgA.id, run.runId, 'stop');
  });

  it('lists approvals per org and across orgs, and decides them as the owner', async () => {
    const { approvals } = h.services.governance;
    const a = approvals.request({ orgId: h.orgA.id, kind: 'payment', title: 'Pay $5' });
    approvals.request({ orgId: h.orgB.id, kind: 'publish', title: 'Post' });
    expect((await call('GET', '/approvals?status=pending')).json()).toHaveLength(2);
    expect((await call('GET', '/orgs/acme/approvals')).json()).toHaveLength(1);
    expect((await call('GET', `/orgs/globex/approvals/${a.id}`)).statusCode).toBe(404);
    const b = approvals.request({ orgId: h.orgA.id, kind: 'publish', title: 'Post here', issueId: 'iss_x' });
    expect((await call('GET', '/orgs/acme/approvals?issueId=iss_x')).json().map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect((await call('GET', `/orgs/acme/approvals?ids=${a.id},${b.id},${a.id}`)).json()).toHaveLength(2);

    const decided = await call('POST', `/orgs/acme/approvals/${a.id}/decide`, { decision: 'approved', note: 'ok' });
    expect(decided.json()).toMatchObject({ status: 'approved', decisionNote: 'ok' });
    expect((await call('POST', `/orgs/acme/approvals/${a.id}/decide`, { decision: 'maybe' })).statusCode).toBe(400);
  });

  it('returns budget summary, ledger and per-agent status', async () => {
    expect((await call('GET', '/orgs/acme/budget/summary')).json()).toMatchObject({ totalUsd: 0 });
    expect((await call('GET', '/orgs/acme/budget/ledger?limit=5')).json()).toEqual([]);
    expect((await call('GET', '/orgs/acme/agents/ada/budget')).json()).toMatchObject({ allowed: true });
  });

  it('queries the activity log for one org only', async () => {
    h.kernel.audit.record({ orgId: h.orgA.id, actor: OWNER, action: 'config.changed', entityKind: 'agent', entityId: h.agent.id });
    h.kernel.audit.record({ orgId: h.orgB.id, actor: OWNER, action: 'config.changed', entityKind: 'agent', entityId: h.agentB.id });
    const res = (await call('GET', '/orgs/acme/activity?action=config.changed')).json();
    expect(res).toHaveLength(1);
    expect(res[0].entityId).toBe(h.agent.id);
  });
});

describe('skills, memory, connectors, browser', () => {
  const skill = (id: string, orgId: string | null): Skill => ({ id, orgId, name: id, scope: orgId ? 'org' : 'global', status: 'draft' }) as unknown as Skill;

  it('scopes skill ids to the org (global skills are visible everywhere)', async () => {
    h.skillRows.set('skl_a', skill('skl_a', h.orgA.id));
    h.skillRows.set('skl_g', skill('skl_g', null));
    expect((await call('GET', '/orgs/acme/skills/skl_a')).json().body).toBe('# body');
    expect((await call('GET', '/orgs/globex/skills/skl_a')).statusCode).toBe(404);
    expect((await call('POST', '/orgs/globex/skills/skl_a/activate', { force: true })).statusCode).toBe(404);
    expect(h.skills.activate).not.toHaveBeenCalled();
    expect((await call('GET', '/orgs/globex/skills/skl_g')).statusCode).toBe(200);
    expect((await call('GET', '/orgs/acme/skills/skl_a/diff?from=1&to=2')).json()).toEqual({ diff: '--- a\n+++ b\n' });
    expect(h.skills.diff).toHaveBeenCalledWith('skl_a', 1, 2);
    expect((await call('GET', '/orgs/acme/skills')).json().map((s: Skill) => s.id).sort()).toEqual(['skl_a', 'skl_g']);
  });

  it('upserts skills into the right scope and drives the lifecycle', async () => {
    await call('POST', '/orgs/acme/skills', { scope: 'org', name: 'triage', description: 'Triage bugs', body: '# Triage' });
    expect(h.skills.upsert).toHaveBeenCalledWith(h.orgA.id, expect.objectContaining({ scope: 'org', scopeId: h.orgA.id, name: 'triage' }), OWNER);
    await call('POST', '/orgs/acme/skills', { scope: 'global', name: 'g', description: 'Global', body: '# G' });
    expect(h.skills.upsert).toHaveBeenLastCalledWith(null, expect.objectContaining({ scope: 'global', scopeId: null }), OWNER);
    expect((await call('POST', '/orgs/acme/skills', { scope: 'agent', name: 'x', description: 'd', body: 'b' })).statusCode).toBe(400);
    expect((await call('POST', '/orgs/acme/skills/import', { sourceDir: '../relative', scope: 'org' })).statusCode).toBe(400);

    h.skillRows.set('skl_a', skill('skl_a', h.orgA.id));
    await call('POST', '/orgs/acme/skills/skl_a/rollback', { toVersion: 2 });
    expect(h.skills.rollback).toHaveBeenCalledWith('skl_a', 2, OWNER);
    await call('POST', '/orgs/acme/skills/skl_a/promote', { toScope: 'org' });
    expect(h.skills.promote).toHaveBeenCalledWith('skl_a', 'org', OWNER);
    await call('PUT', '/orgs/acme/skills/skl_a/status', { status: 'deprecated' });
    expect(h.skills.setStatus).toHaveBeenCalledWith('skl_a', 'deprecated', OWNER);
  });

  it('searches, writes, reviews and forgets memories', async () => {
    await call('GET', '/orgs/acme/memory/search?text=refund%20policy&agentId=ada&kinds=semantic,lesson&limit=5');
    expect(h.memory.search).toHaveBeenCalledWith(h.orgA.id, { text: 'refund policy', agentId: h.agent.id, kinds: ['semantic', 'lesson'], limit: 5 });
    expect((await call('GET', '/orgs/acme/memory/search')).statusCode).toBe(400);

    await call('GET', '/orgs/acme/memory?status=review');
    expect(h.memory.list).toHaveBeenCalledWith(h.orgA.id, { status: 'review' });
    await call('POST', '/orgs/acme/memory', { scope: 'org', scopeId: h.orgA.id, kind: 'semantic', content: 'Refunds within 30 days' });
    expect(h.memory.write).toHaveBeenCalledWith(h.orgA.id, expect.objectContaining({ content: 'Refunds within 30 days', author: 'owner' }), OWNER);
    await call('PATCH', '/orgs/acme/memory/mem_1', { status: 'active', pinned: true });
    expect(h.memory.update).toHaveBeenCalledWith(h.orgA.id, 'mem_1', { status: 'active', pinned: true }, OWNER);
    expect((await call('DELETE', '/orgs/acme/memory/mem_1')).json()).toEqual({ ok: true });
    expect(h.memory.forget).toHaveBeenCalledWith(h.orgA.id, 'mem_1', OWNER);
    expect((await call('GET', '/orgs/acme/owner-model')).json()).toEqual({ content: 'owner model' });
    await call('GET', '/orgs/acme/sessions/search?text=invoice');
    expect(h.memory.searchSessions).toHaveBeenCalledWith(h.orgA.id, null, 'invoice', undefined);
  });

  it('installs connectors, discovers tools and manages grants', async () => {
    await call('POST', '/orgs/acme/connectors', { name: 'gh', kind: 'mcp_http', config: { url: 'https://example.test/mcp' } });
    expect(h.connectors.install).toHaveBeenCalledWith(h.orgA.id, { name: 'gh', kind: 'mcp_http', config: { url: 'https://example.test/mcp' } }, OWNER);
    await call('POST', '/orgs/acme/connectors/from-template', { templateId: 'github', secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' } });
    expect(h.connectors.installFromTemplate).toHaveBeenCalledWith(h.orgA.id, 'github', { secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' } }, OWNER);
    expect((await call('POST', '/orgs/acme/connectors', { name: 'x', kind: 'carrier-pigeon', config: {} })).statusCode).toBe(400);

    await call('GET', '/orgs/acme/connectors/con_1/tools');
    expect(h.connectors.discoverTools).toHaveBeenCalledWith(h.orgA.id, 'con_1');
    await call('POST', '/orgs/acme/connectors/con_1/tools/send_email/retrust');
    expect(h.connectors.retrustTool).toHaveBeenCalledWith(h.orgA.id, 'con_1', 'send_email', OWNER);
    await call('PUT', '/orgs/acme/connectors/con_1/grants/ada', { defaultPolicy: 'ask', toolPolicies: { send: 'off' } });
    expect(h.connectors.grant).toHaveBeenCalledWith(h.orgA.id, 'con_1', h.agent.id, { defaultPolicy: 'ask', toolPolicies: { send: 'off' } }, OWNER);
    expect((await call('PUT', `/orgs/acme/connectors/con_1/grants/${h.agentB.id}`, {})).statusCode).toBe(404);
    await call('DELETE', '/orgs/acme/connectors/con_1/grants/ada');
    expect(h.connectors.revokeGrant).toHaveBeenCalledWith(h.orgA.id, 'con_1', h.agent.id, OWNER);
  });

  it('manages browser profiles and lists takeover sessions without their credentials', async () => {
    await call('POST', '/orgs/acme/browser/profiles', { name: 'Sales', domainAllowlist: ['linkedin.com'] });
    expect(h.browser.createProfile).toHaveBeenCalledWith(h.orgA.id, { name: 'Sales', domainAllowlist: ['linkedin.com'] }, OWNER);
    h.addTakeover('tok');
    const sessions = (await call('GET', '/orgs/acme/browser/sessions')).json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).not.toHaveProperty('tokenHash');
    expect(sessions[0]).not.toHaveProperty('viewerId');
  });
});

describe('gateways and webhooks CRUD', () => {
  it('stores gateway config rows (secrets by reference only)', async () => {
    const created = (await call('POST', '/gateways', { kind: 'telegram', name: 'Owner bot', config: { allowedChatIds: [1] }, authRef: 'gw/telegram' })).json();
    expect(created).toMatchObject({ orgId: null, kind: 'telegram', status: 'active', authRef: 'gw/telegram' });
    const scoped = (await call('POST', '/gateways', { orgId: 'acme', kind: 'slack', name: 'Acme Slack' })).json();
    expect(scoped.orgId).toBe(h.orgA.id);
    expect((await call('GET', '/gateways')).json()).toHaveLength(2);
    expect((await call('GET', '/gateways?orgId=acme')).json()).toHaveLength(1);

    const patched = (await call('PATCH', `/gateways/${created.id}`, { status: 'disabled', config: { allowedChatIds: [2] } })).json();
    expect(patched).toMatchObject({ status: 'disabled', config: { allowedChatIds: [2] } });
    expect((await call('POST', '/gateways', { kind: 'fax', name: 'x' })).statusCode).toBe(400);
    expect((await call('POST', '/gateways', { kind: 'slack', name: 'x', token: 'xoxb-raw' })).statusCode).toBe(400);
    expect((await call('DELETE', `/gateways/${created.id}`)).json()).toEqual({ ok: true });
    expect((await call('GET', `/gateways/${created.id}`)).statusCode).toBe(404);
  });

  it('creates, updates and deletes webhooks inside one org', async () => {
    const inbound = (await call('POST', '/orgs/acme/webhooks', { direction: 'in', name: 'GitHub', source: 'github', agentId: h.agent.id, secretRef: 'wh/github' })).json();
    expect(inbound.inboundUrl).toBe(`http://127.0.0.1:7420/hooks/${inbound.id}`);
    const out = (await call('POST', '/orgs/acme/webhooks', { direction: 'out', name: 'Zap', url: 'https://hooks.example.test/x', events: ['issue.done'] })).json();
    expect(out.inboundUrl).toBeNull();
    expect((await call('GET', '/orgs/acme/webhooks?direction=out')).json()).toHaveLength(1);

    expect((await call('GET', `/orgs/globex/webhooks/${inbound.id}`)).statusCode).toBe(404);
    expect((await call('DELETE', `/orgs/globex/webhooks/${inbound.id}`)).statusCode).toBe(404);
    expect((await call('GET', '/orgs/globex/webhooks')).json()).toEqual([]);

    expect((await call('PATCH', `/orgs/acme/webhooks/${out.id}`, { status: 'disabled', events: ['issue.created'] })).json()).toMatchObject({ status: 'disabled', events: ['issue.created'] });
    expect((await call('DELETE', `/orgs/acme/webhooks/${out.id}`)).json()).toEqual({ ok: true });
  });

  it('only accepts https (or loopback http) destinations and same-org agents', async () => {
    const mk = (extra: object) => call('POST', '/orgs/acme/webhooks', { direction: 'out', name: 'x', events: ['issue.done'], ...extra });
    expect((await mk({ url: 'http://example.test/hook' })).statusCode).toBe(400);
    expect((await mk({ url: 'ftp://example.test/hook' })).statusCode).toBe(400);
    expect((await mk({ url: 'https://user:pw@example.test/hook' })).statusCode).toBe(400);
    expect((await mk({})).statusCode).toBe(400);
    expect((await mk({ url: 'http://127.0.0.1:9999/hook' })).statusCode).toBe(200);
    const foreign = await call('POST', '/orgs/acme/webhooks', { direction: 'in', name: 'x', agentId: h.agentB.id });
    expect(foreign.statusCode).toBe(404);
  });
});
