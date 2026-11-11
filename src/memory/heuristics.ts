/**
 * Deterministic, network-free fallbacks for every utility-model purpose.
 * They back the offline UtilityModel and double as a safety net whenever a
 * live model returns something unusable.
 */
import { estimateTokens } from '../shared/util.js';
import { slugify } from '../shared/ids.js';
import type { AgentScorecard } from '../contracts/services.js';
import { contentTokens, extractEntityCandidates, splitSentences } from './text.js';
import { successfulSteps, type TranscriptStep } from './transcript.js';

export interface ExtractedItem {
  content: string;
  kind: 'semantic' | 'procedural' | 'lesson' | 'owner_model';
  entity: string | null;
  confidence: number;
  importance: number;
}

export interface Extraction {
  summary: string;
  facts: ExtractedItem[];
  lessons: ExtractedItem[];
  preferences: ExtractedItem[];
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

export interface ReviewProposal {
  kind: 'prompt' | 'skill' | 'role';
  agentId: string;
  title: string;
  rationale: string;
  change: string;
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** Lead-biased extractive summary: first sentences up to the budget. */
export function extractiveSummary(text: string, maxChars = 600): string {
  const sentences = splitSentences(text.replace(/<\/?[a-z_]+>/g, ' '));
  const out: string[] = [];
  let used = 0;
  for (const s of sentences) {
    if (used + s.length + 1 > maxChars) break;
    out.push(s);
    used += s.length + 1;
  }
  return out.length > 0 ? out.join(' ') : clip(text.trim(), maxChars);
}

const LESSON_RE = /\b(lesson(?: learned)?:|next time|note to self|should have|shouldn't have|mistake|in future|going forward|avoid\b)/i;
const PREF_RE = /\b(?:the )?(?:owner|user|client|boss) (?:prefers|wants|rejects|likes|dislikes|requires|asked|insists|never wants|always wants)\b/i;
const FACT_MARK_RE = /^(?:remember|fact|fyi|note)\s*[:-]\s*(.+)$/i;
const ENTITY_FACT_RE = /^([A-Z][\w&.-]*(?: [A-Z0-9][\w&.-]*){0,3}): (.{8,})$/;
const PROC_RE = /^(?:how to|procedure|to (?:\w+ ){1,6}[,:])/i;

function firstEntity(text: string): string | null {
  return extractEntityCandidates(text)[0] ?? null;
}

/** Rule-based reflection over a transcript: facts, lessons, preferences and a short summary. */
export function heuristicExtract(
  steps: TranscriptStep[],
  meta: { title?: string; outcome?: string; reviewOutcome?: string | null; expectedOutput?: string } = {},
): Extraction {
  const facts: ExtractedItem[] = [];
  const lessons: ExtractedItem[] = [];
  const preferences: ExtractedItem[] = [];
  const seen = new Set<string>();
  const push = (list: ExtractedItem[], item: ExtractedItem) => {
    const key = contentTokens(item.content).join(' ');
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    list.push({ ...item, content: clip(item.content, 500) });
  };

  // Lessons from tool failures, stronger when the same tool later succeeded.
  steps.forEach((s, i) => {
    if (s.kind !== 'tool_error') return;
    const name = s.name ?? 'tool';
    const laterCallIdx = steps.findIndex((t, j) => j > i && t.kind === 'tool_call' && t.name === name);
    const fixed = laterCallIdx >= 0 && steps.slice(laterCallIdx + 1).find((t) => t.name === name && t.kind !== 'tool_call')?.kind === 'tool_ok';
    const fix = fixed ? steps[laterCallIdx] : undefined;
    push(lessons, {
      kind: 'lesson',
      content: fix
        ? `${name} failed with "${clip(s.text, 160)}"; it worked with input ${clip(fix.text, 200)}.`
        : `${name} failed with "${clip(s.text, 160)}" and was not resolved in this run.`,
      entity: null,
      confidence: fix ? 0.6 : 0.4,
      importance: fix ? 0.6 : 0.4,
    });
  });

  if (meta.reviewOutcome === 'edited' || meta.reviewOutcome === 'rejected') {
    push(lessons, {
      kind: 'lesson',
      content: `Work on "${meta.title ?? 'this task'}" was ${meta.reviewOutcome} by the reviewer${meta.expectedOutput ? `; check the result against the expected output first: ${clip(meta.expectedOutput, 200)}` : '; verify the result against the request before submitting'}.`,
      entity: null,
      confidence: 0.65,
      importance: 0.7,
    });
  }

  for (const s of steps) {
    if (s.kind !== 'assistant') continue;
    for (const sentence of splitSentences(s.text)) {
      const line = sentence.replace(/^[-*•\d.)\s]+/, '').trim();
      if (line.length < 12 || line.length > 500) continue;
      const fm = FACT_MARK_RE.exec(line);
      const ef = ENTITY_FACT_RE.exec(line);
      if (PREF_RE.test(line)) {
        push(preferences, { kind: 'owner_model', content: line, entity: null, confidence: 0.55, importance: 0.6 });
      } else if (LESSON_RE.test(line)) {
        push(lessons, { kind: 'lesson', content: line.replace(/^lesson(?: learned)?:\s*/i, ''), entity: null, confidence: 0.55, importance: 0.6 });
      } else if (PROC_RE.test(line)) {
        push(facts, { kind: 'procedural', content: line.replace(/^procedure:\s*/i, ''), entity: null, confidence: 0.55, importance: 0.5 });
      } else if (fm?.[1]) {
        push(facts, { kind: 'semantic', content: fm[1], entity: firstEntity(fm[1]), confidence: 0.55, importance: 0.5 });
      } else if (ef?.[1] && ef[2]) {
        push(facts, { kind: 'semantic', content: line, entity: ef[1].toLowerCase(), confidence: 0.6, importance: 0.5 });
      }
    }
  }

  const calls = steps.filter((s) => s.kind === 'tool_call').length;
  const errors = steps.filter((s) => s.kind === 'tool_error' || s.kind === 'error').length;
  const finalText = [...steps].reverse().find((s) => s.kind === 'assistant')?.text ?? '';
  const parts = [
    meta.title ? `${meta.title}.` : '',
    finalText ? extractiveSummary(finalText, 320) : '',
    `${calls} tool call${calls === 1 ? '' : 's'}, ${errors} error${errors === 1 ? '' : 's'}${meta.outcome ? `; outcome: ${meta.outcome}` : ''}.`,
  ];
  return { summary: parts.filter(Boolean).join(' '), facts, lessons, preferences };
}

/** Distil the successful tool steps of a run into a SKILL.md body. */
export function heuristicSkillDraft(input: { title: string; taskType?: string | null; trigger?: string; steps: TranscriptStep[]; notes?: string[] }): SkillDraft {
  const name = slugify(input.taskType || input.title);
  const ok = successfulSteps(input.steps);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const s of ok) {
    const line = `Call \`${s.name}\`${s.input ? ` with ${clip(s.input, 180)}` : ''}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= 20) break;
  }
  const failures = input.steps.filter((s) => s.kind === 'tool_error').slice(0, 5);
  const description = clip(`How to handle "${input.taskType || input.title}" tasks, distilled from a completed run.`, 200);
  const body = [
    `# ${input.taskType || input.title}`,
    '',
    '## When to use',
    `Use for tasks like: ${input.title}.`,
    '',
    '## Steps',
    ...(lines.length > 0 ? lines.map((l, i) => `${i + 1}. ${l}`) : ['1. Re-read the task and its expected output, then work through it step by step.']),
    ...(failures.length > 0 ? ['', '## Pitfalls', ...failures.map((f) => `- \`${f.name ?? 'tool'}\` failed with: ${clip(f.text, 160)}`)] : []),
    ...(input.notes && input.notes.length > 0 ? ['', '## Notes', ...input.notes.map((n) => `- ${clip(n, 300)}`)] : []),
    '',
    '## Verify',
    '- Confirm the result matches the expected output before marking the task done.',
  ].join('\n');
  return { name, description, body };
}

/**
 * Guard for merging two similar texts into one: the shorter must say nothing
 * the longer does not (no differing figures/identifiers, almost no missing words),
 * so "Rule 7: vendor 7 …" never swallows "Rule 8: vendor 8 …".
 */
export function mergeable(a: string, b: string): boolean {
  const ta = new Set(contentTokens(a));
  const tb = new Set(contentTokens(b));
  const [short, long] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  const missing = [...short].filter((t) => !long.has(t));
  if (missing.some((t) => /\d/.test(t))) return false;
  return missing.length <= Math.floor(short.size * 0.15);
}

const NEGATIONS = new Set(['not', 'no', 'never', 'none', 'without', 'cannot', 'isn', 'doesn', 'don', 'won']);

/**
 * Cheap contradiction test for two facts about the same entity: they talk
 * about the same subject (shared vocabulary) yet assert different specifics.
 */
export function heuristicConflict(existing: string, incoming: string, entity: string | null): boolean {
  const entityTokens = new Set(entity ? contentTokens(entity) : []);
  const tok = (s: string) => new Set(contentTokens(s).filter((t) => !entityTokens.has(t)));
  const a = tok(existing);
  const b = tok(incoming);
  if (a.size === 0 || b.size === 0) return false;
  const overlapOf = (x: Set<string>, y: Set<string>): number =>
    x.size === 0 || y.size === 0 ? 0 : [...x].filter((t) => y.has(t)).length / Math.min(x.size, y.size);
  const differs = (x: Set<string>, y: Set<string>): boolean => [...x].some((t) => !y.has(t)) && [...y].some((t) => !x.has(t));
  const isNum = (t: string) => /^\d+$/.test(t);
  const split = (s: Set<string>) => ({ words: new Set([...s].filter((t) => !isNum(t))), nums: new Set([...s].filter(isNum)) });
  const sa = split(a);
  const sb = split(b);
  // Same wording, different figures/dates ("renewal 2027-03" vs "renewal 2028-01").
  if (sa.nums.size > 0 && sb.nums.size > 0 && overlapOf(sa.words, sb.words) >= 0.6 && differs(sa.nums, sb.nums)) return true;
  if (overlapOf(a, b) < 0.6) return false;
  const neg = (s: string) => s.toLowerCase().split(/[^a-z]+/).some((w) => NEGATIONS.has(w));
  if (neg(existing) !== neg(incoming)) return true;
  // Same subject, and each side asserts something the other does not.
  return differs(a, b);
}

/** Rule-based weekly-review proposals from scorecards. */
export function heuristicProposals(cards: Array<AgentScorecard & { agentName?: string }>): ReviewProposal[] {
  const out: ReviewProposal[] = [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  for (const c of cards) {
    if (c.runs === 0) continue;
    const who = c.agentName ?? c.agentId;
    const worst = [...c.byTaskType].filter((t) => t.runs >= 2).sort((x, y) => x.successRate - y.successRate)[0];
    if (c.successRate < 0.6) {
      out.push({
        kind: 'prompt',
        agentId: c.agentId,
        title: `Tighten ${who}'s instructions (success rate ${pct(c.successRate)})`,
        rationale: `${who} succeeded on ${pct(c.successRate)} of ${c.runs} runs in the last ${c.days} days${worst ? `; weakest task type is "${worst.taskType}" at ${pct(worst.successRate)}` : ''}.`,
        change: `Revise the agent's goal/backstory to state acceptance criteria explicitly${worst ? ` for "${worst.taskType}" work` : ''}, and add a standing rule to verify output against the issue's expected output before closing.`,
      });
    }
    if (c.reworkRate > 0.3) {
      out.push({
        kind: 'skill',
        agentId: c.agentId,
        title: `Add a review checklist skill for ${who} (rework rate ${pct(c.reworkRate)})`,
        rationale: `${pct(c.reworkRate)} of ${who}'s issues needed rework or reviewer edits.`,
        change: `Draft a skill capturing the reviewer's recurring corrections${worst ? ` for "${worst.taskType}"` : ''} and run it before moving work to review.`,
      });
    }
    const first = c.trend[0];
    const last = c.trend[c.trend.length - 1];
    if (first && last && c.trend.length >= 2 && first.costPerIssue > 0 && last.costPerIssue > first.costPerIssue * 1.5) {
      out.push({
        kind: 'role',
        agentId: c.agentId,
        title: `Narrow ${who}'s role or model (cost per issue rising)`,
        rationale: `Cost per issue rose from $${first.costPerIssue.toFixed(2)} to $${last.costPerIssue.toFixed(2)} across ${c.trend.length} weeks.`,
        change: 'Split the most expensive task type off to a specialist agent, or move routine work to a cheaper model binding.',
      });
    }
  }
  return out;
}

/**
 * Deterministically shrink a standing-rules document under a token budget:
 * drop exact/near-duplicate lines and blank runs, then drop the oldest
 * (top-most) non-heading lines. Returns what was dropped so nothing is lost.
 */
export function compactDocument(doc: string, budgetTokens: number): { doc: string; dropped: string[] } {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of doc.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    const key = contentTokens(line).join(' ') || line.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }
  const dropped: string[] = [];
  const size = () => estimateTokens(kept.join('\n'));
  while (size() > budgetTokens) {
    let idx = kept.findIndex((l) => l.trim() !== '' && !l.startsWith('#'));
    if (idx < 0) idx = kept.findIndex((l) => l.trim() !== '');
    if (idx < 0) break;
    const [line] = kept.splice(idx, 1);
    if (line && !line.startsWith('#')) dropped.push(line.replace(/^[-*•\s]+/, '').trim());
    else if (line && estimateTokens(line) > budgetTokens) kept.splice(idx, 0, line.slice(0, Math.max(0, budgetTokens * 4 - 1)));
  }
  // Headings left with no content under them carry no rule.
  const hasContentBelow = (i: number): boolean => {
    for (let j = i + 1; j < kept.length; j++) {
      const n = kept[j] ?? '';
      if (n.startsWith('#')) return false;
      if (n.trim() !== '') return true;
    }
    return false;
  };
  const out = dropped.length === 0 ? kept : kept.filter((l, i) => !l.startsWith('#') || hasContentBelow(i));
  return { doc: out.join('\n').trim(), dropped: dropped.filter((d) => d.length > 0) };
}
