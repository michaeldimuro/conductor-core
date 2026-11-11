import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AdapterCapabilities, AgentAdapter, AdapterErrorKind, Health, RunContext, RunEvent, RunResult } from '../../contracts/adapter.js';
import type { PricedUsage } from '../pricing.js';
import { AdapterError, kindFromMessage, kindFromStatus } from '../shared/errors.js';
import { ActiveRuns, withRun, type RunEnv } from '../shared/guard.js';
import { CLI_MCP_STARTUP_TIMEOUT_MS, cliToolTimeoutMs } from '../shared/mcp-tools.js';
import { minimalEnv, probeCommand, runJsonLines } from '../shared/proc.js';
import { agentSandbox, RUN_TMP_PREFIX, sandboxConfigJsonSchema } from '../shared/sandbox.js';
import { installClaudeSkills } from '../shared/skills.js';

/** Workspace file tools + skill loading. Shell and network tools are NOT allowed unless the binding adds them. */
export const CLAUDE_LOCAL_DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS', 'TodoWrite', 'Skill'];

const configSchema = z.object({
  /** CLI binary (name on PATH or absolute path). */
  command: z.string().min(1).default('claude'),
  permissionMode: z.enum(['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan']).default('acceptEdits'),
  /** Replaces the default allow list (gateway MCP servers are always allowed). */
  allowedTools: z.array(z.string().min(1)).optional(),
  /** Added to the allow list, e.g. ["Bash(git *)"]. */
  extraAllowedTools: z.array(z.string().min(1)).default([]),
  disallowedTools: z.array(z.string().min(1)).default([]),
  /** Only the generated gateway MCP config is loaded; the user's own MCP servers stay out of agent runs. */
  strictMcpConfig: z.boolean().default(true),
  /** Explicit opt-in to `--dangerously-skip-permissions`. Never the default. */
  dangerouslySkipPermissions: z.boolean().default(false),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  extraArgs: z.array(z.string()).default([]),
  /** Extra NON-secret environment for the CLI. */
  env: z.record(z.string(), z.string()).default({}),
});
type Config = z.infer<typeof configSchema>;

export const claudeLocalConfigJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    command: { type: 'string', default: 'claude' },
    permissionMode: { type: 'string', enum: ['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan'], default: 'acceptEdits' },
    allowedTools: { type: 'array', items: { type: 'string' }, description: 'Replaces the default workspace file tools.' },
    extraAllowedTools: { type: 'array', items: { type: 'string' } },
    disallowedTools: { type: 'array', items: { type: 'string' } },
    strictMcpConfig: { type: 'boolean', default: true },
    dangerouslySkipPermissions: { type: 'boolean', default: false },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    extraArgs: { type: 'array', items: { type: 'string' } },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    pricing: { type: 'object' },
    sandbox: sandboxConfigJsonSchema,
  },
};

function parseConfig(raw: Record<string, unknown>): Config {
  const r = configSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new AdapterError('invalid_request', `claude_local config invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return r.data;
}

const serverName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_') || 'conductor';

/** `--mcp-config` payload pointing Claude Code at the gateway (http transport + run-token headers). */
export function buildClaudeMcpConfig(ctx: Pick<RunContext, 'mcpEndpoints'>): { mcpServers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }> } {
  const mcpServers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }> = {};
  for (const ep of ctx.mcpEndpoints) mcpServers[serverName(ep.name)] = { type: 'http', url: ep.url, headers: { ...ep.headers } };
  return { mcpServers };
}

/**
 * Claude Code's MCP timeouts are environment variables (milliseconds): `MCP_TIMEOUT` for server
 * startup, `MCP_TOOL_TIMEOUT` for one tool call. A gateway call can wait on a human (request_human,
 * takeover) far longer than the CLI's default, so the tool timeout covers the run's wall time plus
 * a takeover allowance. Adapter `env` config can override both.
 */
export function claudeMcpEnv(ctx: Pick<RunContext, 'maxWallMs'>): Record<string, string> {
  return { MCP_TIMEOUT: String(CLI_MCP_STARTUP_TIMEOUT_MS), MCP_TOOL_TIMEOUT: String(cliToolTimeoutMs(ctx.maxWallMs)) };
}

/**
 * Credentials for the child: a bound API key (metered) wins over a long-lived subscription token
 * (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`); with neither, the CLI uses its own login.
 */
export function claudeAuthEnv(secrets: Record<string, string>): Record<string, string> {
  if (secrets.apiKey) return { ANTHROPIC_API_KEY: secrets.apiKey };
  if (secrets.oauthToken) return { CLAUDE_CODE_OAUTH_TOKEN: secrets.oauthToken };
  return {};
}

export function buildClaudeArgs(ctx: RunContext, cfg: Config, mcpConfigPath: string, metered: boolean): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--mcp-config', mcpConfigPath];
  if (cfg.strictMcpConfig) args.push('--strict-mcp-config');
  if (ctx.systemPrompt) args.push('--append-system-prompt', ctx.systemPrompt);
  if (ctx.resumeSessionId) args.push('--resume', ctx.resumeSessionId);
  if (ctx.model) args.push('--model', ctx.model);
  if (cfg.effort) args.push('--effort', cfg.effort);
  args.push('--max-turns', String(Math.max(1, Math.floor(ctx.maxSteps))));
  if (metered && ctx.budgetCapUsd !== null) args.push('--max-budget-usd', String(ctx.budgetCapUsd));
  if (cfg.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  } else {
    const allowed = [...ctx.mcpEndpoints.map((ep) => `mcp__${serverName(ep.name)}`), ...(cfg.allowedTools ?? CLAUDE_LOCAL_DEFAULT_TOOLS), ...cfg.extraAllowedTools];
    args.push('--permission-mode', cfg.permissionMode, '--allowedTools', [...new Set(allowed)].join(','));
  }
  if (cfg.disallowedTools.length > 0) args.push('--disallowedTools', cfg.disallowedTools.join(','));
  args.push(...cfg.extraArgs);
  return args;
}

