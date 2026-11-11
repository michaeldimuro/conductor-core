import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const ANTHROPIC_TEST_KEY = 'sk-ant-test-0123456789abcdefghij';
export const OPENAI_TEST_KEY = 'sk-openai-test-0123456789abcdefghij';

/**
 * `normal`: call the tool once, then answer with its result.
 * `loop`: ask for the tool on every turn (never finishes).
 * `slow`: never answer (until the client goes away).
 * `{ status }`: fail every request with that HTTP status.
 */
export type ProviderMode = 'normal' | 'loop' | 'slow' | { status: number };

export interface ProviderState {
  mode: ProviderMode;
  /** Tool the model asks for, and the arguments it sends. */
  tool: { name: string; args: Record<string, unknown> };
  usage: { input: number; output: number; cacheRead: number };
  /** Parsed request bodies, in order. */
  requests: Array<Record<string, unknown>>;
}

export interface MockProviders {
  anthropicBaseURL: string;
  openaiBaseURL: string;
  anthropic: ProviderState;
  openai: ProviderState;
  reset(): void;
  close(): Promise<void>;
}

const fresh = (): Omit<ProviderState, 'requests'> => ({
  mode: 'normal',
  tool: { name: 'lookup_code', args: { key: 'alpha' } },
  usage: { input: 1000, output: 50, cacheRead: 0 },
});

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data ? (JSON.parse(data) as Record<string, unknown>) : {};
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const ERROR_TYPES: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' };

function findTool(tools: unknown, wanted: string): string {
  const list = Array.isArray(tools) ? (tools as Array<{ name?: string }>) : [];
  return list.find((t) => t.name === wanted)?.name ?? list.find((t) => t.name?.includes(wanted))?.name ?? wanted;
}

/* ───────────── Anthropic Messages (SSE) ───────────── */

function lastToolResultText(body: Record<string, unknown>): string | null {
  const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
  const last = messages.at(-1);
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return null;
  const block = (last.content as Array<Record<string, unknown>>).find((b) => b.type === 'tool_result');
  if (!block) return null;
  const content = block.content;
  if (typeof content === 'string') return content;
  return (content as Array<Record<string, unknown>>).filter((c) => c.type === 'text').map((c) => String(c.text)).join('');
}

async function anthropicMessages(state: ProviderState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  state.requests.push(body);
  if (req.headers['x-api-key'] !== ANTHROPIC_TEST_KEY) {
    json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    return;
  }
  if (typeof state.mode === 'object') {
    const type = ERROR_TYPES[state.mode.status] ?? 'api_error';
    json(res, state.mode.status, { type: 'error', error: { type, message: `mock ${type}` } });
    return;
  }
  if (state.mode === 'slow') return; // hold the request open

  const n = state.requests.length;
  const toolText = lastToolResultText(body);
  const wantsTool = state.mode === 'loop' || toolText === null;
  const model = String(body.model);
  const sse = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse('message_start', {
    type: 'message_start',
    message: {
      id: `msg_mock_${n}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: state.usage.input, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: state.usage.cacheRead },
    },
  });
  if (wantsTool) {
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } });
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    sse('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: `toolu_mock_${n}`, name: findTool(body.tools, state.tool.name), input: {} },
    });
    sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(state.tool.args) } });
    sse('content_block_stop', { type: 'content_block_stop', index: 1 });
  } else {
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `The code is ${toolText}` } });
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
  }
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: wantsTool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: state.usage.output },
  });
  sse('message_stop', { type: 'message_stop' });
  res.end();
}

/* ───────────── OpenAI Responses (SSE) ───────────── */

function lastFunctionOutput(body: Record<string, unknown>): string | null {
  const input = (Array.isArray(body.input) ? body.input : []) as Array<Record<string, unknown>>;
  const last = input.at(-1);
  if (!last || last.type !== 'function_call_output') return null;
  if (typeof last.output === 'string') return last.output;
  return (last.output as Array<Record<string, unknown>>).filter((c) => c.type === 'input_text').map((c) => String(c.text)).join('');
}

async function openaiResponses(state: ProviderState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  state.requests.push(body);
  if (req.headers.authorization !== `Bearer ${OPENAI_TEST_KEY}`) {
    json(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
    return;
  }
  if (typeof state.mode === 'object') {
    json(res, state.mode.status, { error: { message: `mock error ${state.mode.status}`, type: 'error', code: null } });
    return;
  }
  if (state.mode === 'slow') return;

  const n = state.requests.length;
  const toolOutput = lastFunctionOutput(body);
  const wantsTool = state.mode === 'loop' || toolOutput === null;
  const output = wantsTool
    ? [
        {
          type: 'function_call',
          id: `fc_mock_${n}`,
          call_id: `call_mock_${n}`,
          name: findTool(body.tools, state.tool.name),
          arguments: JSON.stringify(state.tool.args),
          status: 'completed',
        },
      ]
    : [
        {
          type: 'message',
          id: `msg_mock_${n}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: `The code is ${toolOutput}`, annotations: [] }],
        },
      ];
  const response = {
    id: `resp_mock_${n}`,
    object: 'response',
    created_at: 1_700_000_000,
    model: String(body.model),
    status: 'completed',
    error: null,
    incomplete_details: null,
    output,
    usage: {
      input_tokens: state.usage.input,
      input_tokens_details: { cached_tokens: state.usage.cacheRead },
      output_tokens: state.usage.output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: state.usage.input + state.usage.output,
    },
  };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const sse = (data: Record<string, unknown>): void => {
    res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  sse({ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [], usage: null } });
  sse({ type: 'response.completed', sequence_number: 1, response });
  res.end();
}

/** One local HTTP server speaking enough of both provider wire formats to drive a multi-step tool loop. */
export async function startMockProviders(): Promise<MockProviders> {
  const anthropic: ProviderState = { ...fresh(), requests: [] };
  const openai: ProviderState = { ...fresh(), requests: [] };

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const run = async (): Promise<void> => {
      if (req.method === 'POST' && path === '/anthropic/v1/messages') return anthropicMessages(anthropic, req, res);
      if (req.method === 'POST' && path === '/openai/v1/responses') return openaiResponses(openai, req, res);
      if (req.method === 'GET' && path.startsWith('/anthropic/v1/models/')) {
        if (req.headers['x-api-key'] !== ANTHROPIC_TEST_KEY) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        return json(res, 200, { id: path.split('/').pop(), type: 'model', display_name: 'Mock Model', created_at: '2026-01-01T00:00:00Z' });
      }
      if (req.method === 'GET' && path.startsWith('/openai/v1/models/')) {
        if (req.headers.authorization !== `Bearer ${OPENAI_TEST_KEY}`) return json(res, 401, { error: { message: 'Incorrect API key provided' } });
        return json(res, 200, { id: path.split('/').pop(), object: 'model', created: 1, owned_by: 'mock' });
      }
      json(res, 404, { error: { message: `no mock route for ${req.method} ${path}` } });
    };
    run().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    anthropicBaseURL: `${origin}/anthropic`,
    openaiBaseURL: `${origin}/openai/v1`,
    anthropic,
    openai,
    reset() {
      Object.assign(anthropic, fresh(), { requests: [] });
      Object.assign(openai, fresh(), { requests: [] });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
