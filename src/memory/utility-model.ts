import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { eq } from 'drizzle-orm';
import type { Kernel, UtilityModel } from '../contracts/kernel.js';
import type { BudgetService } from '../contracts/services.js';
import type { ProviderBinding } from '../contracts/types.js';
import { organizations } from '../db/schema/index.js';
import { errorMessage } from '../shared/errors.js';
import { offlineComplete } from './offline.js';
import { parseJsonLoose } from './text.js';

type Request = Parameters<UtilityModel['complete']>[0];
type Response = Awaited<ReturnType<UtilityModel['complete']>>;

export const DEFAULT_ANTHROPIC_UTILITY_MODEL = 'claude-haiku-5-5';
export const DEFAULT_OPENAI_UTILITY_MODEL = 'gpt-5-mini';
const DEFAULT_MAX_TOKENS = 16_000;
const JSON_INSTRUCTION = 'Respond with a single valid JSON object and nothing else: no prose, no markdown fences.';

/** USD per million tokens [input, output]. Overridable per binding via config.pricing. */
const PRICES: Array<[prefix: string, input: number, output: number]> = [
  ['claude-haiku-5-5', 0.1, 0.5],
  ['claude-haiku-4-5', 1, 5],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4', 3, 15],
  ['claude-opus-5-5', 4, 20],
  ['claude-opus', 5, 25],
  ['claude-fable-5-2', 8, 40],
  ['claude-fable', 10, 50],
];

interface Usage {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

function costOf(binding: ProviderBinding, model: string, tokensIn: number, tokensOut: number): number {
  const pricing = binding.config?.pricing as { inputPerMTok?: unknown; outputPerMTok?: unknown } | undefined;
  let input = 0;
  let output = 0;
  if (pricing && typeof pricing.inputPerMTok === 'number' && typeof pricing.outputPerMTok === 'number') {
    input = pricing.inputPerMTok;
    output = pricing.outputPerMTok;
  } else {
    const hit = PRICES.find(([prefix]) => model.startsWith(prefix));
    if (hit) [, input, output] = hit;
  }
  return (tokensIn * input + tokensOut * output) / 1_000_000;
}

function baseUrlOf(binding: ProviderBinding): string | undefined {
  const raw = binding.config?.baseUrl ?? binding.config?.baseURL;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

async function callAnthropic(binding: ProviderBinding, apiKey: string, model: string, req: Request): Promise<Usage | null> {
  const client = new Anthropic({ apiKey, baseURL: baseUrlOf(binding) });
  const effortRaw = binding.config?.effort;
  const effort = effortRaw === 'medium' || effortRaw === 'high' || effortRaw === 'xhigh' || effortRaw === 'max' ? effortRaw : 'low';
  const system = [req.system, req.json ? JSON_INSTRUCTION : undefined].filter((s): s is string => Boolean(s)).join('\n\n');
  const response = await client.messages.create({
    model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    // The utility model does cheap, high-volume work; thinking stays adaptive (the default).
    output_config: { effort },
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: req.prompt }],
  });
  if (response.stop_reason === 'refusal') return null;
  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }
  const u = response.usage;
  const tokensIn = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return { text, tokensIn, tokensOut: u.output_tokens };
}

async function callOpenAI(binding: ProviderBinding, apiKey: string, model: string, req: Request): Promise<Usage | null> {
  const client = new OpenAI({ apiKey, baseURL: baseUrlOf(binding) });
  const system = [req.system, req.json ? JSON_INSTRUCTION : undefined].filter((s): s is string => Boolean(s)).join('\n\n');
  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(req.json ? { response_format: { type: 'json_object' as const } } : {}),
    messages: [...(system ? [{ role: 'system' as const, content: system }] : []), { role: 'user' as const, content: req.prompt }],
  });
  const choice = response.choices[0];
  if (!choice || choice.message.refusal) return null;
  return { text: choice.message.content ?? '', tokensIn: response.usage?.prompt_tokens ?? 0, tokensOut: response.usage?.completion_tokens ?? 0 };
}

function describeFailure(e: unknown): { kind: string; status?: number } {
  if (e instanceof Anthropic.AuthenticationError || e instanceof OpenAI.AuthenticationError) return { kind: 'auth', status: 401 };
  if (e instanceof Anthropic.RateLimitError || e instanceof OpenAI.RateLimitError) return { kind: 'rate_limit', status: 429 };
  if (e instanceof Anthropic.BadRequestError || e instanceof OpenAI.BadRequestError) return { kind: 'invalid_request', status: 400 };
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError) return { kind: 'connection' };
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError) return { kind: 'api', status: typeof e.status === 'number' ? e.status : undefined };
  return { kind: 'other' };
}

/**
 * The org's cheap utility model. Resolves `organizations.utility_model`
 * (adapters `claude_api` / `openai_api`) with the key fetched from the secret
 * store at call time. With no binding, no key, a refusal or a provider
 * failure it answers from the deterministic offline heuristic (`offline: true`)
 * so the learning loop never depends on the network.
 */
export function createUtilityModel(kernel: Kernel, deps: { budgets?: Pick<BudgetService, 'record'> } = {}): UtilityModel {
  return {
    async complete(req: Request): Promise<Response> {
      const org = kernel.db.select({ utilityModel: organizations.utilityModel }).from(organizations).where(eq(organizations.id, req.orgId)).get();
      const binding = org?.utilityModel ?? null;
      if (!binding || (binding.adapter !== 'claude_api' && binding.adapter !== 'openai_api') || !binding.authRef) return offlineComplete(req);
      const apiKey = await kernel.secrets.get(binding.authRef);
      if (!apiKey) return offlineComplete(req);

      const anthropic = binding.adapter === 'claude_api';
      const model = binding.model ?? (anthropic ? DEFAULT_ANTHROPIC_UTILITY_MODEL : DEFAULT_OPENAI_UTILITY_MODEL);
      let usage: Usage | null;
      try {
        usage = anthropic ? await callAnthropic(binding, apiKey, model, req) : await callOpenAI(binding, apiKey, model, req);
      } catch (e) {
        kernel.log.warn({ orgId: req.orgId, purpose: req.purpose, model, ...describeFailure(e), err: errorMessage(e) }, 'utility model call failed; using offline heuristic');
        return offlineComplete(req);
      }
      if (usage === null) {
        kernel.log.warn({ orgId: req.orgId, purpose: req.purpose, model }, 'utility model declined; using offline heuristic');
        return offlineComplete(req);
      }
      const costUsd = costOf(binding, model, usage.tokensIn, usage.tokensOut);
      try {
        deps.budgets?.record({
          orgId: req.orgId,
          category: 'reflection',
          provider: binding.adapter,
          model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          costUsd,
        });
      } catch (e) {
        kernel.log.warn({ err: errorMessage(e) }, 'failed to record utility model spend');
      }
      return {
        text: usage.text,
        json: req.json ? parseJsonLoose(usage.text) : null,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costUsd,
        offline: false,
      };
    },
  };
}
