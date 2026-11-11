import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { settings } from '../../src/db/schema/index.js';
import { createExternalBackend, type BindableMemoryService } from '../../src/memory/index.js';
import { makeService, mockServer, type MockServer } from './helpers.js';

describe('external memory backends', () => {
  let k: TestKernel;
  let mem: BindableMemoryService;
  let org: Organization;
  let ada: Agent;
  let server: MockServer | null = null;

  beforeEach(() => {
    k = createTestKernel();
    mem = makeService(k);
    org = seedOrg(k);
    ada = seedAgent(k, org.id, seedDept(k, org.id).id);
  });
  afterEach(async () => {
    await server?.close();
    server = null;
    k.dispose();
  });

  const enable = async (orgId: string, value: unknown) => {
    await k.secrets.set('mem0_key', 'm0-secret-value');
    k.db.insert(settings).values({ key: `memory.backend.${orgId}`, value, updatedAt: k.clock.now() }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  };

  /** A tiny Mem0-shaped fake that actually stores, searches and deletes. */
  const mem0 = async (opts: { fail?: () => boolean } = {}) => {
    const stored = new Map<string, { id: string; memory: string; user_id: string; metadata: Record<string, unknown> }>();
    let n = 0;
    const s = await mockServer((req) => {
      if (opts.fail?.()) return [500, { error: 'boom' }];
      if (req.method === 'POST' && req.path === '/v1/memories/') {
        const b = req.body as { messages: Array<{ content: string }>; user_id: string; metadata: Record<string, unknown> };
        const id = `ext-${++n}`;
        stored.set(id, { id, memory: b.messages[0]!.content, user_id: b.user_id, metadata: b.metadata });
        return [200, [{ id, event: 'ADD', data: { memory: b.messages[0]!.content } }]];
      }
      if (req.method === 'POST' && req.path === '/v2/memories/search/') {
        const b = req.body as { query: string; filters: { OR: Array<{ user_id: string }> } };
        const users = new Set(b.filters.OR.map((f) => f.user_id));
        return [200, [...stored.values()].filter((m) => users.has(m.user_id)).map((m) => ({ ...m, score: /synergy/i.test(b.query) ? 0.93 : 0.1 }))];
      }
      const del = /^\/v1\/memories\/([^/]+)\/$/.exec(req.path);
      if (req.method === 'DELETE' && del) {
        stored.delete(decodeURIComponent(del[1]!));
        return [200, { message: 'deleted' }];
      }
      return [404, { error: 'not found' }];
    });
    return { s, stored };
  };

  it('mirrors writes, merges external search results, mirrors deletes; scoped per org', async () => {
    const { s, stored } = await mem0();
    server = s;
    await enable(org.id, { kind: 'mem0', baseUrl: s.url, authRef: 'mem0_key' });
    const org2 = seedOrg(k, 'Globex');

    const m = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: 'Quarterly close checklist lives in the finance drive.', taskType: 'close' }, OWNER);
    const other = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: 'Rotate the on-call pager every Monday.' }, OWNER);
    await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'semantic', content: 'Unsure rumour about a vendor.', confidence: 0.2 }, OWNER);
    await mem.write(org2.id, { scope: 'org', scopeId: org2.id, kind: 'procedural', content: 'Other org memory stays local.' }, OWNER);

    // Only active memories of the enabled org are mirrored, with auth from the secret store.
    expect(stored.size).toBe(2);
    const first = s.requests[0]!;
    expect(first.headers.authorization).toBe('Token m0-secret-value');
    expect(first.body).toMatchObject({ user_id: `conductor-${org.id}-agent-${ada.id}`, infer: false, metadata: { conductor_id: m.id, kind: 'procedural', task_type: 'close' } });
    expect(JSON.stringify(k.db.select().from(settings).all())).not.toContain('m0-secret-value');

    // The query shares no words with the memory: only the external backend can surface it.
    const hits = await mem.search(org.id, { agentId: ada.id, text: 'synergy' });
    expect(hits.map((h) => h.memory.id).sort()).toEqual([m.id, other.id].sort());
    expect(hits[0]!.similarity).toBeCloseTo(0.93, 5);
    const search = s.requests.find((r) => r.path === '/v2/memories/search/')!;
    expect((search.body as { filters: { OR: Array<{ user_id: string }> } }).filters.OR.map((f) => f.user_id)).toEqual([
      `conductor-${org.id}-agent-${ada.id}`, `conductor-${org.id}-dept-${ada.deptId}`, `conductor-${org.id}-org-${org.id}`,
    ]);

    mem.forget(org.id, m.id, OWNER);
    await expect.poll(() => stored.size).toBe(1);
    expect(s.requests.some((r) => r.method === 'DELETE' && r.path === '/v1/memories/ext-1/')).toBe(true);
  });

  it('backend failures, bad config or a missing secret never break local memory', async () => {
    let failing = true;
    const { s, stored } = await mem0({ fail: () => failing });
    server = s;
    await enable(org.id, { kind: 'mem0', baseUrl: s.url, authRef: 'mem0_key' });
    const m = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: 'Invoices are approved by the controller.' }, OWNER);
    expect(m.status).toBe('active');
    expect(stored.size).toBe(0);
    expect((await mem.search(org.id, { agentId: ada.id, text: 'who approves invoices' }))[0]?.memory.id).toBe(m.id);
    expect(() => mem.forget(org.id, m.id, OWNER)).not.toThrow();

    failing = false;
    await enable(org.id, { kind: 'not-a-backend', authRef: 'mem0_key' });
    const n = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: 'Refunds over 500 need a second approver.' }, OWNER);
    await enable(org.id, { kind: 'mem0', baseUrl: s.url, authRef: 'no_such_secret' });
    const o = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: 'Chargebacks are logged in the disputes sheet.' }, OWNER);
    expect([n.status, o.status]).toEqual(['active', 'active']);
    expect(stored.size).toBe(0);
    await server.close();
    server = null;
    await enable(org.id, { kind: 'mem0', baseUrl: s.url, authRef: 'mem0_key' });
    const p = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: 'Payroll runs on the 25th.' }, OWNER);
    expect(p.status).toBe('active');
    expect((await mem.search(org.id, { agentId: ada.id, text: 'payroll' }))[0]?.memory.id).toBe(p.id);
  });

  it('Zep, Supermemory and Honcho clients speak the same interface', async () => {
    const seen: Array<{ method: string; path: string }> = [];
    server = await mockServer((req) => {
      seen.push({ method: req.method, path: req.path });
      const p = req.path;
      if (p === '/api/v2/graph') return [200, { uuid: 'zep-1' }];
      if (p === '/api/v2/graph/search') return [200, { episodes: [{ uuid: 'zep-1', content: 'zep text', score: 0.8, source_description: 'conductor:mem_1' }] }];
      if (p === '/v3/documents') return [200, { id: 'sm-1', status: 'queued' }];
      if (p === '/v3/search') return [200, { results: [{ documentId: 'sm-1', score: 0.7, metadata: { conductor_id: 'mem_1' }, chunks: [{ content: 'sm text', score: 0.7 }] }] }];
      if (/\/sessions\/[^/]+\/messages$/.test(p)) return [200, [{ id: 'h-1', content: 'honcho text' }]];
      if (/\/sessions\/[^/]+\/search$/.test(p)) return [200, [{ id: 'h-1', content: 'honcho text', metadata: { conductor_id: 'mem_1' } }, { id: 'h-2', content: 'gone', metadata: { deleted: true } }]];
      return [200, null];
    });
    const item = { id: 'mem_1', content: 'hello', scopeKey: 'conductor-org-agent-a', metadata: { kind: 'semantic' } };
    for (const [kind, extId, text] of [['zep', 'zep-1', 'zep text'], ['supermemory', 'sm-1', 'sm text'], ['honcho', 'h-1', 'honcho text']] as const) {
      const backend = createExternalBackend({ kind, baseUrl: server.url, authRef: 'x' }, 'key');
      expect(backend.kind).toBe(kind);
      expect(await backend.write(item)).toEqual({ externalId: extId });
      const hits = await backend.search('hello', { scopeKeys: [item.scopeKey], limit: 5 });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ externalId: extId, conductorId: 'mem_1', content: text });
      expect(hits[0]!.score).toBeGreaterThan(0);
      await backend.delete(extId, item.scopeKey);
    }
    expect(seen).toEqual(expect.arrayContaining([
      { method: 'DELETE', path: '/api/v2/graph/episodes/zep-1' },
      { method: 'DELETE', path: '/v3/documents/sm-1' },
      { method: 'PUT', path: '/v2/workspaces/conductor/sessions/conductor-org-agent-a/messages/h-1' },
    ]));
    const failing = createExternalBackend({ kind: 'zep', baseUrl: 'http://127.0.0.1:1', authRef: 'x' }, 'key');
    await expect(failing.write(item)).rejects.toThrow();
  });
});
