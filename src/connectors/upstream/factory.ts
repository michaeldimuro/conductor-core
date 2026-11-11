import type { Kernel } from '../../contracts/kernel.js';
import { ConductorError, invalid } from '../../shared/errors.js';
import { parseConfig, type HttpConfig, type OpenApiConfig } from '../config.js';
import { SecretResolver } from '../secrets.js';
import { AuthRequiredError, type CredentialContext, type UpstreamClient } from '../types.js';
import { connectHttp, connectStdio, discoverAuthUrl } from './mcp.js';
import { arcadeUpstream, composioUpstream } from './hosted.js';
import { loadSpec, OpenApiUpstream } from './openapi.js';


export interface Connected {
  client: UpstreamClient;
  resolver: SecretResolver;
}

/**
 * Pool key part for "which credentials": clients are shared per
 * (connector, credential ref); per-agent Composio entities / Arcade users get
 * their own connection.
 */
export function credentialKey(cred: CredentialContext): string {
  const cfg = cred.connector.config as { entityMode?: unknown; userMode?: unknown };
  const perAgent = (cred.connector.kind === 'composio' && cfg.entityMode === 'agent') || (cred.connector.kind === 'arcade' && cfg.userMode === 'agent');
  return `${cred.authRefs.join(',')}${perAgent ? `|agent:${cred.agentId}` : ''}`;
}

function parseUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(`${what} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid(`${what} must be http(s)`);
  return url;
}

/** Stored OAuth token: a bare access token, or JSON `{ access_token, expires_at }` (epoch seconds or ms). */
function readOAuthToken(raw: string | null, now: number): string | null {
  if (!raw) return null;
  if (!raw.trim().startsWith('{')) return raw.trim();
  try {
    const t = JSON.parse(raw) as { access_token?: unknown; expires_at?: unknown };
    if (typeof t.access_token !== 'string' || !t.access_token) return null;
    if (typeof t.expires_at === 'number') {
      const expiresMs = t.expires_at < 1e12 ? t.expires_at * 1000 : t.expires_at;
      if (expiresMs <= now) return null;
    }
    return t.access_token;
  } catch {
    return null;
  }
}

async function httpUpstream(k: Kernel, config: HttpConfig, resolver: SecretResolver, timeoutMs: number): Promise<UpstreamClient> {
  const url = parseUrl(await resolver.value(config.url, 'config.url'), 'connector url');
  const headers = await resolver.map(config.headers, 'config.headers');
  const auth = config.auth;
  const authUrl = () => discoverAuthUrl(url, { clientId: auth?.clientId, scope: auth?.scope });
  if (auth?.type === 'oauth') {
    const token = readOAuthToken(await resolver.lookup(auth.secretRef ?? 'access_token'), k.clock.now());
    if (!token) throw new AuthRequiredError('no valid OAuth access token is stored for this connector', await authUrl());
    headers.Authorization = `Bearer ${token}`;
  } else if (auth?.type === 'bearer') {
    const token = (await resolver.lookup(auth.secretRef ?? 'token')) ?? (await resolver.direct());
    if (!token) throw new ConductorError('unavailable', `missing secret "${auth.secretRef ?? 'token'}" for bearer auth`);
    headers.Authorization = `Bearer ${token}`;
  } else if (!auth && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
    const direct = await resolver.direct();
    if (direct) headers.Authorization = `Bearer ${direct}`;
  }
  return connectHttp({ url, headers, mode: config.transport ?? 'auto' }, { timeoutMs, authUrl });
}

async function openapiUpstream(k: Kernel, config: OpenApiConfig, resolver: SecretResolver, timeoutMs: number): Promise<UpstreamClient> {
  const doc = await loadSpec(config, k.paths.home, timeoutMs);
  const headers = await resolver.map(config.headers, 'config.headers');
  const query: Record<string, string> = {};
  if (config.auth) {
    const fallback = config.auth.type === 'bearer' ? 'token' : 'api_key';
    const secret = (await resolver.lookup(config.auth.secretRef ?? fallback)) ?? (await resolver.direct());
    if (!secret) throw new ConductorError('unavailable', `missing secret "${config.auth.secretRef ?? fallback}" for OpenAPI auth`);
    if (config.auth.type === 'bearer') headers.Authorization = `Bearer ${secret}`;
    else if (config.auth.in === 'query') query[config.auth.name ?? 'api_key'] = secret;
    else headers[config.auth.name ?? 'X-API-Key'] = secret;
  }
  return new OpenApiUpstream(doc, { baseUrl: config.baseUrl, specUrl: config.specUrl }, { headers, query }, timeoutMs);
}

/** Open a connection to an upstream connector, injecting credentials from the secret store. */
export async function connectUpstream(k: Kernel, cred: CredentialContext, timeoutMs: number): Promise<Connected> {
  const { connector } = cred;
  const resolver = new SecretResolver(k.secrets, cred.authRefs, cred.orgSlug);
  let client: UpstreamClient;
  switch (connector.kind) {
    case 'mcp_stdio': {
      const config = parseConfig('mcp_stdio', connector.config);
      client = await connectStdio(
        { command: config.command, args: config.args ?? [], env: await resolver.map(config.env, 'config.env'), cwd: config.cwd },
        { timeoutMs },
      );
      break;
    }
    case 'mcp_http':
      client = await httpUpstream(k, parseConfig('mcp_http', connector.config), resolver, timeoutMs);
      break;
    case 'composio':
      client = await composioUpstream(parseConfig('composio', connector.config), cred, resolver, timeoutMs);
      break;
    case 'arcade':
      client = await arcadeUpstream(parseConfig('arcade', connector.config), cred, resolver, timeoutMs);
      break;
    case 'openapi':
      client = await openapiUpstream(k, parseConfig('openapi', connector.config), resolver, timeoutMs);
      break;
    default:
      throw invalid(`connector kind ${connector.kind} has no upstream`);
  }
  return { client, resolver };
}