interface StreamState {
  sessionId?: string;
  model: string | null;
  finalText: string;
  lastText: string;
  turns: number;
  toolNames: Map<string, string>;
  /** Latest usage per assistant message id (the CLI repeats it on every content block of a message). */
  perMessage: Map<string, PricedUsage>;
  result?: Record<string, unknown>;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function usageOf(raw: unknown): PricedUsage {
  const u = obj(raw) ?? {};
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      const block = obj(c);
      if (!block) return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return typeof block.type === 'string' ? `[${block.type} content]` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Translate one stream-json line into RunEvents. */
function handleLine(msg: Record<string, unknown>, st: StreamState, env: RunEnv, metered: boolean): void {
  const { emit } = env;
  if (typeof msg.session_id === 'string' && msg.session_id !== st.sessionId) {
    st.sessionId = msg.session_id;
    emit({ type: 'session', sessionId: msg.session_id });
  }
  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        if (typeof msg.model === 'string') st.model = msg.model;
        emit({ type: 'status', status: `claude session started${st.model ? ` (model ${st.model})` : ''}` });
      }
      return;
    }
    case 'assistant': {
      const message = obj(msg.message);
      if (!message) return;
      if (typeof message.model === 'string') st.model = message.model;
      const id = typeof message.id === 'string' ? message.id : `m${st.perMessage.size}`;
      if (!st.perMessage.has(id)) st.turns++;
      st.perMessage.set(id, usageOf(message.usage));
      for (const raw of Array.isArray(message.content) ? message.content : []) {
        const block = obj(raw);
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          st.lastText = block.text;
          emit({ type: 'text', text: block.text });
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          emit({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          st.toolNames.set(block.id, block.name);
          emit({ type: 'tool_call', id: block.id, name: block.name, input: block.input ?? {} });
        }
      }
      if (metered) {
        let estimate = 0;
        for (const u of st.perMessage.values()) estimate += env.meter.estimate(st.model, u);
        if (env.meter.overBudget(estimate)) {
          emit({ type: 'status', status: `stopped: estimated cost $${estimate.toFixed(4)} exceeded the budget cap` });
          env.guard.stop('budget');
        }
      }
      return;
    }
    case 'user': {
      const message = obj(msg.message);
      for (const raw of Array.isArray(message?.content) ? (message?.content as unknown[]) : []) {
        const block = obj(raw);
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        emit({
          type: 'tool_result',
          id: block.tool_use_id,
          name: st.toolNames.get(block.tool_use_id) ?? 'tool',
          output: toolResultText(block.content),
          isError: block.is_error === true,
        });
      }
      return;
    }
    case 'result': {
      st.result = msg;
      if (typeof msg.result === 'string') st.finalText = msg.result;
      return;
    }
    default:
      return;
  }
}

function classifyResultError(result: Record<string, unknown>, text: string): AdapterErrorKind {
  if (typeof result.api_error_status === 'number') return kindFromStatus(result.api_error_status);
  return kindFromMessage(text);
}

/**
 * `claude_local` — Claude Code (`claude -p`) owns the inner loop in the
 * issue workspace; Conductor injects skills, the gateway MCP config and the
 * prompt, and parses the stream-json output.
 */
export class ClaudeLocalAdapter implements AgentAdapter {
  readonly id = 'claude_local';
  private readonly active = new ActiveRuns();

  capabilities(): AdapterCapabilities {
    return { tools: true, mcp: true, resume: true, vision: true, browser: 'via_mcp' };
  }

