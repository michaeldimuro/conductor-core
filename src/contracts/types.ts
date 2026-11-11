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
  /** Secret-store reference for the API key (or, with `auth: 'token'`, the long-lived CLI token). */
  authRef?: string;
  /**
   * Local CLI adapters only: `login` (default) uses the CLI's own login on this Mac; `token` a stored
   * long-lived Claude token; `api_key` a stored API key (metered). See contracts/providers.ts.
   */
  auth?: 'login' | 'token' | 'api_key';
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
  /**
   * Hours a pending approval stays actionable before it expires (default 72).
   * 0 disables the default expiry; a requester's explicit `expiresAt` always wins.
   */
  approvalExpiryHours?: number;
  /**
   * Hours an APPROVED single-use grant (an approval carrying a `matchKey`) stays usable before it
   * lapses unused (default 72). 0 = an approved grant never lapses.
   */
  approvalUseWithinHours?: number;
  /**
   * Replays per arm and case in the skill eval gate (default 2, capped at 5). More samples make
   * the verdict steadier and the evaluation proportionally more expensive.
   */
  skillEvalSamples?: number;
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
  /**
   * The evaluation could not be decided (a check that cannot be verified, or the judge gave no
   * usable verdict). `passed` is false, but this is "needs human review", not a failed skill.
   */
  needsReview?: boolean;
  /** Replays per arm and case; the metrics are sums over cases of the per-case medians. */
  samples?: number;
  /** Share of samples that succeeded in each arm (0..1). */
  successRate?: { baseline: number; withSkill: number };
  /** True when this evaluated a pending candidate version against the live version (not against "no skill"). */
  candidate?: boolean;
}

/** Deterministic expectations of an eval case, checked without a model. */
export interface EvalExpectations {
  /** Strings the final answer must contain (case-insensitive). */
  contains?: string[];
  /** Strings the final answer must NOT contain (case-insensitive). */
  notContains?: string[];
  /** Regular expressions (`/source/flags` or a bare source) the final answer must match. */
  regex?: string[];
  /** Workspace-relative files the run must leave behind in its sandbox. */
  files?: string[];
}

/** A stored eval case of a skill, decoded. */
export interface SkillEvalCase {
  id: string;
  skillId: string;
  /** `issue` — replay of an issue; `folder` — from the skill's `evals/cases.*`; `manual` — added through the service. */
  source: 'issue' | 'folder' | 'manual';
  issueId: string | null;
  prompt: string;
  /** Natural-language success criteria (judged by the utility model when one is configured). */
  criteria: string;
  expect: EvalExpectations;
  createdAt: number;
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
