import { z } from 'zod';
import type { AdapterCapabilities, AgentAdapter, Health, RunContext, RunEvent, RunResult } from '../../contracts/adapter.js';
import { AdapterError } from '../shared/errors.js';
import { parseRunEvent } from '../shared/events.js';
import { ActiveRuns, withRun } from '../shared/guard.js';
import { findExecutable, minimalEnv, runProcess } from '../shared/proc.js';
import { agentSandbox, sandboxConfigJsonSchema } from '../shared/sandbox.js';

const RESERVED_ENV = /^CONDUCTOR_(API_URL|RUN_TOKEN|RUN_ID|ISSUE_ID|MCP_URL|AGENT_ID|ORG_ID|MODEL|SYSTEM_PROMPT_FILE)$/;

const configSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Extra NON-secret environment. */
  env: z.record(z.string(), z.string()).default({}),
  /** `text`: stdout is the final answer. `jsonl`: every stdout line is a RunEvent. */
  output: z.enum(['text', 'jsonl']).default('text'),
  /** `prompt`: stdin is the task prompt. `json`: stdin is `{ systemPrompt, prompt, model, skills }`. */
  input: z.enum(['prompt', 'json']).default('prompt'),
  /** Map run secrets into the child env, e.g. { "MY_API_KEY": "apiKey" }. */
  secretEnv: z.record(z.string(), z.string()).default({}),
});
type Config = z.infer<typeof configSchema>;

export const processConfigJsonSchema: Record<string, unknown> = {
  type: 'object',
  required: ['command'],
  properties: {
    command: { type: 'string', description: 'Executable to run in the issue workspace.' },
    args: { type: 'array', items: { type: 'string' } },
    env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Non-secret environment variables.' },
    output: { type: 'string', enum: ['text', 'jsonl'], default: 'text' },
    input: { type: 'string', enum: ['prompt', 'json'], default: 'prompt' },
    secretEnv: { type: 'object', additionalProperties: { type: 'string' }, description: 'ENV_NAME -> name of a run secret.' },
    pricing: { type: 'object' },
    sandbox: sandboxConfigJsonSchema,
  },
};

function parseConfig(raw: Record<string, unknown>): Config {
  const r = configSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new AdapterError('invalid_request', `process config invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return r.data;
}

function childEnv(ctx: RunContext, cfg: Config): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.env)) if (!RESERVED_ENV.test(k)) extra[k] = v;
  for (const [envName, secretName] of Object.entries(cfg.secretEnv)) {
    const value = ctx.secrets[secretName];
    if (value !== undefined && !RESERVED_ENV.test(envName)) extra[envName] = value;
  }
  return minimalEnv({
    ...extra,
    CONDUCTOR_API_URL: ctx.apiBaseUrl,
    CONDUCTOR_RUN_TOKEN: ctx.runToken,
    CONDUCTOR_RUN_ID: ctx.runId,
    CONDUCTOR_ISSUE_ID: ctx.issueId ?? '',
    CONDUCTOR_MCP_URL: ctx.mcpEndpoints[0]?.url ?? '',
    CONDUCTOR_AGENT_ID: ctx.agentId,
    CONDUCTOR_ORG_ID: ctx.orgId,
    ...(ctx.model ? { CONDUCTOR_MODEL: ctx.model } : {}),
  });
}

/**
 * `process` — run any command as the agent. The prompt arrives on stdin and
 * the Conductor API / MCP gateway coordinates in `CONDUCTOR_*` env vars.
 * A non-zero exit code fails the run.
 */
export class ProcessAdapter implements AgentAdapter {
  readonly id = 'process';
  private readonly active = new ActiveRuns();

  capabilities(): AdapterCapabilities {
    return { tools: true, mcp: true, resume: false, vision: false, browser: 'via_mcp' };
  }

  async testConnection(cfg: { config: Record<string, unknown>; secrets: Record<string, string>; model?: string | null }): Promise<Health> {
    try {
      const config = parseConfig(cfg.config);
      const path = findExecutable(config.command);
      return path ? { ok: true, detail: `command found at ${path}` } : { ok: false, detail: `command not found or not executable: ${config.command}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  run(ctx: RunContext, onEvent: (e: RunEvent) => void): Promise<RunResult> {
    return withRun(this.active, ctx, onEvent, { metered: false }, async (env) => {
      const cfg = parseConfig(ctx.config);
      const { emit, guard, meter } = env;
      const plain: string[] = [];
      let finalText = '';
      let toolCalls = 0;
      let sessionId: string | undefined;
      let reportedError: { kind: AdapterError['kind']; message: string } | undefined;

      const onLine = (line: string): void => {
        if (cfg.output === 'text') {
          plain.push(line);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = undefined;
        }
        const event = parseRunEvent(parsed);
        if (!event) {
          emit({ type: 'status', status: `ignored non-event output line: ${line.slice(0, 200)}` });
          return;
        }
        emit(event);
        switch (event.type) {
          case 'text':
            finalText = event.text;
            break;
          case 'tool_call':
            toolCalls++;
            if (toolCalls > ctx.maxSteps) {
              emit({ type: 'status', status: `stopped: reached the step limit (${ctx.maxSteps})` });
              guard.stop('max_steps');
            }
            break;
          case 'usage':
            meter.addReported(event.tokensIn, event.tokensOut, event.costUsd);
            if (meter.overBudget()) {
              emit({ type: 'status', status: `stopped: run cost $${meter.costUsd.toFixed(4)} exceeded the budget cap` });
              guard.stop('budget');
            }
            break;
          case 'session':
            sessionId = event.sessionId;
            break;
          case 'error':
            reportedError = { kind: event.kind, message: event.message };
            break;
          default:
            break;
        }
      };

      const stdin =
        cfg.input === 'json'
          ? JSON.stringify({ systemPrompt: ctx.systemPrompt, prompt: ctx.prompt, model: ctx.model, skills: ctx.skills })
          : ctx.prompt;
      const childEnvironment = childEnv(ctx, cfg);
      const exit = await runProcess({
        command: cfg.command,
        args: cfg.args,
        cwd: ctx.workspacePath,
        env: childEnvironment,
        // An arbitrary command: workspace + temp only, no provider CLI state, no Keychain.
        sandbox: agentSandbox(ctx, emit, { env: childEnvironment }),
        stdin,
        signal: guard.signal,
        onStdoutLine: onLine,
      });

      if (cfg.output === 'text') {
        finalText = plain.join('\n').trim();
        if (finalText && !guard.reason && exit.code === 0) emit({ type: 'text', text: finalText });
      }
      const steps = Math.max(1, toolCalls);
      const base = { steps, finalText, sessionId };

      if (exit.spawnError) {
        const missing = exit.spawnError.code === 'ENOENT';
        return env.fail(new AdapterError(missing ? 'outage' : 'other', missing ? `command not found: ${cfg.command}` : exit.spawnError.message), 0, base);
      }
      if (guard.reason) return env.finish({ ...base, outcome: 'failed' });
      if (exit.code !== 0) {
        const detail = exit.stderr.trim().slice(-600);
        const message = `command exited with code ${exit.code ?? `signal ${exit.signal ?? 'unknown'}`}${detail ? `: ${detail}` : ''}`;
        if (reportedError) return env.finish({ ...base, outcome: 'failed', error: reportedError });
        return env.fail(new AdapterError('other', message), steps, base);
      }
      return env.finish({ ...base, outcome: 'completed' });
    });
  }

  async cancel(runId: string): Promise<void> {
    this.active.cancel(runId);
  }
}
