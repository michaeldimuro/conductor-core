import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { ConductorError, invalid } from '../../shared/errors.js';
import { resolveInside } from '../../shared/paths.js';
import { truncate } from '../../shared/util.js';
import type { OpenApiConfig } from '../config.js';
import type { UpstreamClient, UpstreamResult, UpstreamTool } from '../types.js';

type Json = Record<string, unknown>;
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;
const MAX_BODY = 200_000;

interface Param {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
}

interface Operation {
  tool: UpstreamTool;
  method: string;
  path: string;
  params: Param[];
  hasBody: boolean;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseSpecText(text: string): Json {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = parseYaml(text);
  }
  if (!isObj(doc) || !isObj(doc.paths)) throw invalid('OpenAPI spec has no "paths" object');
  return doc;
}

/** Load the spec from the inline object, a file under CONDUCTOR_HOME, or a URL (JSON or YAML). */
export async function loadSpec(config: OpenApiConfig, home: string, timeoutMs: number): Promise<Json> {
  if (config.spec) {
    if (!isObj(config.spec.paths)) throw invalid('OpenAPI spec has no "paths" object');
    return config.spec;
  }
  if (config.specPath) return parseSpecText(await readFile(resolveInside(home, config.specPath), 'utf8'));
  const res = await fetch(config.specUrl!, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!res.ok) throw new ConductorError('unavailable', `could not fetch OpenAPI spec: HTTP ${res.status}`);
  return parseSpecText(await res.text());
}

/** Inline local `#/…` references (cycle-safe, depth-limited) so tool schemas are self-contained. */
function deref(doc: Json, node: unknown, seen: Set<string> = new Set(), depth = 0): unknown {
  if (depth > 24) return {};
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, seen, depth + 1));
  if (!isObj(node)) return node;
  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) return {};
    let target: unknown = doc;
    for (const part of ref.slice(2).split('/')) {
      target = isObj(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    }
    return deref(doc, target ?? {}, new Set([...seen, ref]), depth + 1);
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(doc, v, seen, depth + 1);
  return out;
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'operation';

/** One tool per operation: name from operationId, input schema from parameters + JSON body. */
export function buildOperations(doc: Json): Operation[] {
  const ops: Operation[] = [];
  const used = new Set<string>();
  for (const [path, rawItem] of Object.entries(doc.paths as Json)) {
    const item = deref(doc, rawItem);
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      let name = safeName(typeof op.operationId === 'string' && op.operationId ? op.operationId : `${method}_${path}`);
      for (let i = 2; used.has(name); i++) name = `${safeName(name).slice(0, 60)}_${i}`;
      used.add(name);

      const properties: Json = {};
      const required: string[] = [];
      const params: Param[] = [];
      const merged = new Map<string, Json>();
      for (const p of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        if (isObj(p) && typeof p.name === 'string' && typeof p.in === 'string') merged.set(`${p.in}:${p.name}`, p);
      }
      for (const p of merged.values()) {
        const where = p.in as string;
        if (where !== 'path' && where !== 'query' && where !== 'header') continue;
        const pname = p.name as string;
        const schema = isObj(p.schema) ? { ...p.schema } : { type: 'string' };
        if (typeof p.description === 'string' && schema.description === undefined) schema.description = p.description;
        properties[pname] = schema;
        const isRequired = where === 'path' || p.required === true;
        if (isRequired) required.push(pname);
        params.push({ name: pname, in: where, required: isRequired });
      }
      let hasBody = false;
      const body = op.requestBody;
      if (isObj(body) && isObj(body.content)) {
        const json = Object.entries(body.content).find(([type]) => /json/i.test(type))?.[1];
        if (isObj(json)) {
          hasBody = true;
          properties.body = isObj(json.schema) ? json.schema : { type: 'object' };
          if (body.required === true) required.push('body');
        }
      }
      const description = [op.summary, op.description].filter((s): s is string => typeof s === 'string' && s.length > 0).join(' — ');
      ops.push({
        method: method.toUpperCase(),
        path,
        params,
        hasBody,
        tool: {
          name,
          description: description || `${method.toUpperCase()} ${path}`,
          inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
          annotations:
            method === 'get' || method === 'head' || method === 'options'
              ? { readOnlyHint: true, openWorldHint: true }
              : { readOnlyHint: false, destructiveHint: method === 'delete', openWorldHint: true },
        },
      });
    }
  }
  return ops;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

/** The spec's servers (variables defaulted, relative URLs resolved against the spec URL). */
export function specServers(doc: Json, specUrl?: string): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(doc.servers) ? doc.servers : []) {
    if (!isObj(s) || typeof s.url !== 'string') continue;
    let url = s.url;
    if (isObj(s.variables)) {
      for (const [k, v] of Object.entries(s.variables)) {
        if (isObj(v) && typeof v.default === 'string') url = url.split(`{${k}}`).join(v.default);
      }
    }
    try {
      const abs = new URL(url, specUrl);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') out.push(trimSlash(abs.href));
    } catch {
      // relative server URL without a spec URL to resolve against
    }
  }
  if (out.length === 0 && specUrl) out.push(new URL(specUrl).origin);
  return out;
}

