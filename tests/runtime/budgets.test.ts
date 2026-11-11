import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createHarness, usage, type Harness } from './harness.js';
import { costLedger } from '../../src/db/schema/index.js';
import { SpendMeter } from '../../src/runtime/spend.js';
import { OWNER } from '../../src/contracts/types.js';

describe('budgets', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  const ledger = (runId: string) => h.k.db.select().from(costLedger).where(and(eq(costLedger.orgId, h.acme.id), eq(costLedger.runId, runId))).all();
  const sum = (rows: Array<{ costUsd: number }>) => Number(rows.reduce((n, r) => n + r.costUsd, 0).toFixed(6));

  it('re-checks the project cap for the issue the inbox checkout actually picked', async () => {
    const project = h.work.createProject(h.acme.id, { name: 'Capped', budgetUsd: 1 }, OWNER);
    const capped = h.work.createIssue(h.acme.id, { title: 'In the capped project', projectId: project.id, assigneeAgentId: h.ada.id, priority: 0 }, OWNER);
    await h.drain();
    expect(h.calls).toHaveLength(1); // under the cap: runs
    h.work.updateIssue(h.acme.id, capped.id, { status: 'todo' }, OWNER);
    await h.drain();

    // The project is now over its cap (spend recorded without an agent, so no agent is paused).
    h.governance.budgets.record({ orgId: h.acme.id, projectId: project.id, costUsd: 1.5 });
    expect(h.org.getAgent(h.acme.id, h.ada.id).status).toBe('active');
    const before = h.calls.length;

    // An UNPINNED wake: the wake-time check knows no project; the checkout picks the capped issue.
    const skips: string[] = [];
    h.k.bus.on('run.skipped', (e) => void skips.push(e.code));
    const res = await h.runtime.runNow(h.acme.id, h.ada.id);
    expect(res.skipped).toBeUndefined();
    await h.drain();
    expect(h.calls).toHaveLength(before);
    expect(skips).toEqual(['over_budget']);
    expect(h.work.getIssue(h.acme.id, capped.id)).toMatchObject({ status: 'todo', checkoutLock: null });

    // Other work outside the capped project still runs, and is preferred over the blocked issue.
    const free = h.work.createIssue(h.acme.id, { title: 'Outside the project', assigneeAgentId: h.ada.id, priority: 3 }, OWNER);
    await h.drain();
    expect(h.calls.at(-1)!.issueId).toBe(free.id);
    expect(h.work.getIssue(h.acme.id, capped.id)).toMatchObject({ status: 'todo', checkoutLock: null });
  });

  it('records spend while the run is in flight, without double counting at the end', async () => {
    h.work.createIssue(h.acme.id, { title: 'Metered', assigneeAgentId: h.ada.id }, OWNER);
    let midRun = -1;
    h.script = (ctx, emit) => {
      emit({ type: 'usage', tokensIn: 1000, tokensOut: 200, costUsd: 0.06 });
      emit({ type: 'usage', tokensIn: 1000, tokensOut: 200, costUsd: 0.07 });
      midRun = sum(ledger(ctx.runId)); // visible to every other run right now
      emit({ type: 'usage', tokensIn: 500, tokensOut: 100, costUsd: 0.02 }); // below the flush threshold
      return { usage: { ...usage(0.15), tokensIn: 2500, tokensOut: 500 } };
    };
    await h.drain();
    const rows = ledger(h.calls[0]!.runId);
    expect(midRun).toBe(0.13);
    expect(rows.length).toBeGreaterThan(1);
    expect(sum(rows)).toBe(0.15);
    expect(rows.reduce((n, r) => n + r.tokensIn, 0)).toBe(2500);
    expect(rows.reduce((n, r) => n + r.tokensOut, 0)).toBe(500);
    expect(h.runtime.listRuns(h.acme.id, { agentId: h.ada.id })[0]!.costUsd).toBe(0.15);
  });

  it('stops concurrent runs when their shared cap is spent, instead of letting each overshoot', async () => {
    h.org.updateOrg(h.acme.id, { budgetMonthlyUsd: 1 }, OWNER);
    const a = h.work.createIssue(h.acme.id, { title: 'A', assigneeAgentId: h.ada.id }, OWNER);
    h.work.createIssue(h.acme.id, { title: 'B', assigneeAgentId: h.lead.id }, OWNER);
    // Each run was told it has the whole $1 left; together they would spend $4.
    h.script = async (_ctx, emit) => {
      for (let i = 0; i < 20; i++) {
        emit({ type: 'usage', tokensIn: 10, tokensOut: 10, costUsd: 0.1 });
        await new Promise((r) => setTimeout(r, 5));
      }
      return { usage: usage(2) };
    };
    await h.drain();
    expect(h.calls).toHaveLength(2);
    expect(h.calls.map((c) => c.budgetCapUsd)).toEqual([1, 1]);
    const outcomes = h.runtime.listRuns(h.acme.id).map((r) => r.outcome);
    expect(outcomes).toContain('budget');
    expect(outcomes.every((o) => o === 'budget' || o === 'cancelled')).toBe(true); // nobody ran to the end
    expect(h.work.getIssue(h.acme.id, a.id).checkoutLock).toBeNull();
    // The in-flight ledger caught the overshoot at the cap, not at $4.
    const spentDuringRuns = h.k.audit.query({ orgId: h.acme.id, action: 'budget.alert' });
    expect(spentDuringRuns.length).toBeGreaterThan(0);
  });

  it('SpendMeter: batches deltas, ignores $0 usage until the end, and reports the remainder', () => {
    const flushed: number[] = [];
    const m = new SpendMeter((d) => void flushed.push(d.costUsd), 0.05, 60_000);
    expect(m.add({ type: 'usage', tokensIn: 100, tokensOut: 10, costUsd: 0 })).toBe(false); // subscription-style usage
    expect(m.add({ type: 'usage', tokensIn: 100, tokensOut: 10, costUsd: 0.03 })).toBe(false);
    expect(m.add({ type: 'usage', tokensIn: 100, tokensOut: 10, costUsd: 0.03 })).toBe(true);
    expect(flushed).toEqual([0.06]);
    expect(m.remainder({ tokensIn: 400, tokensOut: 40, costUsd: 0.1, subscription: false, seatSeconds: 0 })).toEqual({ tokensIn: 100, tokensOut: 10, costUsd: 0.04 });
    // A chain result smaller than what was streamed never goes negative.
    expect(m.remainder({ tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 })).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
  });
});
