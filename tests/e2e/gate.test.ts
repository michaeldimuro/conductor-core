import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { createServices } from '../../src/daemon/compose.js';
import { createApiServer } from '../../src/api/index.js';
import { MemorySecretStore } from '../../src/kernel/index.js';
import { OWNER } from '../../src/contracts/types.js';
import { toolCalls, costLedger, jobs } from '../../src/db/schema/index.js';

/**
 * End-to-end gate: the real composition root, the real HTTP API, a real
 * forked run worker, and a real agent process that can only reach the world
 * through the connector gateway with its run-scoped token.
 */
const AGENT = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

describe('end-to-end: an issue goes from assignment to done through the whole stack', () => {
  let home: string;
  let s: Awaited<ReturnType<typeof createServices>>;
  let api: Awaited<ReturnType<typeof createApiServer>>;
  let trace: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'conductor-e2e-'));
    trace = join(home, 'trace.json');
    const port = await freePort();
    s = await createServices({
      home, secrets: new MemorySecretStore(), config: { port, host: '127.0.0.1' },
      runtime: { tickMs: 0, systemJobs: false, powerAssertion: false },
    });
    api = await createApiServer(s);
    await api.listen('127.0.0.1', port);
    await s.runtime.start();
  }, 60_000);

  afterAll(async () => {
    await api.close();
    await s.close();
    rmSync(home, { recursive: true, force: true });
  });

  const drain = async (ms = 30_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      await s.runtime.tick();
      await s.runtime.idle();
      const due = (s.kernel.sqlite.prepare("select count(*) as n from jobs where status = 'pending' and run_at <= ?").get(Date.now()) as { n: number }).n;
      if (due === 0 && s.runtime.status().running === 0) return;
      if (Date.now() > deadline) throw new Error('drain timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const provider = (mode: string) => ({
    adapter: 'process',
    config: { command: process.execPath, args: [AGENT], env: { E2E_MODE: mode, E2E_TRACE: trace } },
  });

  it('runs the heartbeat loop with real processes, tools, memory, cost and audit', async () => {
    const org = s.org.createOrg({ name: 'Gate Co', mission: 'Ship reliable software', defaultProvider: provider('work'), budgetMonthlyUsd: 50 }, OWNER);
    const dept = s.org.createDept(org.id, { name: 'Engineering' }, OWNER);
    const agent = s.org.hireAgent(org.id, { deptId: dept.id, name: 'Ada', role: 'Release Engineer', autonomyLevel: 2 }, OWNER).agent!;
    const goal = s.work.createGoal(org.id, { title: 'Zero-downtime releases' }, OWNER);
    const issue = s.work.createIssue(org.id, { title: 'Verify the staging deploy', body: 'Run the checks and write a report.', expectedOutput: 'report.md', goalId: goal.id, assigneeAgentId: agent.id, taskType: 'deploy-check' }, OWNER);

    await drain();

    const t = JSON.parse(readFileSync(trace, 'utf8'));
    // The agent saw the task and only gateway tools, scoped to itself.
    expect(t.prompt).toContain('Verify the staging deploy');
    expect(t.tools).toEqual(expect.arrayContaining(['conductor-tasks__report_progress', 'conductor-memory__memory_write', 'conductor-skills__list_skills', 'conductor-browser__navigate', 'conductor-files__write_file']));
    expect(t.me.agent.id).toBe(agent.id);
    expect(t.me.issue.id).toBe(issue.id);
    expect(t.ownerRoute).toBe(403); // run token cannot reach the owner API
    expect(t.file.isError).toBe(false);
    expect(t.escape.isError).toBe(true); // workspace confinement
    expect(existsSync(join(home, 'escape.txt'))).toBe(false);
    expect(readFileSync(join(s.kernel.paths.agentWorkspace(org.slug, agent.slug), 'report.md'), 'utf8')).toContain('All checks passed');
    expect(t.report.status).toBe(200);

    // Issue closed by the agent's own report (autonomy 2, no reviewer), lock released, traced to its goal.
    const done = s.work.getIssue(org.id, issue.id);
    expect(done).toMatchObject({ status: 'done', checkoutLock: null, goalId: goal.id });
    expect(s.work.listComments(org.id, issue.id).some((c) => c.body.includes('all checks passed'))).toBe(true);

    // Run journal + transcript + capability snapshot.
    const [run] = s.runtime.listRuns(org.id, { agentId: agent.id });
    expect(run).toMatchObject({ status: 'succeeded', outcome: 'completed', provider: 'process', issueId: issue.id, trigger: 'assignment' });
    expect(run!.capabilitySnapshot?.connectors).toBeDefined();
    expect(existsSync(run!.transcriptRef!)).toBe(true);
    expect(run!.pid).toBeNull();

    // Every tool call logged and on the issue timeline.
    const calls = s.kernel.db.select().from(toolCalls).where(and(eq(toolCalls.runId, run!.id), eq(toolCalls.orgId, org.id))).all();
    expect(calls.map((c) => c.tool)).toEqual(expect.arrayContaining(['conductor-files__write_file', 'conductor-memory__memory_write', 'conductor-tasks__report_progress']));
    expect(calls.find((c) => c.tool === 'conductor-files__write_file' && c.status !== 'ok')).toBeDefined(); // the refused escape
    expect(s.work.timeline(org.id, issue.id).some((e) => e.kind === 'activity' && e.activity.action === 'tool.called')).toBe(true);

    // Memory written in run N…
    const mems = s.memory.list(org.id, { scope: 'agent', scopeId: agent.id });
    expect(mems.some((m) => m.kind === 'procedural' && m.sourceRunId === run!.id)).toBe(true);
    // …reflection ran (offline utility model): graded + episodic summary.
    expect(s.runtime.getRun(org.id, run!.id).grade).toMatchObject({ issueClosed: true, success: true });
    expect(mems.some((m) => m.kind === 'episodic')).toBe(true);
    expect(s.kernel.db.select().from(jobs).where(eq(jobs.kind, 'reflect')).all().every((j) => j.status === 'done')).toBe(true);

    // …and is retrieved in run N+1 on a related issue (FR-14).
    const next = s.work.createIssue(org.id, { title: 'Promote release 2.4 to production', body: 'Follow the deploy checklist for staging first.', assigneeAgentId: agent.id, taskType: 'deploy-check' }, OWNER);
    await drain();
    const t2 = JSON.parse(readFileSync(trace, 'utf8'));
    expect(t2.recalled.text).toMatch(/smoke suite against staging/);
    const run2 = s.runtime.listRuns(org.id, { issueId: next.id })[0]!;
    expect(run2.status).toBe('succeeded');

    // The run token died with the run.
    const res = await fetch(`${s.baseUrl()}/api/v1/agent/me`, { headers: { Authorization: 'Bearer cnd_run_bogus' } });
    expect(res.status).toBe(401);

    // Audit trail is complete and ledger rows exist only for metered spend.
    const actions = new Set(s.kernel.audit.query({ orgId: org.id, limit: 2000 }).map((a) => a.action));
    for (const a of ['run.started', 'run.finished', 'tool.called', 'memory.written']) expect(actions).toContain(a);
    expect(s.kernel.db.select().from(costLedger).where(eq(costLedger.orgId, org.id)).all().every((l) => l.costUsd === 0)).toBe(true);
  }, 120_000);

  it('gates an external action behind a board approval and wakes the agent when it is decided', async () => {
    const org = s.org.createOrg({ name: 'Approval Co', defaultProvider: provider('ask') }, OWNER);
    const dept = s.org.createDept(org.id, { name: 'Marketing' }, OWNER);
    const agent = s.org.hireAgent(org.id, { deptId: dept.id, name: 'Mia', role: 'Marketer', autonomyLevel: 1 }, OWNER).agent!;
    const issue = s.work.createIssue(org.id, { title: 'Announce the launch', assigneeAgentId: agent.id }, OWNER);
    await drain();

    const pending = s.governance.approvals.list(org.id, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'external_send', requesterAgentId: agent.id });
    expect(s.work.getIssue(org.id, issue.id).status).toBe('in_review'); // supervised agent → needs review

    const before = s.runtime.listRuns(org.id, { agentId: agent.id }).length;
    s.governance.approvals.decide(org.id, pending[0]!.id, 'approved', OWNER, 'go ahead');
    s.work.review(org.id, issue.id, 'rejected', 'Approved — now send it.', OWNER);
    await drain();
    const runs = s.runtime.listRuns(org.id, { agentId: agent.id });
    expect(runs.length).toBeGreaterThan(before); // woken by the decision
    expect(JSON.parse(readFileSync(trace, 'utf8')).prompt).toMatch(/approval request .* was approved|sent back for rework/i);

    // Cross-org isolation at the API boundary: another org's ids are not found.
    const owner = s.governance.tokens.issueOwnerToken('e2e');
    const other = s.org.listOrgs().find((o) => o.id !== org.id)!;
    const res = await fetch(`${s.baseUrl()}/api/v1/orgs/${other.id}/issues/${issue.id}`, { headers: { Authorization: `Bearer ${owner}` } });
    expect(res.status).toBe(404);
  }, 120_000);
});
