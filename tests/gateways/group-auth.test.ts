import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { reachRoutes } from '../../src/api/routes/reach.js';
import { GROUP_REFUSAL_TEXT, mayDecide } from '../../src/gateways/actions.js';
import { startGateways, type Gateways } from '../../src/gateways/index.js';
import { parseGatewayConfig } from '../../src/gateways/types.js';
import type { Organization } from '../../src/contracts/rows.js';
import { startTelegramMock } from './mock-servers.js';
import { createFakeServices, createMemoryPlatform, getGateway, insertGateway, waitFor, type FakeServices, type MemoryPlatform } from './fake-services.js';

describe('gateways / who may decide in a group chat', () => {
  let f: FakeServices;
  let platform: MemoryPlatform;
  let gw: Gateways | null;
  let app: FastifyInstance | null;
  let acme: Organization;

  const start = async () => {
    gw = await startGateways(f.services, { adapters: { telegram: platform.factory }, pollMs: 0 });
    return gw;
  };
  const GROUP = 'team-room';
  const say = (gatewayId: string, text: string, userId: string, chatId = GROUP, isGroup = true) => platform.receive(gatewayId, { chatId, userId, text, isGroup });
  const press = async (gatewayId: string, action: string, userId: string, chatId = GROUP, isGroup = true) => {
    const outcomes: Array<{ text: string; changed: boolean }> = [];
    await platform.receive(gatewayId, { chatId, userId, text: '', action, isGroup, respond: async (o) => void outcomes.push({ text: o.text, changed: o.changed }) });
    return outcomes[0]!;
  };
  const last = () => platform.sent.at(-1)!.message.text;

  beforeEach(() => {
    f = createFakeServices();
    platform = createMemoryPlatform();
    gw = null;
    app = null;
    acme = seedOrg(f.k, 'Acme');
    seedAgent(f.k, acme.id, seedDept(f.k, acme.id).id, 'Ada');
  });
  afterEach(async () => {
    await app?.close();
    await gw?.stop();
    f.dispose();
  });

  it('mayDecide: 1:1 chats decide; a group needs the user on allowedUserIds or approverUserIds', () => {
    const cfg = (extra: Record<string, unknown>) => parseGatewayConfig({ allowedChatIds: ['room'], ...extra });
    expect(mayDecide(cfg({}), { userId: 'u1', isGroup: false })).toBe(true);
    expect(mayDecide(cfg({}), { userId: 'u1', isGroup: true })).toBe(false);
    expect(mayDecide(cfg({ allowedUserIds: ['U1'] }), { userId: 'u1', isGroup: true })).toBe(true);
    expect(mayDecide(cfg({ approverUserIds: [7] }), { userId: '7', isGroup: true })).toBe(true);
    expect(mayDecide(cfg({ approverUserIds: ['u2'] }), { userId: '', isGroup: true })).toBe(false);
  });

  it('a member of a paired group cannot approve, deny or review — by button or by command — but can still chat', async () => {
    const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: [GROUP] } });
    await start();
    const approval = f.requestApproval(acme.id, 'Wire $9,000 to a new vendor');
    const review = f.requestReview(acme.id, 'Quarterly report');

    expect(await press(row.id, `approval:approve:${approval.id}`, 'member-1')).toEqual({ text: GROUP_REFUSAL_TEXT, changed: false });
    expect(await press(row.id, `review:accepted:${review.id}`, 'member-1')).toEqual({ text: GROUP_REFUSAL_TEXT, changed: false });
    await say(row.id, `/approve ${approval.id}`, 'member-2');
    expect(last()).toBe(GROUP_REFUSAL_TEXT);
    await say(row.id, `/deny ${approval.id} nope`, 'member-2');
    expect(last()).toBe(GROUP_REFUSAL_TEXT);
    await say(row.id, `/reject ${review.id}`, 'member-2');
    expect(last()).toBe(GROUP_REFUSAL_TEXT);
    expect(f.decisions).toEqual([]);
    expect(f.reviews).toEqual([]);

    const refused = f.k.audit.query({ action: 'gateway.action_refused' });
    expect(refused).toHaveLength(5);
    expect(refused.every((r) => r.entityId === row.id)).toBe(true);
    expect(refused.map((r) => r.data).find((d) => (d as { action?: string }).action === 'approval' && (d as { userId?: string }).userId === 'member-1'))
      .toMatchObject({ approvalId: approval.id, decision: 'approved', chatId: GROUP });

    // Reading and talking are still fine for the group.
    await say(row.id, '/approvals', 'member-1');
    expect(last()).toContain('Wire $9,000 to a new vendor');
    await say(row.id, 'status update please', 'member-1');
    expect(last()).toBe('echo: status update please');
  });

  it('an allow-listed user decides from the group; the same chat id as a 1:1 chat needs no user list', async () => {
    const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: [GROUP], approverUserIds: ['owner-7'] } });
    await start();
    const a = f.requestApproval(acme.id, 'Publish the launch post');
    const b = f.requestApproval(acme.id, 'Hire a designer');
    expect((await press(row.id, `approval:approve:${a.id}`, 'member-1')).changed).toBe(false);
    expect(await press(row.id, `approval:approve:${a.id}`, 'OWNER-7')).toEqual({ text: 'Approved: Publish the launch post', changed: true });
    await say(row.id, `/deny ${b.id} not yet`, 'owner-7');
    expect(last()).toBe('Denied: Hire a designer');
    expect(f.decisions.map((d) => [d.approvalId, d.decision])).toEqual([[a.id, 'approved'], [b.id, 'denied']]);
    expect(f.k.audit.query({ action: 'gateway.action' }).map((r) => (r.data as { userId: string }).userId).sort()).toEqual(['OWNER-7', 'owner-7']);

    const dm = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, name: 'dm', config: { allowedChatIds: ['4242'] } });
    await gw!.reload();
    const c = f.requestApproval(acme.id, 'Renew the domain');
    expect((await press(dm.id, `approval:approve:${c.id}`, '4242', '4242', false)).changed).toBe(true);
  });

  it('fails closed when an adapter does not say what kind of chat it is and the chat is not the user', async () => {
    const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['room-1', 'solo'] } });
    await start();
    const approval = f.requestApproval(acme.id, 'Send the invoice');
    const ctx = platform.contexts.get(row.id)!;
    const outcomes: string[] = [];
    const respond = async (o: { text: string }) => void outcomes.push(o.text);
    await ctx.emit({ chatId: 'room-1', userId: 'someone', text: '', action: `approval:approve:${approval.id}`, respond });
    expect(outcomes).toEqual([GROUP_REFUSAL_TEXT]);
    await ctx.emit({ chatId: 'solo', userId: 'SOLO', text: '', action: `approval:approve:${approval.id}`, respond });
    expect(outcomes[1]).toBe('Approved: Send the invoice');
  });

  it('pairing end to end: the API mints a code, the owner redeems it in a group and becomes its only approver', async () => {
    const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id });
    const g = await start();
    app = Fastify();
    reachRoutes(app, f.services, g);
    await app.ready();

    // Nothing is allow-listed yet: the group is refused.
    await say(row.id, 'hello?', 'owner-7');
    expect(last()).toContain('not authorized');

    const res = await app.inject({ method: 'POST', url: `/gateways/${row.id}/pairing-code`, payload: {} });
    expect(res.statusCode).toBe(200);
    const { code } = res.json() as { code: string };
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(res.body).not.toContain('pairingCodeHash');
    expect(JSON.stringify(getGateway(f.k, row.id).config)).not.toContain(code);
    expect((await app.inject({ method: 'POST', url: '/gateways/gw_missing/pairing-code', payload: {} })).statusCode).toBeGreaterThanOrEqual(400);

    await say(row.id, `/pair ${code}`, 'owner-7');
    expect(last()).toContain('Paired');
    expect(getGateway(f.k, row.id).config).toMatchObject({ allowedChatIds: [GROUP], approverUserIds: ['owner-7'] });
    expect(f.k.audit.query({ action: 'gateway.paired' })[0]!.data).toMatchObject({ chatId: GROUP, userId: 'owner-7', isGroup: true });
    expect(f.k.audit.query({ action: 'gateway.pairing_code_minted' })).toHaveLength(1);

    // The whole group can now talk; only the person who held the code can decide.
    await say(row.id, 'hi team', 'member-1');
    expect(last()).toBe('echo: hi team');
    const approval = f.requestApproval(acme.id, 'Raise the budget');
    await g.idle();
    expect(platform.texts(GROUP).some((t) => t.includes('Approval needed: Raise the budget'))).toBe(true);
    expect((await press(row.id, `approval:approve:${approval.id}`, 'member-1')).text).toBe(GROUP_REFUSAL_TEXT);
    expect(await press(row.id, `approval:approve:${approval.id}`, 'owner-7')).toEqual({ text: 'Approved: Raise the budget', changed: true });
    // The code was single-use.
    await say(row.id, `/pair ${code}`, 'x', 'another-room');
    expect(platform.texts('another-room').at(-1)).toBe('That pairing code is not valid.');
  });

  it('pairing a 1:1 chat adds no approver list (the chat itself is the owner)', async () => {
    const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id });
    const g = await start();
    await say(row.id, `/pair ${g.mintPairingCode(row.id)}`, '555', '555', false);
    expect(getGateway(f.k, row.id).config).toMatchObject({ allowedChatIds: ['555'] });
    expect(getGateway(f.k, row.id).config.approverUserIds).toBeUndefined();
    const approval = f.requestApproval(acme.id, 'Ship it');
    expect((await press(row.id, `approval:approve:${approval.id}`, '555', '555', false)).changed).toBe(true);
  });
});

