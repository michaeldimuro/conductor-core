import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Agent, Organization, Skill } from '../../src/contracts/rows.js';
import type { EvalRunner } from '../../src/contracts/services.js';
import { evalCases, skillUsages } from '../../src/db/schema/index.js';
import { createUtilityModel } from '../../src/memory/index.js';
import { createSkillService, type SkillsContext } from '../../src/skills/index.js';
import { BODY, WIN, createHarness, fakeApprovals, fakeOrg, fakeRunner, seedIssue, type ArmScript } from './helpers.js';

/** The real evaluate path: real offline utility model (no org utility model configured = a default install), no fake judge. */
function realService(k: TestKernel, evalRunner: EvalRunner): SkillsContext {
  return createSkillService(k, { org: fakeOrg(k), approvals: fakeApprovals(k), utility: createUtilityModel(k), evalRunner });
}

/** Runner that also reports the sandbox's files for the with-skill arm. */
function runnerWithFiles(skillName: string, arms: { baseline: ArmScript; withSkill: ArmScript }, files: { baseline?: string[]; withSkill?: string[] }) {
  const inner = fakeRunner(skillName, arms);
  const run = vi.fn(async (input: Parameters<EvalRunner['run']>[0]) => {
    const withSkill = input.skills.some((s) => s.name === skillName);
    return { ...(await inner.run(input)), files: withSkill ? files.withSkill : files.baseline };
  });
  return { run } as EvalRunner & { run: typeof run };
}

