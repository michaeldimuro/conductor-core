import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { startGateways, type Gateways } from '../../src/gateways/index.js';
import type { Gateway, Organization } from '../../src/contracts/rows.js';
import { createFakeServices, insertGateway, updateGateway, waitFor, type FakeServices } from './fake-services.js';
import { discordKeys, discordSignature, startDiscordMock, type DiscordKeys, type DiscordMock } from './mock-servers.js';

const BOT_TOKEN = 'discord-bot-token-for-tests';
const CHANNEL = '100200300400';
const USER = '900800700600';
const APP_ID = '123456789012345678';

describe('gateways / discord', () => {
  let f: FakeServices;
  let discord: DiscordMock;
  let keys: DiscordKeys;
  let gw: Gateways | null;
  let app: FastifyInstance;
  let acme: Organization;
  let row: Gateway;

  const start = async () => {
    gw = await startGateways(f.services, { pollMs: 0 });
    app = Fastify();
    await app.register(gw.routes);
    await app.ready();
    return gw;
  };
  const interact = (payload: Record<string, unknown>, opts: { key?: DiscordKeys; mutate?: (body: string) => string } = {}) => {
    const body = JSON.stringify(payload);
    const headers = discordSignature((opts.key ?? keys).privateKey, '1700000000', body);
    return app.inject({
      method: 'POST', url: `/gateways/discord/${row.id}/interactions`, payload: opts.mutate ? opts.mutate(body) : body,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };
  const messages = () => discord.of('POST', /^\/channels\/\d+\/messages$/);

  beforeEach(async () => {
    f = createFakeServices();
    discord = await startDiscordMock(BOT_TOKEN);
    keys = discordKeys();
    gw = null;
    await f.k.secrets.set('discord-bot', BOT_TOKEN);
    acme = seedOrg(f.k, 'Acme');
    seedAgent(f.k, acme.id, seedDept(f.k, acme.id).id, 'Ada');
    row = insertGateway(f.k, {
      kind: 'discord', orgId: acme.id, authRef: 'discord-bot',
      config: { apiBaseUrl: discord.url, publicKey: keys.publicKeyHex, applicationId: APP_ID, allowedChatIds: [CHANNEL] },
    });
  });
  afterEach(async () => {
    await app?.close();
    await gw?.stop();
    await discord.close();
    f.dispose();
  });

  it('verifies the Ed25519 signature and answers PING with PONG', async () => {
    await start();
    const pong = await interact({ type: 1 });
    expect(pong.statusCode).toBe(200);
    expect(pong.json()).toEqual({ type: 1 });

    expect((await interact({ type: 1 }, { key: discordKeys() })).statusCode).toBe(401);
    expect((await interact({ type: 1 }, { mutate: (b) => `${b} ` })).statusCode).toBe(401);
    const noHeaders = await app.inject({ method: 'POST', url: `/gateways/discord/${row.id}/interactions`, payload: '{"type":1}', headers: { 'content-type': 'application/json' } });
    expect(noHeaders.statusCode).toBe(401);
    const garbage = await app.inject({
      method: 'POST', url: `/gateways/discord/${row.id}/interactions`, payload: '{"type":1}',
      headers: { 'content-type': 'application/json', 'x-signature-ed25519': 'zz', 'x-signature-timestamp': '1' },
    });
    expect(garbage.statusCode).toBe(401);
  });

  it('registers slash commands on start and requires a public key', async () => {
    const noKey = insertGateway(f.k, { kind: 'discord', authRef: 'discord-bot', config: { apiBaseUrl: discord.url } });
    const g = await start();
    expect(g.status().find((s) => s.id === row.id)).toMatchObject({ status: 'active' });
    expect(g.status().find((s) => s.id === noKey.id)).toMatchObject({ status: 'error' });
    const registered = discord.calls.find((c) => c.method === 'PUT' && c.path === `/applications/${APP_ID}/commands`)!;
    const names = (registered.body as unknown as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['chat', 'approve', 'deny', 'approvals', 'status', 'stop']));
    expect(discord.calls.every((c) => c.auth === `Bot ${BOT_TOKEN}`)).toBe(true);
  });

  it('parses slash-style commands and chat text delivered through interactions', async () => {
    await start();
    const chat = await interact({
      type: 2, channel_id: CHANNEL, member: { user: { id: USER } },
      data: { name: 'chat', options: [{ type: 3, name: 'text', value: 'What is blocked?' }] },
    });
    expect(chat.json()).toEqual({ type: 4, data: { content: 'On it.', flags: 64 } });
    await waitFor(() => messages().find((m) => m.content === 'echo: What is blocked?'), 'agent reply');
    expect(messages().at(-1)).toMatchObject({ allowed_mentions: { parse: [] } });
    expect(f.comments.map((c) => c.body)).toEqual(['What is blocked?', 'echo: What is blocked?']);

    const approval = f.requestApproval(acme.id, 'Rotate the API keys');
    await interact({ type: 2, channel_id: CHANNEL, user: { id: USER }, data: { name: 'deny', options: [{ type: 3, name: 'id', value: `${approval.id} not now` }] } });
    await waitFor(() => messages().find((m) => m.content === 'Denied: Rotate the API keys'), 'deny reply');
    expect(f.decisions[0]).toMatchObject({ decision: 'denied', note: 'not now' });

    await interact({ type: 2, channel_id: '999', member: { user: { id: '1' } }, data: { name: 'status' } });
    await waitFor(() => discord.calls.find((c) => c.path === '/channels/999/messages'), 'refusal');
    expect(discord.calls.find((c) => c.path === '/channels/999/messages')!.body.content).toBe('This chat is not authorized to talk to Conductor.');
  });

  it('sends approvals with button components and decides on press, updating the message', async () => {
    const g = await start();
    const approval = f.requestApproval(acme.id, 'Pay invoice 4411');
    await g.idle();
    const sent = messages().at(-1)!;
    expect(sent.content).toBe('Approval needed: Pay invoice 4411\n\nRequested: external_send');
    expect(sent.components).toEqual([{
      type: 1,
      components: [
        { type: 2, label: 'Approve', custom_id: `approval:approve:${approval.id}`, style: 3 },
        { type: 2, label: 'Deny', custom_id: `approval:deny:${approval.id}`, style: 4 },
      ],
    }]);

    const press = (customId: string, user = USER, channel = CHANNEL) => interact({
      type: 3, channel_id: channel, member: { user: { id: user } },
      message: { id: '5000', content: sent.content }, data: { custom_id: customId, component_type: 2 },
    });
    const first = await press(`approval:approve:${approval.id}`);
    expect(first.json()).toEqual({
      type: 7,
      data: { content: `${sent.content}\n\nApproved: Pay invoice 4411`, components: [], allowed_mentions: { parse: [] } },
    });
    const second = await press(`approval:deny:${approval.id}`);
    expect((second.json() as { data: { content: string } }).data.content).toContain('Already decided — this approval is approved.');
    expect(f.decisions).toHaveLength(1);

    // A stranger pressing the button gets an ephemeral refusal and decides nothing.
    const other = f.requestApproval(acme.id, 'Second approval');
    const refused = await press(`approval:approve:${other.id}`, '666', '777');
    expect(refused.json()).toEqual({ type: 4, data: { content: 'This chat is not authorized to talk to Conductor.', flags: 64 } });
    const forged = await press('approval:approve:not-an-id');
    expect((forged.json() as { type: number }).type).toBe(4);
    expect(f.decisions).toHaveLength(1);
  });

  it('in a server channel (guild_id present) only an allow-listed user can press Approve', async () => {
    updateGateway(f.k, row.id, { config: { ...row.config, approverUserIds: [USER] } });
    await start();
    const approval = f.requestApproval(acme.id, 'Refund order 77');
    const press = (user: string) => interact({
      type: 3, guild_id: '4000', channel_id: CHANNEL, member: { user: { id: user } },
      message: { id: '5001', content: 'Approval needed: Refund order 77' }, data: { custom_id: `approval:approve:${approval.id}`, component_type: 2 },
    });
    const refused = (await press('31337')).json() as { type: number; data: { content: string; flags?: number } };
    expect(refused.data.content).toContain('in a group chat, approvals and reviews need a user on this gateway\'s allow-list');
    expect(f.decisions).toHaveLength(0);
    expect(f.k.audit.query({ action: 'gateway.action_refused' })).toHaveLength(1);

    const ok = (await press(USER)).json() as { data: { content: string } };
    expect(ok.data.content).toContain('Approved: Refund order 77');
    expect(f.decisions).toHaveLength(1);
  });
});
