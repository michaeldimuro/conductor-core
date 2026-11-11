/**
 * Public surface for third-party adapter authors.
 *
 * An adapter plugin is a folder in `~/.conductor/adapters/<pkg>/` containing a
 * `conductor-adapter.json` manifest (`AdapterManifest`) whose `entry` is an ES
 * module that default-exports an `AgentAdapter` (or a function returning one):
 *
 *   import { defineAdapter } from 'conductor/adapters/sdk';
 *   export default defineAdapter({ id: 'my_agent', capabilities() {...}, ... });
 *
 * Adapters receive a serializable `RunContext`, reach tools only through
 * `ctx.mcpEndpoints`, and must resolve `run()` with a `RunResult`.
 */
import type { AgentAdapter } from '../contracts/adapter.js';

export type {
  AdapterCapabilities,
  AdapterErrorKind,
  AdapterManifest,
  AdapterRegistry,
  AgentAdapter,
  Health,
  McpEndpoint,
  ResolvedSkillRef,
  RunContext,
  RunEvent,
  RunOutcome,
  RunResult,
  RunUsage,
} from '../contracts/adapter.js';

/** Identity helper that gives adapter objects full type checking. */
export function defineAdapter<T extends AgentAdapter>(adapter: T): T {
  return adapter;
}

export { AdapterError, FALLBACK_KINDS, isRetryable, kindFromMessage, kindFromStatus, toAdapterError } from './shared/errors.js';
export { createScrubber, parseRunEvent, runEventSchema, secretValuesOf, type Scrubber } from './shared/events.js';
export { ActiveRuns, RunGuard, UsageMeter, withRun, type FinishInput, type RunEnv, type StopReason, type WithRunOptions } from './shared/guard.js';
export { McpToolset, outcomeToEventText, sanitizeToolName, type McpTool, type ToolImage, type ToolOutcome } from './shared/mcp-tools.js';
export { runMcpToolLoop, type ModelToolCall, type ModelTurn, type ToolLoopDriver, type ToolReturn } from './shared/tool-loop.js';
export { findExecutable, minimalEnv, probeCommand, runJsonLines, runProcess, type ProcessExit, type ProcessOptions } from './shared/proc.js';
export { AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END, installClaudeSkills, renderAgentsSkillsBlock, writeAgentsSkills } from './shared/skills.js';
export { PRICE_TABLE, findPrice, parsePricingOverrides, priceFor, type ModelPrice, type PricedUsage, type PricingOverrides } from './pricing.js';
export { MANIFEST_FILE, adapterManifestSchema } from './registry.js';
