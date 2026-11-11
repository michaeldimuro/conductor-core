import { z } from 'zod';
import type { Kernel } from '../contracts/kernel.js';
import { ConductorError, errorMessage } from '../shared/errors.js';
import { getSetting } from './indexes.js';

/** One interface over every optional external memory service. */
export interface ExternalMemoryBackend {
  readonly kind: string;
  /** Mirror one memory. Returns the backend's own id for it (used for delete). */
  write(item: { id: string; content: string; scopeKey: string; metadata: Record<string, unknown> }): Promise<{ externalId: string | null }>;
  search(query: string, opts: { scopeKeys: string[]; limit: number }): Promise<ExternalHit[]>;
  delete(externalId: string, scopeKey: string): Promise<void>;
}

export interface ExternalHit {
  externalId: string | null;
  /** The Conductor memory id carried in metadata, when the backend returns it. */
  conductorId: string | null;
  content: string;
  /** 0..1, higher is better. */
  score: number;
}

export const EXTERNAL_KINDS = ['honcho', 'mem0', 'zep', 'supermemory'] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];

export const backendConfigSchema = z.object({
  kind: z.enum(EXTERNAL_KINDS),
  baseUrl: z.url().optional(),
  authRef: z.string().min(1),
  /** Backend-specific, non-secret options (e.g. Honcho workspace). */
  options: z.record(z.string(), z.string()).optional(),
});
export type BackendConfig = z.infer<typeof backendConfigSchema>;

