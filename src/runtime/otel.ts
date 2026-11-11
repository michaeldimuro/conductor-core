import { randomBytes } from 'node:crypto';
import type { Kernel } from '../contracts/kernel.js';
import type { RunEvent } from '../contracts/adapter.js';
import type { RunJournal } from './journal.js';

/**
 * Optional OpenTelemetry export (PRD observability NFR). When
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, every finished run is exported as one
 * trace over OTLP/HTTP JSON: a root span for the run and a child span per
 * tool call. No SDK dependency; failures are logged and never affect runs.
 */
export function startOtelExport(k: Kernel, journal: RunJournal, endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT): () => void {
  if (!endpoint) return () => {};
  const url = `${endpoint.replace(/\/+$/, '')}/v1/traces`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const pair of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) headers[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }

  return k.bus.on('run.finished', async (e) => {
    try {
      const run = journal.find(e.runId);
      if (!run || !run.startedAt || run.outcome === 'no_work') return;
      const body = buildTrace(run, journal.events(run.orgId, run.id));
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) k.log.warn({ status: res.status }, 'otel export rejected');
    } catch (err) {
      k.log.warn({ err }, 'otel export failed');
    }
  });
}

type Attr = { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean } };
const str = (key: string, v: string | null | undefined): Attr[] => (v ? [{ key, value: { stringValue: v } }] : []);
const int = (key: string, v: number): Attr => ({ key, value: { intValue: String(Math.round(v)) } });
const nanos = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);

export function buildTrace(
  run: { id: string; orgId: string; agentId: string; issueId: string | null; provider: string | null; model: string | null; trigger: string; outcome: string | null; status: string; startedAt: number | null; endedAt: number | null; tokensIn: number; tokensOut: number; costUsd: number; steps: number; error: string | null },
  events: Array<{ seq: number; ts: number; event: RunEvent }>,
) {
  const traceId = randomBytes(16).toString('hex');
  const rootId = randomBytes(8).toString('hex');
  const start = run.startedAt ?? 0;
  const end = run.endedAt ?? start;
  const failed = run.status === 'failed';

  const spans: unknown[] = [
    {
      traceId, spanId: rootId, name: `run ${run.provider ?? 'unknown'}`, kind: 1,
      startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end),
      attributes: [
        ...str('conductor.run.id', run.id), ...str('conductor.org.id', run.orgId), ...str('conductor.agent.id', run.agentId),
        ...str('conductor.issue.id', run.issueId), ...str('conductor.trigger', run.trigger), ...str('conductor.outcome', run.outcome),
        ...str('gen_ai.system', run.provider), ...str('gen_ai.request.model', run.model),
        int('gen_ai.usage.input_tokens', run.tokensIn), int('gen_ai.usage.output_tokens', run.tokensOut),
        int('conductor.steps', run.steps), { key: 'conductor.cost_usd', value: { doubleValue: run.costUsd } },
      ],
      status: failed ? { code: 2, message: run.error ?? run.outcome ?? 'failed' } : { code: 1 },
    },
  ];

  const open = new Map<string, { name: string; ts: number }>();
  for (const { ts, event } of events) {
    if (event.type === 'tool_call') open.set(event.id, { name: event.name, ts });
    else if (event.type === 'tool_result') {
      const call = open.get(event.id);
      if (!call) continue;
      open.delete(event.id);
      spans.push({
        traceId, spanId: randomBytes(8).toString('hex'), parentSpanId: rootId, name: `tool ${call.name}`, kind: 3,
        startTimeUnixNano: nanos(call.ts), endTimeUnixNano: nanos(Math.max(ts, call.ts)),
        attributes: [...str('conductor.tool.name', call.name), int('conductor.tool.result_size', event.output.length)],
        status: event.isError ? { code: 2 } : { code: 1 },
      });
    }
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: [...str('service.name', 'conductord')] },
        scopeSpans: [{ scope: { name: 'conductor.runtime' }, spans }],
      },
    ],
  };
}
