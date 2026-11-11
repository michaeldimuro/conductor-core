import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import { goals, jobs } from '../../src/db/schema/index.js';
import { newId } from '../../src/shared/ids.js';
import { OWNER } from '../../src/contracts/types.js';

const MIN = 60_000;

/** PRD core use case: "Set an org goal; watch the CEO agent cascade it into department goals and issues." */
describe('goal cascade', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  it('routes an ownerless org goal to the top of the org chart and wakes them to plan it', async () => {
    const goal = h.work.createGoal(h.acme.id, { title: 'Reach 10k newsletter subscribers', successMetric: 'subscribers', target: '10000' }, OWNER);
    expect(goal.ownerAgentId).toBeNull();
    await h.drain();

    expect(h.work.getGoal(h.acme.id, goal.id).ownerAgentId).toBe(h.lead.id); // Lena reports to nobody
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.agentId).toBe(h.lead.id);
    expect(h.calls[0]!.prompt).toContain('Reach 10k newsletter subscribers');
    expect(h.calls[0]!.prompt).toMatch(/Decompose the goal into .* issues/);
    expect(h.calls[0]!.prompt).toContain(goal.id);
    expect(h.calls[0]!.issueId).toBeNull(); // planning does not check out inbox work
    expect(h.k.audit.query({ orgId: h.acme.id, action: 'goal.routed' })).toHaveLength(1);
  });

  it('routes a department goal to that department\'s lead', async () => {
    const mkt = h.org.createDept(h.acme.id, { name: 'Marketing' }, OWNER);
    const mia = h.org.hireAgent(h.acme.id, { deptId: mkt.id, name: 'Mia', role: 'Marketing Lead', autonomyLevel: 3, isLead: true, reportsTo: h.lead.id }, OWNER).agent!;
    const goal = h.work.createGoal(h.acme.id, { title: 'Double organic traffic', level: 'dept', deptId: mkt.id }, OWNER);
    await h.drain();
    expect(h.work.getGoal(h.acme.id, goal.id).ownerAgentId).toBe(mia.id);
    expect(h.calls.map((c) => c.agentId)).toEqual([mia.id]);
  });

  it('falls back to the top of the chart when the department has no lead', async () => {
    const ops = h.org.createDept(h.acme.id, { name: 'Operations' }, OWNER);
    const goal = h.work.createGoal(h.acme.id, { title: 'Cut costs', level: 'dept', deptId: ops.id }, OWNER);
    await h.drain();
    expect(h.work.getGoal(h.acme.id, goal.id).ownerAgentId).toBe(h.lead.id);
  });

  it('wakes the named owner of a goal that was created with one', async () => {
    h.work.createGoal(h.acme.id, { title: 'Ship v2', ownerAgentId: h.ada.id, level: 'agent' }, OWNER);
    await h.drain();
    expect(h.calls.map((c) => c.agentId)).toEqual([h.ada.id]);
    expect(h.calls[0]!.prompt).toContain('Ship v2');
  });

  it('picks up ownerless goals at heartbeat (e.g. created while the daemon was down)', async () => {
    const now = h.k.clock.now();
    const id = newId('goal');
    h.k.db.insert(goals).values({ id, orgId: h.acme.id, level: 'org', title: 'Imported goal', createdAt: now, updatedAt: now }).run(); // no goal.created event
    await h.drain();
    expect(h.calls).toHaveLength(0);

    h.k.clock.advance(31 * MIN); // the lead's heartbeat
    await h.drain();
    expect(h.work.getGoal(h.acme.id, id).ownerAgentId).toBe(h.lead.id);
    expect(h.calls.some((c) => c.agentId === h.lead.id && c.prompt.includes('Imported goal') && c.prompt.includes('not been broken down'))).toBe(true);
  });

  it('does not plan a goal twice, nor one that already has issues', async () => {
    const goal = h.work.createGoal(h.acme.id, { title: 'Launch', ownerAgentId: h.lead.id, level: 'agent' }, OWNER);
    h.script = (ctx, _emit, hh) => {
      // The planner breaks the goal down.
      hh.work.createIssue(hh.acme.id, { title: 'Draft launch plan', goalId: goal.id, assigneeAgentId: hh.ada.id }, { kind: 'agent', id: ctx.agentId, runId: ctx.runId });
    };
    await h.drain();
    const planning = h.calls.filter((c) => c.prompt.includes('not been broken down'));
    expect(planning).toHaveLength(1);
    expect(h.calls.some((c) => c.agentId === h.ada.id && c.prompt.includes('Draft launch plan'))).toBe(true); // the cascade reached Ada

    // A stale planning wake for the same goal is void now.
    h.runtime.enqueue({ kind: 'event', orgId: h.acme.id, agentId: h.lead.id, payload: { trigger: 'assignment', goalId: goal.id } });
    const before = h.calls.length;
    await h.drain();
    expect(h.calls).toHaveLength(before);
  });

  it('leaves the automatic default goal alone (it is a bucket, not a request)', async () => {
    h.work.createIssue(h.acme.id, { title: 'Goal-less backlog item', status: 'backlog' }, OWNER);
    await h.drain();
    h.k.clock.advance(61 * MIN);
    await h.drain();
    const [dflt] = h.work.listGoals(h.acme.id);
    expect(dflt!.ownerAgentId).toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(h.k.db.select().from(jobs).all().filter((j) => j.kind === 'event')).toHaveLength(0);
  });

  it('never routes a goal to an agent of another org', async () => {
    const beta = h.org.createOrg({ name: 'Beta', defaultProvider: { adapter: 'fake' } }, OWNER);
    const goal = h.work.createGoal(beta.id, { title: 'Beta goal' }, OWNER);
    await h.drain();
    expect(h.work.getGoal(beta.id, goal.id).ownerAgentId).toBeNull(); // Beta has no agents yet
    expect(h.calls).toHaveLength(0);
  });
});