const DEFAULT_BASE: Record<ExternalKind, string> = {
  honcho: 'https://api.honcho.dev',
  mem0: 'https://api.mem0.ai',
  zep: 'https://api.getzep.com',
  supermemory: 'https://api.supermemory.ai',
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
const conductorIdOf = (metadata: unknown): string | null => str(obj(metadata).conductor_id);

class Rest {
  constructor(
    private readonly base: string,
    private readonly headers: Record<string, string>,
    private readonly timeoutMs = 10_000,
  ) {}

  async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.base.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...this.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new ConductorError('unavailable', `external memory backend responded ${res.status} for ${method} ${path}`);
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
}

/** Mem0 platform REST API. `infer: false` stores the text verbatim so ids map 1:1. */
class Mem0Backend implements ExternalMemoryBackend {
  readonly kind = 'mem0';
  constructor(private readonly rest: Rest) {}

  async write(item: { id: string; content: string; scopeKey: string; metadata: Record<string, unknown> }) {
    const res = await this.rest.call('POST', '/v1/memories/', {
      messages: [{ role: 'user', content: item.content }],
      user_id: item.scopeKey,
      metadata: { ...item.metadata, conductor_id: item.id },
      infer: false,
    });
    const first = arr(Array.isArray(res) ? res : obj(res).results)[0];
    return { externalId: str(obj(first).id) };
  }

  async search(query: string, opts: { scopeKeys: string[]; limit: number }) {
    const res = await this.rest.call('POST', '/v2/memories/search/', {
      query,
      filters: { OR: opts.scopeKeys.map((user_id) => ({ user_id })) },
      top_k: opts.limit,
    });
    return arr(Array.isArray(res) ? res : (obj(res).results ?? obj(res).memories)).map((r): ExternalHit => {
      const o = obj(r);
      return { externalId: str(o.id), conductorId: conductorIdOf(o.metadata), content: str(o.memory) ?? '', score: num(o.score, 0.5) };
    });
  }

  async delete(externalId: string) {
    await this.rest.call('DELETE', `/v1/memories/${encodeURIComponent(externalId)}/`);
  }
}

/** Zep Cloud graph API: each memory is a text episode on the scope's user graph. */
class ZepBackend implements ExternalMemoryBackend {
  readonly kind = 'zep';
  constructor(private readonly rest: Rest) {}

  async write(item: { id: string; content: string; scopeKey: string; metadata: Record<string, unknown> }) {
    const res = await this.rest.call('POST', '/api/v2/graph', {
      user_id: item.scopeKey,
      type: 'text',
      data: item.content,
      source_description: `conductor:${item.id}`,
    });
    return { externalId: str(obj(res).uuid) };
  }

  async search(query: string, opts: { scopeKeys: string[]; limit: number }) {
    const hits: ExternalHit[] = [];
    for (const user_id of opts.scopeKeys) {
      const res = await this.rest.call('POST', '/api/v2/graph/search', { user_id, query: query.slice(0, 400), scope: 'episodes', limit: opts.limit });
      for (const e of arr(obj(res).episodes)) {
        const o = obj(e);
        const src = str(o.source_description);
        hits.push({
          externalId: str(o.uuid),
          conductorId: src?.startsWith('conductor:') ? src.slice('conductor:'.length) : null,
          content: str(o.content) ?? '',
          score: num(o.score, 0.5),
        });
      }
    }
    return hits;
  }

  async delete(externalId: string) {
    await this.rest.call('DELETE', `/api/v2/graph/episodes/${encodeURIComponent(externalId)}`);
  }
}

/** Supermemory v3: documents tagged with the scope as a container tag. */
class SupermemoryBackend implements ExternalMemoryBackend {
  readonly kind = 'supermemory';
  constructor(private readonly rest: Rest) {}

  async write(item: { id: string; content: string; scopeKey: string; metadata: Record<string, unknown> }) {
    const res = await this.rest.call('POST', '/v3/documents', {
      content: item.content,
      containerTags: [item.scopeKey],
      customId: item.id,
      metadata: { ...item.metadata, conductor_id: item.id },
    });
    return { externalId: str(obj(res).id) };
  }

  async search(query: string, opts: { scopeKeys: string[]; limit: number }) {
    const res = await this.rest.call('POST', '/v3/search', { q: query, containerTags: opts.scopeKeys, limit: opts.limit });
    return arr(obj(res).results).map((r): ExternalHit => {
      const o = obj(r);
      const chunk = obj(arr(o.chunks)[0]);
      return {
        externalId: str(o.documentId) ?? str(o.id),
        conductorId: conductorIdOf(o.metadata),
        content: str(chunk.content) ?? str(o.content) ?? '',
        score: num(o.score, num(chunk.score, 0.5)),
      };
    });
  }

  async delete(externalId: string) {
    await this.rest.call('DELETE', `/v3/documents/${encodeURIComponent(externalId)}`);
  }
}

/**
 * Honcho v2: memories are messages from a peer (the scope) in one long-lived
 * session per scope. Honcho messages are immutable, so delete tombstones the
 * message through its metadata and search drops tombstoned hits.
 */
class HonchoBackend implements ExternalMemoryBackend {
  readonly kind = 'honcho';
  constructor(
    private readonly rest: Rest,
    private readonly workspace: string,
  ) {}

  private session(scopeKey: string): string {
    return `/v2/workspaces/${encodeURIComponent(this.workspace)}/sessions/${encodeURIComponent(scopeKey)}`;
  }

  async write(item: { id: string; content: string; scopeKey: string; metadata: Record<string, unknown> }) {
    const res = await this.rest.call('POST', `${this.session(item.scopeKey)}/messages`, {
      messages: [{ peer_id: item.scopeKey, content: item.content, metadata: { ...item.metadata, conductor_id: item.id } }],
    });
    return { externalId: str(obj(arr(res)[0]).id) };
  }

  async search(query: string, opts: { scopeKeys: string[]; limit: number }) {
    const hits: ExternalHit[] = [];
    for (const scopeKey of opts.scopeKeys) {
      const res = await this.rest.call('POST', `${this.session(scopeKey)}/search`, { query, limit: opts.limit });
      arr(Array.isArray(res) ? res : obj(res).items).forEach((m, i) => {
        const o = obj(m);
        if (obj(o.metadata).deleted === true) return;
        // Honcho returns hits in rank order without a score.
        hits.push({ externalId: str(o.id), conductorId: conductorIdOf(o.metadata), content: str(o.content) ?? '', score: num(o.score, 1 / (1 + i * 0.25)) });
      });
    }
    return hits;
  }

  async delete(externalId: string, scopeKey: string) {
    await this.rest.call('PUT', `${this.session(scopeKey)}/messages/${encodeURIComponent(externalId)}`, { metadata: { deleted: true } });
  }
}

export function createExternalBackend(config: BackendConfig, apiKey: string): ExternalMemoryBackend {
  const base = config.baseUrl ?? DEFAULT_BASE[config.kind];
  switch (config.kind) {
    case 'mem0':
      return new Mem0Backend(new Rest(base, { authorization: `Token ${apiKey}` }));
    case 'zep':
      return new ZepBackend(new Rest(base, { authorization: `Api-Key ${apiKey}` }));
    case 'supermemory':
      return new SupermemoryBackend(new Rest(base, { authorization: `Bearer ${apiKey}` }));
    case 'honcho':
      return new HonchoBackend(new Rest(base, { authorization: `Bearer ${apiKey}` }), config.options?.workspace ?? 'conductor');
  }
}

export const backendSettingKey = (orgId: string): string => `memory.backend.${orgId}`;
export const externalRefKey = (memoryId: string): string => `memory.ext.${memoryId}`;

/** Stable, URL-safe scope identifier on the external side; includes the org so tenants never mix. */
export function externalScopeKey(orgId: string, scope: string, scopeId: string): string {
  return `conductor-${orgId}-${scope}-${scopeId}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Resolve the org's enabled backend from `settings["memory.backend.<orgId>"]`
 * = `{ kind, baseUrl?, authRef }`. Null when disabled, misconfigured or the
 * secret is missing — local memory always keeps working.
 */
export async function resolveBackend(kernel: Kernel, orgId: string): Promise<ExternalMemoryBackend | null> {
  const raw = getSetting(kernel.db, backendSettingKey(orgId));
  if (raw === null) return null;
  const parsed = backendConfigSchema.safeParse(raw);
  if (!parsed.success) {
    kernel.log.warn({ orgId }, 'invalid memory.backend setting; external memory disabled');
    return null;
  }
  try {
    const apiKey = await kernel.secrets.get(parsed.data.authRef);
    if (!apiKey) return null;
    return createExternalBackend(parsed.data, apiKey);
  } catch (e) {
    kernel.log.warn({ orgId, err: errorMessage(e) }, 'could not resolve external memory backend');
    return null;
  }
}
