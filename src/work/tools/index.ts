import type { Kernel } from '../../contracts/kernel.js';
import type { BuiltinToolProvider, ToolCallContext, ToolResult } from '../../contracts/tools.js';
import { jsonResult, textResult } from '../../contracts/tools.js';
import { isConductorError } from '../../shared/errors.js';
import { TOOL_SPECS, isToolName, toolDefsFor, type ToolName } from './defs.js';
import { issueHandlers } from './issue-handlers.js';
import { orgHandlers } from './org-handlers.js';
import type { Handlers, TasksToolDeps, ToolEnv } from './support.js';

export type { TasksToolDeps } from './support.js';

const HANDLERS: Handlers<ToolName> = { ...issueHandlers, ...orgHandlers };

const fail = (message: string): ToolResult => textResult(message, { isError: true });

/**
 * The agent-facing API (PRD "Interfaces"): the `conductor-tasks` builtin tool
 * server. Which tools an agent sees depends on its autonomy level; every call
 * acts as `{kind:'agent', id: ctx.agentId, runId: ctx.runId}`, so the Work
 * context's actor rules and the reporting line apply. Domain failures come
 * back as `isError` results the agent can read and act on.
 */
export function createTasksToolProvider(kernel: Kernel, deps: TasksToolDeps): BuiltinToolProvider {
  const env: ToolEnv = { kernel, ...deps };
  return {
    id: 'conductor-tasks',
    description:
      'Issues, comments, goals, delegation, escalation, approvals and playbooks — how agents receive, coordinate and report work.',
    tools: (ctx: ToolCallContext) => toolDefsFor(ctx.autonomyLevel),

    async call(ctx: ToolCallContext, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
      if (!isToolName(tool)) return fail(`unknown tool: ${tool}`);
      const spec = TOOL_SPECS[tool];
      if (ctx.autonomyLevel < spec.minAutonomy) {
        return fail(`forbidden: ${tool} requires autonomy level ${spec.minAutonomy}; you are at level ${ctx.autonomyLevel}`);
      }
      const parsed = spec.schema.safeParse(args ?? {});
      if (!parsed.success) {
        const problems = parsed.error.issues
          .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
          .join('; ');
        return fail(`validation: invalid arguments for ${tool} — ${problems}`);
      }
      try {
        const handler = HANDLERS[tool] as (env: ToolEnv, ctx: ToolCallContext, args: unknown) => unknown;
        return jsonResult(await handler(env, ctx, parsed.data));
      } catch (e) {
        if (isConductorError(e)) return fail(`${e.code}: ${e.message}`);
        kernel.log.error({ err: e, tool, runId: ctx.runId }, 'conductor-tasks tool failed');
        throw e;
      }
    },
  };
}
