import { STOPWORDS, stem, tokenize } from './text.js';

/** Words in a task type label. */
const MAX_WORDS = 4;
const MAX_LEN = 60;
/** Token-set overlap at which two task types are the same kind of task ("a-b-c" ~ "a-b-c-d", but not "a-b-c" ~ "a-b-x"). */
export const SAME_TYPE_SIMILARITY = 0.65;

/** Words that say when, how much or how politely — never what kind of task it is. */
const NOISE: ReadonlySet<string> = new Set(
  (
    'please kindly asap urgent urgently quick quickly new latest current today tomorrow yesterday tonight daily weekly monthly quarterly yearly annual ' +
    'week month quarter year day morning january february march april may june july august september october november december ' +
    'jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday ' +
    'first second third fourth last next another again re fwd task issue ticket todo need needs needed want wants make sure'
  ).split(' '),
);

const significant = (text: string): string[] => tokenize(text).filter((t) => t.length > 1 && !/\d/.test(t) && !STOPWORDS.has(t) && !NOISE.has(t));

/** A task type as it is stored: lowercase kebab-case, at most four words. Null when nothing usable is left. */
export function normalizeTaskType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const words = [...new Set(tokenize(raw).filter((t) => t.length > 1 && !/^\d+$/.test(t) && !STOPWORDS.has(t)))].slice(0, MAX_WORDS);
  const slug = words.join('-').slice(0, MAX_LEN).replace(/-+$/, '');
  return slug.length >= 2 ? slug : null;
}

/**
 * Model-free classification: the leading content words of the title ("Export the Stripe balance
 * report for March 2026" → `export-stripe-balance-report`), falling back to the issue's labels.
 */
export function heuristicTaskType(title: string | null | undefined, labels: readonly string[] = []): string | null {
  const fromTitle = [...new Set(significant(title ?? ''))].slice(0, MAX_WORDS);
  if (fromTitle.length >= 2) return normalizeTaskType(fromTitle.join(' '));
  // Machine labels ("skill:skl_…") carry ids, not a kind of task.
  const fromLabels = [...new Set(labels.filter((l) => !l.includes(':')).flatMap(significant))].slice(0, MAX_WORDS);
  return normalizeTaskType([...fromTitle, ...fromLabels].join(' '));
}

const stems = (type: string): Set<string> => new Set(tokenize(type).filter((t) => !/^\d+$/.test(t) && !STOPWORDS.has(t)).map(stem));

/** Jaccard overlap of the stemmed words of two task types (0..1). */
export function taskTypeSimilarity(a: string, b: string): number {
  const sa = stems(a);
  const sb = stems(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.size + sb.size - shared);
}

export const sameTaskType = (a: string, b: string): boolean => a === b || taskTypeSimilarity(a, b) >= SAME_TYPE_SIMILARITY;

/**
 * Snap a freshly classified type onto the org's vocabulary: the most similar known type wins
 * (ties go to the one used more often), so "export-stripe-report" and "stripe-report-export"
 * count as one repeated task instead of two one-offs. `known` is ordered most-used first.
 */
export function canonicalTaskType(candidate: string, known: readonly string[]): string {
  let best: { type: string; score: number } | null = null;
  for (const type of known) {
    const score = type === candidate ? 1 : taskTypeSimilarity(candidate, type);
    if (score >= SAME_TYPE_SIMILARITY && (!best || score > best.score)) best = { type, score };
  }
  return best?.type ?? candidate;
}

/** The members of `known` that are the same kind of task as `type` (always includes `type` itself). */
export function taskTypeCluster(type: string, known: readonly string[]): string[] {
  return [...new Set([type, ...known.filter((k) => sameTaskType(type, k))])];
}