describe('skills: eval gate without a utility model, eval cases, review outcomes', () => {
  let k: TestKernel;
  let org: Organization;
  let ada: Agent;
  let issueId: string;
  const caller = (runId = 'run_author') => ({ orgId: org.id, agentId: ada.id, runId, issueId });
  const agent = () => ({ kind: 'agent' as const, id: ada.id });

  beforeEach(() => {
    k = createTestKernel();
    org = seedOrg(k);
    ada = seedAgent(k, org.id, seedDept(k, org.id).id);
    issueId = seedIssue(k, org.id);
  });
  afterEach(() => k.dispose());

  it('a default install (no utility model) auto-activates an agent-authored skill on deterministic evidence', async () => {
    const runner = fakeRunner('stripe-export', WIN);
    const svc = realService(k, runner);
    const draft = await svc.manage(caller(), { action: 'create', name: 'stripe-export', description: 'Export the Stripe balance report', body: BODY });

    // Authoring wrote the originating issue as a replay case.
    const cases = svc.evalCases(draft.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ source: 'issue', issueId, criteria: 'A CSV attached to the issue', expect: {} });
    expect(cases[0]!.prompt).toContain('Export the monthly Stripe report');

    const result = await svc.evaluate(draft.id);
    expect(runner.run).toHaveBeenCalledTimes(4); // two samples per arm
    // Both arms completed; the skill is cheaper in cost and steps → a real pass, not "unknown = fail".
    expect(result).toMatchObject({ passed: true, baseline: { success: true, steps: 12 }, withSkill: { success: true, steps: 4 } });
    expect(result.needsReview).toBeUndefined();
    expect(result.notes).toContain('criteria not judged');
    expect((await svc.activate(draft.id, agent())).status).toBe('active');
  });

  it('without a model the gate still fails a skill that is not better, crashes, or answers nothing', async () => {
    const worse = realService(k, fakeRunner('s-worse', { baseline: { steps: 4, costUsd: 0.02 }, withSkill: { steps: 9, costUsd: 0.05 } }));
    const a = await worse.manage(caller(), { action: 'create', name: 's-worse', description: 'd', body: BODY });
    // Same success, costlier beyond the noise margin: never auto-activated — the owner gets to look.
    expect(await worse.evaluate(a.id)).toMatchObject({ passed: false, needsReview: true, withSkill: { success: true } });
    await expect(worse.activate(a.id, agent())).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringContaining('needs human review') });

    const crashed = realService(k, fakeRunner('s-crash', { baseline: { steps: 4, costUsd: 0.02 }, withSkill: { steps: 1, costUsd: 0.01, outcome: 'failed' } }));
    const b = await crashed.manage(caller(), { action: 'create', name: 's-crash', description: 'd', body: BODY });
    const r = await crashed.evaluate(b.id);
    expect(r).toMatchObject({ passed: false, withSkill: { success: false } });
    expect(r.needsReview).toBeUndefined();

    const silent = realService(k, fakeRunner('s-silent', { baseline: { steps: 4, costUsd: 0.02 }, withSkill: { steps: 1, costUsd: 0.01, finalText: '   ' } }));
    const c = await silent.manage(caller(), { action: 'create', name: 's-silent', description: 'd', body: BODY });
    expect(await silent.evaluate(c.id)).toMatchObject({ passed: false, withSkill: { success: false } });
  });

  it('explicit cases in the skill folder (evals/cases.json) are stored and decided by their expectations', async () => {
    const casesJson = JSON.stringify([{ prompt: 'Export the balance report', expect: { contains: ['WITH-SKILL'], notContains: ['error'], regex: ['/^done/i'] } }]);
    const runner = fakeRunner('stripe-export', WIN);
    const svc = realService(k, runner);
    const draft = await svc.manage({ orgId: org.id, agentId: ada.id, runId: 'r1' }, { action: 'create', name: 'stripe-export', description: 'd', body: BODY, files: { 'evals/cases.json': casesJson } });
    expect(svc.evalCases(draft.id)).toMatchObject([{ source: 'folder', prompt: 'Export the balance report', criteria: '', expect: { contains: ['WITH-SKILL'], regex: ['/^done/i'] } }]);

    const result = await svc.evaluate(draft.id);
    // Baseline answers "done BASELINE" (misses the required string); the skill arm satisfies every expectation.
    expect(result).toMatchObject({ passed: true, baseline: { success: false }, withSkill: { success: true } });
    expect(result.notes).toContain('answer does not contain "WITH-SKILL"');
    expect(runner.run.mock.calls[0]?.[0].prompt).toBe('Export the balance report');

    // A patch replaces the folder cases; the issue it came from is added as a replay.
    await svc.manage(caller('r2'), { action: 'patch', name: 'stripe-export', files: { 'evals/cases.json': JSON.stringify({ cases: [{ prompt: 'P1', expect: { contains: ['nope'] } }, { prompt: 'P2', criteria: 'Has a CSV' }] }) } });
    expect(svc.evalCases(draft.id).map((c) => [c.source, c.prompt.slice(0, 2)])).toEqual(expect.arrayContaining([['folder', 'P1'], ['folder', 'P2'], ['issue', 'Ex']]));
    expect(svc.evalCases(draft.id)).toHaveLength(3);
    // The patched version fails its own explicit expectation.
    expect(await svc.evaluate(draft.id)).toMatchObject({ passed: false });

    // An invalid case file never blocks the write and leaves the stored cases alone.
    await svc.manage(caller('r3'), { action: 'patch', name: 'stripe-export', files: { 'evals/cases.json': '{"cases": "nope"}' } });
    expect(svc.evalCases(draft.id)).toHaveLength(3);
  });

  it('an undecidable check is "needs human review", not a fail; file outputs are checked when the runner reports them', async () => {
    const files = { 'evals/cases.json': JSON.stringify([{ prompt: 'Export it', expect: { files: ['out/balance.csv'] } }]) };
    const blind = realService(k, fakeRunner('stripe-export', WIN));
    const draft = await blind.manage({ orgId: org.id, agentId: ada.id }, { action: 'create', name: 'stripe-export', description: 'd', body: BODY, files });
    const undecided = await blind.evaluate(draft.id);
    expect(undecided).toMatchObject({ passed: false, needsReview: true });
    expect(undecided.notes).toContain('NEEDS HUMAN REVIEW');
    await expect(blind.activate(draft.id, agent())).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringContaining('needs human review') });
    // The owner reviews and force-activates.
    expect((await blind.activate(draft.id, OWNER, { force: true })).status).toBe('active');

    const other = seedAgent(k, org.id, ada.deptId, 'Bea');
    const seeing = realService(k, runnerWithFiles('csv-export', WIN, { baseline: ['notes.txt'], withSkill: ['./out/balance.csv'] }));
    const d2 = await seeing.manage({ orgId: org.id, agentId: other.id }, { action: 'create', name: 'csv-export', description: 'd', body: BODY, files });
    expect(await seeing.evaluate(d2.id)).toMatchObject({ passed: true, baseline: { success: false }, withSkill: { success: true } });

    const missing = realService(k, runnerWithFiles('csv-export', WIN, { baseline: [], withSkill: [] }));
    const r = await missing.evaluate(d2.id);
    expect(r.passed).toBe(false);
    expect(r.needsReview).toBeUndefined();
    expect(r.notes).toContain('expected file out/balance.csv was not produced');
  });

  it('a configured judge that returns no usable verdict needs review; a usable verdict decides', async () => {
    const garbage = { complete: vi.fn(async () => ({ text: 'maybe?', json: null, tokensIn: 1, tokensOut: 1, costUsd: 0, offline: false })) };
    const svc = createSkillService(k, { org: fakeOrg(k), approvals: fakeApprovals(k), utility: garbage, evalRunner: fakeRunner('stripe-export', WIN) });
    const draft = await svc.manage(caller(), { action: 'create', name: 'stripe-export', description: 'd', body: BODY });
    expect(await svc.evaluate(draft.id)).toMatchObject({ passed: false, needsReview: true });

    const strict = createHarness(k, { evalRunner: fakeRunner('stripe-export', WIN), verdict: (p) => !p.includes('WITH-SKILL') });
    const res = await strict.svc.evaluate(draft.id);
    expect(res).toMatchObject({ passed: false, withSkill: { success: false } });
    expect(res.needsReview).toBeUndefined();
  });

  it('eval cases are exposed and managed through the service (validated, scoped, audited)', async () => {
    const svc = realService(k, fakeRunner('stripe-export', WIN));
    const skill = await svc.manage(caller(), { action: 'create', name: 'stripe-export', description: 'd', body: BODY });
    const added = svc.addEvalCase(skill.id, { prompt: 'Export Q3', criteria: 'CSV for Q3', expect: { contains: ['q3'] } }, OWNER);
    expect(added).toMatchObject({ source: 'manual', prompt: 'Export Q3', criteria: 'CSV for Q3', expect: { contains: ['q3'] }, issueId: null });
    expect(svc.evalCases(skill.id).map((c) => c.source).sort()).toEqual(['issue', 'manual']);
    expect(k.db.select().from(evalCases).where(eq(evalCases.id, added.id)).get()).toMatchObject({ orgId: org.id, skillId: skill.id });
    expect(k.audit.query({ orgId: org.id, action: 'skill.eval_case_added' })).toHaveLength(1);

    expect(() => svc.addEvalCase(skill.id, { prompt: '' }, OWNER)).toThrow(/invalid eval case/);
    expect(() => svc.addEvalCase(skill.id, { prompt: 'x', expect: { regex: ['/(unclosed/'] } }, OWNER)).toThrow(/invalid eval case regex/);
    expect(() => svc.addEvalCase(skill.id, { prompt: 'x', issueId: 'iss_other_org' }, OWNER)).toThrow(/not found/i);
    const bea = seedAgent(k, org.id, ada.deptId, 'Bea');
    expect(() => svc.addEvalCase(skill.id, { prompt: 'x' }, { kind: 'agent', id: bea.id })).toThrow(/may not modify/);
    expect(() => svc.evalCases('skl_missing')).toThrow(/not found/i);

    svc.removeEvalCase(skill.id, added.id, OWNER);
    expect(svc.evalCases(skill.id).map((c) => c.source)).toEqual(['issue']);
    expect(() => svc.removeEvalCase(skill.id, added.id, OWNER)).toThrow(/not found/i);
  });

  it('recordReview corrects the usages of a reviewed run and auto-reverts a version humans keep editing', async () => {
    const { svc } = createHarness(k);
    const v1: Skill = await svc.manage(caller('run_c'), { action: 'create', name: 'stripe-export', description: 'd', body: BODY }).then((s) => svc.activate(s.id, OWNER, { force: true }));
    await svc.manage(caller('run_p'), { action: 'patch', name: 'stripe-export', body: 'A sloppier procedure.' });
    // The patch of a live skill waits as a candidate; here the owner waves it through.
    expect(svc.get(v1.id).version).toBe(1);
    await svc.activate(v1.id, OWNER, { force: true });
    // Reflection ran before review: every use was recorded as a success nobody edited.
    for (const runId of ['r1', 'r2', 'r3']) await svc.recordUsage({ orgId: org.id, runId, agentId: ada.id, skillIds: [v1.id], success: true, humanEdited: false, costUsd: 0.01, steps: 3 });
    expect(svc.get(v1.id)).toMatchObject({ version: 2, useCount: 3, successCount: 3 });

    // Review verdicts arrive: two edited (still done), then nothing changes on a repeat.
    expect(await svc.recordReview({ orgId: org.id, runId: 'r1', success: true, humanEdited: true })).toEqual({ updated: [v1.id], reverted: [] });
    expect(await svc.recordReview({ orgId: org.id, runId: 'r1', success: true, humanEdited: true })).toEqual({ updated: [], reverted: [] });
    expect(await svc.recordReview({ orgId: org.id, runId: 'r2', success: false, humanEdited: false })).toEqual({ updated: [v1.id], reverted: [] });
    expect(svc.get(v1.id)).toMatchObject({ version: 2, successCount: 2 });
    expect(k.db.select().from(skillUsages).where(eq(skillUsages.runId, 'r2')).get()).toMatchObject({ success: false, humanEdited: false });
    // Another org's verdict for the same run id touches nothing.
    const other = seedOrg(k, 'Globex');
    expect(await svc.recordReview({ orgId: other.id, runId: 'r3', success: false, humanEdited: true })).toEqual({ updated: [], reverted: [] });

    await svc.recordReview({ orgId: org.id, runId: 'r2', success: true, humanEdited: true });
    // Third human-edited result of the last five uses → the version is reverted to v1's content.
    expect(await svc.recordReview({ orgId: org.id, runId: 'r3', success: true, humanEdited: true })).toEqual({ updated: [v1.id], reverted: [v1.id] });
    expect(svc.get(v1.id)).toMatchObject({ version: 3, contentHash: v1.contentHash, status: 'active' });
    expect(k.audit.query({ orgId: org.id, action: 'skill.reverted' })[0]?.data).toMatchObject({ reason: 'human_edited_outcomes', restoredVersion: 1 });
    await expect(svc.recordReview({ orgId: '', runId: 'r1', success: true, humanEdited: false })).rejects.toMatchObject({ code: 'validation' });
  });
});