export interface OpenApiAuth {
  headers: Record<string, string>;
  query: Record<string, string>;
}

/** Executes OpenAPI operations over HTTP; requests may only go to the spec's servers. */
export class OpenApiUpstream implements UpstreamClient {
  readonly closed = false;
  private readonly ops = new Map<string, Operation>();
  private readonly base: URL;
  private readonly allowed: URL[];

  constructor(
    doc: Json,
    opts: { baseUrl?: string; specUrl?: string },
    private readonly auth: OpenApiAuth,
    private readonly timeoutMs: number,
  ) {
    for (const op of buildOperations(doc)) this.ops.set(op.tool.name, op);
    const servers = specServers(doc, opts.specUrl);
    if (servers.length === 0) throw invalid('OpenAPI spec declares no usable servers');
    this.allowed = servers.map((s) => new URL(s));
    const base = trimSlash(opts.baseUrl ?? servers[0]!);
    if (!servers.includes(base)) throw new ConductorError('policy_denied', `base URL ${base} is not one of the OpenAPI spec's servers`);
    this.base = new URL(base);
  }

  private permitted(url: URL): boolean {
    return this.allowed.some((a) => {
      const prefix = trimSlash(a.pathname);
      return url.origin === a.origin && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
    });
  }

  async listTools(): Promise<UpstreamTool[]> {
    return [...this.ops.values()].map((o) => o.tool);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<UpstreamResult> {
    const op = this.ops.get(name);
    if (!op) return { content: [{ type: 'text', text: `unknown operation ${name}` }], isError: true };
    let path = op.path;
    const query = new URLSearchParams(this.auth.query);
    const headers: Record<string, string> = { accept: 'application/json', ...this.auth.headers };
    for (const p of op.params) {
      const v = args[p.name];
      if (v === undefined || v === null) {
        if (p.required) return { content: [{ type: 'text', text: `missing required parameter "${p.name}"` }], isError: true };
        continue;
      }
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (p.in === 'path') path = path.split(`{${p.name}}`).join(encodeURIComponent(s));
      else if (p.in === 'query') {
        if (Array.isArray(v)) for (const item of v) query.append(p.name, String(item));
        else query.set(p.name, s);
      } else if (!/^(authorization|cookie|host)$/i.test(p.name)) headers[p.name] = s;
    }
    const url = new URL(`${trimSlash(this.base.href)}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [k, v] of query) url.searchParams.append(k, v);
    if (!this.permitted(url)) throw new ConductorError('policy_denied', `request to ${url.origin} is outside the OpenAPI spec's servers`);

    let body: string | undefined;
    if (op.hasBody && args.body !== undefined) {
      body = JSON.stringify(args.body);
      headers['content-type'] = 'application/json';
    }
    // Redirects are never followed: a 3xx could send credentials off the allowlist.
    const res = await fetch(url, { method: op.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      return { content: [{ type: 'text', text: `HTTP ${res.status}: redirect to ${res.headers.get('location') ?? 'unknown'} refused (not followed)` }], isError: true };
    }
    const text = truncate(await res.text(), MAX_BODY);
    return res.ok ? { content: [{ type: 'text', text: text || `HTTP ${res.status}` }] } : { content: [{ type: 'text', text: `HTTP ${res.status}: ${text}` }], isError: true };
  }

  async close(): Promise<void> {}
}