describe('gateways / telegram group chats (real adapter, mock Bot API)', () => {
  it('a tap by another member of a Telegram group does not approve; the allow-listed owner\'s tap does', async () => {
    const f = createFakeServices();
    const tg = await startTelegramMock();
    const CHAT = -100123;
    const OWNER_ID = 7001;
    await f.k.secrets.set('telegram-bot', tg.token);
    const acme = seedOrg(f.k, 'Acme');
    seedAgent(f.k, acme.id, seedDept(f.k, acme.id).id, 'Ada');
    insertGateway(f.k, {
      kind: 'telegram', orgId: acme.id, authRef: 'telegram-bot',
      config: { apiBaseUrl: tg.url, pollTimeoutSec: 0, pollIdleMs: 10, allowedChatIds: [CHAT], approverUserIds: [OWNER_ID] },
    });
    const gw = await startGateways(f.services, { pollMs: 0 });
    try {
      const approval = f.requestApproval(acme.id, 'Pay the contractor');
      await gw.idle();
      const stranger = tg.pushCallback(CHAT, 9009, `approval:approve:${approval.id}`, 9, 'supergroup');
      await waitFor(() => tg.of('answerCallbackQuery').length === 1, 'refusal toast');
      expect(tg.of('answerCallbackQuery')[0]).toEqual({ callback_query_id: stranger, text: GROUP_REFUSAL_TEXT.slice(0, 200) });
      expect(f.decisions).toEqual([]);
      expect(tg.of('editMessageReplyMarkup')).toEqual([]);

      const owner = tg.pushCallback(CHAT, OWNER_ID, `approval:approve:${approval.id}`, 9, 'supergroup');
      await waitFor(() => tg.of('answerCallbackQuery').length === 2, 'approval toast');
      expect(tg.of('answerCallbackQuery')[1]).toEqual({ callback_query_id: owner, text: 'Approved: Pay the contractor' });
      expect(f.decisions).toHaveLength(1);

      // By command from the group, too.
      const second = f.requestApproval(acme.id, 'Renew hosting');
      tg.pushMessage(CHAT, 9009, `/approve ${second.id}`, 'group');
      await waitFor(() => tg.of('sendMessage').find((m) => m.text === GROUP_REFUSAL_TEXT), 'command refusal');
      expect(f.decisions).toHaveLength(1);
    } finally {
      await gw.stop();
      await tg.close();
      f.dispose();
    }
  });
});
