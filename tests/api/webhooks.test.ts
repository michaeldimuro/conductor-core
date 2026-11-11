import { createHmac } from 'node:crypto';
import { signComposioWebhook } from '../../src/connectors/composio-webhook.js';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './fake-services.js';
import { signSha256Header, verifySha256Header } from '../../src/api/index.js';
import type { DomainEvents } from '../../src/shared/events.js';
import type { Job } from '../../src/contracts/rows.js';
import type { WebhookDto } from '../../src/api/types.js';

let h: Harness;
let received: Array<DomainEvents['webhook.received']>;

beforeEach(async () => {
  h = await createHarness({ webhookRatePerMinute: 8 });
  received = [];
  h.kernel.bus.on('webhook.received', (e) => {
    received.push(e);
  });
});
afterEach(async () => {
  await h.close();
});

const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');
const api = (method: 'POST' | 'PATCH', url: string, payload: object) => h.api.app.inject({ method, url: `/api/v1${url}`, headers: h.owner, payload });

async function inboundHook(source: string, extra: object = {}): Promise<WebhookDto> {
  await h.kernel.secrets.set(`wh/${source}`, `${source}-signing-secret`);
  const res = await api('POST', '/orgs/acme/webhooks', { direction: 'in', name: source, source, agentId: h.agent.id, secretRef: `wh/${source}`, ...extra });
  expect(res.statusCode).toBe(200);
  return res.json();
}
const deliver = (id: string, payload: string, headers: Record<string, string>) =>
  h.api.app.inject({ method: 'POST', url: `/hooks/${id}`, headers: { 'content-type': 'application/json', ...headers }, payload });

