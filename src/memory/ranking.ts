import type { Memory } from '../contracts/rows.js';
import type { ScoredMemory } from '../contracts/services.js';
import { clamp01 } from './text.js';

/** Recency half-life: a memory unused for this long counts half as much. */
export const RECENCY_HALF_LIFE_MS = 30 * 86_400_000;
/** Blend weights for the normalised similarity term. */
export const VECTOR_WEIGHT = 0.7;
export const KEYWORD_WEIGHT = 0.3;
/** Below this cosine (and with no keyword hit) a memory is considered unrelated. */
export const SIMILARITY_FLOOR = 0.12;
/** Write-time near-duplicate threshold (same scope + kind). */
export const MERGE_THRESHOLD = 0.9;
/** Texts this close are the same statement regardless of kind. */
export const IDENTICAL_THRESHOLD = 0.985;
/** Minimum similarity for two same-entity facts to be compared for contradiction. */
export const CONFLICT_MIN_SIMILARITY = 0.3;
/** Confidence below this lands in the review queue instead of memory. */
export const REVIEW_CONFIDENCE = 0.5;
/** Token budget of the always-on profile (role card + MEMORY.md). */
export const PROFILE_TOKEN_BUDGET = 2000;

/** Exponential decay on `last_used_at ?? created_at`; pinned memories never decay. */
export function recencyDecay(memory: Pick<Memory, 'pinned' | 'lastUsedAt' | 'createdAt'>, now: number): number {
  if (memory.pinned) return 1;
  const age = Math.max(0, now - (memory.lastUsedAt ?? memory.createdAt));
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

/**
 * Normalised blend of vector cosine and FTS5 bm25. `keyword` is the hit's
 * positive bm25 relevance and `maxKeyword` the best one in the result set.
 */
export function blendSimilarity(cosine: number | undefined, keyword: number | undefined, maxKeyword: number): number {
  const vec = clamp01(cosine ?? 0);
  const kw = keyword !== undefined && maxKeyword > 0 ? clamp01(keyword / maxKeyword) : 0;
  return clamp01(VECTOR_WEIGHT * vec + KEYWORD_WEIGHT * kw);
}

/** similarity × recency decay × importance × confidence (CrewAI-style). */
export function scoreMemory(memory: Memory, similarity: number, now: number): ScoredMemory {
  const score = similarity * recencyDecay(memory, now) * clamp01(memory.importance) * clamp01(memory.confidence);
  return { memory, score, similarity };
}

export const byScore = (a: ScoredMemory, b: ScoredMemory): number => b.score - a.score || b.memory.createdAt - a.memory.createdAt;
