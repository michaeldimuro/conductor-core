import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { agents, evalCases, issues, skillVersions, skills } from '../db/schema/index.js';
import type { ResolvedSkillRef } from '../contracts/adapter.js';
import type { EvalRunner } from '../contracts/services.js';
import type { Skill, SkillVersion } from '../contracts/rows.js';
import type { EvalExpectations, EvalMetrics, SkillEvalResult } from '../contracts/types.js';
import { SYSTEM } from '../contracts/types.js';
import { ConductorError, conflict, invalid } from '../shared/errors.js';
import { truncate } from '../shared/util.js';
import { compare, median, samplesFor, type ArmSummary } from './eval-compare.js';
import { decodeCriteria } from './eval-cases.js';
import { deterministicChecks, type Verdict } from './eval-checks.js';
import { readSkillMd } from './format.js';
import { resolveForAgent, toRef } from './resolve.js';
import { scanSkillDir } from './scan.js';
import { authorAgentId, type SkillCtx } from './store.js';

interface Case {
  id: string;
  prompt: string;
  /** Natural-language criteria ('' = none given). */
  criteria: string;
  expect: EvalExpectations;
}

type ArmResult = EvalMetrics & { verdict: Verdict; reason: string };

const verdictSchema = z.object({ success: z.boolean(), reason: z.string().optional() });
const DEFAULT_CRITERIA = 'The task is fully and correctly completed.';

/** Stored eval cases first; otherwise the originating issue is replayed. */
function casesFor(ctx: SkillCtx, skill: Skill): Case[] {
  const db = ctx.kernel.db;
  const stored = db
    .select()
    .from(evalCases)
    .where(and(eq(evalCases.skillId, skill.id), skill.orgId ? or(eq(evalCases.orgId, skill.orgId), isNull(evalCases.orgId)) : isNull(evalCases.orgId)))
    .orderBy(asc(evalCases.createdAt))
    .all();
  if (stored.length > 0) return stored.map((c) => ({ id: c.id, prompt: c.prompt, ...decodeCriteria(c.successCriteria) }));
  if (skill.originIssueId && skill.orgId) {
    const issue = db
      .select()
      .from(issues)
      .where(and(eq(issues.id, skill.originIssueId), eq(issues.orgId, skill.orgId)))
      .get();
    if (issue) {
      const prompt = [issue.title, issue.body, issue.expectedOutput ? `Expected output: ${issue.expectedOutput}` : ''].filter((p) => p.trim().length > 0).join('\n\n');
      return [{ id: issue.id, prompt, criteria: issue.expectedOutput ?? '', expect: {} }];
    }
  }
  return [];
}

/** The agent whose sandbox replays the cases: the owner of the scope, else the authoring agent, else the department lead. */
function evalAgent(ctx: SkillCtx, skill: Skill): { orgId: string; agentId: string } {
  const db = ctx.kernel.db;
  if (skill.scope === 'agent' && skill.orgId && skill.scopeId) return { orgId: skill.orgId, agentId: skill.scopeId };
  const authorId = authorAgentId(skill.author);
  if (authorId) {
    const a = db
      .select({ id: agents.id, orgId: agents.orgId })
      .from(agents)
      .where(skill.orgId ? and(eq(agents.id, authorId), eq(agents.orgId, skill.orgId)) : eq(agents.id, authorId))
      .get();
    if (a) return { orgId: a.orgId, agentId: a.id };
  }
  if (skill.scope === 'dept' && skill.orgId && skill.scopeId) {
    const lead = ctx.deps.org.leadOf(skill.orgId, skill.scopeId);
    if (lead) return { orgId: skill.orgId, agentId: lead.id };
  }
  throw invalid('cannot evaluate this skill: no agent to replay its eval cases with');
}

/**
 * Ask the utility model whether the answer meets the criteria.
 * `unjudged` = no model is configured (the offline heuristic never asserts a verdict);
 * `unknown`  = a model answered but gave no usable verdict.
 */
