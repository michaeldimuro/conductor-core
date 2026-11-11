import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpEndpoint } from '../../contracts/adapter.js';
import { AdapterError } from './errors.js';

/** A gateway tool, exposed to a model under a provider-safe name. */
export interface McpTool {
  /** Name sent to the provider: `[A-Za-z0-9_-]{1,64}`, unique within the toolset. */
  name: string;
  /** The tool's real name on the MCP server (what events and the gateway log use). */
  originalName: string;
  /** Which `mcpEndpoints` entry serves it. */
  endpoint: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolImage {
  mimeType: string;
  /** base64 */
  data: string;
}

export interface ToolOutcome {
  /** Original MCP tool name. */
  name: string;
  text: string;
  /** Image content returned by the tool (e.g. browser screenshots), passed to vision-capable models. */
  images: ToolImage[];
  isError: boolean;
}

const NAME_MAX = 64;

/**
 * "No deadline of its own" for a gateway tool call (the largest delay a timer
 * accepts, ~24.8 days): the caller's AbortSignal — the run guard, whose wall
 * clock stops while the run is paused for a human — decides when it ends.
 */
export const GUARD_BOUND_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * How long the local CLIs (Claude Code, Codex) may wait on one gateway tool
 * call. They cannot stop their own timer while a run is paused, so the limit
 * is the run's wall time plus a generous allowance for a human takeover; the
 * run guard still ends the run when its (pause-aware) wall time is spent.
 */
export const HUMAN_WAIT_ALLOWANCE_MS = 24 * 3_600_000;
export const cliToolTimeoutMs = (maxWallMs: number): number => Math.min(Math.max(60_000, maxWallMs) + HUMAN_WAIT_ALLOWANCE_MS, GUARD_BOUND_TIMEOUT_MS);
/** Time a local CLI gets to connect to the gateway and list its tools. */
export const CLI_MCP_STARTUP_TIMEOUT_MS = 30_000;

/** Map an arbitrary MCP tool name onto the charset every provider accepts. */
export function sanitizeToolName(name: string, taken: ReadonlySet<string> = new Set()): string {
  let safe = name.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!safe) safe = 'tool';
  if (safe.length > NAME_MAX || taken.has(safe)) {
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
    safe = `${safe.slice(0, NAME_MAX - 9)}_${hash}`;
  }
  let candidate = safe;
  for (let i = 2; taken.has(candidate); i++) {
    const suffix = `_${i}`;
    candidate = `${safe.slice(0, NAME_MAX - suffix.length)}${suffix}`;
  }
  return candidate;
}

interface Connection {
  endpoint: McpEndpoint;
  client: Client;
}

function describeContent(content: unknown, images: ToolImage[]): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      images.push({ mimeType: block.mimeType, data: block.data });
    } else if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
      const res = block.resource as Record<string, unknown>;
      parts.push(typeof res.text === 'string' ? res.text : `[resource ${String(res.uri ?? '')}]`);
    } else if (block.type === 'resource_link') {
      parts.push(`[resource link ${String(block.uri ?? '')}]`);
    } else if (typeof block.type === 'string') {
      parts.push(`[${block.type} content]`);
    }
  }
  return parts.join('\n');
}

/**
 * MCP clients for every gateway endpoint of a run, with the merged tool list.
 * This is the ONLY way API adapters reach tools: Streamable HTTP to the
 * Conductor gateway, authenticated by the endpoint's headers (run token).
 */
export class McpToolset {
  readonly tools: McpTool[] = [];
  private readonly byName = new Map<string, { tool: McpTool; conn: Connection }>();

  private constructor(private readonly connections: Connection[]) {}

  static async connect(endpoints: McpEndpoint[], opts: { signal?: AbortSignal; clientName?: string } = {}): Promise<McpToolset> {
    const connections: Connection[] = [];
    const set = new McpToolset(connections);
    try {
      for (const endpoint of endpoints) {
        const client = new Client({ name: opts.clientName ?? 'conductor-adapter', version: '0.1.0' });
        const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: { headers: { ...endpoint.headers } },
        });
        await client.connect(transport, { signal: opts.signal });
        connections.push({ endpoint, client });
      }
      const taken = new Set<string>();
      const qualify = endpoints.length > 1;
      for (const conn of connections) {
        let cursor: string | undefined;
        do {
          const page = await conn.client.listTools(cursor ? { cursor } : undefined, { signal: opts.signal });
          for (const t of page.tools) {
            const name = sanitizeToolName(qualify ? `${conn.endpoint.name}__${t.name}` : t.name, taken);
            taken.add(name);
            const tool: McpTool = {
              name,
              originalName: t.name,
              endpoint: conn.endpoint.name,
              description: t.description ?? '',
              inputSchema: { type: 'object', ...(t.inputSchema as Record<string, unknown>) },
            };
            set.tools.push(tool);
            set.byName.set(name, { tool, conn });
          }
          cursor = page.nextCursor;
        } while (cursor);
      }
      // Deterministic order keeps the provider-side prompt cache prefix stable across runs.
      set.tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return set;
    } catch (e) {
      await set.close();
      if (opts.signal?.aborted) throw e;
      throw new AdapterError('other', `could not reach the Conductor tool gateway: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  get(name: string): McpTool | undefined {
    return this.byName.get(name)?.tool;
  }

  /** Execute a tool by its provider-safe name. Tool failures come back as `isError`, they never throw. */
  async call(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ToolOutcome> {
    const entry = this.byName.get(name);
    if (!entry) return { name, text: `Unknown tool: ${name}`, images: [], isError: true };
    const images: ToolImage[] = [];
    try {
      const res = await entry.conn.client.callTool({ name: entry.tool.originalName, arguments: args }, undefined, {
        signal: opts.signal,
        timeout: Math.min(Math.max(1000, opts.timeoutMs ?? 600_000), GUARD_BOUND_TIMEOUT_MS),
        resetTimeoutOnProgress: true,
      });
      let text = describeContent(res.content, images);
      if (!text && res.structuredContent !== undefined) text = JSON.stringify(res.structuredContent);
      return { name: entry.tool.originalName, text, images, isError: res.isError === true };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      return { name: entry.tool.originalName, text: `Tool call failed: ${e instanceof Error ? e.message : String(e)}`, images: [], isError: true };
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      this.connections.map(async (c) => {
        try {
          await c.client.close();
        } catch {
          // already closed
        }
      }),
    );
  }
}

/** Short human-readable form of a tool result for the normalized `tool_result` event. */
export function outcomeToEventText(out: ToolOutcome): string {
  const notes = out.images.map((img) => `[image ${img.mimeType}, ${Math.floor((img.data.length * 3) / 4)} bytes]`);
  return [out.text, ...notes].filter((s) => s.length > 0).join('\n');
}
