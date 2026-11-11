import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { agents, evalCases, issues, skillVersions, skills } from '../db/schema/index.js';
import type { ResolvedSkillRef } from '../contracts/adapter.js';
import type { EvalRunner } from '../contracts/services.js';
import type { Skill } from '../contracts/rows.js';
import type { EvalExpectations, EvalMetrics, SkillEvalResult } from '../contracts/types.js';
import { SYSTEM } from '../contracts/types.js';
import { ConductorError, conflict, invalid } from '../shared/errors.js';
import { truncate } from '../shared/util.js';
import { decodeCriteria } from './eval-cases.js';
import { deterministicChecks, type Verdict } from './eval-checks.js';
import { resolveForAgent, toRef } from './resolve.js';
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
 * expectations, then the judge. Without a utility model the deterministic evidence decides
 * (the comparison against the baseline's cost/steps still has to be won); a check that cannot
 * be evaluated yields `unknown`, which is "needs human review" — never a silent fail or pass.
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

const LABEL: Record<Verdict, string> = { pass: 'ok', fail: 'fail', unknown: 'undecided' };
const metricsOf = (a: ArmResult, success: boolean): EvalMetrics => ({ success, steps: a.steps, tokens: a.tokens, costUsd: a.costUsd, wallMs: a.wallMs });

function aggregate(arms: EvalMetrics[]): EvalMetrics & { rate: number } {
  const ok = arms.filter((a) => a.success).length;
  return {
    success: arms.length > 0 && ok === arms.length,
    rate: arms.length ? ok / arms.length : 0,
    steps: arms.reduce((n, a) => n + a.steps, 0),
    tokens: arms.reduce((n, a) => n + a.tokens, 0),
    costUsd: arms.reduce((n, a) => n + a.costUsd, 0),
    wallMs: arms.reduce((n, a) => n + a.wallMs, 0),
  };
}

const saving = (base: number, withSkill: number): number => (base > 0 ? Math.max(-1, Math.min(1, (base - withSkill) / base)) : withSkill > 0 ? -1 : 0);

/**
 * passed = with-skill succeeds AND beats baseline: strictly better success,
 * or equal success at lower cost (ties broken by steps, then tokens).
 */
export function compare(baseline: EvalMetrics & { rate: number }, withSkill: EvalMetrics & { rate: number }): { passed: boolean; score: number } {
  const cheaper =
    withSkill.costUsd < baseline.costUsd ||
    (withSkill.costUsd === baseline.costUsd && (withSkill.steps < baseline.steps || (withSkill.steps === baseline.steps && withSkill.tokens < baseline.tokens)));
  const passed = withSkill.success && (withSkill.rate > baseline.rate || (withSkill.rate === baseline.rate && cheaper));
  const efficiency = (saving(baseline.costUsd > 0 ? baseline.costUsd : baseline.tokens, baseline.costUsd > 0 ? withSkill.costUsd : withSkill.tokens) + saving(baseline.steps, withSkill.steps)) / 2;
  // 0..1: success dominates, the gain over baseline and the efficiency saving refine it.
  const score = Math.max(0, Math.min(1, 0.6 * withSkill.rate + 0.2 * Math.max(0, withSkill.rate - baseline.rate) + 0.2 * (0.5 + efficiency / 2)));
  return { passed, score: Math.round(score * 1000) / 1000 };
}

/** Replay each case without and with the skill in the runtime's sandbox; store the result on the version. */
export async function evaluate(ctx: SkillCtx, skillId: string): Promise<SkillEvalResult> {
  const runner = ctx.deps.evalRunner;
  if (!runner) throw new ConductorError('unavailable', 'no eval runner is configured; skill evaluation is unavailable');
  const skill = ctx.store.get(skillId);
  if (skill.status === 'quarantined') throw conflict('a quarantined skill cannot be evaluated');
  const cases = casesFor(ctx, skill);
  if (cases.length === 0) throw invalid('skill has no eval case and no originating issue to replay');
  const who = evalAgent(ctx, skill);

  const others = resolveForAgent(ctx, who.orgId, who.agentId).filter((r) => r.id !== skill.id);
  const withRefs = [...others.filter((r) => r.name !== skill.name), toRef(skill)];
  const evaluatedVersion = skill.version;

  const baselineArms: EvalMetrics[] = [];
  const skillArms: EvalMetrics[] = [];
  const notes: string[] = [];
  let skillFailed = false;
  let undecided = false;
  for (const c of cases) {
    const base = await runArm(ctx, runner, who, c, others, `skill-eval:${skill.name}:baseline`);
    const withSkill = await runArm(ctx, runner, who, c, withRefs, `skill-eval:${skill.name}:with-skill`);
    // An unverifiable baseline gets the benefit of the doubt: the skill then has to win on cost/steps.
    baselineArms.push(metricsOf(base, base.verdict !== 'fail'));
    skillArms.push(metricsOf(withSkill, withSkill.verdict === 'pass'));
    if (withSkill.verdict === 'fail') skillFailed = true;
    if (withSkill.verdict === 'unknown') undecided = true;
    notes.push(`${c.id}: baseline ${LABEL[base.verdict]} (${base.reason}); with skill ${LABEL[withSkill.verdict]} (${withSkill.reason})`);
  }
  const baseline = aggregate(baselineArms);
  const withSkill = aggregate(skillArms);
  // Undecidable (and not already failed outright): a human decides, the gate neither passes nor "fails" the skill.
  const needsReview = undecided && !skillFailed;
  const compared = compare(baseline, withSkill);
  const passed = compared.passed && !needsReview;
  const score = compared.score;
  if (needsReview) notes.unshift('NEEDS HUMAN REVIEW: at least one check could not be decided; the owner can review and force-activate.');
  const { rate: _b, ...baselineMetrics } = baseline;
  const { rate: _w, ...withMetrics } = withSkill;
  const result: SkillEvalResult = { ranAt: ctx.kernel.clock.now(), baseline: baselineMetrics, withSkill: withMetrics, passed, score, notes: truncate(notes.join('\n'), 4000), ...(needsReview ? { needsReview: true } : {}) };

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
    data: { name: skill.name, version: evaluatedVersion, passed, needsReview, score, cases: cases.length, baseline: baselineMetrics, withSkill: withMetrics },
  });
  return result;
}
