import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Agent, Department, Organization } from '../../src/contracts/rows.js';
import type { ToolCallContext } from '../../src/contracts/tools.js';
import { sessionSummaries } from '../../src/db/schema/index.js';
import { estimateTokens } from '../../src/shared/util.js';
import { PROFILE_TOKEN_BUDGET, type BindableMemoryService } from '../../src/memory/index.js';
import { DAY, makeService, seedRun } from './helpers.js';

describe('memory: storage, retrieval, write path', () => {
  let k: TestKernel;
  let mem: BindableMemoryService;
  let org: Organization;
  let dept: Department;
  let ada: Agent;

  beforeEach(() => {
    k = createTestKernel();
    mem = makeService(k);
    org = seedOrg(k);
    dept = seedDept(k, org.id);
    ada = seedAgent(k, org.id, dept.id, 'Ada', { goal: 'Keep finance reporting accurate', backstory: 'Former controller.' });
  });
  afterEach(() => k.dispose());

  const agentActor = (a: Agent, runId?: string) => ({ kind: 'agent' as const, id: a.id, runId });

  it('FR-14: a memory written in run N is recalled in run N+1 on a related issue; the owner can edit and delete it', async () => {
    const runN = seedRun(k, org.id, ada.id);
    const written = await mem.write(
      org.id,
      { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: 'Stripe dashboard export lives under Reports → Balance.', sourceRunId: runN.id },
      agentActor(ada, runN.id),
    );
    await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: 'The office plants are watered every Friday by facilities.' }, agentActor(ada));
    expect(written.status).toBe('active');
    expect(written.sourceRunId).toBe(runN.id);

    k.clock.advance(DAY);
    const bundle = await mem.recall(org.id, ada.id, { title: 'Download last month\'s balance report from Stripe', body: 'Finance needs the export as CSV.' });
    expect(bundle.memories[0]?.memory.id).toBe(written.id);
    expect(bundle.memories.map((m) => m.memory.content).join('\n')).not.toMatch(/plants/);
    expect(bundle.profile).toContain('Role: Engineer');
    // Retrieval bumps usage.
    const after = mem.get(org.id, written.id);
    expect(after.useCount).toBe(1);
    expect(after.lastUsedAt).toBe(k.clock.now());

    const edited = await mem.update(org.id, written.id, { content: 'Stripe balance exports moved to Reporting → Payout reconciliation.', pinned: true }, OWNER);
    expect(edited.content).toMatch(/Payout reconciliation/);
    expect(edited.pinned).toBe(true);
    const found = await mem.search(org.id, { agentId: ada.id, text: 'payout reconciliation export' });
    expect(found[0]?.memory.id).toBe(written.id);

    mem.forget(org.id, written.id, OWNER);
    expect(mem.get(org.id, written.id).status).toBe('forgotten');
    const gone = await mem.recall(org.id, ada.id, { title: 'Download the Stripe balance report', body: '' });
    expect(gone.memories.find((m) => m.memory.id === written.id)).toBeUndefined();

    expect(k.audit.query({ orgId: org.id, action: 'memory.written' }).length).toBeGreaterThanOrEqual(2);
    expect(k.audit.query({ orgId: org.id, action: 'memory.updated', entityId: written.id })).toHaveLength(1);
    expect(k.audit.query({ orgId: org.id, action: 'memory.forgotten', entityId: written.id })).toHaveLength(1);
  });

  it('emits memory.written', async () => {
    const seen: string[] = [];
    k.bus.on('memory.written', (p) => void seen.push(p.memoryId));
    const m = await mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'semantic', content: 'The fiscal year ends in June.', entity: 'Fiscal Year' }, OWNER);
    expect(seen).toEqual([m.id]);
    expect(m.entity).toBe('fiscal year');
    expect(m.author).toBe('owner');
  });

  it('merges near-duplicates: keeps the richer text, max confidence/importance, bumps use', async () => {
    const a = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'lesson', content: 'Check for open duplicates before filing SEO issues', confidence: 0.6, importance: 0.4 }, OWNER);
    const b = await mem.write(
      org.id,
      { scope: 'agent', scopeId: ada.id, kind: 'lesson', content: 'Check for open duplicates before filing SEO issues, always.', confidence: 0.9, importance: 0.8 },
      OWNER,
    );
    expect(b.id).toBe(a.id);
    expect(b.content).toMatch(/always\.$/);
    expect(b.confidence).toBe(0.9);
    expect(b.importance).toBe(0.8);
    expect(b.useCount).toBe(1);
    expect(mem.list(org.id, { kind: 'lesson' })).toHaveLength(1);
    // Same text in a different scope or kind is a different memory.
    const other = await mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'lesson', content: 'Check for open duplicates before filing SEO issues' }, OWNER);
    expect(other.id).not.toBe(a.id);
  });

  it('a conflicting fact about the same entity supersedes the old one, which is kept as history', async () => {
    const old = await mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'semantic', entity: 'Acme Corp', content: 'Acme Corp: champion is Dana, renewal 2027-03.' }, OWNER);
    const unrelated = await mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'semantic', entity: 'Acme Corp', content: 'Acme Corp runs its billing on Postgres 15.' }, OWNER);
    const next = await mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'semantic', entity: 'acme corp', content: 'Acme Corp: champion is Priya, renewal 2027-03.' }, OWNER);

    expect(next.id).not.toBe(old.id);
    const history = mem.get(org.id, old.id);
    expect(history.status).toBe('superseded');
    expect(history.supersededBy).toBe(next.id);
    expect(mem.get(org.id, unrelated.id).status).toBe('active');

    const hits = await mem.search(org.id, { agentId: ada.id, text: 'who is the champion at Acme Corp', entity: 'Acme Corp' });
    expect(hits.map((h) => h.memory.id)).toContain(next.id);
    expect(hits.map((h) => h.memory.id)).not.toContain(old.id);

    // Different entity → no supersede even with the same wording.
    const globex = await mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'semantic', entity: 'Globex', content: 'Globex: champion is Sam, renewal 2027-03.' }, OWNER);
    expect(globex.status).toBe('active');
    expect(mem.get(org.id, next.id).status).toBe('active');
  });

  it('routes low-confidence memories to the review queue, hidden from default searches', async () => {
    const m = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'semantic', entity: 'Initech', content: 'Initech might be switching payroll vendors.', confidence: 0.3 }, agentActor(ada));
    expect(m.status).toBe('review');
    expect(await mem.search(org.id, { agentId: ada.id, text: 'Initech payroll vendor' })).toHaveLength(0);
    const withReview = await mem.search(org.id, { agentId: ada.id, text: 'Initech payroll vendor', includeReview: true });
    expect(withReview.map((h) => h.memory.id)).toEqual([m.id]);
    expect(mem.list(org.id, { status: 'review' }).map((x) => x.id)).toEqual([m.id]);
    // Owner approves from the queue.
    const approved = await mem.update(org.id, m.id, { status: 'active', confidence: 0.8 }, OWNER);
    expect(approved.status).toBe('active');
    expect(await mem.search(org.id, { agentId: ada.id, text: 'Initech payroll vendor' })).toHaveLength(1);
  });

  it('visibility: own ∪ department ∪ org — never another agent\'s private scope, never another org', async () => {
    const sales = seedDept(k, org.id, 'Sales');
    const bob = seedAgent(k, org.id, dept.id, 'Bob');
    const sue = seedAgent(k, org.id, sales.id, 'Sue');
    const org2 = seedOrg(k, 'Globex');
    const dept2 = seedDept(k, org2.id);
    const eve = seedAgent(k, org2.id, dept2.id, 'Eve');

    const text = 'The deploy runbook for the billing service requires a database snapshot first.';
    const mine = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'procedural', content: `${text} (ada)` }, OWNER);
    const bobs = await mem.write(org.id, { scope: 'agent', scopeId: bob.id, kind: 'procedural', content: `${text} (bob private)` }, OWNER);
    const deptWide = await mem.write(org.id, { scope: 'dept', scopeId: dept.id, kind: 'procedural', content: `${text} (engineering)` }, OWNER);
    const salesWide = await mem.write(org.id, { scope: 'dept', scopeId: sales.id, kind: 'procedural', content: `${text} (sales)` }, OWNER);
    const orgWide = await mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'procedural', content: `${text} (org)` }, OWNER);
    const foreign = await mem.write(org2.id, { scope: 'org', scopeId: org2.id, kind: 'procedural', content: `${text} (other org)` }, OWNER);

    const ids = async (o: string, agentId: string) => (await mem.search(o, { agentId, text: 'billing service deploy runbook', limit: 50 })).map((h) => h.memory.id).sort();
    expect(await ids(org.id, ada.id)).toEqual([mine.id, deptWide.id, orgWide.id].sort());
    expect(await ids(org.id, sue.id)).toEqual([salesWide.id, orgWide.id].sort());
    expect(await ids(org2.id, eve.id)).toEqual([foreign.id]);
    const recalled = (await mem.recall(org.id, ada.id, { title: 'Deploy the billing service', body: 'follow the runbook' })).memories.map((m) => m.memory.id);
    expect(recalled).not.toContain(bobs.id);
    expect(recalled).not.toContain(foreign.id);

    // Cross-org ids behave as not found.
    expect(() => mem.get(org2.id, mine.id)).toThrow(/not found/);
    expect(() => mem.forget(org2.id, mine.id, OWNER)).toThrow(/not found/);
    await expect(mem.update(org2.id, mine.id, { pinned: true }, OWNER)).rejects.toThrow(/not found/);
    await expect(mem.search(org2.id, { agentId: ada.id, text: 'runbook' })).rejects.toThrow(/not found/);
    await expect(mem.recall(org2.id, ada.id, { title: 'x', body: '' })).rejects.toThrow(/not found/);
    await expect(mem.write(org2.id, { scope: 'agent', scopeId: ada.id, kind: 'lesson', content: 'cross-org write' }, OWNER)).rejects.toThrow(/not found/);
    await expect(mem.write(org.id, { scope: 'org', scopeId: org2.id, kind: 'lesson', content: 'cross-org write' }, OWNER)).rejects.toThrow(/not found/);
    expect(mem.list(org2.id).map((m) => m.id)).toEqual([foreign.id]);
    // Owner search without an agent still never leaves the org.
    expect((await mem.search(org2.id, { text: 'billing service deploy runbook', limit: 50 })).map((h) => h.memory.id)).toEqual([foreign.id]);
  });

  it('validates input at the boundary', async () => {
    await expect(mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'lesson', content: '   ' }, OWNER)).rejects.toMatchObject({ code: 'validation' });
    await expect(mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'lesson', content: 'x', confidence: 1.5 }, OWNER)).rejects.toMatchObject({ code: 'validation' });
    await expect(mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'nope' as never, content: 'x' }, OWNER)).rejects.toMatchObject({ code: 'validation' });
    await expect(mem.search(org.id, { text: '' })).rejects.toMatchObject({ code: 'validation' });
    const m = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'lesson', content: 'A real lesson about invoices.' }, OWNER);
    await expect(mem.update(org.id, m.id, { importance: 7 }, OWNER)).rejects.toMatchObject({ code: 'validation' });
    await expect(mem.update(org.id, m.id, { orgId: 'x' } as never, OWNER)).rejects.toMatchObject({ code: 'validation' });
  });

  describe('hybrid ranking = similarity × recency × importance × confidence', () => {
    const base = 'Quarterly VAT filing steps for the Dutch entity';
    const write = (suffix: string, extra: { importance?: number; confidence?: number; pinned?: boolean } = {}) =>
      mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'episodic', content: `${base} ${suffix}`, importance: 0.5, confidence: 0.7, ...extra }, OWNER);
    const order = async () => (await mem.search(org.id, { agentId: ada.id, text: 'Dutch VAT filing steps', limit: 10 })).map((h) => h.memory.id);

    it('importance and confidence each move the score', async () => {
      const plain = await write('alpha');
      const important = await write('bravo', { importance: 0.9 });
      const unsure = await write('charlie', { confidence: 0.5 });
      expect(await order()).toEqual([important.id, plain.id, unsure.id]);
    });

    it('recency decays the score; pinned memories do not decay', async () => {
      const old = await write('alpha');
      const pinnedOld = await write('bravo', { pinned: true });
      k.clock.advance(60 * DAY);
      const fresh = await write('charlie');
      const hits = await mem.search(org.id, { agentId: ada.id, text: 'Dutch VAT filing steps', limit: 10 });
      const score = (id: string) => hits.find((h) => h.memory.id === id)!.score;
      expect(score(fresh.id)).toBeGreaterThan(score(old.id) * 3);
      expect(score(pinnedOld.id)).toBeGreaterThan(score(old.id) * 3);
      expect(hits[hits.length - 1]?.memory.id).toBe(old.id);
    });

    it('similarity moves the score and blends keyword hits', async () => {
      const close = await write('alpha');
      const far = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'episodic', content: 'Dutch entity onboarding checklist for new hires' }, OWNER);
      const hits = await mem.search(org.id, { agentId: ada.id, text: 'Dutch VAT filing steps', limit: 10 });
      expect(hits.map((h) => h.memory.id)).toEqual([close.id, far.id]);
      expect(hits[0]!.similarity).toBeGreaterThan(hits[1]!.similarity);
      expect(hits[0]!.similarity).toBeLessThanOrEqual(1);
    });
  });

  it('recall: lessons for the task type rank first; semantic facts come by entity mention; profile and owner model are injected', async () => {
    const lesson = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'lesson', taskType: 'seo-audit', content: 'Never file tickets without checking the open duplicates list.', importance: 0.3 }, OWNER);
    const otherLesson = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'lesson', taskType: 'invoicing', content: 'Round invoice totals only at the end.' }, OWNER);
    const fact = await mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'semantic', entity: 'Acme Corp', content: 'Their champion is Dana and the renewal is due in March.' }, OWNER);
    const proc = await mem.write(org.id, { scope: 'dept', scopeId: dept.id, kind: 'procedural', content: 'To audit page titles for SEO, crawl the sitemap and compare against the keyword sheet.', importance: 0.9, confidence: 0.95 }, OWNER);
    await mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'owner_model', content: 'Owner rejects designs with stock photos.' }, OWNER);
    await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'profile', content: 'Always cc ops@ on vendor emails.' }, OWNER);
    mem.setProfileDoc(org.id, ada.id, '# Standing rules\n- Brand voice is plain, no exclamation marks.', OWNER);
    mem.setOwnerModel(org.id, 'The owner reads the digest at 8am.', OWNER);

    const bundle = await mem.recall(org.id, ada.id, { title: 'SEO audit of page titles for Acme Corp', body: 'Crawl the sitemap and report issues.', taskType: 'seo-audit' });
    const ids = bundle.memories.map((m) => m.memory.id);
    expect(ids[0]).toBe(lesson.id);
    expect(ids).toContain(fact.id);
    expect(ids).toContain(proc.id);
    expect(ids).not.toContain(otherLesson.id);
    expect(bundle.profile).toMatch(/Role: Engineer/);
    expect(bundle.profile).toMatch(/Goal: Keep finance reporting accurate/);
    expect(bundle.profile).toMatch(/no exclamation marks/);
    expect(bundle.profile).toMatch(/cc ops@/);
    expect(bundle.ownerModel).toMatch(/digest at 8am/);
    expect(bundle.ownerModel).toMatch(/stock photos/);
    expect(bundle.memories.every((m) => m.memory.kind !== 'profile' && m.memory.kind !== 'owner_model')).toBe(true);
  });

  it('profile docs live at the configured paths and the injected profile is truncated to the 2k-token budget', async () => {
    const rules = Array.from({ length: 900 }, (_, i) => `- Standing rule number ${i}: handle case ${i} carefully.`).join('\n');
    mem.setProfileDoc(org.id, ada.id, rules, OWNER);
    const file = k.paths.agentMemoryFile(org.slug, ada.slug);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(rules);
    expect(mem.getProfileDoc(org.id, ada.id)).toBe(rules);
    expect(estimateTokens(rules)).toBeGreaterThan(PROFILE_TOKEN_BUDGET);

    const bundle = await mem.recall(org.id, ada.id, { title: 'anything', body: '' });
    expect(estimateTokens(bundle.profile)).toBeLessThanOrEqual(PROFILE_TOKEN_BUDGET);
    expect(bundle.profile).toMatch(/^# Ada\nRole: Engineer/);
    expect(bundle.profile).toMatch(/truncated/);

    mem.setOwnerModel(org.id, 'Prefers short updates.', OWNER);
    expect(readFileSync(k.paths.ownerModelFile(org.slug), 'utf8')).toBe('Prefers short updates.');
    expect(mem.getOwnerModel(org.id)).toBe('Prefers short updates.');
    const org2 = seedOrg(k, 'Globex');
    expect(mem.getOwnerModel(org2.id)).toBe('');
    expect(() => mem.getProfileDoc(org2.id, ada.id)).toThrow(/not found/);
  });

  it('searchSessions: FTS5 over run summaries, scoped to org and agent', () => {
    const bob = seedAgent(k, org.id, dept.id, 'Bob');
    const org2 = seedOrg(k, 'Globex');
    const add = (orgId: string, agentId: string, summary: string) => {
      const run = seedRun(k, orgId, agentId);
      k.db.insert(sessionSummaries).values({ runId: run.id, orgId, agentId, issueId: null, summary, createdAt: k.clock.now() }).run();
      return run.id;
    };
    const r1 = add(org.id, ada.id, 'SEO audit of the pricing pages; 14 issues filed, 2 rejected as duplicates.');
    const r2 = add(org.id, bob.id, 'Audited the invoicing pipeline and fixed rounding.');
    add(org2.id, 'agt_other', 'SEO audit for the other org.');

    expect(mem.searchSessions(org.id, ada.id, 'seo audits').map((s) => s.runId)).toEqual([r1]);
    expect(mem.searchSessions(org.id, null, 'audited').map((s) => s.runId).sort()).toEqual([r1, r2].sort());
    expect(mem.searchSessions(org.id, ada.id, 'kubernetes')).toEqual([]);
    expect(mem.searchSessions(org.id, ada.id, '"); drop table')).toEqual([]);
  });

  describe('conductor-memory tool provider', () => {
    const ctx = (a: Agent, autonomyLevel = a.autonomyLevel): ToolCallContext => ({
      orgId: a.orgId, agentId: a.id, deptId: a.deptId, runId: 'run_tool', issueId: null, workspacePath: '/tmp', autonomyLevel,
    });
    const parse = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content[0]!.text!) as never;

    it('exposes four tools with schemas and risk levels', async () => {
      const p = mem.toolProvider();
      expect(p.id).toBe('conductor-memory');
      const tools = await p.tools(ctx(ada));
      expect(tools.map((t) => [t.name, t.risk])).toEqual([['memory_search', 'read'], ['memory_write', 'write'], ['memory_forget', 'write'], ['session_search', 'read']]);
      for (const t of tools) {
        expect(t.inputSchema.type).toBe('object');
        expect(t.inputSchema.additionalProperties).toBe(false);
        expect(Array.isArray(t.inputSchema.required)).toBe(true);
      }
    });

    it('writes to own scope; dept/org scope needs autonomy ≥ 2, otherwise the review queue', async () => {
      const p = mem.toolProvider();
      const own = parse(await p.call(ctx(ada, 1), 'memory_write', { content: 'The staging database resets every Sunday night.', kind: 'semantic', entity: 'staging' })) as { id: string; status: string };
      expect(own.status).toBe('active');
      const stored = mem.get(org.id, own.id);
      expect([stored.scope, stored.scopeId, stored.sourceRunId, stored.author]).toEqual(['agent', ada.id, 'run_tool', `agent:${ada.id}`]);

      const queued = parse(await p.call(ctx(ada, 1), 'memory_write', { content: 'Everyone must tag releases with the ticket number.', kind: 'procedural', scope: 'org' })) as { id: string; status: string };
      expect(queued.status).toBe('review');
      expect(mem.get(org.id, queued.id).scopeId).toBe(org.id);

      const direct = parse(await p.call(ctx(ada, 2), 'memory_write', { content: 'Engineering freezes deploys on Fridays after 3pm.', kind: 'procedural', scope: 'dept' })) as { id: string; status: string };
      expect(direct.status).toBe('active');
      expect(mem.get(org.id, direct.id).scopeId).toBe(dept.id);

      const hits = parse(await p.call(ctx(ada), 'memory_search', { query: 'when does staging database reset' })) as Array<{ id: string }>;
      expect(hits[0]?.id).toBe(own.id);
      await expect(p.call(ctx(ada), 'memory_write', { content: 'x', kind: 'semantic', scopeId: 'agt_other' })).rejects.toMatchObject({ code: 'validation' });
      await expect(p.call(ctx(ada), 'nope', {})).rejects.toMatchObject({ code: 'validation' });
    });

    it('memory_forget is own-scope only; session_search is the caller\'s own history', async () => {
      const p = mem.toolProvider();
      const bob = seedAgent(k, org.id, dept.id, 'Bob');
      const mine = await mem.write(org.id, { scope: 'agent', scopeId: ada.id, kind: 'lesson', content: 'Obsolete lesson about the old CMS.' }, OWNER);
      const shared = await mem.write(org.id, { scope: 'dept', scopeId: dept.id, kind: 'lesson', content: 'Department lesson about code review.' }, OWNER);
      const bobs = await mem.write(org.id, { scope: 'agent', scopeId: bob.id, kind: 'lesson', content: 'Bob keeps his own notes on the CMS.' }, OWNER);

      await expect(p.call(ctx(ada), 'memory_forget', { memory_id: shared.id })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(p.call(ctx(ada), 'memory_forget', { memory_id: bobs.id })).rejects.toMatchObject({ code: 'forbidden' });
      await p.call(ctx(ada), 'memory_forget', { memory_id: mine.id });
      expect(mem.get(org.id, mine.id).status).toBe('forgotten');
      expect(mem.get(org.id, bobs.id).status).toBe('active');

      const run = seedRun(k, org.id, bob.id);
      k.db.insert(sessionSummaries).values({ runId: run.id, orgId: org.id, agentId: bob.id, issueId: null, summary: 'Migrated the CMS templates.', createdAt: k.clock.now() }).run();
      expect(parse(await p.call(ctx(ada), 'session_search', { query: 'CMS templates' }))).toEqual([]);
      expect((parse(await p.call(ctx(bob), 'session_search', { query: 'CMS templates' })) as unknown[]).length).toBe(1);
    });
  });
});
