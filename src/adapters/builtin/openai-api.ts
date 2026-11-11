import OpenAI from 'openai';
import { z } from 'zod';
import type { AdapterCapabilities, AgentAdapter, Health, RunContext, RunEvent, RunResult } from '../../contracts/adapter.js';
import { AdapterError, kindFromStatus } from '../shared/errors.js';
import { ActiveRuns, withRun } from '../shared/guard.js';
import type { McpTool } from '../shared/mcp-tools.js';
import { runMcpToolLoop, type ModelToolCall, type ModelTurn, type ToolLoopDriver, type ToolReturn } from '../shared/tool-loop.js';


export const OPENAI_API_DEFAULT_MODEL = 'gpt-5.5';

const configSchema = z.object({
  /** Override the API origin, including the `/v1` path (proxies, compatible servers, tests). */
  baseURL: z.string().url().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoningEffort: z.string().min(1).optional(),
  maxRetries: z.number().int().min(0).max(10).default(2),
  organization: z.string().optional(),
  project: z.string().optional(),
  /** Conductor transcript to resume from: Responses API input items from an earlier run. */
  priorMessages: z.array(z.record(z.string(), z.unknown())).optional(),
});
type Config = z.infer<typeof configSchema>;

export const openaiApiConfigJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    baseURL: { type: 'string', format: 'uri', description: 'Override the OpenAI API origin (include /v1).' },
    maxOutputTokens: { type: 'integer', minimum: 1 },
    reasoningEffort: { type: 'string' },
    maxRetries: { type: 'integer', minimum: 0, maximum: 10, default: 2 },
    organization: { type: 'string' },
    project: { type: 'string' },
    priorMessages: { type: 'array', description: 'Responses API input items to resume from (Conductor transcript).' },
    pricing: { type: 'object', description: 'USD per MTok: { input, output, cacheRead? } or a per-model map.' },
  },
};