describe('inbound webhooks', () => {
  it('verifies GitHub signatures over the raw body and wakes the agent', async () => {
    const hook = await inboundHook('github');
    // Unusual whitespace: the signature only matches if the exact bytes are verified.
    const raw = '{ "action":"opened",\n  "number": 7 }';
    const good = await deliver(hook.id, raw, { 'x-hub-signature-256': `sha256=${hmac('github-signing-secret', raw)}`, 'x-github-event': 'pull_request', 'x-github-delivery': 'd-1' });
    expect(good.statusCode).toBe(202);
    expect(good.json()).toEqual({ accepted: true });
    expect(received).toEqual([{
      orgId: h.orgA.id, webhookId: hook.id, agentId: h.agent.id,
      payload: { source: 'github', event: 'pull_request', deliveryId: 'd-1', body: { action: 'opened', number: 7 } },
    }]);
    const audit = h.kernel.audit.query({ orgId: h.orgA.id, action: 'webhook.received' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({ source: 'github', event: 'pull_request', bytes: raw.length });

    const bad = await deliver(hook.id, raw, { 'x-hub-signature-256': `sha256=${hmac('wrong-secret', raw)}`, 'x-github-event': 'pull_request' });
    expect(bad.statusCode).toBe(401);
    const tampered = await deliver(hook.id, raw.replace('7', '8'), { 'x-hub-signature-256': `sha256=${hmac('github-signing-secret', raw)}` });
    expect(tampered.statusCode).toBe(401);
    const unsigned = await deliver(hook.id, raw, {});
    expect(unsigned.statusCode).toBe(401);
    expect(received).toHaveLength(1);
    expect(h.kernel.audit.query({ action: 'webhook.rejected' })).toHaveLength(3);
  });

  it('ignores a replayed GitHub delivery id', async () => {
    const hook = await inboundHook('github');
    const raw = '{"zen":"x"}';
    const headers = { 'x-hub-signature-256': `sha256=${hmac('github-signing-secret', raw)}`, 'x-github-event': 'ping', 'x-github-delivery': 'same-id' };
    expect((await deliver(hook.id, raw, headers)).json()).toEqual({ accepted: true });
    const replay = await deliver(hook.id, raw, headers);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ accepted: false, reason: 'duplicate delivery' });
    expect(received).toHaveLength(1);
  });

  it('verifies Stripe signatures with a 5-minute tolerance', async () => {
    const hook = await inboundHook('stripe');
    const raw = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: {} });
    const now = Math.floor(h.kernel.clock.now() / 1000);
    const sig = (t: number, secret = 'stripe-signing-secret', body = raw) => `t=${t},v1=${hmac(secret, `${t}.${body}`)}`;

    expect((await deliver(hook.id, raw, { 'stripe-signature': sig(now, 'wrong') })).statusCode).toBe(401);
    expect((await deliver(hook.id, raw, { 'stripe-signature': sig(now - 301) })).statusCode).toBe(401); // stale / replayed
    expect((await deliver(hook.id, raw, { 'stripe-signature': sig(now + 301) })).statusCode).toBe(401);
    expect((await deliver(hook.id, raw, { 'stripe-signature': `t=${now}` })).statusCode).toBe(401);
    expect((await deliver(hook.id, raw, { 'stripe-signature': 'garbage' })).statusCode).toBe(401);
    expect(received).toHaveLength(0);

    // A rotated-secret header carries several v1 values; any match is enough.
    const ok = await deliver(hook.id, raw, { 'stripe-signature': `t=${now - 200},v1=${'0'.repeat(64)},v1=${hmac('stripe-signing-secret', `${now - 200}.${raw}`)}` });
    expect(ok.statusCode).toBe(202);
    expect(received[0]!.payload).toMatchObject({ source: 'stripe', event: 'invoice.paid', deliveryId: 'evt_1' });

    // The same signed delivery replayed after the tolerance window is refused.
    h.kernel.clock.advance(10 * 60_000);
    expect((await deliver(hook.id, raw, { 'stripe-signature': sig(now) })).statusCode).toBe(401);
  });

  it('verifies generic and Composio hooks with their own signature schemes and applies the events filter', async () => {
    const hook = await inboundHook('generic', { events: ['deploy.finished'] });
    const raw = JSON.stringify({ event: 'deploy.finished', sha: 'abc' });
    const headers = { 'x-conductor-signature': signSha256Header('generic-signing-secret', raw) };
    expect((await deliver(hook.id, raw, headers)).statusCode).toBe(202);
    expect(received).toHaveLength(1);
    expect((await deliver(hook.id, raw, { 'x-conductor-signature': 'sha256=deadbeef' })).statusCode).toBe(401);

    const other = JSON.stringify({ event: 'deploy.started' });
    const filtered = await deliver(hook.id, other, { 'x-conductor-signature': signSha256Header('generic-signing-secret', other) });
    expect(filtered.statusCode).toBe(202);
    expect(filtered.json()).toEqual({ accepted: false, reason: 'event filtered' });
    expect(received).toHaveLength(1);

    const composio = await inboundHook('composio');
    const composioTs = Math.floor(h.kernel.clock.now() / 1000);
    const body = 'not json at all';
    const res = await h.api.app.inject({
      method: 'POST', url: `/hooks/${composio.id}`, payload: body,
      headers: {
        'content-type': 'text/plain', 'x-conductor-event': 'gmail.new_message',
        // Composio signs in the Standard Webhooks format: id.timestamp.body.
        'webhook-id': 'msg_1', 'webhook-timestamp': String(composioTs),
        'webhook-signature': signComposioWebhook('composio-signing-secret', Buffer.from(body), 'msg_1', composioTs),
      },
    });
    expect(res.statusCode).toBe(202);
    expect(received[1]!.payload).toEqual({ source: 'composio', event: 'gmail.new_message', deliveryId: null, body });
  });

  it('rejects everything when no secret is configured', async () => {
    const noRef = (await api('POST', '/orgs/acme/webhooks', { direction: 'in', name: 'open', source: 'generic' })).json() as WebhookDto;
    const dangling = (await api('POST', '/orgs/acme/webhooks', { direction: 'in', name: 'dangling', source: 'generic', secretRef: 'wh/not-stored' })).json() as WebhookDto;
    const raw = '{}';
    for (const hook of [noRef, dangling]) {
      // Even a signature made with the empty string must not pass.
      const res = await deliver(hook.id, raw, { 'x-conductor-signature': signSha256Header('', raw) });
      expect(res.statusCode).toBe(401);
    }
    expect(received).toHaveLength(0);
  });

  it('404s unknown, outbound and disabled hooks, and rate-limits per hook', async () => {
    expect((await deliver('wh_missing', '{}', {})).statusCode).toBe(404);
    const out = (await api('POST', '/orgs/acme/webhooks', { direction: 'out', name: 'o', url: 'https://example.test/h', events: ['issue.done'] })).json() as WebhookDto;
    expect((await deliver(out.id, '{}', {})).statusCode).toBe(404);

    const hook = await inboundHook('generic');
    const other = await inboundHook('github');
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await deliver(hook.id, '{}', {})).statusCode);
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(statuses.slice(8)).toEqual([429, 429]);
    expect((await deliver(other.id, '{}', {})).statusCode).toBe(401); // separate bucket

    await api('PATCH', `/orgs/acme/webhooks/${other.id}`, { status: 'disabled' });
    expect((await deliver(other.id, '{}', {})).statusCode).toBe(404);
  });
});