async function judge(ctx: SkillCtx, orgId: string, c: Case, answer: string): Promise<{ verdict: Verdict | 'unjudged'; reason: string }> {
  const judged = await ctx.deps.utility.complete({
    orgId,
    purpose: 'judge',
    json: true,
    maxTokens: 300,
    system: 'You grade whether an AI agent accomplished a task. Reply with a JSON object: {"success": boolean, "reason": string}. Be strict: partial or unverifiable work is not success.',
    prompt: `## Task\n${truncate(c.prompt, 6000)}\n\n## Success criteria\n${truncate(c.criteria.trim() || DEFAULT_CRITERIA, 2000)}\n\n## Agent's final answer\n${truncate(answer, 8000)}`,
  });
  const verdict = verdictSchema.safeParse(judged.json);
  if (verdict.success) return { verdict: verdict.data.success ? 'pass' : 'fail', reason: verdict.data.reason ?? (verdict.data.success ? 'judged successful' : 'judged unsuccessful') };
  if (judged.offline) return { verdict: 'unjudged', reason: 'no utility model configured' };
  return { verdict: 'unknown', reason: 'judge returned no usable verdict' };
}

/**
 * One replay. The verdict comes from, in order: exit status, the case's deterministic
 * expectations, then the utility-model judge (an API model or the local CLI, whichever the org
 * resolves to). With no model at all the deterministic evidence decides and the comparison of the
 * medians against the baseline still has to be won; a check that cannot be evaluated yields
 * `unknown`, which is "needs human review" — never a silent fail or pass.
 */
async function runArm(
  ctx: SkillCtx,
  runner: EvalRunner,
  who: { orgId: string; agentId: string },
  c: Case,
  refs: ResolvedSkillRef[],
  label: string,
): Promise<ArmResult> {
  const { result, wallMs, finalText, files } = await runner.run({ orgId: who.orgId, agentId: who.agentId, prompt: c.prompt, skills: refs, label });
  const metrics = { steps: result.steps, tokens: result.usage.tokensIn + result.usage.tokensOut, costUsd: result.usage.costUsd, wallMs };
  const done = (verdict: Verdict, reason: string): ArmResult => ({ ...metrics, success: verdict === 'pass', verdict, reason });

  if (result.outcome !== 'completed') return done('fail', `run ended with outcome ${result.outcome}`);
  const answer = finalText || result.finalText;
  const checks = deterministicChecks(c.expect, { answer, files });
  if (checks.verdict === 'fail') return done('fail', checks.reasons.join('; '));

  // A case with expectations and no written criteria is decided by the expectations alone.
  const judged = checks.checked > 0 && !c.criteria.trim() ? { verdict: 'unjudged' as const, reason: '' } : await judge(ctx, who.orgId, c, answer);
  if (judged.verdict === 'fail') return done('fail', judged.reason);
  if (checks.verdict === 'unknown') return done('unknown', checks.reasons.join('; '));
  if (judged.verdict === 'unknown') return done('unknown', judged.reason);
  if (judged.verdict === 'pass') return done('pass', [judged.reason, ...checks.reasons].join('; '));
  if (!answer.trim()) return done('fail', 'run completed without a final answer');
  return done('pass', checks.checked > 0 ? checks.reasons.join('; ') : `run completed; criteria not judged (${judged.reason}) — decided on exit status and cost/steps against the baseline`);
}

type CaseStatus = 'pass' | 'fail' | 'undecided';

interface CaseOutcome {
  status: CaseStatus;
  baseline: EvalMetrics & { ok: number };
  withSkill: EvalMetrics & { ok: number };
  note: string;
}

/** Medians over the samples of one arm; `ok` = how many samples count as a success. */
function summarize(samples: ArmResult[], counts: (a: ArmResult) => boolean): EvalMetrics & { ok: number } {
  const ok = samples.filter(counts).length;
  return {
    ok,
    success: ok * 2 > samples.length,
    steps: median(samples.map((a) => a.steps)),
    tokens: median(samples.map((a) => a.tokens)),
    costUsd: median(samples.map((a) => a.costUsd)),
    wallMs: median(samples.map((a) => a.wallMs)),
  };
}

