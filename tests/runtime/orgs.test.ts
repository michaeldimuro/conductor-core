import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHarness, type Harness } from './harness.js';
import { costLedger, jobs, runEvents } from '../../src/db/schema/index.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('archiving an organization', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  const pendingFor = (orgId: string) => h.k.db.select().from(jobs).where(eq(jobs.orgId, orgId)).all().filter((j) => j.status === 'pending');

  it('cancels in-flight runs, releases their issues and stops scheduling for the org', async () => {
    const issue = h.work.createIssue(h.acme.id, { title: 'Long task', assigneeAgentId: h.ada.id }, OWNER);
    expect(pendingFor(h.acme.id).filter((j) => j.kind === 'heartbeat')).toHaveLength(2);
    h.script = async () => {
      h.org.archiveOrg(h.acme.id, OWNER);
      await sleep(5_000); // would run for 5 s if not cancelled
    };
    const t0 = Date.now();
    await h.drain();
    expect(Date.now() - t0).toBeLessThan(3_000);

    const [run] = h.runtime.listRuns(h.acme.id, { agentId: h.ada.id });
    expect(run).toMatchObject({ status: 'cancelled', outcome: 'cancelled', error: 'organization archived' });
    expect(h.work.getIssue(h.acme.id, issue.id).checkoutLock).toBeNull();
    expect(pendingFor(h.acme.id)).toHaveLength(0); // heartbeats and wakes are off the queue

    // Nothing comes back: not on a schedule sync, not when the old cron time passes, not on new events.
    h.runtime.syncSchedules();
    h.k.bus.emit('issue.assigned', { orgId: h.acme.id, issueId: issue.id, agentId: h.ada.id });
    h.k.clock.advance(3 * 3_600_000);
    await h.drain();
    expect(h.calls).toHaveLength(1);
    expect(pendingFor(h.acme.id).filter((j) => j.kind === 'heartbeat')).toHaveLength(0);
    expect(h.runtime.status().running).toBe(0);
  });

  it('reacts to the dedicated org.archived event as well', async () => {
    h.work.createIssue(h.acme.id, { title: 'Long task', assigneeAgentId: h.ada.id }, OWNER);
    h.script = async () => {
      h.k.bus.emit('org.archived', { orgId: h.acme.id });
      await sleep(5_000);
    };
    await h.drain();
    expect(h.runtime.listRuns(h.acme.id, { agentId: h.ada.id })[0]).toMatchObject({ status: 'cancelled' });
    expect(pendingFor(h.acme.id)).toHaveLength(0);
  });

  it('leaves other organizations running', async () => {
    const beta = h.org.createOrg({ name: 'Beta', defaultProvider: { adapter: 'fake' } }, OWNER);
    const dept = h.org.createDept(beta.id, { name: 'Ops' }, OWNER);
    const bo = h.org.hireAgent(beta.id, { deptId: dept.id, name: 'Bo', role: 'Operator', heartbeatCron: '0 * * * *' }, OWNER).agent!;
    await h.drain();
    h.org.archiveOrg(h.acme.id, OWNER);
    const issue = h.work.createIssue(beta.id, { title: 'Beta work', assigneeAgentId: bo.id }, OWNER);
    await h.drain();
    expect(h.calls.map((c) => c.issueId)).toEqual([issue.id]);
    expect(pendingFor(beta.id).filter((j) => j.kind === 'heartbeat')).toHaveLength(1);
  });
});

