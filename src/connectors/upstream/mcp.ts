import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError, discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/client/auth.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContent } from '../../contracts/tools.js';
import { AuthRequiredError, type UpstreamClient, type UpstreamResult, type UpstreamTool } from '../types.js';

const CLIENT_INFO = { name: 'conductor-gateway', version: '0.1.0' };

export function isAuthError(e: unknown): boolean {
  if (e instanceof UnauthorizedError) return true;
  if (e instanceof StreamableHTTPError || e instanceof SseError) return e.code === 401;
  return false;
}

/** Where a human should go to authorize, if the server advertises OAuth metadata (MCP auth spec). */
export async function discoverAuthUrl(serverUrl: URL, opts: { clientId?: string; scope?: string } = {}): Promise<string | null> {
  try {
    let authServer: string | URL = new URL('/', serverUrl);
    try {
      const prm = await discoverOAuthProtectedResourceMetadata(serverUrl);
      const first = prm.authorization_servers?.[0];
      if (first) authServer = first;
    } catch {
      // No protected-resource metadata: fall back to the server's own origin.
    }
    const meta = await discoverAuthorizationServerMetadata(authServer);
    if (!meta?.authorization_endpoint) return null;
    const u = new URL(meta.authorization_endpoint);
    if (opts.clientId) {
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', opts.clientId);
    }
    if (opts.scope) u.searchParams.set('scope', opts.scope);
    u.searchParams.set('resource', serverUrl.href);
    return u.href;
  } catch {
    return null;
  }
}

const AUTH_URL_KEYS = new Set(['authorization_url', 'authorizationurl', 'auth_url', 'authurl', 'redirect_url', 'redirecturl']);

function findAuthUrl(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && AUTH_URL_KEYS.has(k.toLowerCase()) && /^https?:\/\//.test(v)) return v;
    const nested = findAuthUrl(v, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * Just-in-time OAuth (Arcade, Composio): a tool response saying the user must
 * authorize first. Returns the authorization URL (null when none was given),
 * or undefined when the result is an ordinary one.
 */
export function detectAuthorizationRequired(result: UpstreamResult): { url: string | null } | undefined {
  for (const c of result.content) {
    if (c.type !== 'text') continue;
    const mentions = /authori[sz](ation|e)[^.\n]{0,60}(required|needed|pending)|requires? authori[sz]ation|authorization_required/i.test(c.text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(c.text);
    } catch {
      parsed = undefined;
    }
    const url = findAuthUrl(parsed);
    if (url && (mentions || result.isError)) return { url };
    if (mentions) return { url: c.text.match(/https?:\/\/[^\s"'<>)\]]+/)?.[0] ?? null };
  }
  return undefined;
}

function toContent(block: Record<string, unknown>): ToolContent {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
    return { type: 'image', data: block.data, mimeType: block.mimeType };
  }
  if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
    const r = block.resource as { uri?: unknown; text?: unknown };
    return { type: 'text', text: typeof r.text === 'string' ? r.text : `[resource ${String(r.uri ?? '')}]` };
  }
  if (block.type === 'resource_link') return { type: 'text', text: `[resource link ${String(block.uri ?? '')}]` };
  return { type: 'text', text: `[unsupported ${String(block.type)} content omitted]` };
}

export interface McpUpstreamOptions {
  timeoutMs: number;
  /** Convert authorization-required tool responses into AuthRequiredError (arcade/composio). */
  jitAuth?: boolean;
  /** Resolves the authorization URL after a 401. */
  authUrl?: () => Promise<string | null>;
}

class McpUpstream implements UpstreamClient {
  closed = false;
  private listeners: Array<() => void> = [];

  constructor(
    private readonly client: Client,
    private readonly opts: McpUpstreamOptions,
  ) {
    client.onclose = () => {
      this.closed = true;
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      for (const fn of this.listeners) fn();
    });
  }

  onToolsChanged = (fn: () => void): void => {
    this.listeners.push(fn);
  };

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isAuthError(e)) throw new AuthRequiredError('the upstream server rejected the stored credentials', (await this.opts.authUrl?.()) ?? null);
      throw e;
    }
  }

  async listTools(): Promise<UpstreamTool[]> {
    return this.guard(async () => {
      const out: UpstreamTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 200; page++) {
        const r = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: this.opts.timeoutMs });
        for (const t of r.tools) {
          out.push({
            name: t.name,
            description: t.description ?? '',
            inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
            annotations: t.annotations
              ? { readOnlyHint: t.annotations.readOnlyHint, destructiveHint: t.annotations.destructiveHint, openWorldHint: t.annotations.openWorldHint }
              : undefined,
          });
        }
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      return out;
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<UpstreamResult> {
    const result = await this.guard(async () => {
      const r = await this.client.callTool({ name, arguments: args }, undefined, { timeout: this.opts.timeoutMs });
      const blocks = Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>) : [];
      const content = blocks.map(toContent);
      if (content.length === 0 && r.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify(r.structuredContent, null, 2) });
      return { content, ...(r.isError === true ? { isError: true } : {}) } satisfies UpstreamResult;
    });
    if (this.opts.jitAuth) {
      const auth = detectAuthorizationRequired(result);
      if (auth) throw new AuthRequiredError(`"${name}" needs the connected account to be authorized first`, auth.url);
    }
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.close().catch(() => undefined);
  }
}

export interface StdioSpec {
  command: string;
  args: string[];
  /** Already secret-resolved. Merged over a minimal inherited environment. */
  env: Record<string, string>;
  cwd?: string;
}

export async function connectStdio(spec: StdioSpec, opts: McpUpstreamOptions): Promise<UpstreamClient> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...getDefaultEnvironment(), ...spec.env },
    cwd: spec.cwd,
    stderr: 'ignore',
  });
  try {
    await client.connect(transport, { timeout: opts.timeoutMs });
  } catch (e) {
    await client.close().catch(() => undefined);
    throw e;
  }
  return new McpUpstream(client, opts);
}

export interface HttpSpec {
  url: URL;
  /** Already secret-resolved. */
  headers: Record<string, string>;
  mode: 'auto' | 'streamable' | 'sse';
}

/** Streamable HTTP first, falling back to the legacy HTTP+SSE transport. */
export async function connectHttp(spec: HttpSpec, opts: McpUpstreamOptions): Promise<UpstreamClient> {
  const attempt = async (kind: 'streamable' | 'sse'): Promise<Client> => {
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const init = { requestInit: { headers: spec.headers } };
    const transport = kind === 'streamable' ? new StreamableHTTPClientTransport(spec.url, init) : new SSEClientTransport(spec.url, init);
    try {
      await client.connect(transport, { timeout: opts.timeoutMs });
      return client;
    } catch (e) {
      await client.close().catch(() => undefined);
      throw e;
    }
  };
  const authRequired = async () => new AuthRequiredError('the upstream server requires authorization', (await opts.authUrl?.()) ?? null);

  let client: Client;
  try {
    client = await attempt(spec.mode === 'sse' ? 'sse' : 'streamable');
  } catch (first) {
    if (isAuthError(first)) throw await authRequired();
    if (spec.mode !== 'auto') throw first;
    try {
      client = await attempt('sse');
    } catch (second) {
      if (isAuthError(second)) throw await authRequired();
      throw first;
    }
  }
  return new McpUpstream(client, opts);
}
