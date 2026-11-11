import { z } from 'zod';
import type { AdapterCapabilities, AgentAdapter, Health, RunContext, RunEvent, RunOutcome, RunResult } from '../../contracts/adapter.js';
import { AdapterError, kindFromStatus } from '../shared/errors.js';
import { parseRunEvent } from '../shared/events.js';
import { ActiveRuns, withRun, type RunEnv } from '../shared/guard.js';

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL');

const configSchema = z.object({
  url: httpUrl,
  /** Extra NON-secret request headers. */
  headers: z.record(z.string(), z.string()).default({}),
  pollIntervalMs: z.number().int().min(50).max(60_000).default(2000),
});
type Config = z.infer<typeof configSchema>;

export const httpConfigJsonSchema: Record<string, unknown> = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', format: 'uri', description: 'Webhook that runs the agent.' },
    headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Non-secret request headers.' },
    pollIntervalMs: { type: 'integer', minimum: 50, maximum: 60000, default: 2000 },
    pricing: { type: 'object' },
  },
};

const responseSchema = z.object({
  finalText: z.string().optional(),
  status: z.string().optional(),
  outcome: z.enum(['completed', 'failed']).optional(),
  sessionId: z.string().optional(),
  steps: z.number().int().nonnegative().optional(),
  usage: z
    .object({
      tokensIn: z.number().nonnegative().default(0),
      tokensOut: z.number().nonnegative().default(0),
      costUsd: z.number().nonnegative().default(0),
    })
    .optional(),
  events: z.array(z.unknown()).optional(),
  error: z.object({ kind: z.enum(['rate_limit', 'auth', 'outage', 'invalid_request', 'other']).optional(), message: z.string() }).optional(),
  pollUrl: z.string().optional(),
  cancelUrl: z.string().optional(),
});
type AgentResponse = z.infer<typeof responseSchema>;

