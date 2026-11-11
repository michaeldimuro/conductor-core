import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import type { Embedder } from '../../src/contracts/kernel.js';
import { OWNER, type ProviderBinding } from '../../src/contracts/types.js';
import { organizations, settings } from '../../src/db/schema/index.js';
import {
  cosine, createEmbedder, createMemoryService, createUtilityModel, ensureMemoryIndexes, LocalHashEmbedder, OpenAIEmbedder,
} from '../../src/memory/index.js';
import { makeService, mockServer, type MockServer } from './helpers.js';

describe('embedders and indexes', () => {
  let k: TestKernel;
  let server: MockServer | null = null;
  beforeEach(() => {
    k = createTestKernel();
  });
  afterEach(async () => {
    await server?.close();
    server = null;
    k.dispose();
  });

  const setSetting = (key: string, value: unknown) =>
    k.db.insert(settings).values({ key, value, updatedAt: k.clock.now() }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  const getSetting = (key: string) => k.db.select().from(settings).where(eq(settings.key, key)).get()?.value;

  it('LocalHashEmbedder: deterministic, 384 dims, L2-normalised, related text scores well above unrelated text', async () => {
    const e = new LocalHashEmbedder();
    expect(e.dims).toBe(384);
    const [a, b, c, a2, empty] = await e.embed([
      'Stripe dashboard export lives under Reports → Balance.',
      'Download last month\'s balance report from Stripe as an export',
      'The office plants are watered every Friday by facilities.',
      'Stripe dashboard export lives under Reports → Balance.',
      '',
    ]);
    expect(a!.length).toBe(384);
    expect(Array.from(a!)).toEqual(Array.from(a2!));
    expect(cosine(a!, a!)).toBeCloseTo(1, 5);
    const related = cosine(a!, b!);
    const unrelated = cosine(a!, c!);
    expect(related).toBeGreaterThan(0.3);
    expect(Math.abs(unrelated)).toBeLessThan(0.12);
    expect(related).toBeGreaterThan(unrelated + 0.25);
    // Morphological variants share features.
    const [x, y] = await e.embed(['exporting invoices', 'invoice exports']);
    expect(cosine(x!, y!)).toBeGreaterThan(0.5);
    expect(Array.from(empty!).every((v) => v === 0)).toBe(true);
  });

  const embeddingServer = (dims: number) =>
    mockServer((req) => {
      if (req.path !== '/v1/embeddings') return [404, { error: { message: 'not found' } }];
      const input = (req.body as { input: string[] }).input;
      return [200, { object: 'list', model: 'text-embedding-3-small', data: input.map((t, index) => ({ object: 'embedding', index, embedding: Array.from({ length: dims }, (_, i) => (i === t.length % dims ? 2 : 0)) })), usage: { prompt_tokens: 3, total_tokens: 3 } }];
    });

  it('OpenAIEmbedder calls text-embedding-3-small through the SDK (baseURL overridable) and normalises vectors', async () => {
    server = await embeddingServer(1536);
    const e = new OpenAIEmbedder({ apiKey: 'test-key', baseURL: `${server.url}/v1` });
    expect([e.id, e.dims]).toEqual(['openai:text-embedding-3-small:1536', 1536]);
    const [v, w] = await e.embed(['abc', 'hello']);
    expect(v!.length).toBe(1536);
    expect(v![3]).toBeCloseTo(1, 5);
    expect(w![5]).toBeCloseTo(1, 5);
    const req = server.requests[0]!;
    expect(req.headers.authorization).toBe('Bearer test-key');
    expect(req.body).toMatchObject({ model: 'text-embedding-3-small', input: ['abc', 'hello'], encoding_format: 'float' });
    const short = new OpenAIEmbedder({ apiKey: 'test-key', baseURL: `${server.url}/v1`, dims: 8 });
    await expect(short.embed(['abc'])).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('createEmbedder: local by default; OpenAI only when settings say so AND the secret exists', async () => {
    server = await embeddingServer(1536);
    const base = `${server.url}/v1`;
    const a = createEmbedder(k);
    await a.resolve();
    expect(a.id).toBe('local-hash-v1:384');

    setSetting('embeddings.provider', 'openai');
    setSetting('embeddings.baseUrl', base);
    const noKey = createEmbedder(k);
    await noKey.resolve();
    expect(noKey.id).toBe('local-hash-v1:384');
    expect((await noKey.embed(['x']))[0]!.length).toBe(384);
    expect(server.requests).toHaveLength(0);

    await k.secrets.set('openai_api_key', 'sk-test');
    const withKey = createEmbedder(k);
    const [v] = await withKey.embed(['abc']);
    expect([withKey.id, withKey.dims, v!.length]).toEqual(['openai:text-embedding-3-small:1536', 1536, 1536]);
    expect(server.requests).toHaveLength(1);

    await k.secrets.set('custom_ref', 'sk-other');
    setSetting('embeddings.authRef', 'custom_ref');
    const custom = createEmbedder(k);
    await custom.embed(['abc']);
    expect(server.requests[1]!.headers.authorization).toBe('Bearer sk-other');
    // The key itself is never persisted.
    expect(JSON.stringify(k.db.select().from(settings).all())).not.toContain('sk-');
  });

  it('ensureMemoryIndexes is idempotent and creates FTS5 + vec tables', () => {
    expect(ensureMemoryIndexes(k.sqlite, 384)).toEqual({ vecRebuilt: false });
    expect(ensureMemoryIndexes(k.sqlite, 384)).toEqual({ vecRebuilt: false });
    const names = (k.sqlite.prepare("select name from sqlite_master where name in ('memories_fts','memories_vec','session_summaries_fts')").all() as Array<{ name: string }>).map((r) => r.name).sort();
    expect(names).toEqual(['memories_fts', 'memories_vec', 'session_summaries_fts']);
    expect(ensureMemoryIndexes(k.sqlite, 16)).toEqual({ vecRebuilt: true });
    expect(() => ensureMemoryIndexes(k.sqlite, 0)).toThrow(/dims/);
  });

  it('records the embedder in settings; a dimension/id change rebuilds the vec table and re-embeds every memory', async () => {
    const org = seedOrg(k);
    const ada = seedAgent(k, org.id, seedDept(k, org.id).id);
    const mem = makeService(k);
    const a = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: 'Stripe balance exports live under Reports.' }, OWNER);
    const b = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: 'Office plants are watered on Fridays.' }, OWNER);
    const forgotten = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: 'Old fax number is 555-0100.' }, OWNER);
    mem.forget(org.id, forgotten.id, OWNER);
    expect(getSetting('embeddings.index')).toEqual({ id: 'local-hash-v1:384', dims: 384 });
    const vecSql = () => (k.sqlite.prepare("select sql from sqlite_master where name = 'memories_vec'").get() as { sql: string }).sql;
    const vecRows = () => (k.sqlite.prepare('select rowid from memories_vec order by rowid').all() as Array<{ rowid: number }>).map((r) => r.rowid);
    expect(vecSql()).toMatch(/float\[384\]/);
    expect(vecRows()).toEqual([a.rowid, b.rowid]);

    const small = new LocalHashEmbedder(64);
    const spy = vi.spyOn(small, 'embed');
    const embedder: Embedder = small;
    const mem2 = createMemoryService(k, { utility: createUtilityModel(k), embedder });
    // Nothing is dropped until the new embedder is actually used.
    expect(vecSql()).toMatch(/float\[384\]/);
    const hits = await mem2.search(org.id, { agentId: ada.id, text: 'where are the stripe balance exports' });
    expect(hits[0]?.memory.id).toBe(a.id);
    expect(vecSql()).toMatch(/float\[64\]/);
    expect(vecRows()).toEqual([a.rowid, b.rowid]);
    expect(getSetting('embeddings.index')).toEqual({ id: 'local-hash-v1:64', dims: 64 });
    expect(spy.mock.calls.flat(2)).toEqual(expect.arrayContaining([a.content, b.content]));
    expect(spy.mock.calls.flat(2)).not.toContain(forgotten.content);

    // Same embedder again: no rebuild.
    spy.mockClear();
    const mem3 = createMemoryService(k, { utility: createUtilityModel(k), embedder: small });
    await mem3.search(org.id, { agentId: ada.id, text: 'plants' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('utility model', () => {
  let k: TestKernel;
  let server: MockServer | null = null;
  beforeEach(() => {
    k = createTestKernel();
  });
  afterEach(async () => {
    await server?.close();
    server = null;
    k.dispose();
  });

  const bind = (orgId: string, binding: ProviderBinding) => k.db.update(organizations).set({ utilityModel: binding }).where(eq(organizations.id, orgId)).run();
  const anthropicReply = (text: string, extra: Record<string, unknown> = {}) => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 200 }, ...extra,
  });

  it('falls back to a deterministic offline heuristic per purpose when no model or key is configured', async () => {
    const org = seedOrg(k);
    const budgets = { record: vi.fn() };
    const u = createUtilityModel(k, { budgets });
    const summary = await u.complete({ orgId: org.id, purpose: 'summarize', prompt: 'The deploy failed twice. Then the cache was cleared. After that it passed.', maxTokens: 20 });
    expect(summary).toMatchObject({ offline: true, json: null, tokensIn: 0, tokensOut: 0, costUsd: 0 });
    expect(summary.text).toMatch(/^The deploy failed twice\./);
    const again = await u.complete({ orgId: org.id, purpose: 'summarize', prompt: 'The deploy failed twice. Then the cache was cleared. After that it passed.', maxTokens: 20 });
    expect(again.text).toBe(summary.text);

    const judge = await u.complete({ orgId: org.id, purpose: 'judge', json: true, prompt: 'Do these conflict?' });
    expect(judge.json).toMatchObject({ conflict: false, verdict: 'unknown' });

    const extract = await u.complete({
      orgId: org.id, purpose: 'extract', json: true,
      prompt: '<task>\nmemory_extraction\n</task>\n\n<meta>\n{"title":"Ship it"}\n</meta>\n\n<transcript>\n[tool_call] deploy: {"env":"prod"}\n[tool_result error] deploy: missing token\n[tool_call] deploy: {"env":"prod","token":true}\n[tool_result ok] deploy: done\n[assistant] Lesson: next time pass the token flag.\n</transcript>',
    });
    const ex = extract.json as { summary: string; lessons: Array<{ content: string; confidence: number }>; facts: unknown[]; preferences: unknown[] };
    expect(ex.summary).toMatch(/Ship it/);
    expect(ex.lessons.map((l) => l.content).join('\n')).toMatch(/deploy failed with "missing token"; it worked with input/);
    expect(ex.lessons.some((l) => /pass the token flag/.test(l.content))).toBe(true);

    const review = await u.complete({ orgId: org.id, purpose: 'review', json: true, prompt: '<scorecards>\n[{"agentId":"agt_1","days":30,"runs":10,"issuesClosed":2,"successRate":0.2,"reworkRate":0.5,"costPerIssue":1,"trend":[],"byTaskType":[]}]\n</scorecards>' });
    expect((review.json as { proposals: Array<{ kind: string }> }).proposals.map((p) => p.kind)).toEqual(['prompt', 'skill']);

    // Configured but the key is missing → still offline, and nothing is billed.
    bind(org.id, { adapter: 'claude_api', authRef: 'missing_key' });
    expect((await u.complete({ orgId: org.id, purpose: 'chat', prompt: 'hello there.' })).offline).toBe(true);
    bind(org.id, { adapter: 'claude_local' });
    expect((await u.complete({ orgId: org.id, purpose: 'chat', prompt: 'hello there.' })).offline).toBe(true);
    expect(budgets.record).not.toHaveBeenCalled();
  });

  it('claude_api: calls the Messages API with claude-haiku-5-5 by default, parses fenced JSON, records spend as reflection', async () => {
    server = await mockServer((req) => (req.path === '/v1/messages' ? [200, anthropicReply('```json\n{"conflict": true, "reason": "dates differ"}\n```')] : [404, {}]));
    const org = seedOrg(k);
    await k.secrets.set('anthropic_key', 'sk-ant-test-key-000000000000');
    bind(org.id, { adapter: 'claude_api', authRef: 'anthropic_key', config: { baseUrl: server.url } });
    const budgets = { record: vi.fn() };
    const u = createUtilityModel(k, { budgets });

    const res = await u.complete({ orgId: org.id, purpose: 'judge', json: true, system: 'You judge.', prompt: 'Conflict?' });
    expect(res).toMatchObject({ offline: false, tokensIn: 1000, tokensOut: 200, json: { conflict: true, reason: 'dates differ' } });
    expect(res.costUsd).toBeCloseTo((1000 * 0.1 + 200 * 0.5) / 1e6, 10);

    const req = server.requests[0]!;
    expect(req.headers.authorization ?? req.headers['x-api-key']).toMatch(/sk-ant-test-key-000000000000$/);
    const body = req.body as { model: string; max_tokens: number; system: string; messages: Array<{ role: string; content: string }>; thinking?: unknown; temperature?: unknown; output_config?: { effort?: string } };
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.messages).toEqual([{ role: 'user', content: 'Conflict?' }]);
    expect(body.system).toMatch(/^You judge\.\n\nRespond with a single valid JSON object/);
    expect(body.max_tokens).toBe(16_000);
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(budgets.record).toHaveBeenCalledWith({ orgId: org.id, category: 'reflection', provider: 'claude_api', model: 'claude-haiku-5-5', tokensIn: 1000, tokensOut: 200, costUsd: res.costUsd });

    // Explicit model + pricing override; plain-text mode returns json: null.
    bind(org.id, { adapter: 'claude_api', model: 'claude-sonnet-5-5', authRef: 'anthropic_key', config: { baseUrl: server.url, pricing: { inputPerMTok: 1, outputPerMTok: 1 } } });
    const text = await u.complete({ orgId: org.id, purpose: 'summarize', prompt: 'Summarise.', maxTokens: 500 });
    expect(text.json).toBeNull();
    expect(text.costUsd).toBeCloseTo(1200 / 1e6, 10);
    expect((server.requests[1]!.body as { model: string; max_tokens: number }).model).toBe('claude-sonnet-5-5');
    expect((server.requests[1]!.body as { max_tokens: number }).max_tokens).toBe(500);
  });

  it('claude_api: a refusal, an API error or malformed JSON never breaks the caller', async () => {
    let mode: 'refusal' | 'error' | 'garbage' = 'refusal';
    server = await mockServer(() => {
      if (mode === 'refusal') return [200, anthropicReply('', { content: [], stop_reason: 'refusal' })];
      if (mode === 'error') return [400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }];
      return [200, anthropicReply('not json at all')];
    });
    const org = seedOrg(k);
    await k.secrets.set('anthropic_key', 'sk-ant-test-key-000000000000');
    bind(org.id, { adapter: 'claude_api', authRef: 'anthropic_key', config: { baseUrl: server.url } });
    const budgets = { record: vi.fn() };
    const u = createUtilityModel(k, { budgets });
    expect((await u.complete({ orgId: org.id, purpose: 'judge', json: true, prompt: 'x' })).offline).toBe(true);
    mode = 'error';
    expect((await u.complete({ orgId: org.id, purpose: 'judge', json: true, prompt: 'x' })).json).toMatchObject({ conflict: false });
    expect(budgets.record).not.toHaveBeenCalled();
    mode = 'garbage';
    expect(await u.complete({ orgId: org.id, purpose: 'judge', json: true, prompt: 'x' })).toMatchObject({ offline: false, json: null, text: 'not json at all' });
  });

  it('openai_api: chat completions in JSON mode with the key from the secret store', async () => {
    server = await mockServer((req) =>
      req.path === '/v1/chat/completions'
        ? [200, { id: 'c1', object: 'chat.completion', created: 1, model: 'gpt-5-mini', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"summary":"done"}', refusal: null } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }]
        : [404, {}],
    );
    const org = seedOrg(k);
    await k.secrets.set('oai', 'sk-openai-test');
    bind(org.id, { adapter: 'openai_api', model: 'gpt-5-mini', authRef: 'oai', config: { baseUrl: `${server.url}/v1` } });
    const budgets = { record: vi.fn() };
    const res = await createUtilityModel(k, { budgets }).complete({ orgId: org.id, purpose: 'reflect', json: true, prompt: 'Reflect.' });
    expect(res).toMatchObject({ offline: false, json: { summary: 'done' }, tokensIn: 50, tokensOut: 10 });
    const req = server.requests[0]!;
    expect(req.headers.authorization).toBe('Bearer sk-openai-test');
    expect(req.body).toMatchObject({ model: 'gpt-5-mini', response_format: { type: 'json_object' } });
    expect(budgets.record).toHaveBeenCalledWith(expect.objectContaining({ category: 'reflection', provider: 'openai_api', model: 'gpt-5-mini' }));
  });

  it('a live judge verdict overrides the supersede heuristic on write', async () => {
    let verdict = false;
    server = await mockServer(() => [200, anthropicReply(JSON.stringify({ conflict: verdict }))]);
    const org = seedOrg(k);
    await k.secrets.set('anthropic_key', 'sk-ant-test-key-000000000000');
    bind(org.id, { adapter: 'claude_api', authRef: 'anthropic_key', config: { baseUrl: server.url } });
    const mem = createMemoryService(k, { utility: createUtilityModel(k), embedder: new LocalHashEmbedder() });
    const write = (content: string) => mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'semantic', entity: 'Acme', content }, OWNER);
    const a = await write('Acme: champion is Dana, renewal 2027-03.');
    const b = await write('Acme: champion is Priya, renewal 2027-03.'); // heuristic says conflict, the judge says no
    expect(mem.get(org.id, a.id).status).toBe('active');
    verdict = true;
    const c = await write('Acme: champion is Omar, renewal 2027-03.');
    expect(mem.get(org.id, a.id)).toMatchObject({ status: 'superseded', supersededBy: c.id });
    expect(mem.get(org.id, b.id)).toMatchObject({ status: 'superseded', supersededBy: c.id });
    expect((server.requests[0]!.body as { messages: Array<{ content: string }> }).messages[0]!.content).toMatch(/<existing_fact>\nAcme: champion is Dana/);
  });
});
