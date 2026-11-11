import type { ArcadeConfig, ComposioConfig } from '../config.js';
import type { SecretResolver } from '../secrets.js';
import type { CredentialContext, UpstreamClient } from '../types.js';
import { ConductorError, errorMessage } from '../../shared/errors.js';
import { connectHttp } from './mcp.js';

/**
 * Hosted toolkits. Their MCP endpoints are account-specific, so nothing here
 * invents a server or gateway:
 * - Composio: the MCP URL is issued by Composio's API (docs: "Don't construct the
 *   MCP URL from a server ID") — per user for a chosen MCP server, or a session
 *   covering every toolkit the user connected — unless one is pasted (`mcpUrl`).
 * - Arcade: `https://api.arcade.dev/mcp/<gateway-slug>` of a gateway created in
 *   the Arcade dashboard with user mode "Arcade Headers" (API key + Arcade-User-ID).
 */

const COMPOSIO_API = 'https://backend.composio.dev';
/** Composio Connect: the MCP endpoint for consumer keys (`ck_…`, dashboard → Sessions & API Key). */
const COMPOSIO_CONNECT_MCP = 'https://connect.composio.dev/mcp';
const ARCADE_MCP = 'https://api.arcade.dev/mcp';
/** The slug old Arcade templates filled in; no account has it. */
const PLACEHOLDER_GATEWAY = 'default';

export const ARCADE_GATEWAY_HELP =
  'Create an MCP gateway in the Arcade dashboard with user mode "Arcade Headers", then set its slug (the last part of https://api.arcade.dev/mcp/<slug>) in this connector\'s settings.';
export const COMPOSIO_KEY_HELP =
  'Use either your consumer API key (starts with ck_, dashboard → Sessions & API Key) or a project API key (Settings → API keys), and replace COMPOSIO_API_KEY on this connector.';

/** Which Composio key this is: a consumer key goes to Composio Connect, a project key to the developer API. */
export function composioKeyType(apiKey: string, configured?: string): 'consumer' | 'project' {
  if (configured === 'consumer' || configured === 'project') return configured;
  return apiKey.startsWith('ck_') ? 'consumer' : 'project';
}

function urlOf(raw: string, what: string): URL {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u;
  } catch {
    /* fall through */
  }
  throw new ConductorError('validation', `${what} is not a valid http(s) URL`);
}

/** POST to Composio's REST API; a rejected key becomes an actionable message. */
async function composioPost(base: string, path: string, apiKey: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ConductorError('unavailable', `could not reach Composio: ${errorMessage(e)}`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON error page */
  }
  if (res.ok) return json;
  const detail = (json.error as { message?: unknown } | undefined)?.message;
  const msg = typeof detail === 'string' ? detail : `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) throw new ConductorError('unavailable', `Composio rejected the API key (${msg}). ${COMPOSIO_KEY_HELP}`);
  if (res.status === 404) throw new ConductorError('unavailable', `Composio: ${msg}. Check the MCP server ID in this connector's settings, or clear it to use a session with all your connected toolkits.`);
  throw new ConductorError('unavailable', `Composio answered ${res.status}: ${msg}`);
}

const strMap = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};

