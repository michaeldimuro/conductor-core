import type { RunResult } from '../../contracts/adapter.js';
import type { PricedUsage } from '../pricing.js';
import { AdapterError } from './errors.js';
import type { RunEnv } from './guard.js';
import { McpToolset, outcomeToEventText, type McpTool, type ToolOutcome } from './mcp-tools.js';

/** A tool call requested by the model, using the provider-safe tool name. */
export interface ModelToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when the call must not be executed (unparseable or truncated arguments); returned to the model as an error. */
  invalid?: string;
}

/** One model request/response, normalized. */
export interface ModelTurn {
  text: string;
  thinking?: string;
  toolCalls: ModelToolCall[];
  usage: PricedUsage;
  /** Model that actually served the turn (used for pricing); defaults to the loop's model. */
  model?: string;
  /** The provider paused a turn it wants re-sent as-is (no tool results expected). */
  paused?: boolean;
  /** Informational notes surfaced as `status` events (e.g. a server-side model fallback). */
  notes?: string[];
  /** The model declined; the run fails with this message. */
  refusal?: string;
}

/** A tool result on its way back to the model. */
export interface ToolReturn extends ToolOutcome {
  callId: string;
  /** Provider-safe tool name the model used. */
  toolName: string;
}

/**
 * The provider-specific half of an agent loop. The driver owns the native
 * message history; the loop owns limits, tool execution, events and metering.
 */
export interface ToolLoopDriver {
  /** Model id used for pricing when a turn does not name one. */
  readonly model: string;
  /** Called once with the gateway tool list before the first turn. */
  start(tools: McpTool[]): void | Promise<void>;
  /**
   * Send the next request. `results` holds the outcomes of the previous
   * turn's tool calls (empty on the first turn and after a paused turn).
   * Throw `AdapterError` for provider failures.
   */
  turn(results: ToolReturn[], signal: AbortSignal): Promise<ModelTurn>;
}

/**
 * The Conductor-owned agent loop shared by the API adapters (and available to
 * plugin authors): connect to the gateway over MCP, expose its tools to the
 * model, execute the calls the model makes, and stop on completion,
 * `maxSteps`, `maxWallMs`, cancel or `budgetCapUsd`.
 *
 * One step = one model request.
 */
export async function runMcpToolLoop(env: RunEnv, driver: ToolLoopDriver): Promise<RunResult> {
  const { ctx, guard, meter, emit } = env;
  let steps = 0;
  let finalText = '';
  let toolset: McpToolset | undefined;

  try {
    toolset = await McpToolset.connect(ctx.mcpEndpoints, { signal: guard.signal });
    await driver.start(toolset.tools);
    let results: ToolReturn[] = [];

    for (;;) {
      if (guard.reason) break;
      if (steps >= ctx.maxSteps) {
        guard.stop('max_steps');
        emit({ type: 'status', status: `stopped: reached the step limit (${ctx.maxSteps})` });
        break;
      }

      const turn = await driver.turn(results, guard.signal);
      steps++;
      for (const note of turn.notes ?? []) emit({ type: 'status', status: note });
      if (turn.thinking) emit({ type: 'thinking', text: turn.thinking });
      if (turn.text) {
        finalText = turn.text;
        emit({ type: 'text', text: turn.text });
      }
      meter.add(turn.model ?? driver.model, turn.usage);

      if (turn.refusal !== undefined) {
        return env.fail(new AdapterError('other', `model declined the request: ${turn.refusal}`), steps, { finalText });
      }
      if (meter.overBudget()) {
        guard.stop('budget');
        emit({ type: 'status', status: `stopped: run cost $${meter.costUsd.toFixed(4)} exceeded the budget cap` });
        break;
      }
      if (turn.paused) {
        results = [];
        continue;
      }
      if (turn.toolCalls.length === 0) {
        return env.finish({ outcome: 'completed', finalText, steps });
      }

      results = [];
      for (const call of turn.toolCalls) {
        const tool = toolset.get(call.name);
        const displayName = tool?.originalName ?? call.name;
        emit({ type: 'tool_call', id: call.id, name: displayName, input: call.input });
        let outcome: ToolOutcome;
        if (guard.reason) {
          outcome = { name: displayName, text: 'Run stopped before this tool call was executed.', images: [], isError: true };
        } else if (call.invalid) {
          outcome = { name: displayName, text: `Tool call was not executed: ${call.invalid}`, images: [], isError: true };
        } else {
          outcome = await toolset.call(call.name, call.input, { signal: guard.signal, timeoutMs: guard.remainingMs() });
        }
        emit({ type: 'tool_result', id: call.id, name: displayName, output: outcomeToEventText(outcome), isError: outcome.isError });
        results.push({ ...outcome, callId: call.id, toolName: call.name });
      }
    }

    return env.finish({ outcome: 'failed', finalText, steps });
  } catch (e) {
    if (guard.reason) return env.finish({ outcome: 'failed', finalText, steps });
    return env.fail(e, steps, { finalText });
  } finally {
    await toolset?.close();
  }
}
