import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AdapterCapabilities, AgentAdapter, Health, RunContext, RunEvent, RunResult } from '../../contracts/adapter.js';
import { AdapterError, kindFromStatus } from '../shared/errors.js';
import { ActiveRuns, withRun } from '../shared/guard.js';
import type { McpTool } from '../shared/mcp-tools.js';
import { runMcpToolLoop, type ModelToolCall, type ModelTurn, type ToolLoopDriver, type ToolReturn } from '../shared/tool-loop.js';


export const CLAUDE_API_DEFAULT_MODEL = 'claude-opus-5-5';

/** Models that accept the server-side refusal `fallbacks` parameter. */
const REFUSAL_FALLBACK_MODELS = /^claude-(fable-5-[12]|mythos-5-[12]|opus-5(-5)?|sonnet-5-5)$/;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const VISION_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const configSchema = z.object({
  /** Override the API origin (proxies, tests). */
  baseURL: z.string().url().optional(),
  maxTokens: z.number().int().positive().max(128_000).default(64_000),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Passed through as the `thinking` request field. Omit to let the model's default (adaptive) apply. */
  thinking: z.record(z.string(), z.unknown()).optional(),
  /** SDK-level retries of 408/409/429/5xx before the error reaches the fallback chain. */
  maxRetries: z.number().int().min(0).max(10).default(2),
  /** Re-run a safety-declined request on Anthropic's default fallback model (billed at that model's rates). */
  refusalFallback: z.boolean().default(true),
  /** Stream tool inputs as generated. Off automatically behind a custom baseURL (proxies may reject the field). */
  eagerInputStreaming: z.boolean().optional(),
  /** Conductor transcript to resume from: Anthropic `messages` from an earlier run. */
  priorMessages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]) }))
    .optional(),
});
type Config = z.infer<typeof configSchema>;

export const claudeApiConfigJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    baseURL: { type: 'string', format: 'uri', description: 'Override the Anthropic API origin.' },
    maxTokens: { type: 'integer', minimum: 1, maximum: 128000, default: 64000 },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    thinking: { type: 'object' },
    maxRetries: { type: 'integer', minimum: 0, maximum: 10, default: 2 },
    refusalFallback: { type: 'boolean', default: true },
    eagerInputStreaming: { type: 'boolean' },
    priorMessages: { type: 'array', description: 'Anthropic messages to resume from (Conductor transcript).' },
    pricing: { type: 'object', description: 'USD per MTok: { input, output, cacheRead?, cacheWrite? } or a per-model map.' },
  },
};

