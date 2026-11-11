import type { UtilityModel } from '../contracts/kernel.js';
import type { AgentScorecard } from '../contracts/services.js';
import { estimateTokens } from '../shared/util.js';
import { compactDocument, extractiveSummary, heuristicExtract, heuristicProposals, heuristicSkillDraft } from './heuristics.js';
import { parseJsonLoose } from './text.js';
import { parseSteps, readTag } from './transcript.js';

type Request = Parameters<UtilityModel['complete']>[0];
type Response = Awaited<ReturnType<UtilityModel['complete']>>;

/**
 * Prompt conventions understood offline (the same prompts go to a live model):
 *   <task>memory_extraction|skill_draft</task>, <transcript>, <meta> (JSON),
 *   <document> + <budget_tokens>, <scorecards> (JSON).
 */
export function offlineComplete(req: Request): Response {
  const result = heuristic(req);
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return {
    text,
    json: req.json ? (typeof result === 'string' ? parseJsonLoose(result) : result) : null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    offline: true,
  };
}

function meta(prompt: string): Record<string, unknown> {
  const raw = readTag(prompt, 'meta');
  const parsed = raw ? parseJsonLoose(raw) : null;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function heuristic(req: Request): string | Record<string, unknown> {
  const { prompt } = req;
  const maxChars = Math.max(200, (req.maxTokens ?? 300) * 4);
  switch (req.purpose) {
    case 'extract': {
      const steps = parseSteps(readTag(prompt, 'transcript') ?? '');
      const m = meta(prompt);
      if (readTag(prompt, 'task')?.trim() === 'skill_draft') {
        return { ...heuristicSkillDraft({ title: str(m.title) ?? 'task', taskType: str(m.taskType), trigger: str(m.trigger), steps, notes: Array.isArray(m.notes) ? m.notes.filter((n): n is string => typeof n === 'string') : [] }) };
      }
      return { ...heuristicExtract(steps, { title: str(m.title), outcome: str(m.outcome), reviewOutcome: str(m.reviewOutcome) ?? null, expectedOutput: str(m.expectedOutput) }) };
    }
    case 'judge':
      // Conservative: never assert a contradiction (or a pass) without a model.
      return { conflict: false, verdict: 'unknown', confidence: 0, reason: 'no utility model configured' };
    case 'review': {
      const raw = readTag(prompt, 'scorecards');
      const cards = raw ? parseJsonLoose(`{"cards":${raw}}`) : null;
      const list = cards && Array.isArray((cards as { cards?: unknown }).cards) ? ((cards as { cards: AgentScorecard[] }).cards) : [];
      return { proposals: heuristicProposals(list) };
    }
    case 'consolidate': {
      const doc = readTag(prompt, 'document');
      if (doc === null) return extractiveSummary(prompt, maxChars);
      const budget = Number(readTag(prompt, 'budget_tokens') ?? NaN);
      return compactDocument(doc, Number.isFinite(budget) && budget > 0 ? budget : estimateTokens(doc)).doc;
    }
    case 'reflect':
    case 'summarize':
    case 'plan':
    case 'chat':
    default: {
      const body = readTag(prompt, 'transcript');
      const summary = body !== null ? heuristicExtract(parseSteps(body), meta(prompt)).summary : extractiveSummary(prompt, maxChars);
      return req.json ? { summary } : summary;
    }
  }
}