const reasons = (samples: ArmResult[]): string => [...new Set(samples.map((a) => a.reason).filter(Boolean))].join(' | ');

/**
 * One case, `n` interleaved replays per arm. The with-skill arm passes the case on a majority of
 * passing samples, fails it on a majority of failing ones, and is undecided in between (mixed
 * results, or a check that could not be evaluated).
 */
async function runCase(ctx: SkillCtx, runner: EvalRunner, who: { orgId: string; agentId: string }, c: Case, arms: { baseline: ResolvedSkillRef[]; withSkill: ResolvedSkillRef[] }, name: string, n: number): Promise<CaseOutcome> {
  const base: ArmResult[] = [];
  const skill: ArmResult[] = [];
  for (let i = 0; i < n; i++) {
    base.push(await runArm(ctx, runner, who, c, arms.baseline, `skill-eval:${name}:baseline`));
    skill.push(await runArm(ctx, runner, who, c, arms.withSkill, `skill-eval:${name}:with-skill`));
  }
  // An unverifiable baseline gets the benefit of the doubt: the skill then has to win on cost/steps.
  const baseline = summarize(base, (a) => a.verdict !== 'fail');
  const withSkill = summarize(skill, (a) => a.verdict === 'pass');
  const failed = skill.filter((a) => a.verdict === 'fail').length;
  const status: CaseStatus = withSkill.success ? 'pass' : failed * 2 > n ? 'fail' : 'undecided';
  return {
    status,
    baseline,
    withSkill,
    note: `${c.id}: baseline ${baseline.ok}/${n} ok (${reasons(base)}); with skill ${withSkill.ok}/${n} ok${status === 'undecided' ? ', undecided' : ''} (${reasons(skill)})`,
  };
}

function aggregate(cases: Array<EvalMetrics & { ok: number }>, samples: number): ArmSummary {
  const sum = (pick: (m: EvalMetrics) => number): number => cases.reduce((n, m) => n + pick(m), 0);
  const total = cases.length * samples;
  return {
    success: cases.length > 0 && cases.every((m) => m.success),
    rate: total > 0 ? cases.reduce((n, m) => n + m.ok, 0) / total : 0,
    steps: sum((m) => m.steps),
    tokens: sum((m) => m.tokens),
    costUsd: sum((m) => m.costUsd),
    wallMs: sum((m) => m.wallMs),
  };
}