export async function composioUpstream(config: ComposioConfig, cred: CredentialContext, resolver: SecretResolver, timeoutMs: number): Promise<UpstreamClient> {
  // One Composio user per org or per agent; a grant-bound `user_id`/`entity_id` secret picks a different connected account.
  const userId = (await resolver.lookup('user_id')) ?? (await resolver.lookup('entity_id')) ?? config.entityId ?? (config.entityMode === 'agent' ? cred.agentId : cred.orgId);
  const apiKey = (await resolver.lookup(config.apiKeyRef ?? 'COMPOSIO_API_KEY')) ?? (await resolver.direct());
  if (!apiKey) throw new ConductorError('unavailable', `no Composio API key stored. ${COMPOSIO_KEY_HELP}`);
  const custom = await resolver.map(config.headers, 'config.headers');

  if (composioKeyType(apiKey, (config as { keyType?: string }).keyType) === 'consumer') {
    // Composio Connect: one endpoint for the key's account; apps are connected through Composio's own OAuth links.
    const url = urlOf(config.mcpUrl !== undefined ? await resolver.value(config.mcpUrl, 'config.mcpUrl') : COMPOSIO_CONNECT_MCP, 'composio mcpUrl');
    try {
      return await connectHttp({ url, headers: { ...custom, 'x-consumer-api-key': apiKey }, mode: 'auto' }, { timeoutMs, jitAuth: true });
    } catch (e) {
      if (/\b40[13]\b|unauthori[sz]ed|invalid.*key/i.test(errorMessage(e))) throw new ConductorError('unavailable', `Composio Connect rejected the consumer API key. ${COMPOSIO_KEY_HELP}`);
      throw e;
    }
  }

  const headers: Record<string, string> = { ...custom, 'x-api-key': apiKey };
  const base = config.baseUrl ?? COMPOSIO_API;

  let url: URL;
  if (config.mcpUrl !== undefined) {
    url = urlOf(await resolver.value(config.mcpUrl, 'config.mcpUrl'), 'composio mcpUrl');
    if (!url.searchParams.has('user_id')) url.searchParams.set('user_id', userId);
  } else if (config.serverId) {
    // A server created in Composio (dashboard or API): ask Composio for this user's URL on it.
    const r = await composioPost(base, '/api/v3.1/mcp/servers/generate', apiKey, { mcp_server_id: config.serverId, user_ids: [userId], managed_auth_by_composio: true }, timeoutMs);
    const issued = Array.isArray(r.user_ids_url) ? r.user_ids_url.find((u): u is string => typeof u === 'string') : undefined;
    if (!issued) throw new ConductorError('unavailable', 'Composio did not return an MCP URL for this server');
    url = urlOf(issued, 'Composio MCP URL');
  } else {
    // No server chosen: a Composio session exposes every toolkit this user has connected.
    const r = await composioPost(base, '/api/v3.1/tool_router/session', apiKey, { user_id: userId }, timeoutMs);
    const mcp = (r.mcp ?? {}) as { url?: unknown; headers?: unknown };
    if (typeof mcp.url !== 'string') throw new ConductorError('unavailable', 'Composio did not return an MCP URL for the session');
    url = urlOf(mcp.url, 'Composio session MCP URL');
    Object.assign(headers, strMap(mcp.headers));
  }
  try {
    return await connectHttp({ url, headers, mode: 'auto' }, { timeoutMs, jitAuth: true });
  } catch (e) {
    const m = errorMessage(e);
    if (/MCP server not found/i.test(m)) throw new ConductorError('unavailable', `Composio has no such MCP server. Check the server ID or URL in this connector's settings, or clear both to use a session with all your connected toolkits.`);
    if (/invalid api key|unauthori[sz]ed|\b401\b/i.test(m)) throw new ConductorError('unavailable', `Composio rejected the API key. ${COMPOSIO_KEY_HELP}`);
    throw e;
  }
}

export async function arcadeUpstream(config: ArcadeConfig, cred: CredentialContext, resolver: SecretResolver, timeoutMs: number): Promise<UpstreamClient> {
  let url: URL;
  if (config.mcpUrl !== undefined) url = urlOf(await resolver.value(config.mcpUrl, 'config.mcpUrl'), 'arcade mcpUrl');
  else {
    const slug = config.gateway?.trim();
    if (!slug || slug === PLACEHOLDER_GATEWAY) throw new ConductorError('validation', `This Arcade connector has no MCP gateway yet. ${ARCADE_GATEWAY_HELP}`);
    url = urlOf(`${(config.baseUrl ?? ARCADE_MCP).replace(/\/+$/, '')}/${encodeURIComponent(slug)}`, 'arcade gateway URL');
  }
  const headers = await resolver.map(config.headers, 'config.headers');
  const apiKey = (await resolver.lookup(config.apiKeyRef ?? 'ARCADE_API_KEY')) ?? (await resolver.direct());
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  // "Arcade Headers" user mode: tools act as this Arcade user.
  headers['Arcade-User-ID'] = (await resolver.lookup('user_id')) ?? config.userId ?? (config.userMode === 'agent' ? cred.agentId : cred.orgId);
  try {
    return await connectHttp({ url, headers, mode: 'auto' }, { timeoutMs, jitAuth: true });
  } catch (e) {
    const m = errorMessage(e);
    if (/gateway_not_found|gateway not found/i.test(m)) throw new ConductorError('unavailable', `Arcade has no MCP gateway at ${url.pathname.split('/').pop() ?? url.href}. ${ARCADE_GATEWAY_HELP}`);
    if (/\b401\b|unauthori[sz]ed|invalid.*key/i.test(m)) {
      throw new ConductorError('unavailable', 'Arcade rejected the request: check ARCADE_API_KEY, and that the gateway\'s user mode is "Arcade Headers" (Conductor authenticates with your API key and an Arcade-User-ID header).');
    }
    throw e;
  }
}
