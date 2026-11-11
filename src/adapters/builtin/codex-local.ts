import { z } from 'zod';
import type { AdapterCapabilities, AgentAdapter, Health, RunContext, RunEvent, RunResult } from '../../contracts/adapter.js';
import { AdapterError, kindFromMessage } from '../shared/errors.js';
import { ActiveRuns, withRun, type RunEnv } from '../shared/guard.js';
import { minimalEnv, probeCommand, runJsonLines } from '../shared/proc.js';
import { writeAgentsSkills } from '../shared/skills.js';

const configSchema = z.object({
  /** CLI binary (name on PATH or absolute path). */
  command: z.string().min(1).default('codex'),
  /** Sandbox for model-generated shell commands. */
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
  /**
   * Gateway MCP tool calls are pre-approved in Codex because the Conductor
   * gateway enforces the real policy (Allowed / Ask first / Off) per call.
   */
  mcpToolApproval: z.enum(['approve', 'prompt', 'auto']).default('approve'),
  skipGitRepoCheck: z.boolean().default(true),
  /** Explicit opt-in to `--dangerously-bypass-approvals-and-sandbox`. Never the default. */
  dangerouslyBypassApprovalsAndSandbox: z.boolean().default(false),
  reasoningEffort: z.string().min(1).optional(),
  extraArgs: z.array(z.string()).default([]),
  /** Extra NON-secret environment for the CLI. */
  env: z.record(z.string(), z.string()).default({}),
});
type Config = z.infer<typeof configSchema>;

export const codexLocalConfigJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    command: { type: 'string', default: 'codex' },
    sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], default: 'workspace-write' },
    mcpToolApproval: { type: 'string', enum: ['approve', 'prompt', 'auto'], default: 'approve' },
    skipGitRepoCheck: { type: 'boolean', default: true },
    dangerouslyBypassApprovalsAndSandbox: { type: 'boolean', default: false },
    reasoningEffort: { type: 'string' },
    extraArgs: { type: 'array', items: { type: 'string' } },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    pricing: { type: 'object' },
  },
};

