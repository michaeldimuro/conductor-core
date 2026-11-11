import OpenAI from 'openai';
import { eq } from 'drizzle-orm';
import type { Embedder, Kernel } from '../contracts/kernel.js';
import { settings } from '../db/schema/index.js';
import { ConductorError } from '../shared/errors.js';
import { contentTokens } from './text.js';

export const LOCAL_EMBED_DIMS = 384;

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Zero-dependency, deterministic embedder: signed feature hashing of stemmed
 * words, word bigrams and character trigrams, sublinear TF, L2-normalised.
 * Texts sharing vocabulary land measurably closer than unrelated texts.
 */
export class LocalHashEmbedder implements Embedder {
  readonly id: string;
  readonly dims: number;

  constructor(dims = LOCAL_EMBED_DIMS) {
    this.dims = dims;
    this.id = `local-hash-v1:${dims}`;
  }

  embedOne(text: string): Float32Array {
    const features = new Map<string, { count: number; weight: number }>();
    const add = (key: string, weight: number) => {
      const f = features.get(key);
      if (f) f.count += 1;
      else features.set(key, { count: 1, weight });
    };
    const words = contentTokens(text);
    words.forEach((w, i) => {
      add(`w:${w}`, 1);
      const next = words[i + 1];
      if (next) add(`b:${w} ${next}`, 0.5);
      if (w.length >= 4) {
        const padded = `^${w}$`;
        for (let j = 0; j + 3 <= padded.length; j++) add(`c:${padded.slice(j, j + 3)}`, 0.2);
      }
    });
    const vec = new Float32Array(this.dims);
    for (const [key, f] of features) {
      const h = fnv1a(key);
      const idx = h % this.dims;
      const sign = (fnv1a(`s|${key}`) & 1) === 0 ? 1 : -1;
      vec[idx] = (vec[idx] ?? 0) + sign * f.weight * (1 + Math.log(f.count));
    }
    return l2normalize(vec);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }
}

export interface OpenAIEmbedderOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  dims?: number;
}

/** `text-embedding-3-small` through the official SDK. Never used unless explicitly configured. */
export class OpenAIEmbedder implements Embedder {
  readonly id: string;
  readonly dims: number;
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: OpenAIEmbedderOptions) {
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dims = opts.dims ?? 1536;
    this.id = `openai:${this.model}:${this.dims}`;
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2 });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 96) {
      const batch = texts.slice(i, i + 96).map((t) => (t.length > 0 ? t.slice(0, 24_000) : ' '));
      const res = await this.client.embeddings.create({ model: this.model, input: batch, encoding_format: 'float', dimensions: this.dims });
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      if (sorted.length !== batch.length) throw new ConductorError('unavailable', 'embedding provider returned an unexpected number of vectors');
      for (const d of sorted) {
        if (d.embedding.length !== this.dims) {
          throw new ConductorError('unavailable', `embedding provider returned ${d.embedding.length} dims, expected ${this.dims}`);
        }
        out.push(l2normalize(Float32Array.from(d.embedding)));
      }
    }
    return out;
  }
}

/** An embedder whose identity is settled asynchronously (secret lookup) before first use. */
export interface ResolvableEmbedder extends Embedder {
  /** Re-read settings + secret and settle on a concrete embedder. Cheap; cached briefly. */
  resolve(force?: boolean): Promise<void>;
}

export function isResolvable(e: Embedder): e is ResolvableEmbedder {
  return typeof (e as Partial<ResolvableEmbedder>).resolve === 'function';
}

const RESOLVE_TTL_MS = 60_000;
export const DEFAULT_OPENAI_EMBED_AUTH_REF = 'openai_api_key';

/**
 * Default: LocalHashEmbedder. OpenAI is selected only when the `settings` key
 * `embeddings.provider` = "openai" AND the secret (`embeddings.authRef`,
 * default "openai_api_key") exists. `embeddings.baseUrl` overrides the endpoint.
 */
export function createEmbedder(kernel: Kernel): ResolvableEmbedder {
  const local = new LocalHashEmbedder();
  let current: Embedder = local;
  let currentKey = 'local';
  let resolvedAt: number | null = null;

  const setting = (key: string): unknown =>
    kernel.db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()?.value ?? null;

  const resolve = async (force = false): Promise<void> => {
    const now = kernel.clock.now();
    if (!force && resolvedAt !== null && now - resolvedAt < RESOLVE_TTL_MS) return;
    resolvedAt = now;
    if (setting('embeddings.provider') !== 'openai') {
      current = local;
      currentKey = 'local';
      return;
    }
    const authRefRaw = setting('embeddings.authRef');
    const authRef = typeof authRefRaw === 'string' && authRefRaw ? authRefRaw : DEFAULT_OPENAI_EMBED_AUTH_REF;
    const baseRaw = setting('embeddings.baseUrl');
    const baseURL = typeof baseRaw === 'string' && baseRaw ? baseRaw : undefined;
    const apiKey = await kernel.secrets.get(authRef);
    if (!apiKey) {
      current = local;
      currentKey = 'local';
      return;
    }
    const key = `openai|${authRef}|${baseURL ?? ''}`;
    if (key !== currentKey) {
      current = new OpenAIEmbedder({ apiKey, baseURL });
      currentKey = key;
    }
  };

  return {
    get id() {
      return current.id;
    },
    get dims() {
      return current.dims;
    },
    resolve,
    async embed(texts: string[]) {
      await resolve();
      return current.embed(texts);
    },
  };
}

export function l2normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function vecToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function bufferToVec(b: Buffer): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
