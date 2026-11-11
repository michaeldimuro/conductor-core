import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Agent, Issue, Organization } from '../../src/contracts/rows.js';
import { comments, issues, memories, organizations, runs, settings } from '../../src/db/schema/index.js';
import { newId } from '../../src/shared/ids.js';
import { createEmbedder, createMemoryService, createUtilityModel, type BindableMemoryService } from '../../src/memory/index.js';
import { call, DAY, fakeSkills, makeService, mockServer, result, say, seedIssue, seedRun, type MockServer } from './helpers.js';

describe('review verdicts reach the learning loop', () => {
  let k: TestKernel;
  let mem: BindableMemoryService;
  let skills: ReturnType<typeof fakeSkills>;
  let org: Organization;
  let ada: Agent;

  beforeEach(() => {
    k = createTestKernel();
    skills = fakeSkills();
    mem = makeService(k, { skills });
    org = seedOrg(k);
    ada = seedAgent(k, org.id, seedDept(k, org.id).id, 'Ada');
  });
  afterEach(() => k.dispose());

  /** What the work context does on `review()`: status + review_outcome, the `issue.reviewed` audit row, a `Review …:` comment. */
  const review = (issue: Issue, outcome: 'accepted' | 'edited' | 'rejected', note?: string, orgId = org.id) => {
    const now = k.clock.now();
    k.db.update(issues).set(outcome === 'rejected' ? { status: 'todo', reviewOutcome: outcome, reworkCount: 1 } : { status: 'done', reviewOutcome: outcome, closedAt: now }).where(eq(issues.id, issue.id)).run();
    k.audit.record({ orgId, actor: OWNER, action: 'issue.reviewed', entityKind: 'issue', entityId: issue.id, issueId: issue.id, data: { outcome } });
    if (note || outcome === 'rejected') {
      const body = outcome === 'rejected' ? `Review rejected — rework needed: ${note ?? 'no note given'}` : `Review ${outcome}: ${note}`;
      k.db.insert(comments).values({ id: newId('comment'), orgId, issueId: issue.id, authorKind: 'human', authorId: 'owner', body, createdAt: now }).run();
    }
  };
  const gradeOf = (runId: string) => k.db.select({ grade: runs.grade }).from(runs).where(eq(runs.id, runId)).get()?.grade;
  const work = [say('Drafting the launch email.'), call('1', 'gmail__draft', { to: 'list' }), result('1', 'gmail__draft', 'Draft saved'), say('Done — draft is ready for review.')];

  it('an edited verdict re-grades the run, refreshes the episode, stores the correction as a lesson and opens a skill draft', async () => {
    const issue = seedIssue(k, org.id, { title: 'Write the launch email', taskType: 'launch-email', status: 'in_review', assigneeAgentId: ada.id });
    const run = seedRun(k, org.id, ada.id, { issueId: issue.id, costUsd: 0.2, steps: 3 }, work);
    const first = await mem.reflect(org.id, run.id);
    // Reflection runs before review: the verdict is still pending and no human-correction trigger fires.
    expect(first.grade).toMatchObject({ reviewOutcome: 'pending', success: true, issueClosed: false });
    expect(skills.manage).not.toHaveBeenCalled();
    expect(await mem.applyReview(org.id, issue.id)).toBeNull(); // nothing to apply yet

    k.clock.advance(60_000);
    review(issue, 'edited', 'Lead with the customer benefit, and never use exclamation marks.');
    const regrade = await mem.applyReview(org.id, issue.id);
    expect(regrade).toMatchObject({ runId: run.id, agentId: ada.id, issueId: issue.id, grade: { reviewOutcome: 'edited', issueClosed: true, success: true }, previous: { reviewOutcome: 'pending' } });
    expect(gradeOf(run.id)).toMatchObject({ reviewOutcome: 'edited', issueClosed: true });

    const mine = k.db.select().from(memories).where(and(eq(memories.orgId, org.id), eq(memories.sourceRunId, run.id))).all();
    expect(mine.find((m) => m.kind === 'episodic')?.content).toContain('review edited');
    const lesson = mine.find((m) => m.kind === 'lesson' && m.content.includes('never use exclamation marks'));
    expect(lesson).toMatchObject({ scope: 'agent', scopeId: ada.id, status: 'active', taskType: 'launch-email' });
    // "A correction from a human" → a skill draft for this task type, carrying the reviewer's note.
    expect(skills.manage).toHaveBeenCalledTimes(1);
    expect(skills.created[0]).toMatchObject({ ctx: { orgId: org.id, agentId: ada.id, runId: run.id }, input: { action: 'create', name: 'launch-email', reason: 'learning loop: human_correction' } });
    expect(k.audit.query({ orgId: org.id, action: 'run.regraded' })[0]).toMatchObject({ entityId: run.id, data: { grade: { reviewOutcome: 'edited' } } });

    // Idempotent: the same verdict is not applied twice.
    expect(await mem.applyReview(org.id, issue.id)).toBeNull();
    expect(skills.manage).toHaveBeenCalledTimes(1);
  });

  it('a rejection fails the run it judged — not the rework run after it — and the scorecard follows', async () => {
    const issue = seedIssue(k, org.id, { title: 'Reconcile the ledger', taskType: 'ledger', status: 'in_review', assigneeAgentId: ada.id });
    const run1 = seedRun(k, org.id, ada.id, { issueId: issue.id, costUsd: 0.3, steps: 2 }, work);
    await mem.reflect(org.id, run1.id);
    expect(mem.scorecard(org.id, ada.id)).toMatchObject({ runs: 1, successRate: 1 });

    k.clock.advance(60_000);
    review(issue, 'rejected', 'The totals do not match the bank statement.');
    expect(await mem.applyReview(org.id, issue.id)).toMatchObject({ runId: run1.id, grade: { reviewOutcome: 'rejected', success: false } });
    expect(mem.scorecard(org.id, ada.id)).toMatchObject({ runs: 1, successRate: 0, reworkRate: 1 });
    // A rejected transcript is not distilled into a skill.
    expect(skills.manage).not.toHaveBeenCalled();

    // The rework run is graded on its own: the old rejection (still in issues.review_outcome) is not inherited.
    k.clock.advance(60_000);
    const run2 = seedRun(k, org.id, ada.id, { issueId: issue.id, costUsd: 0.1, steps: 2 }, work);
    k.db.update(issues).set({ status: 'in_review' }).where(eq(issues.id, issue.id)).run();
    expect((await mem.reflect(org.id, run2.id)).grade).toMatchObject({ reviewOutcome: 'pending', success: true });
    expect(await mem.applyReview(org.id, issue.id)).toBeNull();

    k.clock.advance(60_000);
    review(issue, 'accepted');
    expect(await mem.applyReview(org.id, issue.id)).toMatchObject({ runId: run2.id, grade: { reviewOutcome: 'accepted', success: true, issueClosed: true } });
    expect(gradeOf(run1.id)).toMatchObject({ reviewOutcome: 'rejected', success: false });
    expect(mem.scorecard(org.id, ada.id)).toMatchObject({ runs: 2, successRate: 0.5, issuesClosed: 1 });
  });

  it('is org-scoped and ignores issues without a verdict or a run', async () => {
    const issue = seedIssue(k, org.id, { status: 'in_review', assigneeAgentId: ada.id });
    seedRun(k, org.id, ada.id, { issueId: issue.id }, work);
    const other = seedOrg(k, 'Globex');
    await expect(mem.applyReview(other.id, issue.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await mem.applyReview(org.id, issue.id)).toBeNull();
    const orphan = seedIssue(k, org.id, { status: 'done', reviewOutcome: 'accepted' });
    expect(await mem.applyReview(org.id, orphan.id)).toBeNull();
  });

  it('scorecards count only real loop runs: chat turns and skill-eval replays are left out', async () => {
    const issue = seedIssue(k, org.id, { taskType: 'ledger', status: 'done', assigneeAgentId: ada.id });
    seedRun(k, org.id, ada.id, { issueId: issue.id, costUsd: 0.5, trigger: 'heartbeat' });
    seedRun(k, org.id, ada.id, { issueId: issue.id, costUsd: 9, trigger: 'chat' });
    seedRun(k, org.id, ada.id, { costUsd: 7, trigger: 'system', status: 'failed', outcome: 'failed' }); // sandboxed eval replay
    seedRun(k, org.id, ada.id, { costUsd: 0, trigger: 'heartbeat', outcome: 'no_work' });
    const card = mem.scorecard(org.id, ada.id);
    expect(card).toMatchObject({ runs: 1, successRate: 1, issuesClosed: 1, costPerIssue: 0.5 });
    expect(card.byTaskType).toEqual([{ taskType: 'ledger', runs: 1, successRate: 1, costPerIssue: 0.5 }]);
    k.clock.advance(DAY);
    expect(mem.snapshotScorecards(org.id).map((s) => [s.taskType, s.runs])).toEqual([[null, 1], ['ledger', 1]]);
  });
});

describe('embedder selection and status', () => {
  let k: TestKernel;
  let server: MockServer | null = null;
  const setSetting = (key: string, value: unknown) =>
    k.db.insert(settings).values({ key, value, updatedAt: k.clock.now() }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  const embeddingServer = (state: { fail: boolean }) =>
    mockServer((req) => {
      if (state.fail) return [500, { error: { message: 'boom' } }];
      const input = (req.body as { input: string[] }).input;
      return [200, { object: 'list', model: 'text-embedding-3-small', data: input.map((t, index) => ({ object: 'embedding', index, embedding: Array.from({ length: 1536 }, (_, i) => (i === t.length % 1536 ? 1 : 0)) })), usage: { prompt_tokens: 1, total_tokens: 1 } }];
    });

  beforeEach(() => {
    k = createTestKernel();
  });
  afterEach(async () => {
    await server?.close();
    server = null;
    k.dispose();
  });

  it('auto mode: hash fallback without a key, real embeddings as soon as an OpenAI key exists; "local" opts out', async () => {
    const state = { fail: false };
    server = await embeddingServer(state);
    setSetting('embeddings.baseUrl', `${server.url}/v1`);

    const none = createEmbedder(k);
    expect(await none.status()).toMatchObject({ provider: 'local', semantic: false, mode: 'auto', id: 'local-hash-v1:384', authRef: null });
    expect((await none.status()).reason).toContain('no embedding provider key');

    await k.secrets.set('conductor/openai-api-key', 'sk-install');
    const auto = createEmbedder(k);
    expect(await auto.status()).toMatchObject({ provider: 'openai', semantic: true, mode: 'auto', id: 'openai:text-embedding-3-small:1536', dims: 1536, authRef: 'conductor/openai-api-key' });
    expect((await auto.embed(['abc']))[0]).toHaveLength(1536);
    expect(server.requests[0]!.headers.authorization).toBe('Bearer sk-install');

    setSetting('embeddings.provider', 'local');
    const pinned = createEmbedder(k);
    expect(await pinned.status()).toMatchObject({ provider: 'local', mode: 'local', semantic: false });
    expect(JSON.stringify(await auto.status())).not.toContain('sk-install');
  });

  it('auto mode on a single-org install uses that org\'s OpenAI binding key, never with several orgs', async () => {
    const org = seedOrg(k, 'Acme');
    k.db.update(organizations).set({ utilityModel: { adapter: 'openai_api', model: 'gpt-5-mini', authRef: 'acme-openai' } }).where(eq(organizations.id, org.id)).run();
    await k.secrets.set('acme-openai', 'sk-acme');
    expect(await createEmbedder(k).status()).toMatchObject({ provider: 'openai', authRef: 'acme-openai' });
    seedOrg(k, 'Globex');
    expect(await createEmbedder(k).status()).toMatchObject({ provider: 'local', mode: 'auto' });
  });

  it('auto mode degrades to the local embedder when the provider fails, and memory keeps working', async () => {
    const state = { fail: false };
    server = await embeddingServer(state);
    setSetting('embeddings.baseUrl', `${server.url}/v1`);
    await k.secrets.set('openai_api_key', 'sk-test');
    const org = seedOrg(k, 'Acme');
    const embedder = createEmbedder(k);
    const mem = createMemoryService(k, { utility: createUtilityModel(k), embedder });
    const a = await mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'semantic', content: 'Invoices are exported monthly as CSV.' }, OWNER);
    expect(await mem.embedderStatus()).toMatchObject({ provider: 'openai', semantic: true });

    state.fail = true;
    const b = await mem.write(org.id, { scope: 'org', scopeId: org.id, kind: 'semantic', content: 'The staging deploy runs every Tuesday.' }, OWNER);
    const status = await mem.embedderStatus();
    expect(status).toMatchObject({ provider: 'local', semantic: false, mode: 'auto' });
    expect(status.reason).toContain('embedding provider failed');
    // The index was rebuilt for the fallback embedder: both memories are searchable.
    const hits = await mem.search(org.id, { text: 'staging deploy Tuesday' });
    expect(hits[0]?.memory.id).toBe(b.id);
    expect((await mem.search(org.id, { text: 'invoices exported CSV' }))[0]?.memory.id).toBe(a.id);
  }, 20_000);

  it('a fixed embedder reports itself; the external backend setting is validated, audited and org-scoped', async () => {
    const org = seedOrg(k, 'Acme');
    const mem = makeService(k);
    expect(await mem.embedderStatus()).toMatchObject({ provider: 'local', mode: 'fixed', id: 'local-hash-v1:384', semantic: false });

    expect(await mem.getExternalBackend(org.id)).toBeNull();
    const set = await mem.setExternalBackend(org.id, { kind: 'mem0', authRef: 'mem0_key', baseUrl: 'https://mem0.example.test' }, OWNER);
    expect(set).toEqual({ kind: 'mem0', authRef: 'mem0_key', baseUrl: 'https://mem0.example.test', ready: false });
    expect(k.db.select().from(settings).where(eq(settings.key, `memory.backend.${org.id}`)).get()?.value).toEqual({ kind: 'mem0', authRef: 'mem0_key', baseUrl: 'https://mem0.example.test' });
    await k.secrets.set('mem0_key', 'm0-secret');
    expect(await mem.getExternalBackend(org.id)).toMatchObject({ kind: 'mem0', ready: true });
    expect(JSON.stringify(k.audit.query({ orgId: org.id, action: 'config.changed' }))).not.toContain('m0-secret');
    expect(k.audit.query({ orgId: org.id, action: 'config.changed' })).toHaveLength(1);

    await expect(mem.setExternalBackend(org.id, { kind: 'pinecone' as 'mem0', authRef: 'x' }, OWNER)).rejects.toMatchObject({ code: 'validation' });
    await expect(mem.setExternalBackend(org.id, { kind: 'zep', authRef: '' }, OWNER)).rejects.toMatchObject({ code: 'validation' });
    await expect(mem.setExternalBackend('org_missing', { kind: 'zep', authRef: 'z' }, OWNER)).rejects.toMatchObject({ code: 'not_found' });
    const other = seedOrg(k, 'Globex');
    expect(await mem.getExternalBackend(other.id)).toBeNull();

    expect(await mem.setExternalBackend(org.id, null, OWNER)).toBeNull();
    expect(await mem.getExternalBackend(org.id)).toBeNull();
  });
});
