import type { EvalExpectations } from '../contracts/types.js';
import { compileRegex } from './eval-cases.js';

/** `unknown` = the check could not be evaluated at all (never silently a pass or a fail). */
export type Verdict = 'pass' | 'fail' | 'unknown';

export interface CheckOutcome {
  verdict: Verdict;
  /** How many expectations were evaluated (0 = the case has none). */
  checked: number;
  reasons: string[];
}

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/**
 * Model-free checks of an eval arm: required / forbidden strings and regexes
 * against the final answer, and files the run must leave in its sandbox.
 */
export function deterministicChecks(expect: EvalExpectations, arm: { answer: string; files?: string[] }): CheckOutcome {
  const failures: string[] = [];
  const unknowns: string[] = [];
  let checked = 0;
  const haystack = arm.answer.toLowerCase();

  for (const s of expect.contains ?? []) {
    checked++;
    if (!haystack.includes(s.toLowerCase())) failures.push(`answer does not contain "${s.slice(0, 60)}"`);
  }
  for (const s of expect.notContains ?? []) {
    checked++;
    if (haystack.includes(s.toLowerCase())) failures.push(`answer contains forbidden "${s.slice(0, 60)}"`);
  }
  for (const pattern of expect.regex ?? []) {
    checked++;
    try {
      if (!compileRegex(pattern).test(arm.answer)) failures.push(`answer does not match ${pattern.slice(0, 60)}`);
    } catch {
      unknowns.push(`regex ${pattern.slice(0, 60)} is invalid`);
    }
  }
  const wanted = expect.files ?? [];
  if (wanted.length > 0) {
    checked += wanted.length;
    if (!arm.files) unknowns.push('file outputs cannot be verified: the eval runner reported no file list');
    else {
      const present = new Set(arm.files.map(normPath));
      for (const f of wanted) if (!present.has(normPath(f))) failures.push(`expected file ${f.slice(0, 80)} was not produced`);
    }
  }

  if (failures.length > 0) return { verdict: 'fail', checked, reasons: failures };
  if (unknowns.length > 0) return { verdict: 'unknown', checked, reasons: unknowns };
  return { verdict: 'pass', checked, reasons: checked > 0 ? [`${checked} deterministic check(s) passed`] : [] };
}
