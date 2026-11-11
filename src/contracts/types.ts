/**
 * Shared value types used by the schema and across bounded contexts.
 * This file must not import from src/db (the schema imports it).
 */

/** A provider binding: which adapter + model runs an agent, with an optional fallback chain. */
export interface ProviderBinding {
  /** Adapter id: claude_local | codex_local | claude_api | openai_api | process | http | <plugin id>. */
  adapter: string;
  model?: string;
  /** Adapter-specific, non-secret config (validated against the adapter's config schema). */
  config?: Record<string, unknown>;
  /** Secret-store reference for the API key, when the adapter needs one. */
  authRef?: string;
  /** Tried in order on rate limit, auth failure or outage. */
  fallback?: Array<Omit<ProviderBinding, 'fallback'>>;
}

export type ToolPolicy = 'allowed' | 'ask' | 'off';

/** Action types that are approval-gated by default (PRD "Approvals"). */
export const DEFAULT_GATED_ACTIONS = [
  'hire_agent',
  'terminate_agent',
  'budget_raise',
  'payment',
  'external_send',
  'publish',
  'grant_connector',
  'grant_skill',
  'promote_skill',
] as const;
export type GatedAction = (typeof DEFAULT_GATED_ACTIONS)[number];

export interface OrgPolicies {
  /**
   * Explicit owner toggles loosening a default gate: action -> false means
   * "do not require approval". Absent = default (gated).
   */
  approvalOverrides?: Partial<Record<GatedAction, boolean>>;
  /** Extra action kinds this org additionally gates (tightening). */
  extraGated?: string[];
  /** Spend above this (USD, single action) always needs approval. */
  approvalSpendThresholdUsd?: number;
  /** Skill promotion to department scope: 'lead' (lead-reviewed, default) or 'auto' on eval win. */
  deptSkillPromotion?: 'lead' | 'auto';
  /** Whether org/global skill promotion needs owner approval (default true). */
  ownerApprovesOrgSkillPromotion?: boolean;
  /** Default network allowlist for sandboxed shell tools. */
  networkAllowlist?: string[];
  /** Preferred toolkit source when both offer the same app. */
  toolkitDefault?: 'composio' | 'arcade';
}

/** Effective capabilities resolved at run start and snapshotted onto the Run for audit. */
export interface CapabilitySnapshot {
  resolvedAt: number;
  skills: Array<{ id: string; name: string; scope: string; version: number; contentHash: string }>;
  connectors: Array<{ id: string; name: string; kind: string; scope: string; tools: string[] | null }>;
  budget: { remainingUsd: number | null; capUsd: number | null; tightestScope: string | null };
  autonomyLevel: number;
  provider: { adapter: string; model: string | null };
}

/** Outcome grading written by the reflection pass. */
export interface RunGrade {
  issueClosed: boolean;
  reviewOutcome: 'accepted' | 'edited' | 'rejected' | 'pending' | null;
  /** cost / median cost for this task type (1 = median). */
  costVsMedian: number | null;
  success: boolean;
  notes?: string;
}

export interface SkillEvalResult {
  ranAt: number;
  baseline: EvalMetrics;
  withSkill: EvalMetrics;
  /** withSkill beats baseline. */
  passed: boolean;
  score: number;
  notes?: string;
}

export interface EvalMetrics {
  success: boolean;
  steps: number;
  tokens: number;
  costUsd: number;
  wallMs: number;
}

/** Who is performing an action. The Owner is `{kind:'human', id:'owner'}`. */
export interface Actor {
  kind: 'human' | 'agent' | 'system';
  id?: string;
  /** Present when an agent acts inside a run. */
  runId?: string;
}

export const OWNER: Actor = { kind: 'human', id: 'owner' };
export const SYSTEM: Actor = { kind: 'system', id: 'conductor' };

export const AUTONOMY = { ASSIST: 0, SUPERVISED: 1, AUTONOMOUS: 2, LEAD: 3 } as const;