describe('run now is honest about skipped wakes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  it('returns a plain job id when the run can start', async () => {
    h.work.createIssue(h.acme.id, { title: 'Work', assigneeAgentId: h.ada.id }, OWNER);
    const res = await h.runtime.runNow(h.acme.id, h.ada.id);
    expect(res.jobId).toMatch(/^job_/);
    expect(res.skipped).toBeUndefined();
  });

  it('says why a wake for a paused agent will not run now, and keeps it queued', async () => {
    h.org.pauseAgent(h.acme.id, h.ada.id, 'vacation', OWNER);
    const res = await h.runtime.runNow(h.acme.id, h.ada.id);
    expect(res.skipped).toMatchObject({ code: 'agent_paused', temporary: true });
    expect(res.skipped!.reason).toContain('vacation');
    expect(res.jobId).toMatch(/^job_/);
  });

  it('reports kill switch, budget and rate limit', async () => {
    h.governance.killSwitch.engage(h.acme.id, OWNER);
    expect((await h.runtime.runNow(h.acme.id, h.lead.id)).skipped).toMatchObject({ code: 'kill_switch', temporary: true });
    h.governance.killSwitch.release(h.acme.id, OWNER);

    h.org.updateAgent(h.acme.id, h.lead.id, { maxRunsPerHour: 1 }, OWNER);
    h.work.createIssue(h.acme.id, { title: 'One', assigneeAgentId: h.lead.id }, OWNER);
    await h.drain();
    expect((await h.runtime.runNow(h.acme.id, h.lead.id)).skipped).toMatchObject({ code: 'rate_limited', temporary: true });

    // A spent project cap stops a wake pinned to an issue of that project.
    const project = h.work.createProject(h.acme.id, { name: 'Capped', budgetUsd: 1 }, OWNER);
    const issue = h.work.createIssue(h.acme.id, { title: 'Capped work', projectId: project.id, assigneeAgentId: h.ada.id }, OWNER);
    h.governance.budgets.record({ orgId: h.acme.id, projectId: project.id, costUsd: 2 });
    const res = await h.runtime.runNow(h.acme.id, h.ada.id, { issueId: issue.id });
    expect(res.skipped).toMatchObject({ code: 'over_budget', temporary: true });
    expect(res.skipped!.reason).toMatch(/budget/);

    // An org-wide hard stop pauses its agents: reported as such.
    h.org.updateOrg(h.acme.id, { budgetMonthlyUsd: 1 }, OWNER);
    h.governance.budgets.record({ orgId: h.acme.id, costUsd: 2 });
    expect((await h.runtime.runNow(h.acme.id, h.ada.id)).skipped).toMatchObject({ code: 'agent_paused', temporary: true });
  });

  it('queues nothing for a permanent cause and announces it on the bus', async () => {
    const seen: string[] = [];
    h.k.bus.on('run.skipped', (e) => void seen.push(`${e.code}:${e.jobId}`));
    h.org.archiveOrg(h.acme.id, OWNER);
    const res = await h.runtime.runNow(h.acme.id, h.ada.id);
    expect(res).toMatchObject({ jobId: '', skipped: { code: 'org_archived', temporary: false } });
    expect(seen).toEqual(['org_archived:null']);
    expect(h.k.db.select().from(jobs).all().filter((j) => j.status === 'pending' && j.kind === 'event')).toHaveLength(0);
  });

  it('no longer has a manual.run_now bus subscriber (runNow is the only entry point)', async () => {
    h.work.createIssue(h.acme.id, { title: 'Work', assigneeAgentId: h.ada.id }, OWNER);
    h.k.db.update(jobs).set({ status: 'cancelled' }).run();
    h.k.bus.emit('manual.run_now', { orgId: h.acme.id, agentId: h.ada.id, issueId: null });
    await h.drain();
    expect(h.calls).toHaveLength(0);
  });
});