function parseConfig(raw: Record<string, unknown>): Config {
  const r = configSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new AdapterError('invalid_request', `claude_api config invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return r.data;
}

/** Map SDK failures onto the fallback taxonomy (most specific class first). */
export function mapAnthropicError(e: unknown): AdapterError {
  if (e instanceof AdapterError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new AdapterError('auth', e.message);
  if (e instanceof Anthropic.RateLimitError) return new AdapterError('rate_limit', e.message);
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) {
    return new AdapterError('invalid_request', e.message);
  }
  if (e instanceof Anthropic.APIConnectionError) return new AdapterError('outage', e.message);
  if (e instanceof Anthropic.InternalServerError) return new AdapterError('outage', e.message);
  if (e instanceof Anthropic.APIError) {
    return new AdapterError(typeof e.status === 'number' ? kindFromStatus(e.status) : 'outage', e.message);
  }
  if (e instanceof Anthropic.AnthropicError) {
    // Raised before any request when no credential can be resolved.
    return new AdapterError(/api.?key|auth|credential/i.test(e.message) ? 'auth' : 'other', e.message);
  }
  return new AdapterError('other', e instanceof Error ? e.message : String(e));
}

function createClient(cfg: Pick<Config, 'baseURL' | 'maxRetries'>, secrets: Record<string, string>, timeoutMs?: number): Anthropic {
  try {
    return new Anthropic({
      // Without a bound key the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
      ...(secrets.apiKey ? { apiKey: secrets.apiKey } : {}),
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      maxRetries: cfg.maxRetries,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
  } catch (e) {
    throw mapAnthropicError(e);
  }
}

class ClaudeDriver implements ToolLoopDriver {
  readonly model: string;
  private tools: Beta.BetaToolUnion[] = [];
  private readonly messages: Beta.BetaMessageParam[];

  constructor(
    private readonly client: Anthropic,
    private readonly ctx: RunContext,
    private readonly cfg: Config,
  ) {
    this.model = ctx.model ?? CLAUDE_API_DEFAULT_MODEL;
    this.messages = [...((cfg.priorMessages ?? []) as Beta.BetaMessageParam[]), { role: 'user', content: ctx.prompt }];
  }

  start(tools: McpTool[]): void {
    const eager = this.cfg.eagerInputStreaming ?? !this.cfg.baseURL;
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description || t.originalName,
      input_schema: t.inputSchema as Beta.BetaTool.InputSchema,
      ...(eager ? { eager_input_streaming: true } : {}),
    }));
  }

  async turn(results: ToolReturn[], signal: AbortSignal): Promise<ModelTurn> {
    if (results.length > 0) {
      // Every result of a turn goes back in ONE user message.
      this.messages.push({ role: 'user', content: results.map((r) => this.toolResult(r)) });
    }
    const useFallback = this.cfg.refusalFallback && !this.cfg.baseURL && REFUSAL_FALLBACK_MODELS.test(this.model);
    const params: Beta.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.cfg.maxTokens,
      // Render order is tools -> system -> messages: this breakpoint caches tools + system,
      // the top-level one caches the growing conversation.
      ...(this.ctx.systemPrompt
        ? { system: [{ type: 'text' as const, text: this.ctx.systemPrompt, cache_control: { type: 'ephemeral' as const } }] }
        : {}),
      cache_control: { type: 'ephemeral' },
      ...(this.tools.length > 0 ? { tools: this.tools } : {}),
      messages: this.messages,
      ...(this.cfg.effort ? { output_config: { effort: this.cfg.effort } } : {}),
      ...(this.cfg.thinking ? { thinking: this.cfg.thinking as unknown as Beta.BetaThinkingConfigParam } : {}),
      ...(useFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };

    let message: Beta.BetaMessage;
    try {
      message = await this.client.beta.messages.stream(params, { signal }).finalMessage();
    } catch (e) {
      throw mapAnthropicError(e);
    }

    // Replay the assistant turn verbatim (thinking blocks included) on the next request.
    this.messages.push({ role: 'assistant', content: message.content as unknown as Beta.BetaContentBlockParam[] });

    const turn: ModelTurn = {
      text: '',
      toolCalls: [],
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
    const text: string[] = [];
    const thinking: string[] = [];
    const truncated = message.stop_reason === 'max_tokens';
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text);
      else if (block.type === 'thinking' && block.thinking) thinking.push(block.thinking);
      else if (block.type === 'tool_use') {
        const call: ModelToolCall = { id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> };
        // A tool input cut off at max_tokens can parse as a valid partial object: never run it.
        if (truncated) call.invalid = 'the response hit max_tokens and the tool input may be truncated; issue the call again';
        turn.toolCalls.push(call);
      }
    }
    turn.text = text.join('');
    if (thinking.length > 0) turn.thinking = thinking.join('\n');
    if (message.model !== this.model) turn.notes = [`served by ${message.model} (requested ${this.model})`];

    switch (message.stop_reason) {
      case 'refusal':
        turn.refusal = message.stop_details?.explanation ?? message.stop_details?.category ?? 'refusal';
        turn.toolCalls = [];
        break;
      case 'pause_turn':
        turn.paused = true;
        break;
      case 'model_context_window_exceeded':
        throw new AdapterError('invalid_request', 'the conversation exceeded the model context window');
      case 'max_tokens':
        if (turn.toolCalls.length === 0) (turn.notes ??= []).push('response truncated at max_tokens');
        break;
      default:
        break;
    }
    return turn;
  }

  private toolResult(r: ToolReturn): Beta.BetaToolResultBlockParam {
    const content: Array<Beta.BetaTextBlockParam | Beta.BetaImageBlockParam> = [];
    const notes: string[] = [];
    for (const img of r.images) {
      if (VISION_TYPES.has(img.mimeType)) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType as 'image/png', data: img.data },
        });
      } else {
        notes.push(`[image of unsupported type ${img.mimeType} omitted]`);
      }
    }
    const text = [r.text, ...notes].filter((s) => s.length > 0).join('\n');
    content.unshift({ type: 'text', text: text || (content.length > 0 ? '(image result)' : '(no output)') });
    return { type: 'tool_result', tool_use_id: r.callId, content, ...(r.isError ? { is_error: true } : {}) };
  }
}

/**
 * `claude_api` — Anthropic Messages API with the loop owned by Conductor.
 * Tools come only from the gateway MCP endpoints in the RunContext.
 */
export class ClaudeApiAdapter implements AgentAdapter {
  readonly id = 'claude_api';
  private readonly active = new ActiveRuns();

  capabilities(): AdapterCapabilities {
    return { tools: true, mcp: true, resume: true, vision: true, browser: 'via_mcp' };
  }

  async testConnection(cfg: { config: Record<string, unknown>; secrets: Record<string, string>; model?: string | null }): Promise<Health> {
    try {
      const config = parseConfig(cfg.config);
      const client = createClient({ ...config, maxRetries: 0 }, cfg.secrets, 15_000);
      const model = await client.models.retrieve(cfg.model ?? CLAUDE_API_DEFAULT_MODEL);
      return { ok: true, detail: `authenticated; model ${model.id} (${model.display_name}) is available` };
    } catch (e) {
      const err = mapAnthropicError(e);
      return { ok: false, detail: `${err.kind}: ${err.message}` };
    }
  }

  run(ctx: RunContext, onEvent: (e: RunEvent) => void): Promise<RunResult> {
    return withRun(this.active, ctx, onEvent, { metered: true }, async (env) => {
      const cfg = parseConfig(ctx.config);
      const client = createClient(cfg, ctx.secrets);
      return runMcpToolLoop(env, new ClaudeDriver(client, ctx, cfg));
    });
  }

  async cancel(runId: string): Promise<void> {
    this.active.cancel(runId);
  }
}