describe('outbound webhooks', () => {
  let server: Server;
  let target: string;
  let hits: Array<{ headers: IncomingHttpHeaders; body: string }>;
  let respond: number;

  beforeEach(async () => {
    hits = [];
    respond = 200;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(respond).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sink`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  const job = (i: number): Job => ({ id: `job_${i}`, orgId: h.jobs[i]!.orgId ?? null, kind: 'webhook_out', payload: h.jobs[i]!.payload ?? {}, attempts: 1 }) as unknown as Job;
  const run = (i: number) => h.jobHandlers.get('webhook_out')!(job(i));

  it('enqueues a webhook_out job per matching active hook of the event org', async () => {
    await api('POST', '/orgs/acme/webhooks', { direction: 'out', name: 'done', url: target, events: ['issue.done', 'approval.requested'] });
    await api('POST', '/orgs/acme/webhooks', { direction: 'out', name: 'all', url: target, events: ['*'] });
    await api('POST', '/orgs/acme/webhooks', { direction: 'out', name: 'off', url: target, events: ['issue.done'], status: 'disabled' });
    await api('POST', '/orgs/globex/webhooks', { direction: 'out', name: 'other org', url: target, events: ['issue.done'] });
    expect(h.jobHandlers.has('webhook_out')).toBe(true);

    h.kernel.bus.emit('issue.done', { orgId: h.orgA.id, issueId: 'iss_1' });
    expect(h.jobs).toHaveLength(2);
    expect(h.jobs[0]).toMatchObject({ kind: 'webhook_out', orgId: h.orgA.id, payload: { delivery: { event: 'issue.done', orgId: h.orgA.id, data: { issueId: 'iss_1' } } } });

    h.kernel.bus.emit('issue.created', { orgId: h.orgA.id, issueId: 'iss_2', assigneeAgentId: null });
    expect(h.jobs).toHaveLength(3); // only the wildcard hook
    h.kernel.bus.emit('run.event', { orgId: h.orgA.id, runId: 'r', seq: 1, event: {} });
    h.kernel.bus.emit('org.kill_switch', { orgId: null, engaged: true });
    expect(h.jobs).toHaveLength(3);
    for (const name of ['approval.requested', 'approval.decided', 'run.finished'] as const) {
      h.kernel.bus.emit(name, { orgId: h.orgA.id } as never);
    }
    expect(h.jobs).toHaveLength(7);
  });

  it('POSTs signed JSON to the destination, with the issue attached', async () => {
    await h.kernel.secrets.set('wh/out', 'outbound-secret');
    await api('POST', '/orgs/acme/webhooks', { direction: 'out', name: 'done', url: target, events: ['issue.done'], secretRef: 'wh/out' });
    const issue = (await api('POST', '/orgs/acme/issues', { title: 'Ship it' })).json();
    h.kernel.bus.emit('issue.done', { orgId: h.orgA.id, issueId: issue.id });
    await run(0);

    expect(hits).toHaveLength(1);
    const { headers, body } = hits[0]!;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-conductor-event']).toBe('issue.done');
    expect(headers['x-conductor-signature']).toBe(`sha256=${hmac('outbound-secret', body)}`);
    expect(verifySha256Header('outbound-secret', Buffer.from(body), String(headers['x-conductor-signature']))).toBe(true);
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ event: 'issue.done', orgId: h.orgA.id, data: { issueId: issue.id, issue: { title: 'Ship it' } } });
    expect(headers['x-conductor-delivery']).toBe(parsed.id);
    expect(body).not.toContain('outbound-secret');
    expect(h.kernel.audit.query({ action: 'webhook.delivered' })).toHaveLength(1);
  });

  it('fails the job (so the queue retries with backoff) on a non-2xx answer or a missing secret', async () => {
    const hook = (await api('POST', '/orgs/acme/webhooks', { direction: 'out', name: 'done', url: target, events: ['issue.done'], secretRef: 'wh/missing' })).json() as WebhookDto;
    h.kernel.bus.emit('issue.done', { orgId: h.orgA.id, issueId: 'iss_1' });
    expect(h.jobs[0]!.maxAttempts).toBeGreaterThan(3);
    await expect(run(0)).rejects.toThrow(/signing secret/);
    expect(hits).toHaveLength(0);

    await h.kernel.secrets.set('wh/missing', 's');
    respond = 500;
    await expect(run(0)).rejects.toThrow(/answered 500/);
    respond = 204;
    await expect(run(0)).resolves.toBeUndefined();
    expect(hits).toHaveLength(2);

    // Deleted since the event fired: dropped, not retried.
    await h.api.app.inject({ method: 'DELETE', url: `/api/v1/orgs/acme/webhooks/${hook.id}`, headers: h.owner });
    await expect(run(0)).resolves.toBeUndefined();
    expect(hits).toHaveLength(2);
  });

  it('never delivers to a non-https, non-loopback destination even if the row says so', async () => {
    const hook = (await api('POST', '/orgs/acme/webhooks', { direction: 'out', name: 'done', url: target, events: ['issue.done'] })).json() as WebhookDto;
    h.kernel.sqlite.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run('http://169.254.169.254/latest/meta-data', hook.id);
    h.kernel.bus.emit('issue.done', { orgId: h.orgA.id, issueId: 'iss_1' });
    await expect(run(0)).rejects.toThrow(/https/);
    expect(hits).toHaveLength(0);
  });
});
