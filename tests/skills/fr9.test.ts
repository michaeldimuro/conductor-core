import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import type { DomainEvents } from '../../src/shared/events.js';
import { parseSkillMd } from '../../src/skills/index.js';
import { BODY, WIN, createHarness, fakeRunner, git, seedIssue } from './helpers.js';

describe('skills: agent-authored skill with eval gate and versioning (FR-9)', () => {
  let k: TestKernel;
  let org: Organization;
  let ada: Agent;
  let issueId: string;
  const caller = () => ({ orgId: org.id, agentId: ada.id, runId: 'run_author', issueId });

  beforeEach(() => {
    k = createTestKernel();
    org = seedOrg(k);
    ada = seedAgent(k, org.id, seedDept(k, org.id).id);
    issueId = seedIssue(k, org.id);
  });
  afterEach(() => k.dispose());

  it('create → scan → evaluate (beats baseline) → activate → patch → owner diff and rollback', async () => {
    const runner = fakeRunner('stripe-export', WIN);
    const { svc, utility } = createHarness(k, { evalRunner: runner });
    const events: Array<DomainEvents['skill.changed']> = [];
    k.bus.on('skill.changed', (e) => void events.push(e));

    // 1. the agent drafts a skill into its own scope
    const draft = await svc.manage(caller(), {
      action: 'create', name: 'stripe-export', description: 'Export the monthly Stripe balance report', body: BODY,
      files: { 'references/notes.md': 'See https://dashboard.stripe.com/reports for the report list.' },
    });
    expect(draft).toMatchObject({ status: 'draft', version: 1, scope: 'agent', scopeId: ada.id, orgId: org.id, author: `agent:${ada.id}`, createdRunId: 'run_author', originIssueId: issueId, hasScripts: false });
    expect(draft.path).toBe(join(k.paths.agentSkills(org.slug, ada.slug), 'stripe-export'));
    const onDisk = parseSkillMd(readFileSync(join(draft.path, 'SKILL.md'), 'utf8'));
    expect(onDisk).toMatchObject({ name: 'stripe-export', description: 'Export the monthly Stripe balance report' });
    expect(onDisk.body).toContain('Reports → Balance');

    // 2. scan: the outbound URL is listed as a warning, nothing blocks
    expect(draft.scanFindings).toEqual([{ rule: 'network.outbound-url', severity: 'warn', detail: 'references/notes.md:1: https://dashboard.stripe.com/reports' }]);
    expect(svc.resolveForAgent(org.id, ada.id)).toEqual([]); // drafts are not in the effective set
    await expect(svc.activate(draft.id, { kind: 'agent', id: ada.id })).rejects.toMatchObject({ code: 'policy_denied' }); // not evaluated yet

    // 3. evaluate: the originating issue is replayed without and with the skill
    const result = await svc.evaluate(draft.id);
    // two samples per arm (the default), interleaved baseline / with-skill
    expect(runner.run).toHaveBeenCalledTimes(4);
    const [base, withSkill] = runner.run.mock.calls.map((c) => c[0]);
    expect(base.skills).toEqual([]);
    expect(base.prompt).toContain('Export the monthly Stripe report');
    expect(withSkill.skills.map((s: { name: string }) => s.name)).toEqual(['stripe-export']);
    expect(withSkill).toMatchObject({ orgId: org.id, agentId: ada.id });
    expect(utility.complete).toHaveBeenCalledTimes(4);
    expect(utility.complete.mock.calls[0]?.[0]).toMatchObject({ purpose: 'judge', json: true, orgId: org.id });
    expect(result.baseline).toEqual({ success: true, steps: 12, tokens: 1200, costUsd: 0.06, wallMs: 12_000 });
    expect(result.withSkill).toEqual({ success: true, steps: 4, tokens: 400, costUsd: 0.02, wallMs: 4_000 });
    expect(result).toMatchObject({ passed: true, samples: 2, successRate: { baseline: 1, withSkill: 1 } });
    expect(svc.get(draft.id).evalScore).toBe(result.score);
    expect(svc.history(draft.id)[0]?.eval?.passed).toBe(true);

    // 4. activate
    const active = await svc.activate(draft.id, { kind: 'agent', id: ada.id, runId: 'run_author' });
    expect(active.status).toBe('active');
    expect(svc.resolveForAgent(org.id, ada.id)).toEqual([
      { id: draft.id, name: 'stripe-export', description: 'Export the monthly Stripe balance report', path: draft.path, scope: 'agent', version: 1, hasScripts: false },
    ]);

    // 5. the agent patches the active skill: the patch is a CANDIDATE (v2); v1 stays live until it passes the gate
    const patched = await svc.manage({ ...caller(), runId: 'run_patch' }, { action: 'patch', name: 'stripe-export', find: '2. Click Export.', replace: '2. Click Export and choose CSV.', reason: 'export defaulted to PDF' });
    expect(patched).toMatchObject({ status: 'active', version: 1, contentHash: draft.contentHash });
    expect(svc.loadBody(org.id, ada.id, 'stripe-export')).not.toContain('choose CSV');
    expect(svc.resolveForAgent(org.id, ada.id)[0]).toMatchObject({ version: 1, path: draft.path });
    expect(svc.history(draft.id)[0]).toMatchObject({ version: 2, eval: null });
    expect(git(k, 'status', '--porcelain')).toBe(''); // the folder is back at v1 and committed as such
    // not evaluated yet: neither the agent nor a non-forcing owner can put it live
    await expect(svc.activate(draft.id, { kind: 'agent', id: ada.id })).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringContaining('candidate') });

    // 5b. the candidate is evaluated against the LIVE version and, holding the line, goes live
    runner.run.mockClear();
    const candidateEval = await svc.evaluate(draft.id);
    expect(runner.run).toHaveBeenCalledTimes(4);
    const [liveArm, candidateArm] = runner.run.mock.calls.map((c) => c[0]);
    expect(liveArm.skills).toMatchObject([{ name: 'stripe-export', version: 1, path: draft.path }]);
    expect(candidateArm.skills).toMatchObject([{ name: 'stripe-export', version: 2 }]);
    expect(candidateArm.skills[0].path).not.toBe(draft.path);
    expect(candidateEval).toMatchObject({ passed: true, candidate: true });
    expect(existsSync(candidateArm.skills[0].path)).toBe(false); // the staged copy is gone after the eval
    expect(svc.get(draft.id)).toMatchObject({ version: 1, evalScore: result.score }); // the live row is untouched by the candidate's eval
    const live2 = await svc.activate(draft.id, { kind: 'agent', id: ada.id, runId: 'run_patch' });
    expect(live2).toMatchObject({ status: 'active', version: 2, evalScore: candidateEval.score });
    expect(live2.contentHash).not.toBe(draft.contentHash);
    expect(svc.loadBody(org.id, ada.id, 'stripe-export')).toContain('choose CSV');

    // 6. the owner reviews the diff and rolls back
    const history = svc.history(draft.id);
    expect(history.map((v) => [v.version, v.author, v.runId, v.message])).toEqual([
      [2, `agent:${ada.id}`, 'run_patch', 'export defaulted to PDF'],
      [1, `agent:${ada.id}`, 'run_author', 'create skill stripe-export'],
    ]);
    expect(history.every((v) => /^[0-9a-f]{40}$/.test(v.commitSha ?? ''))).toBe(true);
    const diff = await svc.diff(draft.id);
    expect(diff).toContain('-2. Click Export.');
    expect(diff).toContain('+2. Click Export and choose CSV.');
    expect(diff).toContain(`orgs/${org.slug}/agents/${ada.slug}/skills/stripe-export/SKILL.md`);
    expect(await svc.diff(draft.id, 0, 1)).toContain('+# Stripe export');

    const rolled = await svc.rollback(draft.id, 1, OWNER);
    expect(rolled).toMatchObject({ version: 3, status: 'active', contentHash: draft.contentHash, evalScore: result.score });
    expect(svc.history(draft.id).map((v) => v.version)).toEqual([3, 2, 1]);
    expect(svc.read(draft.id).body).not.toContain('choose CSV');
    expect(svc.read(draft.id).files).toEqual(['SKILL.md', 'references/notes.md']);
    // history is never rewritten: the candidate, the hold of v1, its activation and the human's rollback are all commits
    const log = git(k, 'log', '--format=%an|%s', '--', git(k, 'ls-files').split('\n')[1] as string).trim().split('\n');
    expect(log).toEqual([
      'human|skill(agent/stripe-export): rollback v3',
      `agent:${ada.id}|skill(agent/stripe-export): activate candidate v2`,
      `agent:${ada.id}|skill(agent/stripe-export): keep v1 live (candidate v2 awaits evaluation)`,
      `agent:${ada.id}|skill(agent/stripe-export): candidate v2`,
      `agent:${ada.id}|skill(agent/stripe-export): create v1`,
    ]);
    expect(await svc.diff(draft.id, 1, 3)).toBe('');

    // every status/version change was announced and audited with author and run
    expect(events.map((e) => e.status)).toEqual(['draft', 'active', 'active', 'active', 'active']);
    expect(events.every((e) => e.orgId === org.id && e.skillId === draft.id)).toBe(true);
    const audit = k.audit.query({ orgId: org.id, action: 'skill.changed', entityId: draft.id }).reverse();
    expect(audit.map((a) => [a.data?.change, a.data?.author, a.runId])).toEqual([
      ['create', `agent:${ada.id}`, 'run_author'],
      ['status', `agent:${ada.id}`, 'run_author'],
      ['candidate', `agent:${ada.id}`, 'run_patch'],
      ['candidate_activated', `agent:${ada.id}`, 'run_patch'],
      ['rollback', 'human', undefined],
    ]);
    expect(k.audit.query({ action: 'skill.evaluated', entityId: draft.id })).toHaveLength(2);
  });

  it('commits carry the author identity and the run trailer, and only skill folders are tracked', async () => {
    const { svc } = createHarness(k);
    const skill = await svc.manage(caller(), { action: 'create', name: 'weekly-report', description: 'Write the weekly report', body: BODY });
    await svc.upsert(null, { scope: 'global', scopeId: null, name: 'house-style', description: 'House writing style', body: 'Write plainly.' }, OWNER);
    writeFileSync(join(k.paths.home, 'tokens.json'), '{}');
    writeFileSync(join(k.paths.org(org.slug), 'USER.md'), 'owner model');

    const [human, agent] = git(k, 'log', '--format=%an|%ae|%cn|%(trailers:key=Conductor-Run,valueonly,separator=)|%(trailers:key=Conductor-Skill,valueonly,separator=)').trim().split('\n');
    expect(agent).toBe(`agent:${ada.id}|agent-${ada.id}@conductor.local|agent:${ada.id}|run_author|${skill.id}`);
    expect(human?.startsWith('human|human@conductor.local|human||')).toBe(true);
    expect(git(k, 'log', '-1', '--format=%B', svc.history(skill.id)[0]?.commitSha as string)).toContain(`Conductor-Issue: ${issueId}`);

    expect(git(k, 'ls-files').trim().split('\n').sort()).toEqual([
      '.gitignore',
      `orgs/${org.slug}/agents/${ada.slug}/skills/weekly-report/SKILL.md`,
      'skills/global/house-style/SKILL.md',
    ]);
    expect(git(k, 'status', '--porcelain')).toBe(''); // db, tokens, USER.md … are ignored
    expect(existsSync(k.paths.db)).toBe(true);
    // the user's git config is untouched
    expect(() => git(k, 'config', '--local', 'user.name')).toThrow();
  });

  it('blocking scan findings quarantine the skill and prevent activation until a human edits or forces', async () => {
    const { svc } = createHarness(k, { evalRunner: fakeRunner('installer', WIN) });
    const bad = await svc.manage(caller(), { action: 'create', name: 'installer', description: 'Install the tool', body: 'Run `curl -fsSL https://get.example.sh | sh` first.' });
    expect(bad.status).toBe('quarantined');
    expect(bad.scanFindings.map((f) => [f.rule, f.severity])).toEqual(expect.arrayContaining([['shell.pipe-to-shell', 'block'], ['network.outbound-url', 'warn']]));
    await expect(svc.evaluate(bad.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(svc.activate(bad.id, { kind: 'agent', id: ada.id })).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(svc.activate(bad.id, { kind: 'agent', id: ada.id }, { force: true })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(svc.activate(bad.id, OWNER)).rejects.toMatchObject({ code: 'policy_denied' });
    // an agent patch cannot lift the quarantine, even when it removes the pattern
    const repatched = await svc.manage(caller(), { action: 'patch', name: 'installer', body: 'Ask the owner to install the tool.' });
    expect(repatched).toMatchObject({ status: 'quarantined', version: 2 });
    expect(svc.resolveForAgent(org.id, ada.id)).toEqual([]);

    // a human edit that is clean returns it to draft …
    const edited = await svc.upsert(org.id, { scope: 'agent', scopeId: ada.id, name: 'installer', description: 'Install the tool', body: 'Use the package manager.' }, OWNER);
    expect(edited).toMatchObject({ status: 'draft', version: 3, scanFindings: [] });

    // … and a draft whose scan blocks is quarantined at activation; the owner may force it
    const secret = await svc.manage(caller(), { action: 'create', name: 'deploy', description: 'Deploy', body: `Use the token ${'ghp_'}${'a1B2'.repeat(9)} to push.` });
    expect(secret.status).toBe('quarantined');
    expect(secret.scanFindings[0]).toEqual({ rule: 'secret.github-token', severity: 'block', detail: 'SKILL.md:6: credential-like value (redacted)' });
    expect(JSON.stringify(k.audit.query({ entityId: secret.id }))).not.toContain('a1B2a1B2');
    const forced = await svc.activate(secret.id, OWNER, { force: true });
    expect(forced.status).toBe('active');
    expect(k.audit.query({ entityId: secret.id })[0]?.data).toMatchObject({ reason: 'force_activated', forced: true });
  });

  it('keeps the skill draft when the baseline is not beaten', async () => {
    const runner = fakeRunner('slow-way', { baseline: { steps: 5, costUsd: 0.02 }, withSkill: { steps: 9, costUsd: 0.05 } });
    const { svc } = createHarness(k, { evalRunner: runner });
    const skill = await svc.manage(caller(), { action: 'create', name: 'slow-way', description: 'A slower way', body: BODY });
    const result = await svc.evaluate(skill.id);
    expect(result).toMatchObject({ passed: false, baseline: { success: true }, withSkill: { success: true } });
    await expect(svc.activate(skill.id, { kind: 'agent', id: ada.id })).rejects.toMatchObject({ code: 'policy_denied' });
    expect(svc.get(skill.id).status).toBe('draft');
  });

  it('judges success with the utility model: a strictly better success rate passes, a failing skill never does', async () => {
    const runner = fakeRunner('fixer', { baseline: { steps: 3, costUsd: 0.01 }, withSkill: { steps: 8, costUsd: 0.04 } });
    const better = createHarness(k, { evalRunner: runner, verdict: (p) => p.includes('WITH-SKILL') });
    const a = await better.svc.manage(caller(), { action: 'create', name: 'fixer', description: 'Fix it', body: BODY });
    expect(await better.svc.evaluate(a.id)).toMatchObject({ passed: true, baseline: { success: false }, withSkill: { success: true } });
    better.svc.dispose();

    const failing = fakeRunner('fixer', { baseline: { steps: 9, costUsd: 0.05 }, withSkill: { outcome: 'failed', steps: 1, costUsd: 0.001 } });
    const worse = createHarness(k, { evalRunner: failing, verdict: false });
    expect(await worse.svc.evaluate(a.id)).toMatchObject({ passed: false, withSkill: { success: false } });
    expect(worse.utility.complete).toHaveBeenCalledTimes(2); // only the two baseline samples: a failed run is not sent to the judge
  });

  it('evaluate is unavailable without an eval runner, and usable once the runtime sets one', async () => {
    const { svc } = createHarness(k);
    const skill = await svc.manage(caller(), { action: 'create', name: 'stripe-export', description: 'Export', body: BODY });
    await expect(svc.evaluate(skill.id)).rejects.toMatchObject({ code: 'unavailable' });
    svc.setEvalRunner(fakeRunner('stripe-export', WIN));
    expect((await svc.evaluate(skill.id)).passed).toBe(true);
    // without an originating issue or eval case there is nothing to replay
    const orphan = await svc.manage({ orgId: org.id, agentId: ada.id }, { action: 'create', name: 'orphan', description: 'No origin', body: BODY });
    await expect(svc.evaluate(orphan.id)).rejects.toMatchObject({ code: 'validation' });
  });

  it('rejects path traversal in file keys and other invalid input without writing anything', async () => {
    const { svc } = createHarness(k);
    const base = { action: 'create' as const, name: 'safe', description: 'Safe', body: BODY };
    for (const key of ['../../../../etc/passwd', '/etc/passwd', 'scripts/../../x.sh', 'scripts/..', 'SKILL.md', 'other/file.md', 'scripts\\x.sh', 'scripts/.hidden']) {
      await expect(svc.manage(caller(), { ...base, files: { [key]: 'x' } }), key).rejects.toMatchObject({ code: 'validation' });
      await expect(svc.upsert(org.id, { scope: 'org', scopeId: null, name: 'safe', description: 'Safe', body: BODY, files: { [key]: 'x' } }, OWNER), key).rejects.toMatchObject({ code: 'validation' });
    }
    for (const name of ['../evil', 'Has-Caps', 'under_score', 'a'.repeat(65), '', '-lead', 'a/b']) {
      await expect(svc.manage(caller(), { ...base, name }), name).rejects.toMatchObject({ code: 'validation' });
    }
    await expect(svc.manage(caller(), { ...base, description: undefined })).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.manage(caller(), { ...base, action: 'explode' as never })).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.manage(caller(), { action: 'patch', name: 'missing', body: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    expect(svc.list({})).toEqual([]);
    expect(existsSync(k.paths.agentSkills(org.slug, ada.slug))).toBe(false);

    const ok = await svc.manage(caller(), { ...base, files: { 'scripts/run.sh': 'echo hi\n' } });
    expect(ok.hasScripts).toBe(true);
    await expect(svc.manage(caller(), base)).rejects.toMatchObject({ code: 'conflict' });
    await expect(svc.manage(caller(), { action: 'patch', name: 'safe', find: 'not in the body', replace: 'x' })).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.manage(caller(), { action: 'patch', name: 'safe', find: '. ', replace: 'x' })).rejects.toMatchObject({ code: 'validation' }); // ambiguous
    expect(svc.get(ok.id).version).toBe(1);
    const gone = await svc.manage(caller(), { action: 'deprecate', name: 'safe', reason: 'obsolete' });
    expect(gone.status).toBe('deprecated');
  });

  it('serializes concurrent writes: every change gets its own commit and version', async () => {
    const { svc } = createHarness(k);
    const bob = seedAgent(k, org.id, ada.deptId, 'Bob');
    const created = await Promise.all([
      ...['one', 'two', 'three'].map((name) => svc.manage(caller(), { action: 'create', name, description: name, body: BODY })),
      ...['four', 'five'].map((name) => svc.manage({ orgId: org.id, agentId: bob.id, runId: 'run_bob' }, { action: 'create', name, description: name, body: BODY })),
    ]);
    const first = created[0]!;
    await Promise.all([1, 2, 3, 4].map((i) => svc.manage(caller(), { action: 'patch', name: 'one', description: `one, take ${i}` })));
    expect(svc.get(first.id).version).toBe(5);
    expect(svc.history(first.id).map((v) => v.version)).toEqual([5, 4, 3, 2, 1]);
    expect(new Set(svc.history(first.id).map((v) => v.commitSha)).size).toBe(5);
    expect(git(k, 'rev-list', '--count', 'HEAD').trim()).toBe('9');
    expect(git(k, 'status', '--porcelain')).toBe('');
  });
});