function parseConfig(raw: Record<string, unknown>): Config {
  const r = configSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new AdapterError('invalid_request', `codex_local config invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return r.data;
}

/** A TOML basic string (JSON string escaping is a subset of TOML's). */
const toml = (s: string): string => JSON.stringify(s);
const serverName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_') || 'conductor';

/**
 * Per-run MCP injection through `-c` overrides, so the user's real
 * `~/.codex` (config + auth) is never written. Credentials do not appear in
 * argv or on disk: each header value travels in the child's environment and
 * the override only names the variable.
 */
export function buildCodexMcpOverrides(ctx: Pick<RunContext, 'mcpEndpoints'>, approval: Config['mcpToolApproval']): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  ctx.mcpEndpoints.forEach((ep, i) => {
    const key = `mcp_servers.${serverName(ep.name)}`;
    args.push('-c', `${key}.url=${toml(ep.url)}`);
    const envHeaders: string[] = [];
    let j = 0;
    for (const [header, value] of Object.entries(ep.headers)) {
      const bearer = /^Bearer\s+(.+)$/i.exec(value);
      if (header.toLowerCase() === 'authorization' && bearer?.[1]) {
        const name = `CONDUCTOR_MCP_BEARER_${i}`;
        env[name] = bearer[1];
        args.push('-c', `${key}.bearer_token_env_var=${toml(name)}`);
      } else {
        const name = `CONDUCTOR_MCP_HEADER_${i}_${j++}`;
        env[name] = value;
        envHeaders.push(`${toml(header)}=${toml(name)}`);
      }
    }
    if (envHeaders.length > 0) args.push('-c', `${key}.env_http_headers={${envHeaders.join(',')}}`);
    args.push('-c', `${key}.default_tools_approval_mode=${toml(approval)}`);
  });
  return { args, env };
}

export function buildCodexArgs(ctx: RunContext, cfg: Config, mcpArgs: string[]): string[] {
  const args = ['exec'];
  if (ctx.resumeSessionId) args.push('resume');
  args.push('--json');
  if (cfg.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (ctx.model) args.push('-m', ctx.model);
  if (cfg.dangerouslyBypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('-c', `sandbox_mode=${toml(cfg.sandbox)}`);
  if (cfg.reasoningEffort) args.push('-c', `model_reasoning_effort=${toml(cfg.reasoningEffort)}`);
  args.push(...mcpArgs, ...cfg.extraArgs);
  if (ctx.resumeSessionId) args.push(ctx.resumeSessionId);
  // "-" = read the prompt from stdin (keeps it out of argv).
  args.push('-');
  return args;
}

/** Codex has no system-prompt flag, so a fresh session gets the operating instructions ahead of the task. */
export function buildCodexPrompt(ctx: Pick<RunContext, 'systemPrompt' | 'prompt' | 'resumeSessionId'>): string {
  if (ctx.resumeSessionId || !ctx.systemPrompt) return ctx.prompt;
  return `# Operating instructions\n\n${ctx.systemPrompt}\n\n# Task\n\n${ctx.prompt}`;
}

interface StreamState {
  sessionId?: string;
  finalText: string;
  steps: number;
  started: Set<string>;
  turnCompleted: boolean;
  failure?: string;
  lastError?: string;
}

const TOOL_ITEMS = new Set(['command_execution', 'mcp_tool_call', 'file_change', 'web_search', 'collab_tool_call']);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toolCallOf(item: Record<string, unknown>): { name: string; input: unknown } {
  switch (item.type) {
    case 'command_execution':
      return { name: 'shell', input: { command: item.command } };
    case 'mcp_tool_call':
      return { name: str(item.tool) || 'mcp_tool', input: item.arguments ?? {} };
    case 'file_change':
      return { name: 'apply_patch', input: { changes: item.changes ?? [] } };
    case 'web_search':
      return { name: 'web_search', input: { query: item.query } };
    default:
      return { name: str(item.type) || 'tool', input: {} };
  }
}

function toolResultOf(item: Record<string, unknown>): { output: string; isError: boolean } {
  const failed = item.status === 'failed';
  switch (item.type) {
    case 'command_execution': {
      const code = typeof item.exit_code === 'number' ? item.exit_code : null;
      return { output: str(item.aggregated_output), isError: failed || (code !== null && code !== 0) };
    }
    case 'mcp_tool_call': {
      const error = obj(item.error);
      if (error) return { output: str(error.message) || 'tool call failed', isError: true };
      const result = obj(item.result);
      const content = Array.isArray(result?.content) ? (result?.content as unknown[]) : [];
      const text = content
        .map((c) => {
          const block = obj(c);
          return block?.type === 'text' ? str(block.text) : block ? `[${str(block.type)} content]` : '';
        })
        .filter(Boolean)
        .join('\n');
      return { output: text || (result?.structured_content !== undefined ? JSON.stringify(result.structured_content) : ''), isError: failed };
    }
    case 'file_change':
      return { output: failed ? 'patch failed' : 'patch applied', isError: failed };
    default:
      return { output: '', isError: failed };
  }
}

function handleEvent(msg: Record<string, unknown>, st: StreamState, env: RunEnv, model: string | null, metered: boolean): void {
  const { emit, ctx } = env;
  switch (msg.type) {
    case 'thread.started': {
      const id = str(msg.thread_id);
      if (id) {
        st.sessionId = id;
        emit({ type: 'session', sessionId: id });
      }
      return;
    }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = obj(msg.item);
      if (!item) return;
      const id = str(item.id) || `item_${st.started.size}`;
      const isTool = TOOL_ITEMS.has(str(item.type));
      if (isTool && !st.started.has(id)) {
        st.started.add(id);
        st.steps++;
        emit({ type: 'tool_call', id, ...toolCallOf(item) });
        if (st.steps > ctx.maxSteps) {
          emit({ type: 'status', status: `stopped: reached the step limit (${ctx.maxSteps})` });
          env.guard.stop('max_steps');
        }
      }
      if (msg.type !== 'item.completed') return;
      if (isTool) {
        emit({ type: 'tool_result', id, name: toolCallOf(item).name, ...toolResultOf(item) });
      } else if (item.type === 'agent_message') {
        const text = str(item.text);
        if (text) {
          st.finalText = text;
          emit({ type: 'text', text });
        }
      } else if (item.type === 'reasoning') {
        const text = str(item.text);
        if (text) emit({ type: 'thinking', text });
      } else if (item.type === 'error') {
        st.lastError = str(item.message) || st.lastError;
        emit({ type: 'status', status: `codex: ${str(item.message)}` });
      }
      return;
    }
    case 'turn.completed': {
      st.turnCompleted = true;
      const u = obj(msg.usage) ?? {};
      const cached = num(u.cached_input_tokens);
      env.meter.add(
        model,
        { inputTokens: Math.max(0, num(u.input_tokens) - cached), outputTokens: num(u.output_tokens), cacheReadTokens: cached },
        metered ? {} : { costUsd: 0 },
      );
      if (metered && env.meter.overBudget()) {
        emit({ type: 'status', status: `stopped: run cost $${env.meter.costUsd.toFixed(4)} exceeded the budget cap` });
        env.guard.stop('budget');
      }
      return;
    }
    case 'turn.failed': {
      st.failure = str(obj(msg.error)?.message) || 'codex turn failed';
      return;
    }
    case 'error': {
      // Also used for transient notices ("Reconnecting… 2/5"); only fatal if the turn then fails.
      st.lastError = str(msg.message) || st.lastError;
      emit({ type: 'status', status: `codex: ${str(msg.message)}` });
      return;
    }
    default:
      return;
  }
}

