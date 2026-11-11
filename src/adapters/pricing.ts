import { z } from 'zod';
import { AdapterError } from './shared/errors.js';

/** USD per million tokens. */
export interface ModelPrice {
  /** Uncached input tokens. */
  input: number;
  output: number;
  /** Cache-hit input tokens. Defaults to the `input` rate when omitted. */
  cacheRead?: number;
  /** Cache-write input tokens (5-minute TTL for Anthropic). Defaults to the `input` rate when omitted. */
  cacheWrite?: number;
  /** Higher rates that apply to the whole request once its prompt exceeds `thresholdTokens`. */
  longContext?: { thresholdTokens: number; input: number; output: number };
}

/** Token counts for one model request (or a sum of requests on one model). */
export interface PricedUsage {
  /** Input tokens billed at the full rate, i.e. EXCLUDING cache reads and cache writes. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const anthropic = (input: number, output: number, cacheRead = input * 0.1): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});
const openai = (input: number, output: number, cacheRead = input * 0.1): ModelPrice => ({ input, output, cacheRead, cacheWrite: input });

/**
 * First-party list prices. Anthropic rows follow the published model table
 * (cache writes are the 5-minute rate, 1.25x input). OpenAI rows cover the
 * models whose list price is known to this build; anything else must be priced
 * through the binding's `config.pricing`, otherwise it is metered at $0 and the
 * adapter says so in a `status` event.
 */
export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // Anthropic — current generation
  'claude-fable-5-2': anthropic(8, 40, 0.2),
  'claude-mythos-5-2': anthropic(8, 40, 0.2),
  'claude-opus-5-5': anthropic(4, 20, 0.2),
  'claude-sonnet-5-5': anthropic(2, 10, 0.1),
  'claude-haiku-5-5': { ...anthropic(0.1, 0.5), longContext: { thresholdTokens: 100_000, input: 0.5, output: 2.5 } },
  // Anthropic — still served
  'claude-fable-5-1': anthropic(10, 50, 0.25),
  'claude-mythos-5-1': anthropic(10, 50, 0.25),
  'claude-fable-5': anthropic(10, 50, 1),
  'claude-mythos-5': anthropic(10, 50, 1),
  'claude-opus-5': anthropic(5, 25),
  'claude-opus-4-8': anthropic(5, 25),
  'claude-opus-4-7': anthropic(5, 25),
  'claude-opus-4-6': anthropic(5, 25),
  'claude-sonnet-5': anthropic(2, 10),
  'claude-sonnet-4-6': anthropic(3, 15),
  'claude-haiku-4-5': anthropic(1, 5),
  // OpenAI
  'gpt-5.5': openai(5, 30),
  'gpt-5.4': openai(2.5, 15),
  'gpt-5.4-mini': openai(0.75, 4.5),
  'gpt-5.4-nano': openai(0.2, 1.25),
  'gpt-5.2': openai(1.75, 14),
  'gpt-5.1': openai(1.25, 10),
  'gpt-5.1-codex': openai(1.25, 10),
  'gpt-5': openai(1.25, 10),
  'gpt-5-codex': openai(1.25, 10),
  'gpt-5-mini': openai(0.25, 2),
  'gpt-5-nano': openai(0.05, 0.4),
  'gpt-4.1': openai(2, 8, 0.5),
  'gpt-4.1-mini': openai(0.4, 1.6, 0.1),
  'gpt-4.1-nano': openai(0.1, 0.4, 0.025),
  'gpt-4o': openai(2.5, 10, 1.25),
  'gpt-4o-mini': openai(0.15, 0.6, 0.075),
  o3: openai(2, 8, 0.5),
  'o4-mini': openai(1.1, 4.4, 0.275),
});

const rate = z.number().finite().nonnegative();
const priceSchema = z.object({
  input: rate,
  output: rate,
  cacheRead: rate.optional(),
  cacheWrite: rate.optional(),
  longContext: z.object({ thresholdTokens: rate, input: rate, output: rate }).optional(),
});
const overrideSchema = z.union([priceSchema, z.record(z.string(), priceSchema)]);

/** Parsed `config.pricing`: one price for whatever model the binding runs, or a per-model map. */
export interface PricingOverrides {
  any?: ModelPrice;
  models: Record<string, ModelPrice>;
}

/**
 * Validate a binding's `config.pricing`. Accepts either a single
 * `{ input, output, cacheRead?, cacheWrite? }` (applies to every model the
 * binding runs) or `{ "<model>": { input, output, ... } }`.
 */
export function parsePricingOverrides(raw: unknown): PricingOverrides | undefined {
  if (raw === undefined || raw === null) return undefined;
  const single = priceSchema.safeParse(raw);
  if (single.success) return { any: single.data, models: {} };
  const parsed = overrideSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterError('invalid_request', `config.pricing is invalid: ${parsed.error.issues[0]?.message ?? 'bad shape'}`);
  }
  return { models: parsed.data as Record<string, ModelPrice> };
}

function lookup(table: Readonly<Record<string, ModelPrice>>, model: string): ModelPrice | undefined {
  const exact = table[model];
  if (exact) return exact;
  // Dated snapshots and deployment suffixes ("gpt-5.2-2025-12-11") resolve to the longest matching id.
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (model.startsWith(`${key}-`) || model.startsWith(`${key}@`) || model.startsWith(`${key}:`)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? table[best] : undefined;
}

/** Strip platform prefixes such as `anthropic.` / `us.anthropic.` / `openai/`. */
function bareModelId(model: string): string {
  const slash = model.lastIndexOf('/');
  const m = slash >= 0 ? model.slice(slash + 1) : model;
  const claude = m.indexOf('claude-');
  return claude > 0 ? m.slice(claude) : m;
}

/** The price row used for `model`, or undefined when neither the overrides nor the table know it. */
export function findPrice(model: string | null | undefined, overrides?: PricingOverrides): ModelPrice | undefined {
  if (!model) return overrides?.any;
  const bare = bareModelId(model);
  if (overrides) {
    const o = lookup(overrides.models, model) ?? lookup(overrides.models, bare);
    if (o) return o;
    if (overrides.any) return overrides.any;
  }
  return lookup(PRICE_TABLE, model) ?? lookup(PRICE_TABLE, bare);
}

/** Cost in USD of `usage` on `model`. Unknown models cost 0 — check `findPrice` to tell the difference. */
export function priceFor(model: string | null | undefined, usage: PricedUsage, overrides?: PricingOverrides): number {
  const price = findPrice(model, overrides);
  if (!price) return 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const promptTokens = usage.inputTokens + cacheRead + cacheWrite;
  const long = price.longContext && promptTokens > price.longContext.thresholdTokens ? price.longContext : undefined;
  const inRate = long?.input ?? price.input;
  const outRate = long?.output ?? price.output;
  const scale = long ? long.input / (price.input || 1) : 1;
  const readRate = (price.cacheRead ?? price.input) * (price.input ? scale : 1);
  const writeRate = (price.cacheWrite ?? price.input) * (price.input ? scale : 1);
  const usd =
    (usage.inputTokens * inRate + usage.outputTokens * outRate + cacheRead * readRate + cacheWrite * writeRate) / 1_000_000;
  return Number(usd.toFixed(8));
}
