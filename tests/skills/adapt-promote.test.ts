import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Agent, Department, Organization, Skill } from '../../src/contracts/rows.js';
import { BODY, WIN, createHarness, fakeRunner, git, seedIssue, setLead, setPolicies, type Harness } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

describe('skills: adapt, retire and promote', () => {
  let k: TestKernel;
  let h: Harness;
  let org: Organization;
  let eng: Department;
  let ops: Department;
  let ada: Agent;
  let lena: Agent;
  let omar: Agent;

  const agentActor = (a: Agent, runId?: string) => ({ kind: 'agent' as const, id: a.id, runId });
  const activeOwn = (name = 'stripe-export', owner = ada): Promise<Skill> =>
    h.svc.manage({ orgId: org.id, agentId: owner.id, runId: 'run_c' }, { action: 'create', name, description: `${name} skill`, body: BODY }).then((s) => h.svc.activate(s.id, OWNER, { force: true }));
  const use = (skill: Skill, n: number, outcome: { success: boolean | null; humanEdited?: boolean }) =>
    Array.from({ length: n }).reduce<Promise<void>>(
      (p, _x, i) => p.then(() => h.svc.recordUsage({ orgId: org.id, runId: `run_${k.clock.now()}_${i}`, agentId: ada.id, skillIds: [skill.id], costUsd: 0.01, steps: 3, ...outcome })),
      Promise.resolve(),
    );
  const names = (a: Agent) => h.svc.resolveForAgent(org.id, a.id).map((s) => `${s.name}@${s.scope}`);

  beforeEach(() => {
    k = createTestKernel();
    org = seedOrg(k);
    eng = seedDept(k, org.id, 'Engineering');
    ops = seedDept(k, org.id, 'Operations');
    ada = seedAgent(k, org.id, eng.id, 'Ada');
    lena = seedAgent(k, org.id, eng.id, 'Lena', { autonomyLevel: 3 });
    omar = seedAgent(k, org.id, ops.id, 'Omar');
    setLead(k, eng.id, lena.id);
    h = createHarness(k);
  });
  afterEach(() => k.dispose());

  it('auto-reverts a version whose success rate regressed by ≥ 20 points after 5 uses', async () => {
    const v1 = await activeOwn();
    await use(v1, 5, { success: true });
    expect(h.svc.get(v1.id)).toMatchObject({ useCount: 5, successCount: 5, lastUsedAt: k.clock.now() });
    const v2 = await h.svc.manage({ orgId: org.id, agentId: ada.id, runId: 'run_p' }, { action: 'patch', name: v1.name, body: 'A worse procedure.' });
    expect(v2).toMatchObject({ version: 2, status: 'active' });

    await use(v2, 3, { success: true });
    await use(v2, 1, { success: false });
    await use(v2, 3, { success: null }); // ungraded runs do not count toward the 5
    expect(h.svc.get(v1.id).version).toBe(2);

    const changed = k.bus.once('skill.changed', (e) => e.skillId === v1.id);
    await use(v2, 1, { success: false }); // 5 graded uses at 60% vs 100% before
    expect(await changed).toMatchObject({ skillId: v1.id, status: 'active' });
    const reverted = h.svc.get(v1.id);
    expect(reverted).toMatchObject({ version: 3, status: 'active', contentHash: v1.contentHash, useCount: 13, successCount: 8 });
    expect(h.svc.read(v1.id).body).toBe(BODY);
    expect(h.svc.history(v1.id)[0]).toMatchObject({ version: 3, author: 'system', message: 'auto-revert stripe-export v2 → v1 (success_rate_regressed)' });
    expect(git(k, 'log', '-1', '--format=%an|%s')).toBe('system|skill(agent/stripe-export): revert v3\n');
    const [audit] = k.audit.query({ orgId: org.id, action: 'skill.reverted', entityId: v1.id });
    expect(audit).toMatchObject({ actor: { kind: 'system' }, data: { fromVersion: 2, restoredVersion: 1, newVersion: 3, reason: 'success_rate_regressed', currentRate: 60, previousRate: 100 } });
    expect(k.audit.query({ action: 'skill.changed', entityId: v1.id })[0]?.data).toMatchObject({ change: 'revert', restoredVersion: 1 });

    // the restored version starts with a clean slate: it is not reverted again
    await use(reverted, 6, { success: false });
    expect(h.svc.get(v1.id).version).toBe(3);
  });

  it('does not revert on a small dip, but does when humans keep editing the output', async () => {
    const v1 = await activeOwn();
    await use(v1, 4, { success: true });
    await use(v1, 1, { success: false }); // 80%
    const v2 = await h.svc.manage({ orgId: org.id, agentId: ada.id }, { action: 'patch', name: v1.name, body: 'Slightly different.' });
    await use(v2, 3, { success: true });
    await use(v2, 1, { success: false });
    await use(v2, 1, { success: true }); // 4/5 = 80% vs 80% before
    await use(v2, 1, { success: false }); // 4/6 = 67%: a 13-point dip is tolerated
    expect(h.svc.get(v1.id).version).toBe(2);
    await use(v2, 1, { success: false }); // 4/7 = 57%: 23 points down → reverted
    expect(h.svc.get(v1.id).version).toBe(3);

    const other = await activeOwn('weekly-report');
    await use(other, 5, { success: true, humanEdited: true }); // version 1 has nothing to fall back to
    expect(h.svc.get(other.id).version).toBe(1);
    const o2 = await h.svc.manage({ orgId: org.id, agentId: ada.id }, { action: 'patch', name: 'weekly-report', body: 'New template.' });
    await use(o2, 4, { success: true }); // 100% success, 80% before → no regression
    expect(h.svc.get(other.id).version).toBe(2);
    await use(o2, 2, { success: true, humanEdited: true });
    expect(h.svc.get(other.id).version).toBe(2);
    await use(o2, 1, { success: true, humanEdited: true }); // 3 of the last 5 outcomes were human-edited
    expect(h.svc.get(other.id)).toMatchObject({ version: 3, status: 'active', contentHash: other.contentHash });
    expect(k.audit.query({ action: 'skill.reverted', entityId: other.id })[0]?.data).toMatchObject({ reason: 'human_edited_outcomes', edited: 3 });
  });

  it('retires skills unused for 60 days; deprecated skills leave the index', async () => {
    const used = await activeOwn('used');
    const idle = await activeOwn('idle');
    const draft = await h.svc.manage({ orgId: org.id, agentId: ada.id }, { action: 'create', name: 'old-draft', description: 'never finished', body: BODY });
    const quarantined = await h.svc.manage({ orgId: org.id, agentId: ada.id }, { action: 'create', name: 'bad', description: 'bad', body: 'sudo make install' });
    expect(quarantined.status).toBe('quarantined');

    k.clock.advance(59 * DAY);
    expect(await h.svc.retireStale()).toEqual([]);
    await use(used, 1, { success: true });
    k.clock.advance(2 * DAY);
    expect(names(ada)).toEqual(['idle@agent', 'used@agent']);

    const events: string[] = [];
    k.bus.on('skill.changed', (e) => void events.push(`${e.skillId}:${e.status}`));
    const retired = await h.svc.retireStale();
    expect(retired.sort()).toEqual([idle.id, draft.id].sort());
    expect(events.sort()).toEqual([`${idle.id}:deprecated`, `${draft.id}:deprecated`].sort());
    expect(h.svc.get(idle.id).status).toBe('deprecated');
    expect(h.svc.get(quarantined.id).status).toBe('quarantined');
    expect(names(ada)).toEqual(['used@agent']);
    expect(k.audit.query({ action: 'skill.changed', entityId: idle.id })[0]).toMatchObject({ actor: { kind: 'system' }, data: { reason: 'unused_60_days', status: 'deprecated' } });

    // last_used_at wins over updated_at; an explicit `now` is honoured
    expect(await h.svc.retireStale(k.clock.now() + 57 * DAY)).toEqual([]);
    expect(await h.svc.retireStale(k.clock.now() + 58 * DAY)).toEqual([used.id]);
  });

  it('promotes to the department: humans and the department lead directly, other agents not', async () => {
    const skill = await activeOwn();
    await expect(h.svc.promote(skill.id, 'dept', agentActor(ada))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.svc.promote(skill.id, 'dept', agentActor(omar))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.svc.promote(skill.id, 'agent', OWNER)).rejects.toMatchObject({ code: 'validation' });
    const draft = await h.svc.manage({ orgId: org.id, agentId: ada.id }, { action: 'create', name: 'wip', description: 'wip', body: BODY });
    await expect(h.svc.promote(draft.id, 'dept', OWNER)).rejects.toMatchObject({ code: 'conflict' });

    const { skill: dept, approval } = await h.svc.promote(skill.id, 'dept', agentActor(lena, 'run_lead'));
    expect(approval).toBeUndefined();
    expect(dept).toMatchObject({ scope: 'dept', scopeId: eng.id, orgId: org.id, name: 'stripe-export', status: 'active', version: 1, author: `agent:${ada.id}`, source: `promoted:${skill.id}`, contentHash: skill.contentHash });
    expect(dept?.id).not.toBe(skill.id); // its own row and folder
    expect(dept?.path).toBe(join(k.paths.deptSkills(org.slug, eng.slug), 'stripe-export'));
    expect(git(k, 'log', '-1', '--format=%an|%s|%(trailers:key=Conductor-Run,valueonly,separator=)')).toBe(`agent:${lena.id}|skill(dept/stripe-export): promote v1|run_lead\n`);
    expect(names(lena)).toEqual(['stripe-export@dept']);
    expect(names(ada)).toEqual(['stripe-export@agent']); // narrowest wins
    expect(names(omar)).toEqual([]);
    expect(k.audit.query({ action: 'skill.promoted', entityId: skill.id })[0]?.data).toMatchObject({ fromScope: 'agent', toScope: 'dept', toSkillId: dept?.id });

    // promoting again after a patch updates the department copy as a new version
    await h.svc.manage({ orgId: org.id, agentId: ada.id }, { action: 'patch', name: 'stripe-export', body: 'Improved.' });
    const again = await h.svc.promote(skill.id, 'dept', OWNER);
    expect(again.skill).toMatchObject({ id: dept?.id, version: 2, status: 'active' });
    expect(h.svc.loadBody(org.id, lena.id, 'stripe-export')).toBe('Improved.\n');

    // the agent's byte-identical copy is now superseded by the department one
    expect(await h.svc.retireStale()).toEqual([skill.id]);
    expect(names(ada)).toEqual(['stripe-export@dept']);
  });

  it('org/global promotion by an agent goes through a promote_skill approval executed on approval.decided', async () => {
    const skill = await activeOwn();
    await expect(h.svc.promote(skill.id, 'org', agentActor(omar))).rejects.toMatchObject({ code: 'forbidden' });

    const first = await h.svc.promote(skill.id, 'org', agentActor(ada, 'run_9'));
    expect(first.skill).toBeUndefined();
    expect(first.approval).toMatchObject({ orgId: org.id, kind: 'promote_skill', status: 'pending', requesterAgentId: ada.id, runId: 'run_9', payload: { skillId: skill.id, toScope: 'org', contentHash: skill.contentHash } });
    expect((await h.svc.promote(skill.id, 'org', agentActor(ada))).approval?.id).toBe(first.approval?.id); // no duplicate request
    expect(h.approvals.all).toHaveLength(1);
    expect(h.svc.list({ orgId: org.id, scope: 'org' })).toEqual([]);

    const promoted = k.bus.once('skill.changed', (e) => e.skillId !== skill.id, 5000);
    h.approvals.decide(org.id, first.approval!.id, 'approved', OWNER);
    const event = await promoted;
    await h.svc.diff(skill.id, 0, 1); // drains the serialized queue
    const orgSkill = h.svc.get(event.skillId);
    expect(orgSkill).toMatchObject({ scope: 'org', scopeId: org.id, name: 'stripe-export', status: 'active', author: `agent:${ada.id}` });
    expect(h.approvals.all[0]?.consumedAt).not.toBeNull();
    expect(names(omar)).toEqual(['stripe-export@org']);
    expect(k.audit.query({ action: 'skill.promoted', entityId: skill.id })[0]?.data).toMatchObject({ toScope: 'org', approvalId: first.approval?.id, approvedBy: 'owner' });
    // approvals are single use: a replayed event does nothing
    k.bus.emit('approval.decided', { orgId: org.id, approvalId: first.approval!.id, status: 'approved', requesterAgentId: ada.id });
    await h.svc.diff(skill.id, 0, 1); // drains the serialized queue
    expect(h.svc.get(orgSkill.id).version).toBe(1);

    // global: agents may only propose; a denial leaves nothing behind
    const proposal = await h.svc.promote(skill.id, 'global', agentActor(ada));
    expect(proposal.approval).toMatchObject({ status: 'pending', payload: { toScope: 'global' } });
    h.approvals.decide(org.id, proposal.approval!.id, 'denied', OWNER);
    await h.svc.diff(skill.id, 0, 1);
    expect(h.svc.list({ orgId: null })).toEqual([]);

    // an approval is bound to the content that was reviewed
    const stale = await h.svc.promote(skill.id, 'global', agentActor(ada));
    await h.svc.manage({ orgId: org.id, agentId: ada.id }, { action: 'patch', name: 'stripe-export', body: 'Changed after the request.' });
    h.approvals.decide(org.id, stale.approval!.id, 'approved', OWNER);
    await h.svc.diff(skill.id, 0, 1);
    expect(h.svc.list({ orgId: null })).toEqual([]);
    expect(stale.approval?.consumedAt).toBeNull();
    expect(k.audit.query({ action: 'skill.promotion_skipped', entityId: skill.id })[0]?.data).toMatchObject({ reason: 'skill changed after the approval was requested' });

    // the owner promotes to global directly
    const direct = await h.svc.promote(skill.id, 'global', OWNER);
    expect(direct.skill).toMatchObject({ scope: 'global', orgId: null, scopeId: null, status: 'active' });
    expect(direct.skill?.path).toBe(join(k.paths.globalSkills, 'stripe-export'));
  });

  it('honours the org policies: owner approval can be switched off for org scope, department promotion can be automatic', async () => {
    setPolicies(k, org.id, { ownerApprovesOrgSkillPromotion: false });
    const skill = await activeOwn();
    const direct = await h.svc.promote(skill.id, 'org', agentActor(lena));
    expect(direct.approval).toBeUndefined();
    expect(direct.skill).toMatchObject({ scope: 'org', status: 'active' });
    expect((await h.svc.promote(skill.id, 'global', agentActor(lena))).approval?.status).toBe('pending'); // global is never direct for agents

    // deptSkillPromotion: 'auto' → an eval win that activates the skill also lands it in the department
    setPolicies(k, org.id, { deptSkillPromotion: 'auto' });
    h.svc.setEvalRunner(fakeRunner('triage', WIN));
    const issueId = seedIssue(k, org.id, 'Triage the bug queue');
    const mine = await h.svc.manage({ orgId: org.id, agentId: ada.id, runId: 'run_t', issueId }, { action: 'create', name: 'triage', description: 'Triage bugs', body: BODY });
    expect(h.svc.list({ orgId: org.id, scope: 'dept' })).toEqual([]);
    await h.svc.evaluate(mine.id);
    await h.svc.activate(mine.id, agentActor(ada));
    const [auto] = h.svc.list({ orgId: org.id, scope: 'dept' });
    expect(auto).toMatchObject({ name: 'triage', scopeId: eng.id, status: 'active', source: `promoted:${mine.id}`, evalScore: h.svc.get(mine.id).evalScore });
    expect(h.svc.history(auto!.id)[0]).toMatchObject({ author: 'system', eval: { passed: true } });
    expect(names(lena)).toContain('triage@dept');

    // under the default ('lead') policy nothing is promoted automatically
    setPolicies(k, org.id, {});
    h.svc.setEvalRunner(fakeRunner('notes', WIN));
    const notes = await h.svc.manage({ orgId: org.id, agentId: ada.id, issueId }, { action: 'create', name: 'notes', description: 'Take notes', body: BODY });
    await h.svc.evaluate(notes.id);
    await h.svc.activate(notes.id, agentActor(ada));
    expect(h.svc.list({ orgId: org.id, scope: 'dept' }).map((s) => s.name)).toEqual(['triage']);
  });

  it('enforces who may edit each scope', async () => {
    const input = (scope: 'global' | 'org' | 'dept' | 'agent', scopeId: string | null) => ({ scope, scopeId, name: 'guide', description: 'Guide', body: BODY, status: 'active' as const });
    await expect(h.svc.upsert(null, input('global', null), agentActor(lena))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.svc.upsert(org.id, input('org', null), agentActor(ada))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.svc.upsert(org.id, input('dept', eng.id), agentActor(ada))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.svc.upsert(org.id, input('dept', ops.id), agentActor(lena))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.svc.upsert(org.id, input('agent', ada.id), agentActor(omar))).rejects.toMatchObject({ code: 'forbidden' });
    // the lead may write department and org skills, but an agent write never lands active
    expect(await h.svc.upsert(org.id, input('dept', eng.id), agentActor(lena))).toMatchObject({ status: 'draft', author: `agent:${lena.id}` });
    expect(await h.svc.upsert(org.id, input('org', null), agentActor(lena))).toMatchObject({ status: 'draft', scopeId: org.id });
    const own = await h.svc.upsert(org.id, input('agent', ada.id), OWNER);
    expect(own).toMatchObject({ status: 'active', author: 'human' });
    await expect(h.svc.setStatus(own.id, 'deprecated', agentActor(omar))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await h.svc.setStatus(own.id, 'deprecated', agentActor(ada))).status).toBe('deprecated');
    await expect(h.svc.setStatus(own.id, 'active', agentActor(ada))).rejects.toMatchObject({ code: 'policy_denied' }); // eval gate
    expect((await h.svc.setStatus(own.id, 'draft', OWNER)).status).toBe('draft');
    expect(() => h.svc.get('skl_missing')).toThrow(expect.objectContaining({ code: 'not_found' }));
    await expect(h.svc.rollback(own.id, 7, OWNER)).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.svc.diff(own.id, 1, 9)).rejects.toMatchObject({ code: 'not_found' });
  });
});
