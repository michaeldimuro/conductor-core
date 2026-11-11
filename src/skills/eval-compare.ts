import type { EvalMetrics, OrgPolicies } from '../contracts/types.js';

/** Replays per arm and case unless the org's `skillEvalSamples` policy says otherwise. */
export const DEFAULT_EVAL_SAMPLES = 2;
/** Hard cap: every sample is two sandbox runs per case. */
export const MAX_EVAL_SAMPLES = 5;
/** Relative difference in cost / steps below which two arms are treated as equal (run-to-run noise). */
export const NOISE_MARGIN = 0.1;

export type ArmSummary = EvalMetrics & {
  /** Share of samples that succeeded, over all cases (0..1). */
  rate: number;
};

/** `new` = a draft against no skill at all (must show a gain); `patch` = a candidate against the live version (must not regress). */
export type CompareMode = 'new' | 'patch';

export interface Comparison {
  passed: boolean;
  /** Not a pass and not a failure of the skill: a human decides. */
  needsReview: boolean;
  score: number;
  reason: string;
}

export function samplesFor(policies: Pick<OrgPolicies, 'skillEvalSamples'> | null | undefined): number {
  const wanted = policies?.skillEvalSamples;
  if (typeof wanted !== 'number' || !Number.isFinite(wanted)) return DEFAULT_EVAL_SAMPLES;
  return Math.max(1, Math.min(MAX_EVAL_SAMPLES, Math.floor(wanted)));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** (with − base) / base: negative = the skill arm is cheaper. */
const delta = (base: number, withSkill: number): number => (base > 0 ? (withSkill - base) / base : withSkill > 0 ? Number.POSITIVE_INFINITY : 0);
const saving = (base: number, withSkill: number): number => Math.max(-1, Math.min(1, -delta(base, withSkill)));
const pct = (d: number): string => (Number.isFinite(d) ? `${d > 0 ? '+' : ''}${Math.round(d * 100)}%` : 'from zero');

/**
 * The gate on the medians of the two arms. Auto-activation needs the with-skill arm to succeed and:
 *  - a strictly higher success rate than the baseline; or
 *  - the same success rate with neither cost nor steps worse than the baseline beyond the noise
 *    margin — and, for a new skill, at least one of them better beyond it (a patch of a live
 *    skill only has to hold the line).
 * Anything else that is not an outright failure of the skill arm goes to human review.
 * Cost falls back to tokens when neither arm was metered (subscription runs cost $0).
 */
export function compare(baseline: ArmSummary, withSkill: ArmSummary, opts: { mode?: CompareMode; margin?: number } = {}): Comparison {
  const margin = opts.margin ?? NOISE_MARGIN;
  const metered = baseline.costUsd > 0 || withSkill.costUsd > 0;
  const cost = metered ? delta(baseline.costUsd, withSkill.costUsd) : delta(baseline.tokens, withSkill.tokens);
  const steps = delta(baseline.steps, withSkill.steps);
  const efficiency = ((metered ? saving(baseline.costUsd, withSkill.costUsd) : saving(baseline.tokens, withSkill.tokens)) + saving(baseline.steps, withSkill.steps)) / 2;
  // 0..1: success dominates, the gain over baseline and the efficiency saving refine it.
  const raw = 0.6 * withSkill.rate + 0.2 * Math.max(0, withSkill.rate - baseline.rate) + 0.2 * (0.5 + efficiency / 2);
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 1000) / 1000;
  const measured = `${metered ? 'cost' : 'tokens'} ${pct(cost)}, steps ${pct(steps)} vs baseline (noise margin ±${Math.round(margin * 100)}%)`;

  if (!withSkill.success) return { passed: false, needsReview: false, score, reason: 'the with-skill arm did not succeed' };
  const rateLoss = withSkill.rate < baseline.rate - 1e-9;
  const rateGain = withSkill.rate > baseline.rate + 1e-9;
  if (rateLoss) return { passed: false, needsReview: true, score, reason: `success rate fell from ${baseline.rate.toFixed(2)} to ${withSkill.rate.toFixed(2)}` };
  // Succeeding where the baseline does not is the gain; what a failing baseline spent is no yardstick for cost.
  if (rateGain) return { passed: true, needsReview: false, score, reason: `success rate rose from ${baseline.rate.toFixed(2)} to ${withSkill.rate.toFixed(2)}; ${measured}` };
  const worse = cost > margin || steps > margin;
  if (worse) return { passed: false, needsReview: true, score, reason: `costlier than the baseline beyond the noise margin: ${measured}` };
  const better = cost < -margin || steps < -margin;
  if (better || opts.mode === 'patch') return { passed: true, needsReview: false, score, reason: measured };
  return { passed: false, needsReview: true, score, reason: `no gain beyond the noise margin: ${measured}` };
}
