import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { startGateways, type Gateways } from '../../src/gateways/index.js';
import type { Agent, Gateway, Organization } from '../../src/contracts/rows.js';
import { createFakeServices, getChatRow, insertGateway, waitFor, type FakeServices } from './fake-services.js';
import { slackSignature, startSlackMock, type SlackMock } from './mock-servers.js';

const BOT_TOKEN = 'xoxb-test-000-bot';
const SIGNING_SECRET = 'slack-signing-secret-for-tests';
const CHANNEL = 'C0OWNER';
const USER = 'U0OWNER';

describe('gateways / slack (FR-17)', () => {
  let f: FakeServices;
  let slack: SlackMock;
  let gw: Gateways | null;
  let app: FastifyInstance;
  let acme: Organization;
  let ada: Agent;
  let row: Gateway;

  const nowSec = () => Math.floor(f.k.clock.now() / 1000);
  const start = async () => {
    gw = await startGateways(f.services, { pollMs: 0 });
    app = Fastify();
    await app.register(gw.routes);
    await app.ready();
    return gw;
  };
  const post = (path: string, body: string, contentType: string, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: `/gateways/slack/${row.id}/${path}`, payload: body, headers: { 'content-type': contentType, ...headers } });
  const event = (payload: Record<string, unknown>, ts = nowSec()) => {
    const body = JSON.stringify(payload);
    return post('events', body, 'application/json', slackSignature(SIGNING_SECRET, ts, body));
  };
  const messageEvent = (text: string, extra: Record<string, unknown> = {}, id = `Ev${Math.random()}`) =>
    event({ type: 'event_callback', event_id: id, event: { type: 'message', channel: CHANNEL, user: USER, text, ts: `${Math.random()}`, ...extra } });
  const interaction = (payload: Record<string, unknown>) => {
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    return post('interactions', body, 'application/x-www-form-urlencoded', slackSignature(SIGNING_SECRET, nowSec(), body));
  };
  const press = (action: string, messageTs: string, text: string) => interaction({
    type: 'block_actions', user: { id: USER }, channel: { id: CHANNEL }, message: { ts: messageTs, text }, actions: [{ action_id: 'conductor_0', value: action }],
  });
  const posted = () => slack.of('chat.postMessage');
  const postedText = (text: string) => waitFor(() => posted().find((m) => m.text === text), `slack message "${text}"`);

  beforeEach(async () => {
    f = createFakeServices();
    slack = await startSlackMock(BOT_TOKEN);
    gw = null;
    await f.k.secrets.set('slack-app', JSON.stringify({ token: BOT_TOKEN, signingSecret: SIGNING_SECRET }));
    acme = seedOrg(f.k, 'Acme');
    ada = seedAgent(f.k, acme.id, seedDept(f.k, acme.id).id, 'Ada');
    row = insertGateway(f.k, { kind: 'slack', orgId: acme.id, authRef: 'slack-app', config: { apiBaseUrl: slack.url, allowedChatIds: [CHANNEL], allowedUserIds: [USER] } });
  });
  afterEach(async () => {
    await app?.close();
    await gw?.stop();
    await slack.close();
    f.dispose();
  });

  describe('request verification', () => {
    it('answers the URL-verification challenge for a correctly signed request', async () => {
      await start();
      const res = await event({ type: 'url_verification', challenge: 'challenge-abc' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ challenge: 'challenge-abc' });
    });

    it('rejects a bad signature, a tampered body, a missing signature and an unknown gateway', async () => {
      await start();
      const body = JSON.stringify({ type: 'url_verification', challenge: 'x' });
      const good = slackSignature(SIGNING_SECRET, nowSec(), body);
      const forged = await post('events', body, 'application/json', slackSignature('some-other-secret', nowSec(), body));
      expect(forged.statusCode).toBe(401);
      const tampered = await post('events', body.replace('"x"', '"y"'), 'application/json', good);
      expect(tampered.statusCode).toBe(401);
      expect((await post('events', body, 'application/json', {})).statusCode).toBe(401);
      expect((await post('interactions', 'payload=%7B%7D', 'application/x-www-form-urlencoded', { ...good, 'x-slack-signature': 'v0=00' })).statusCode).toBe(401);

      const unknown = await app.inject({ method: 'POST', url: '/gateways/slack/gw_does_not_exist/events', payload: body, headers: { 'content-type': 'application/json', ...good } });
      expect(unknown.statusCode).toBe(404);
      const wrongKind = await app.inject({ method: 'POST', url: `/gateways/discord/${row.id}/interactions`, payload: body, headers: { 'content-type': 'application/json', ...good } });
      expect(wrongKind.statusCode).toBe(404);
    });

    it('rejects a stale timestamp (replay) even with a valid signature, in either direction', async () => {
      await start();
      expect((await event({ type: 'url_verification', challenge: 'x' }, nowSec() - 301)).statusCode).toBe(401);
      expect((await event({ type: 'url_verification', challenge: 'x' }, nowSec() + 301)).statusCode).toBe(401);
      expect((await event({ type: 'url_verification', challenge: 'x' }, nowSec() - 299)).statusCode).toBe(200);
      // A signed message replayed later is not processed.
      const body = JSON.stringify({ type: 'event_callback', event_id: 'EvOld', event: { type: 'message', channel: CHANNEL, user: USER, text: 'replayed', ts: '1.1' } });
      const headers = slackSignature(SIGNING_SECRET, nowSec(), body);
      f.k.clock.advance(6 * 60_000);
      expect((await post('events', body, 'application/json', headers)).statusCode).toBe(401);
      expect(f.chats).toHaveLength(0);
    });
  });

  it('chats with an agent through the Events API: reply posted, conversation issue and comments recorded', async () => {
    await start();
    const res = await messageEvent('<@UBOT> How are &lt;sales&gt; &amp; churn?');
    expect(res.statusCode).toBe(200);
    const reply = await postedText('echo: How are &lt;sales&gt; &amp; churn?');
    expect(reply).toMatchObject({ channel: CHANNEL });
    expect(slack.calls.every((c) => c.auth === `Bearer ${BOT_TOKEN}`)).toBe(true);

    const chat = getChatRow(f.k, row.id, CHANNEL)!;
    expect(chat).toMatchObject({ orgId: acme.id, agentId: ada.id });
    expect(f.services.work.findIssue(acme.id, chat.issueId!)).toMatchObject({ labels: ['chat'], status: 'backlog', assigneeAgentId: null });
    expect(f.comments.map((c) => [c.actor.kind, c.body])).toEqual([
      ['human', 'How are <sales> & churn?'],
      ['agent', 'echo: How are <sales> & churn?'],
    ]);
  });

  it('ignores retries, bot messages and edits, and refuses channels that are not allow-listed', async () => {
    await start();
    await messageEvent('once', { ts: '5.5' }, 'EvDup');
    await messageEvent('once', { ts: '5.5' }, 'EvDup');
    await messageEvent('from a bot', { bot_id: 'B1' });
    await messageEvent('edited', { subtype: 'message_changed' });
    await messageEvent('me', { user: 'UBOT' });
    await postedText('echo: once');
    expect(f.chats.map((c) => c.message)).toEqual(['once']);

    await messageEvent('hello from elsewhere', { channel: 'C0RANDOM', user: 'U0RANDOM' });
    await waitFor(() => posted().find((m) => m.channel === 'C0RANDOM'), 'refusal');
    expect(posted().find((m) => m.channel === 'C0RANDOM')!.text).toBe('This chat is not authorized to talk to Conductor.');
    expect(f.chats).toHaveLength(1);
  });

  it('receives the digest and takeover links', async () => {
    const g = await start();
    f.k.bus.emit('notification', { orgId: acme.id, kind: 'digest', title: 'Morning digest — Acme', body: 'Issues closed: 2' });
    const link = 'https://conductor.example.ts.net/takeover/bs_9?token=t';
    f.k.bus.emit('notification', { orgId: acme.id, kind: 'takeover', title: 'Ada needs you in the browser', body: 'Login required', link });
    await g.idle();
    expect(posted().map((m) => [m.channel, m.text])).toEqual([
      [CHANNEL, 'Morning digest — Acme\n\nIssues closed: 2'],
      [CHANNEL, `Ada needs you in the browser\n\nLogin required\n\n${link}`],
    ]);
  });

  it('approves from chat with a Block Kit button; the message is updated and a double press is graceful', async () => {
    const g = await start();
    const approval = f.requestApproval(acme.id, 'Email the Q3 deck to investors');
    await g.idle();
    const message = posted().at(-1)!;
    const text = 'Approval needed: Email the Q3 deck to investors\n\nRequested: external_send';
    expect(message.blocks).toEqual([
      { type: 'section', text: { type: 'plain_text', text, emoji: true } },
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'conductor_0', value: `approval:approve:${approval.id}`, text: { type: 'plain_text', text: 'Approve' }, style: 'primary' },
          { type: 'button', action_id: 'conductor_1', value: `approval:deny:${approval.id}`, text: { type: 'plain_text', text: 'Deny' }, style: 'danger' },
        ],
      },
    ]);

    expect((await press(`approval:approve:${approval.id}`, '1000.0001', text)).statusCode).toBe(200);
    await waitFor(() => slack.of('chat.update').length === 1, 'chat.update');
    expect(slack.of('chat.update')[0]).toEqual({
      channel: CHANNEL, ts: '1000.0001', text: `${text}\n\nApproved: Email the Q3 deck to investors`,
      blocks: [
        { type: 'section', text: { type: 'plain_text', text, emoji: true } },
        { type: 'context', elements: [{ type: 'plain_text', text: 'Approved: Email the Q3 deck to investors' }] },
      ],
    });

    await press(`approval:deny:${approval.id}`, '1000.0001', text);
    await waitFor(() => slack.of('chat.update').length === 2, 'second chat.update');
    expect(slack.of('chat.update')[1]!.text).toContain('Already decided — this approval is approved.');
    expect(f.decisions).toEqual([{ orgId: acme.id, approvalId: approval.id, decision: 'approved', by: { kind: 'human', id: 'owner' }, note: undefined }]);
  });

  it('approves from chat by command, via message text and via a slash command; strangers cannot press buttons', async () => {
    const g = await start();
    const a = f.requestApproval(acme.id, 'Renew the certificate');
    const b = f.requestApproval(acme.id, 'Post the job ad');
    const c = f.requestApproval(acme.id, 'Refund order 1182');
    await g.idle();

    await messageEvent(`/approve ${a.id}`);
    await postedText('Approved: Renew the certificate');

    const slash = new URLSearchParams({ command: '/deny', text: `${b.id} budget freeze`, channel_id: CHANNEL, user_id: USER }).toString();
    const res = await post('interactions', slash, 'application/x-www-form-urlencoded', slackSignature(SIGNING_SECRET, nowSec(), slash));
    expect(res.statusCode).toBe(200);
    await postedText('Denied: Post the job ad');

    await interaction({ type: 'block_actions', user: { id: 'U0EVIL' }, channel: { id: 'C0EVIL' }, message: { ts: '1.2', text: 'x' }, actions: [{ value: `approval:approve:${c.id}` }] });
    await waitFor(() => slack.of('chat.postEphemeral').length === 1, 'ephemeral refusal');
    expect(slack.of('chat.postEphemeral')[0]).toMatchObject({ channel: 'C0EVIL', user: 'U0EVIL', text: 'This chat is not authorized to talk to Conductor.' });
    expect(f.decisions.map((d) => [d.approvalId, d.decision, d.note])).toEqual([[a.id, 'approved', undefined], [b.id, 'denied', 'budget freeze']]);
  });

  it('needs a signing secret or an app token, and reports a bad bot token as error', async () => {
    await f.k.secrets.set('slack-token-only', BOT_TOKEN);
    await f.k.secrets.set('slack-wrong', JSON.stringify({ token: 'xoxb-wrong-000', signingSecret: SIGNING_SECRET }));
    const tokenOnly = insertGateway(f.k, { kind: 'slack', authRef: 'slack-token-only', config: { apiBaseUrl: slack.url } });
    const wrong = insertGateway(f.k, { kind: 'slack', authRef: 'slack-wrong', config: { apiBaseUrl: slack.url } });
    const g = await start();
    const status = Object.fromEntries(g.status().map((s) => [s.id, s]));
    expect(status[row.id]).toMatchObject({ status: 'active' });
    expect(status[tokenOnly.id]!.lastError).toContain('signing secret');
    expect(status[wrong.id]).toMatchObject({ status: 'error', lastError: 'slack auth.test failed: invalid_auth' });
  });

  it('works in Socket Mode with an app-level token and no public port', async () => {
    const acks: string[] = [];
    const sockets: Array<{ send(data: string): void }> = [];
    const ws = Fastify();
    await ws.register(websocket);
    ws.get('/link', { websocket: true }, (socket) => {
      sockets.push(socket);
      socket.send(JSON.stringify({ type: 'hello' }));
      socket.on('message', (data: Buffer) => acks.push((JSON.parse(data.toString()) as { envelope_id: string }).envelope_id));
    });
    await ws.listen({ port: 0, host: '127.0.0.1' });
    slack.setSocketUrl(`ws://127.0.0.1:${(ws.server.address() as AddressInfo).port}/link`);
    try {
      await f.k.secrets.set('slack-socket', JSON.stringify({ token: BOT_TOKEN }));
      await f.k.secrets.set('slack-app-token', 'xapp-1-test-app-token');
      const socketRow = insertGateway(f.k, {
        kind: 'slack', orgId: acme.id, authRef: 'slack-socket',
        config: { apiBaseUrl: slack.url, allowedChatIds: ['C0SOCKET'], allowedUserIds: [USER], secretRefs: { appToken: 'slack-app-token' } },
      });
      const g = await start();
      expect(g.status().find((s) => s.id === socketRow.id)).toMatchObject({ status: 'active', lastError: null });
      expect(slack.calls.find((c) => c.path === '/apps.connections.open')!.auth).toBe('Bearer xapp-1-test-app-token');
      await waitFor(() => sockets.length === 1, 'socket connection');

      sockets[0]!.send(JSON.stringify({
        envelope_id: 'env-1', type: 'events_api',
        payload: { type: 'event_callback', event_id: 'EvS1', event: { type: 'message', channel: 'C0SOCKET', user: USER, text: 'over the socket', ts: '9.1' } },
      }));
      await waitFor(() => posted().find((m) => m.channel === 'C0SOCKET' && m.text === 'echo: over the socket'), 'socket-mode reply');

      const approval = f.requestApproval(acme.id, 'Ship it');
      await g.idle();
      sockets[0]!.send(JSON.stringify({
        envelope_id: 'env-2', type: 'interactive',
        payload: { type: 'block_actions', user: { id: USER }, channel: { id: 'C0SOCKET' }, message: { ts: '7.7', text: 'Approval needed: Ship it' }, actions: [{ value: `approval:approve:${approval.id}` }] },
      }));
      await waitFor(() => slack.of('chat.update').some((u) => u.channel === 'C0SOCKET'), 'socket-mode approval');
      expect(acks).toEqual(['env-1', 'env-2']);
      expect(f.decisions).toHaveLength(1);
      // Without a signing secret the webhook routes stay closed.
      const body = '{}';
      const res = await app.inject({ method: 'POST', url: `/gateways/slack/${socketRow.id}/events`, payload: body, headers: { 'content-type': 'application/json', ...slackSignature('', nowSec(), body) } });
      expect(res.statusCode).toBe(401);
    } finally {
      await gw?.stop();
      gw = null;
      await ws.close();
    }
  });
});