function parseConfig(raw: Record<string, unknown>): Config {
  const r = configSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new AdapterError('invalid_request', `http config invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return r.data;
}

/** The request body: the RunContext minus `secrets`, plus convenience URLs. */
export function buildHttpRunPayload(ctx: RunContext): Record<string, unknown> {
  const { secrets: _secrets, ...rest } = ctx;
  return { ...rest, mcpUrl: ctx.mcpEndpoints[0]?.url ?? null };
}

/** Follow-up URLs must stay on the webhook's origin so the bearer never travels elsewhere. */
function sameOriginUrl(base: string, next: string, what: string): string {
  let resolved: URL;
  try {
    resolved = new URL(next, base);
  } catch {
    throw new AdapterError('other', `agent returned an invalid ${what}`);
  }
  if (resolved.origin !== new URL(base).origin) throw new AdapterError('other', `agent returned a ${what} on a different origin`);
  return resolved.toString();
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * `http` — hand the run to any webhook. Synchronous agents answer with
 * `{ finalText, usage?, events? }`; long-running ones answer `202 { pollUrl }`
 * and are polled until done or the run's wall-clock limit.
 */
export class HttpAdapter implements AgentAdapter {
  readonly id = 'http';
  private readonly active = new ActiveRuns();

  capabilities(): AdapterCapabilities {
    return { tools: true, mcp: true, resume: false, vision: false, browser: 'via_mcp' };
  }

  async testConnection(cfg: { config: Record<string, unknown>; secrets: Record<string, string>; model?: string | null }): Promise<Health> {
    try {
      const config = parseConfig(cfg.config);
      const res = await fetch(config.url, { method: 'HEAD', signal: AbortSignal.timeout(8000), redirect: 'manual' });
      await res.body?.cancel();
      return res.status >= 500
        ? { ok: false, detail: `reachable but unhealthy (HTTP ${res.status})` }
        : { ok: true, detail: `reachable (HTTP ${res.status})` };
    } catch (e) {
      return { ok: false, detail: `unreachable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  run(ctx: RunContext, onEvent: (e: RunEvent) => void): Promise<RunResult> {
    return withRun(this.active, ctx, onEvent, { metered: false }, async (env) => {
      const cfg = parseConfig(ctx.config);
      const headers: Record<string, string> = {
        ...cfg.headers,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(ctx.secrets.apiKey ? { authorization: `Bearer ${ctx.secrets.apiKey}` } : {}),
      };
      let cancelUrl: string | undefined;
      try {
        let res = await this.request(cfg.url, { method: 'POST', headers, body: JSON.stringify(buildHttpRunPayload(ctx)) }, env);
        while (res.status === 202 || res.body.status === 'running' || res.body.status === 'queued' || res.body.status === 'pending') {
          if (res.body.cancelUrl) cancelUrl = sameOriginUrl(cfg.url, res.body.cancelUrl, 'cancelUrl');
          if (!res.body.pollUrl) throw new AdapterError('other', 'agent answered 202 without a pollUrl');
          const pollUrl = sameOriginUrl(cfg.url, res.body.pollUrl, 'pollUrl');
          env.emit({ type: 'status', status: 'agent accepted the run; polling for the result' });
          await sleep(cfg.pollIntervalMs, env.guard.signal);
          if (env.guard.reason) break;
          const { 'content-type': _ct, ...pollHeaders } = headers;
          res = await this.request(pollUrl, { method: 'GET', headers: pollHeaders }, env, res.body.pollUrl);
        }
        if (env.guard.reason) {
          await this.notifyCancel(cancelUrl, headers);
          return env.finish({ outcome: 'failed', steps: 0 });
        }
        return this.conclude(env, res.body);
      } catch (e) {
        if (env.guard.reason) {
          await this.notifyCancel(cancelUrl, headers);
          return env.finish({ outcome: 'failed', steps: 0 });
        }
        return env.fail(e, 0);
      }
    });
  }

  private async request(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    env: RunEnv,
    keepPollUrl?: string,
  ): Promise<{ status: number; body: AgentResponse }> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: env.guard.signal, redirect: 'error' });
    } catch (e) {
      if (env.guard.reason) throw e;
      throw new AdapterError('outage', `request to agent failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (res.status >= 400) {
      throw new AdapterError(kindFromStatus(res.status), `agent responded HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    let json: unknown = {};
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new AdapterError('other', 'agent response was not JSON');
      }
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new AdapterError('other', `agent response has an unexpected shape: ${parsed.error.issues[0]?.message ?? ''}`);
    // A poll answer that is still running may omit pollUrl; keep polling the same one.
    if (!parsed.data.pollUrl && keepPollUrl) parsed.data.pollUrl = keepPollUrl;
    return { status: res.status, body: parsed.data };
  }

  private conclude(env: RunEnv, body: AgentResponse): RunResult {
    let toolCalls = 0;
    let lastText = '';
    let usageFromEvents = false;
    for (const raw of body.events ?? []) {
      const event = parseRunEvent(raw);
      if (!event) continue;
      env.emit(event);
      if (event.type === 'tool_call') toolCalls++;
      else if (event.type === 'text') lastText = event.text;
      else if (event.type === 'usage') {
        usageFromEvents = true;
        env.meter.addReported(event.tokensIn, event.tokensOut, event.costUsd);
      }
    }
    if (body.usage && !usageFromEvents) {
      env.meter.addReported(body.usage.tokensIn, body.usage.tokensOut, body.usage.costUsd);
      env.emit({ type: 'usage', ...body.usage });
    }
    const finalText = body.finalText ?? lastText;
    if (finalText && finalText !== lastText) env.emit({ type: 'text', text: finalText });
    const steps = body.steps ?? Math.max(1, toolCalls);
    const base = { steps, finalText, sessionId: body.sessionId };

    const failed = body.outcome === 'failed' || body.status === 'failed' || body.status === 'error' || (body.error !== undefined && body.outcome !== 'completed');
    if (failed) {
      return env.fail(new AdapterError(body.error?.kind ?? 'other', body.error?.message ?? 'agent reported failure'), steps, base);
    }
    let outcome: RunOutcome = 'completed';
    if (env.meter.overBudget()) {
      env.guard.stop('budget');
      outcome = 'budget';
    }
    return env.finish({ ...base, outcome });
  }

  private async notifyCancel(cancelUrl: string | undefined, headers: Record<string, string>): Promise<void> {
    if (!cancelUrl) return;
    try {
      const res = await fetch(cancelUrl, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(3000), redirect: 'error' });
      await res.body?.cancel();
    } catch {
      // best effort
    }
  }

  async cancel(runId: string): Promise<void> {
    this.active.cancel(runId);
  }
}