function parseConfig(raw: Record<string, unknown>): Config {
  const r = configSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new AdapterError('invalid_request', `openai_api config invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return r.data;
}

export function mapOpenAIError(e: unknown): AdapterError {
  if (e instanceof AdapterError) return e;
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) return new AdapterError('auth', e.message);
  if (e instanceof OpenAI.RateLimitError) return new AdapterError('rate_limit', e.message);
  if (e instanceof OpenAI.BadRequestError || e instanceof OpenAI.NotFoundError || e instanceof OpenAI.UnprocessableEntityError) {
    return new AdapterError('invalid_request', e.message);
  }
  if (e instanceof OpenAI.APIConnectionError) return new AdapterError('outage', e.message);
  if (e instanceof OpenAI.InternalServerError) return new AdapterError('outage', e.message);
  if (e instanceof OpenAI.APIError) {
    return new AdapterError(typeof e.status === 'number' ? kindFromStatus(e.status) : 'outage', e.message);
  }
  if (e instanceof OpenAI.OpenAIError) {
    // Raised by the constructor when no API key can be resolved.
    return new AdapterError(/api.?key|credential|auth/i.test(e.message) ? 'auth' : 'other', e.message);
  }
  return new AdapterError('other', e instanceof Error ? e.message : String(e));
}

function createClient(cfg: Pick<Config, 'baseURL' | 'maxRetries' | 'organization' | 'project'>, secrets: Record<string, string>, timeoutMs?: number): OpenAI {
  try {
    return new OpenAI({
      ...(secrets.apiKey ? { apiKey: secrets.apiKey } : {}),
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      ...(cfg.organization ? { organization: cfg.organization } : {}),
      ...(cfg.project ? { project: cfg.project } : {}),
      maxRetries: cfg.maxRetries,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
  } catch (e) {
    throw mapOpenAIError(e);
  }
}

function failedResponseError(response: OpenAI.Responses.Response): AdapterError {
  const code = response.error?.code;
  const message = response.error?.message ?? 'the response failed';
  if (code === 'rate_limit_exceeded') return new AdapterError('rate_limit', message);
  if (code === 'server_error' || code === 'vector_store_timeout') return new AdapterError('outage', message);
  if (code === 'invalid_prompt') return new AdapterError('invalid_request', message);
  return new AdapterError('other', message);
}

class OpenAIDriver implements ToolLoopDriver {
  readonly model: string;
  private tools: OpenAI.Responses.FunctionTool[] = [];
  private readonly input: OpenAI.Responses.ResponseInputItem[];

  constructor(
    private readonly client: OpenAI,
    private readonly ctx: RunContext,
    private readonly cfg: Config,
  ) {
    this.model = ctx.model ?? OPENAI_API_DEFAULT_MODEL;
    this.input = [...((cfg.priorMessages ?? []) as unknown as OpenAI.Responses.ResponseInputItem[]), { role: 'user', content: ctx.prompt }];
  }

  start(tools: McpTool[]): void {
    this.tools = tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description || t.originalName,
      parameters: t.inputSchema,
      // MCP schemas are not guaranteed to satisfy strict mode (all-required, no additionalProperties).
      strict: false,
    }));
  }

  async turn(results: ToolReturn[], signal: AbortSignal): Promise<ModelTurn> {
    for (const r of results) this.input.push(this.toolOutput(r));

    let response: OpenAI.Responses.Response | undefined;
    try {
      const stream = await this.client.responses.create(
        {
          model: this.model,
          ...(this.ctx.systemPrompt ? { instructions: this.ctx.systemPrompt } : {}),
          input: this.input,
          ...(this.tools.length > 0 ? { tools: this.tools } : {}),
          // Stateless: Conductor keeps the transcript, so reasoning items travel back encrypted.
          store: false,
          include: ['reasoning.encrypted_content'],
          ...(this.cfg.maxOutputTokens ? { max_output_tokens: this.cfg.maxOutputTokens } : {}),
          ...(this.cfg.reasoningEffort ? { reasoning: { effort: this.cfg.reasoningEffort as OpenAI.ReasoningEffort } } : {}),
          stream: true,
        },
        { signal },
      );
      for await (const event of stream) {
        if (event.type === 'response.completed' || event.type === 'response.incomplete') response = event.response;
        else if (event.type === 'response.failed') throw failedResponseError(event.response);
        else if (event.type === 'error') {
          throw new AdapterError(event.code === 'rate_limit_exceeded' ? 'rate_limit' : event.code === 'server_error' ? 'outage' : 'other', event.message);
        }
      }
    } catch (e) {
      throw mapOpenAIError(e);
    }
    if (!response) throw new AdapterError('outage', 'the response stream ended before the response completed');

    // Replay every output item (reasoning, messages, function calls) on the next request.
    this.input.push(...(response.output as unknown as OpenAI.Responses.ResponseInputItem[]));

    const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
    const inputTokens = response.usage?.input_tokens ?? 0;
    const turn: ModelTurn = {
      text: '',
      toolCalls: [],
      model: response.model,
      usage: {
        // OpenAI's input_tokens includes cache hits; split them out for pricing.
        inputTokens: Math.max(0, inputTokens - cached),
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: cached,
      },
    };
    const truncated = response.status === 'incomplete';
    const text: string[] = [];
    const thinking: string[] = [];
    let refusal: string | undefined;

    for (const item of response.output) {
      if (item.type === 'message') {
        for (const part of item.content) {
          if (part.type === 'output_text') text.push(part.text);
          else if (part.type === 'refusal') refusal = part.refusal;
        }
      } else if (item.type === 'reasoning') {
        for (const s of item.summary ?? []) if (s.text) thinking.push(s.text);
      } else if (item.type === 'function_call') {
        const call: ModelToolCall = { id: item.call_id, name: item.name, input: {} };
        try {
          const parsed: unknown = item.arguments ? JSON.parse(item.arguments) : {};
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) call.input = parsed as Record<string, unknown>;
          else call.invalid = 'arguments must be a JSON object';
        } catch {
          call.invalid = 'arguments were not valid JSON';
        }
        if (truncated) call.invalid = 'the response was cut off and the arguments may be truncated; issue the call again';
        turn.toolCalls.push(call);
      }
    }
    turn.text = text.join('');
    if (thinking.length > 0) turn.thinking = thinking.join('\n');
    if (refusal !== undefined && turn.toolCalls.length === 0 && !turn.text) turn.refusal = refusal;
    if (truncated) turn.notes = [`response incomplete: ${response.incomplete_details?.reason ?? 'unknown reason'}`];
    return turn;
  }

  private toolOutput(r: ToolReturn): OpenAI.Responses.ResponseInputItem.FunctionCallOutput {
    const text = `${r.isError ? 'ERROR: ' : ''}${r.text}` || '(no output)';
    if (r.images.length === 0) return { type: 'function_call_output', call_id: r.callId, output: text };
    return {
      type: 'function_call_output',
      call_id: r.callId,
      output: [
        { type: 'input_text', text },
        ...r.images.map((img) => ({ type: 'input_image' as const, image_url: `data:${img.mimeType};base64,${img.data}`, detail: 'auto' as const })),
      ],
    };
  }
}

/**
 * `openai_api` — OpenAI Responses API with the loop owned by Conductor.
 * Gateway MCP tools are exposed as function tools.
 */
export class OpenAIApiAdapter implements AgentAdapter {
  readonly id = 'openai_api';
  private readonly active = new ActiveRuns();

  capabilities(): AdapterCapabilities {
    return { tools: true, mcp: true, resume: true, vision: true, browser: 'via_mcp' };
  }

  async testConnection(cfg: { config: Record<string, unknown>; secrets: Record<string, string>; model?: string | null }): Promise<Health> {
    try {
      const config = parseConfig(cfg.config);
      const client = createClient({ ...config, maxRetries: 0 }, cfg.secrets, 15_000);
      const model = await client.models.retrieve(cfg.model ?? OPENAI_API_DEFAULT_MODEL);
      return { ok: true, detail: `authenticated; model ${model.id} is available` };
    } catch (e) {
      const err = mapOpenAIError(e);
      return { ok: false, detail: `${err.kind}: ${err.message}` };
    }
  }

  run(ctx: RunContext, onEvent: (e: RunEvent) => void): Promise<RunResult> {
    return withRun(this.active, ctx, onEvent, { metered: true }, async (env) => {
      const cfg = parseConfig(ctx.config);
      const client = createClient(cfg, ctx.secrets);
      return runMcpToolLoop(env, new OpenAIDriver(client, ctx, cfg));
    });
  }

  async cancel(runId: string): Promise<void> {
    this.active.cancel(runId);
  }
}