  async testConnection(cfg: { config: Record<string, unknown>; secrets: Record<string, string>; model?: string | null }): Promise<Health> {
    try {
      const config = parseConfig(cfg.config);
      const probe = await probeCommand(config.command, ['--version']);
      if (!probe.ok) return { ok: false, detail: probe.error ?? 'claude CLI is not available' };
      const version = probe.output.split('\n')[0]?.trim() ?? '';
      return {
        ok: true,
        version,
        detail: cfg.secrets.apiKey
          ? 'CLI present; runs are metered on the bound API key'
          : cfg.secrets.oauthToken
            ? 'CLI present; runs use the stored long-lived Claude token (subscription)'
            : 'CLI present; runs use the local Claude login (subscription)',
      };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  run(ctx: RunContext, onEvent: (e: RunEvent) => void): Promise<RunResult> {
    const metered = Boolean(ctx.secrets.apiKey);
    return withRun(this.active, ctx, onEvent, { metered }, async (env) => {
      const cfg = parseConfig(ctx.config);
      for (const w of installClaudeSkills(ctx.workspacePath, ctx.skills)) env.emit({ type: 'status', status: w });

      // The MCP config carries the run token: private temp dir, 0600, removed in `finally`.
      const tmp = mkdtempSync(join(tmpdir(), RUN_TMP_PREFIX));
      const mcpConfigPath = join(tmp, 'mcp.json');
      const st: StreamState = { model: ctx.model, finalText: '', lastText: '', turns: 0, toolNames: new Map(), perMessage: new Map() };
      try {
        writeFileSync(mcpConfigPath, JSON.stringify(buildClaudeMcpConfig(ctx)), { mode: 0o600 });
        const childEnv = minimalEnv({ ...claudeMcpEnv(ctx), ...cfg.env, ...claudeAuthEnv(ctx.secrets) }, ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME']);
        const exit = await runJsonLines({
          command: cfg.command,
          args: buildClaudeArgs(ctx, cfg, mcpConfigPath, metered),
          cwd: ctx.workspacePath,
          env: childEnv,
          // Workspace + temp + Claude Code's own state/login; Conductor's home and other secret stores are out of reach.
          sandbox: agentSandbox(ctx, env.emit, { cli: 'claude', env: childEnv, privateTmp: [tmp] }),
          stdin: ctx.prompt,
          signal: env.guard.signal,
          onJson: (msg) => handleLine(msg, st, env, metered),
        });
        return this.conclude(env, st, exit, metered, cfg.command);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  private conclude(
    env: RunEnv,
    st: StreamState,
    exit: { code: number | null; stderr: string; spawnError?: NodeJS.ErrnoException },
    metered: boolean,
    command: string,
  ): RunResult {
    const result = st.result;
    const seatSeconds = metered ? 0 : env.guard.elapsedSeconds();
    const steps = result && typeof result.num_turns === 'number' ? result.num_turns : st.turns;
    const base = { steps, sessionId: st.sessionId, subscription: !metered, seatSeconds };

    // Usage: the result line is authoritative; without one, fall back to what the stream showed.
    let usage: PricedUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    if (result?.usage) usage = usageOf(result.usage);
    else {
      for (const u of st.perMessage.values()) {
        usage = {
          inputTokens: usage.inputTokens + u.inputTokens,
          outputTokens: usage.outputTokens + u.outputTokens,
          cacheReadTokens: (usage.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
          cacheWriteTokens: (usage.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0),
        };
      }
    }
    const reported = result && typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined;
    if (metered) {
      env.meter.add(st.model, usage, reported !== undefined ? { costUsd: reported } : {});
    } else {
      env.meter.add(st.model, usage, { costUsd: 0 });
      if (reported !== undefined) {
        env.emit({ type: 'status', status: `subscription run: marginal cost $0 (CLI-reported API-equivalent cost $${reported.toFixed(4)})` });
      }
    }

    if (exit.spawnError) {
      const missing = exit.spawnError.code === 'ENOENT';
      return env.fail(new AdapterError(missing ? 'outage' : 'other', missing ? `claude CLI not found: ${command}` : exit.spawnError.message), steps, base);
    }
    if (env.guard.reason) return env.finish({ ...base, outcome: 'failed', finalText: st.finalText || st.lastText });

    if (result) {
      const finalText = st.finalText || st.lastText;
      if (result.subtype === 'error_max_turns') {
        env.guard.stop('max_steps');
        return env.finish({ ...base, outcome: 'max_steps', finalText });
      }
      if (result.subtype === 'error_max_budget_usd') {
        env.guard.stop('budget');
        return env.finish({ ...base, outcome: 'budget', finalText });
      }
      if (result.is_error === true || (typeof result.subtype === 'string' && result.subtype !== 'success')) {
        const text = finalText || exit.stderr.trim() || String(result.subtype ?? 'claude reported an error');
        return env.fail(new AdapterError(classifyResultError(result, text), text), steps, { ...base, finalText });
      }
      if (metered && env.meter.overBudget()) {
        env.guard.stop('budget');
        return env.finish({ ...base, outcome: 'budget', finalText });
      }
      return env.finish({ ...base, outcome: 'completed', finalText });
    }

    const detail = exit.stderr.trim().slice(-600) || `claude exited with code ${exit.code ?? 'unknown'} without a result`;
    return env.fail(new AdapterError(kindFromMessage(detail), detail), steps, { ...base, finalText: st.lastText });
  }

  async cancel(runId: string): Promise<void> {
    this.active.cancel(runId);
  }
}