/**
 * `codex_local` — Codex CLI (`codex exec --json`) owns the inner loop in the
 * issue workspace. MCP servers are injected per run with `-c` overrides,
 * skills as a managed block in the workspace AGENTS.md.
 */
export class CodexLocalAdapter implements AgentAdapter {
  readonly id = 'codex_local';
  private readonly active = new ActiveRuns();

  capabilities(): AdapterCapabilities {
    return { tools: true, mcp: true, resume: true, vision: true, browser: 'via_mcp' };
  }

  async testConnection(cfg: { config: Record<string, unknown>; secrets: Record<string, string>; model?: string | null }): Promise<Health> {
    try {
      const config = parseConfig(cfg.config);
      const probe = await probeCommand(config.command, ['--version']);
      if (!probe.ok) return { ok: false, detail: probe.error ?? 'codex CLI is not available' };
      return {
        ok: true,
        version: probe.output.split('\n')[0]?.trim() ?? '',
        detail: cfg.secrets.apiKey ? 'CLI present; runs are metered on the bound API key' : 'CLI present; runs use the local ChatGPT/Codex login (subscription)',
      };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  run(ctx: RunContext, onEvent: (e: RunEvent) => void): Promise<RunResult> {
    const metered = Boolean(ctx.secrets.apiKey);
    return withRun(this.active, ctx, onEvent, { metered }, async (env) => {
      const cfg = parseConfig(ctx.config);
      for (const w of writeAgentsSkills(ctx.workspacePath, ctx.skills)) env.emit({ type: 'status', status: w });

      const mcp = buildCodexMcpOverrides(ctx, cfg.mcpToolApproval);
      const st: StreamState = { finalText: '', steps: 0, started: new Set(), turnCompleted: false };
      const exit = await runJsonLines({
        command: cfg.command,
        args: buildCodexArgs(ctx, cfg, mcp.args),
        cwd: ctx.workspacePath,
        env: minimalEnv(
          { ...cfg.env, ...mcp.env, ...(metered ? { CODEX_API_KEY: ctx.secrets.apiKey, OPENAI_API_KEY: ctx.secrets.apiKey } : {}) },
          // The user's own CODEX_HOME (auth + sessions) is respected, never replaced.
          ['CODEX_HOME'],
        ),
        stdin: buildCodexPrompt(ctx),
        signal: env.guard.signal,
        onJson: (msg) => handleEvent(msg, st, env, ctx.model, metered),
      });

      const steps = Math.max(st.steps, st.turnCompleted ? 1 : 0);
      const base = { steps, sessionId: st.sessionId, subscription: !metered, seatSeconds: metered ? 0 : env.guard.elapsedSeconds(), finalText: st.finalText };
      if (exit.spawnError) {
        const missing = exit.spawnError.code === 'ENOENT';
        return env.fail(new AdapterError(missing ? 'outage' : 'other', missing ? `codex CLI not found: ${cfg.command}` : exit.spawnError.message), steps, base);
      }
      if (env.guard.reason) return env.finish({ ...base, outcome: 'failed' });
      if (st.failure || exit.code !== 0 || !st.turnCompleted) {
        const detail = st.failure ?? st.lastError ?? (exit.stderr.trim().slice(-600) || `codex exited with code ${exit.code ?? 'unknown'}`);
        return env.fail(new AdapterError(kindFromMessage(detail), detail), steps, base);
      }
      return env.finish({ ...base, outcome: 'completed' });
    });
  }

  async cancel(runId: string): Promise<void> {
    this.active.cancel(runId);
  }
}