/** FR-2: many organizations on one daemon, hard isolation. */
describe('multi-org: three organizations running concurrently with zero cross-talk', () => {
  let h: Harness;
  afterEach(() => h.dispose());

  it('runs every org in parallel and keeps runs, issues, spend, events and budgets apart', async () => {
    h = await createHarness({ runtime: { maxGlobalRuns: 12, providerLimits: { fake: 12 } } });
    interface Tenant { org: Organization; agents: Agent[]; issueIds: string[] }
    const tenants: Tenant[] = [];
    for (const name of ['Northwind', 'Globex', 'Initech']) {
      const org = h.org.createOrg({ name, defaultProvider: { adapter: 'fake', model: `model-${name}` }, budgetMonthlyUsd: 10 }, OWNER);
      h.org.updateOrg(org.id, { maxConcurrentRuns: 2 }, OWNER);
      const dept = h.org.createDept(org.id, { name: 'Engineering' }, OWNER); // same dept + agent names in every org
      const agents = ['Ada', 'Bob'].map((n) => h.org.hireAgent(org.id, { deptId: dept.id, name: n, role: 'Engineer', autonomyLevel: 2 }, OWNER).agent!);
      const issueIds = agents.map((a, i) => h.work.createIssue(org.id, { title: `${name} task ${i}`, body: `secret-of-${name}`, assigneeAgentId: a.id }, OWNER).id);
      tenants.push({ org, agents, issueIds });
    }

    const liveByOrg = new Map<string, number>();
    const peakByOrg = new Map<string, number>();
    let live = 0;
    let peak = 0;
    const orgsLiveTogether = new Set<string>();
    h.script = async (ctx, emit, hh) => {
      liveByOrg.set(ctx.orgId, (liveByOrg.get(ctx.orgId) ?? 0) + 1);
      peakByOrg.set(ctx.orgId, Math.max(peakByOrg.get(ctx.orgId) ?? 0, liveByOrg.get(ctx.orgId)!));
      peak = Math.max(peak, ++live);
      for (const [orgId, n] of liveByOrg) if (n > 0) orgsLiveTogether.add(orgId);
      emit({ type: 'text', text: `working for ${ctx.orgId}` });
      emit({ type: 'usage', tokensIn: 10, tokensOut: 10, costUsd: 0.25 });
      // From inside the run: another org's ids behave as not found.
      const other = tenants.find((t) => t.org.id !== ctx.orgId)!;
      emit({ type: 'status', status: `foreign issue: ${hh.work.findIssue(ctx.orgId, other.issueIds[0]!) === null ? 'not found' : 'LEAK'}` });
      await sleep(60);
      live--;
      liveByOrg.set(ctx.orgId, liveByOrg.get(ctx.orgId)! - 1);
      return { finalText: `done for ${ctx.orgId}`, usage: { tokensIn: 10, tokensOut: 10, costUsd: 0.25, subscription: false, seatSeconds: 0 } };
    };
    await h.drain();

    // All three orgs really ran at the same time, each within its own concurrency limit.
    expect(h.calls).toHaveLength(6);
    expect(orgsLiveTogether.size).toBe(3);
    expect(peak).toBeGreaterThanOrEqual(3);
    for (const t of tenants) expect(peakByOrg.get(t.org.id)).toBeLessThanOrEqual(2);

    for (const t of tenants) {
      const others = tenants.filter((o) => o !== t);
      const mine = h.calls.filter((c) => c.orgId === t.org.id);
      // Each run was built only from its own org.
      expect(mine).toHaveLength(2);
      for (const c of mine) {
        expect(t.agents.map((a) => a.id)).toContain(c.agentId);
        expect(t.issueIds).toContain(c.issueId);
        expect(c.model).toBe(`model-${t.org.name}`);
        expect(c.prompt).toContain(`secret-of-${t.org.name}`);
        expect(c.workspacePath).toContain(t.org.slug);
        for (const o of others) {
          expect(c.prompt + c.systemPrompt).not.toContain(`secret-of-${o.org.name}`);
          expect(c.prompt + c.systemPrompt).not.toContain(o.org.name);
          expect(c.workspacePath).not.toContain(`/${o.org.slug}/`);
        }
        // The run token is scoped to this org and agent.
        expect(h.k.audit.query({ orgId: t.org.id, runId: c.runId, action: 'token.issued' })).toHaveLength(1);
      }

      // Journal, transcript, ledger and issues: only this org's rows, all of them.
      const runs = h.runtime.listRuns(t.org.id);
      expect(runs.map((r) => r.id).sort()).toEqual(mine.map((c) => c.runId).sort());
      expect(runs.every((r) => r.status === 'succeeded' && r.orgId === t.org.id)).toBe(true);
      for (const r of runs) {
        const events = h.runtime.transcript(t.org.id, r.id);
        expect(events.some((e) => e.event.type === 'text' && e.event.text === `working for ${t.org.id}`)).toBe(true);
        expect(JSON.stringify(events)).toContain('foreign issue: not found');
        expect(r.transcriptRef).toContain(t.org.slug);
        for (const o of others) {
          expect(() => h.runtime.getRun(o.org.id, r.id)).toThrow(/not found/);
          expect(() => h.runtime.transcript(o.org.id, r.id)).toThrow(/not found/);
          await expect(h.runtime.cancelRun(o.org.id, r.id)).rejects.toThrow(/not found/);
        }
      }
      expect(h.k.db.select().from(runEvents).where(eq(runEvents.orgId, t.org.id)).all().every((e) => runs.some((r) => r.id === e.runId))).toBe(true);
      const ledger = h.k.db.select().from(costLedger).where(eq(costLedger.orgId, t.org.id)).all();
      expect(Number(ledger.reduce((n, l) => n + l.costUsd, 0).toFixed(6))).toBe(0.5);
      expect(ledger.every((l) => t.agents.some((a) => a.id === l.agentId))).toBe(true);
      expect(h.governance.budgets.summary(t.org.id).totalUsd).toBe(0.5);
      for (const id of t.issueIds) expect(h.work.getIssue(t.org.id, id)).toMatchObject({ status: 'done', checkoutLock: null });
      for (const o of others) expect(h.work.findIssue(o.org.id, t.issueIds[0]!)).toBeNull();
    }

    // One org's hard stop / kill switch touches nobody else.
    const [a, b] = tenants as [Tenant, Tenant, Tenant];
    h.governance.killSwitch.engage(a.org.id, OWNER);
    const blocked = h.work.createIssue(a.org.id, { title: 'held', assigneeAgentId: a.agents[0]!.id }, OWNER);
    const free = h.work.createIssue(b.org.id, { title: 'free', assigneeAgentId: b.agents[0]!.id }, OWNER);
    await h.drain();
    expect(h.work.getIssue(a.org.id, blocked.id).status).toBe('todo');
    expect(h.work.getIssue(b.org.id, free.id).status).toBe('done');
    // The original Acme org never saw any of it.
    expect(h.runtime.listRuns(h.acme.id)).toHaveLength(0);
  });
});

describe('wake latency', () => {
  let h: Harness;
  afterEach(() => h.dispose());

  it('dispatches an assignment wake well under 10 s with the production tick interval', async () => {
    h = await createHarness({ runtime: { tickMs: 1000 } }); // the daemon default: a real 1 s timer, no manual ticking
    const started = h.k.bus.once('run.started', (e) => e.agentId === h.ada.id, 10_000);
    const t0 = Date.now();
    const issue = h.work.createIssue(h.acme.id, { title: 'Urgent', assigneeAgentId: h.ada.id }, OWNER);
    const e = await started;
    const latency = Date.now() - t0;
    expect(e.issueId).toBe(issue.id);
    expect(latency).toBeLessThan(2_500); // PRD target is < 10 s; one tick is 1 s
    await h.runtime.idle();
  }, 15_000);
});