/** The candidate's tree, written to a throwaway folder the eval sandbox can read it from. */
async function materializeCandidate(ctx: SkillCtx, skill: Skill, candidate: SkillVersion): Promise<{ ref: ResolvedSkillRef; cleanup: () => void }> {
  if (!candidate.commitSha) throw conflict('the candidate version has no recorded commit');
  const sha = candidate.commitSha;
  const root = mkdtempSync(join(ctx.kernel.paths.ensure(join(ctx.kernel.paths.runDir, 'skill-candidates')), 'cand-'));
  const cleanup = (): void => rmSync(root, { recursive: true, force: true });
  try {
    const dir = join(root, skill.name);
    await ctx.git.exclusive(async () => {
      await ctx.git.ensureRepo();
      await ctx.git.exportTree(sha, skill.path, dir);
    });
    const md = readSkillMd(dir);
    return { ref: { ...toRef(skill), path: dir, version: candidate.version, description: md.description ?? skill.description, hasScripts: scanSkillDir(dir).hasScripts }, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * The eval gate. Each case is replayed `samples` times per arm in the runtime's sandbox (default 2,
 * org policy `skillEvalSamples`, capped); the arms are compared on per-case medians with a noise
 * margin (`compare`). A draft is measured against "no skill"; a pending candidate of a live skill is
 * measured against the live version. The result is stored on the version that was evaluated.
 */
export async function evaluate(ctx: SkillCtx, skillId: string): Promise<SkillEvalResult> {
  const runner = ctx.deps.evalRunner;
  if (!runner) throw new ConductorError('unavailable', 'no eval runner is configured; skill evaluation is unavailable');
  const skill = ctx.store.get(skillId);
  if (skill.status === 'quarantined') throw conflict('a quarantined skill cannot be evaluated');
  const cases = casesFor(ctx, skill);
  if (cases.length === 0) throw invalid('skill has no eval case and no originating issue to replay');
  const who = evalAgent(ctx, skill);
  const samples = samplesFor(ctx.deps.org.getOrg(who.orgId).policies);

  const candidate = ctx.store.pendingCandidate(skill);
  const others = resolveForAgent(ctx, who.orgId, who.agentId).filter((r) => r.id !== skill.id && r.name !== skill.name);
  const staged = candidate ? await materializeCandidate(ctx, skill, candidate) : null;
  const arms = staged ? { baseline: [...others, toRef(skill)], withSkill: [...others, staged.ref] } : { baseline: resolveForAgent(ctx, who.orgId, who.agentId).filter((r) => r.id !== skill.id), withSkill: [...others, toRef(skill)] };
  const evaluatedVersion = candidate?.version ?? skill.version;

  const outcomes: CaseOutcome[] = [];
  try {
    for (const c of cases) outcomes.push(await runCase(ctx, runner, who, c, arms, skill.name, samples));
  } finally {
    staged?.cleanup();
  }
  const baseline = aggregate(outcomes.map((o) => o.baseline), samples);
  const withSkill = aggregate(outcomes.map((o) => o.withSkill), samples);
  const skillFailed = outcomes.some((o) => o.status === 'fail');
  const undecided = outcomes.some((o) => o.status === 'undecided');
  const compared = compare(baseline, withSkill, { mode: candidate ? 'patch' : 'new' });
  // An outright failure of the skill arm is a failed skill; everything else short of a pass is a human's call.
  const needsReview = !skillFailed && (undecided || compared.needsReview);
  const passed = !skillFailed && !undecided && compared.passed;
  const score = compared.score;
  const notes = outcomes.map((o) => o.note);
  notes.unshift(`${samples} sample(s) per arm, medians compared${candidate ? `; candidate v${candidate.version} against live v${skill.version}` : ''}: ${skillFailed ? 'the with-skill arm failed a case' : undecided ? 'at least one case could not be decided' : compared.reason}`);
  if (needsReview) notes.unshift('NEEDS HUMAN REVIEW: the evaluation did not produce a clear pass; the owner can review and force-activate.');
  const { rate: baseRate, ...baselineMetrics } = baseline;
  const { rate: withRate, ...withMetrics } = withSkill;
  const result: SkillEvalResult = {
    ranAt: ctx.kernel.clock.now(), baseline: baselineMetrics, withSkill: withMetrics, passed, score, notes: truncate(notes.join('\n'), 4000),
    samples, successRate: { baseline: baseRate, withSkill: withRate },
    ...(needsReview ? { needsReview: true } : {}), ...(candidate ? { candidate: true } : {}),
  };

  const db = ctx.kernel.db;
  const current = ctx.store.get(skillId);
  db.update(skillVersions)
    .set({ eval: result })
    .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, evaluatedVersion)))
    .run();
  // The skill may have been patched while the eval ran: the score only describes the version it tested.
  if (current.version === evaluatedVersion) db.update(skills).set({ evalScore: score }).where(eq(skills.id, skillId)).run();
  ctx.kernel.audit.record({
    orgId: skill.orgId,
    actor: SYSTEM,
    action: 'skill.evaluated',
    entityKind: 'skill',
    entityId: skill.id,
    data: { name: skill.name, version: evaluatedVersion, candidate: candidate !== null, samples, passed, needsReview, score, cases: cases.length, baseline: baselineMetrics, withSkill: withMetrics, successRate: result.successRate },
  });
  return result;
}
