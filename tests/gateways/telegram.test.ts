import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { startGateways, type Gateways } from '../../src/gateways/index.js';
import type { Agent, Gateway, Organization } from '../../src/contracts/rows.js';
import { createFakeServices, getChatRow, getGateway, insertGateway, waitFor, type FakeServices } from './fake-services.js';
import { startTelegramMock, type TelegramMock } from './mock-servers.js';

const CHAT = 5550001;
const USER = 777;

describe('gateways / telegram (FR-16, FR-17)', () => {
  let f: FakeServices;
  let tg: TelegramMock;
  let gw: Gateways | null;
  let acme: Organization;
  let ada: Agent;
  let row: Gateway;

  const config = (extra: Record<string, unknown> = {}) => ({ apiBaseUrl: tg.url, pollTimeoutSec: 0, pollIdleMs: 10, allowedChatIds: [CHAT], ...extra });
  const start = async () => {
    gw = await startGateways(f.services, { pollMs: 0 });
    return gw;
  };
  const sent = () => tg.of('sendMessage');
  const sentText = (text: string) => waitFor(() => sent().find((m) => m.text === text), `telegram message "${text}"`);

  beforeEach(async () => {
    f = createFakeServices();
    tg = await startTelegramMock();
    gw = null;
    await f.k.secrets.set('telegram-bot', tg.token);
    acme = seedOrg(f.k, 'Acme');
    ada = seedAgent(f.k, acme.id, seedDept(f.k, acme.id).id, 'Ada');
    row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, authRef: 'telegram-bot', config: config() });
  });
  afterEach(async () => {
    await gw?.stop();
    await tg.close();
    f.dispose();
  });

  it('chats with an agent over long polling: reply delivered, conversation issue and comments recorded, offset persisted', async () => {
    await start();
    expect(gw!.status()).toEqual([{ id: row.id, kind: 'telegram', status: 'active', lastError: null }]);
    tg.pushMessage(CHAT, USER, 'How is the launch going?');
    const reply = await sentText('echo: How is the launch going?');
    expect(reply).toMatchObject({ chat_id: String(CHAT) });

    const chat = getChatRow(f.k, row.id, String(CHAT))!;
    expect(chat).toMatchObject({ orgId: acme.id, agentId: ada.id });
    expect(f.services.work.findIssue(acme.id, chat.issueId!)).toMatchObject({ labels: ['chat'], status: 'backlog', assigneeAgentId: null });
    expect(f.comments.map((c) => [c.issueId, c.actor.kind, c.body])).toEqual([
      [chat.issueId, 'human', 'How is the launch going?'],
      [chat.issueId, 'agent', 'echo: How is the launch going?'],
    ]);
    expect(f.chats).toEqual([{ orgId: acme.id, agentId: ada.id, message: 'How is the launch going?', issueId: chat.issueId }]);

    // The next poll acknowledges the update, and the offset survives a restart.
    await waitFor(() => tg.offsets.includes(101), 'offset 101');
    expect(getGateway(f.k, row.id).config.state).toEqual({ telegramOffset: 101 });
    await gw!.stop();
    tg.offsets.length = 0;
    await start();
    await waitFor(() => tg.offsets.length > 0, 'poll after restart');
    expect(tg.offsets[0]).toBe(101);
    expect(f.chats).toHaveLength(1);
  });

  it('delivers the morning digest and answers /digest on demand', async () => {
    const g = await start();
    f.k.bus.emit('notification', { orgId: acme.id, kind: 'digest', title: 'Morning digest — Acme', body: 'Acme — last 24 hours\nIssues closed: 4' });
    await g.idle();
    expect(sent().at(-1)).toMatchObject({ chat_id: String(CHAT), text: 'Morning digest — Acme\n\nAcme — last 24 hours\nIssues closed: 4' });

    tg.pushMessage(CHAT, USER, '/digest');
    const onDemand = await waitFor(() => sent().find((m) => String(m.text).startsWith('Acme — last 24 hours')), 'on-demand digest');
    expect(onDemand.text).toContain('Spend: $1.50');
  });

  it('approves from Telegram with one tap; the keyboard is removed and a double press is graceful', async () => {
    const g = await start();
    const approval = f.requestApproval(acme.id, 'Send contract to client');
    await g.idle();
    const message = sent().at(-1)!;
    expect(message.text).toBe('Approval needed: Send contract to client\n\nRequested: external_send');
    expect(message.reply_markup).toEqual({
      inline_keyboard: [[
        { text: 'Approve', callback_data: `approval:approve:${approval.id}` },
        { text: 'Deny', callback_data: `approval:deny:${approval.id}` },
      ]],
    });
    expect(Buffer.byteLength(`approval:approve:${approval.id}`)).toBeLessThanOrEqual(64);

    const first = tg.pushCallback(CHAT, USER, `approval:approve:${approval.id}`, 9);
    await waitFor(() => tg.of('answerCallbackQuery').length === 1, 'callback answer');
    expect(tg.of('answerCallbackQuery')[0]).toEqual({ callback_query_id: first, text: 'Approved: Send contract to client' });
    await waitFor(() => tg.of('editMessageReplyMarkup').length === 1, 'keyboard removal');
    expect(tg.of('editMessageReplyMarkup')[0]).toEqual({ chat_id: String(CHAT), message_id: 9, reply_markup: { inline_keyboard: [] } });
    await sentText('Approved: Send contract to client');

    const second = tg.pushCallback(CHAT, USER, `approval:deny:${approval.id}`, 9);
    await waitFor(() => tg.of('answerCallbackQuery').length === 2, 'second callback answer');
    expect(tg.of('answerCallbackQuery')[1]).toEqual({ callback_query_id: second, text: 'Already decided — this approval is approved.' });
    expect(f.decisions).toEqual([{ orgId: acme.id, approvalId: approval.id, decision: 'approved', by: { kind: 'human', id: 'owner' }, note: undefined }]);
  });

  it('approves and denies by command, and reviews by button', async () => {
    const g = await start();
    const a = f.requestApproval(acme.id, 'Buy the domain');
    const b = f.requestApproval(acme.id, 'Publish release notes');
    const issue = f.requestReview(acme.id, 'Pricing page');
    await g.idle();

    tg.pushMessage(CHAT, USER, `/approve ${a.id}`);
    await sentText('Approved: Buy the domain');
    tg.pushMessage(CHAT, USER, `/deny@conductor_bot ${b.id} wait for legal`);
    await sentText('Denied: Publish release notes');
    tg.pushMessage(CHAT, USER, `/approve ${a.id}`);
    await sentText('Already decided — this approval is approved.');
    expect(f.decisions.map((d) => [d.approvalId, d.decision, d.note])).toEqual([[a.id, 'approved', undefined], [b.id, 'denied', 'wait for legal']]);

    tg.pushCallback(CHAT, USER, `review:accepted:${issue.id}`, 12);
    await sentText('Accepted: #1 Pricing page');
    expect(f.reviews).toEqual([{ orgId: acme.id, issueId: issue.id, outcome: 'accepted', note: undefined }]);
  });

  it('delivers takeover requests with the share link', async () => {
    const g = await start();
    const link = 'https://conductor.example.ts.net/takeover/bs_1?token=one-time';
    f.k.bus.emit('notification', { orgId: acme.id, kind: 'takeover', title: 'Ada needs you in the browser', body: 'CAPTCHA on the supplier portal', link });
    await g.idle();
    expect(sent().at(-1)).toMatchObject({ chat_id: String(CHAT), text: `Ada needs you in the browser\n\nCAPTCHA on the supplier portal\n\n${link}`, link_preview_options: { is_disabled: true } });
  });

  it('refuses strangers and pairs a new chat with an owner-minted code', async () => {
    const g = await start();
    tg.pushMessage(999, 1, 'let me in');
    await waitFor(() => sent().find((m) => m.chat_id === '999' && m.text === 'This chat is not authorized to talk to Conductor.'), 'refusal');
    tg.pushCallback(999, 1, 'approval:approve:apr_01ARZ3NDEKTSV4RRFFQ69G5FAV', 3);
    await waitFor(() => tg.of('answerCallbackQuery').some((a) => a.text === 'This chat is not authorized to talk to Conductor.'), 'callback refusal');
    expect(f.chats).toHaveLength(0);
    expect(f.k.audit.query({ action: 'gateway.message_refused' })).toHaveLength(2);

    const code = g.mintPairingCode(row.id);
    tg.pushMessage(999, 1, `/pair ${code}`);
    await waitFor(() => sent().find((m) => m.chat_id === '999' && String(m.text).startsWith('Paired.')), 'pairing confirmation');
    tg.pushMessage(999, 1, 'now?');
    await waitFor(() => sent().find((m) => m.chat_id === '999' && m.text === 'echo: now?'), 'reply after pairing');
  });

  it('chunks replies longer than 4096 characters', async () => {
    await start();
    const long = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ');
    f.reply = () => long;
    tg.pushMessage(CHAT, USER, 'long answer please');
    await waitFor(() => sent().map((m) => m.text).join(' ') === long, 'all chunks');
    expect(sent().length).toBeGreaterThan(1);
    expect(sent().every((m) => String(m.text).length <= 4096)).toBe(true);
  });

  it('a bad token marks only that gateway as error, never leaking the token', async () => {
    await f.k.secrets.set('telegram-bad', '987654321:BBwrongwrongwrongwrongwrongwrongwrong');
    const bad = insertGateway(f.k, { kind: 'telegram', authRef: 'telegram-bad', config: config() });
    const missing = insertGateway(f.k, { kind: 'telegram', config: config() });
    const g = await start();
    const status = Object.fromEntries(g.status().map((s) => [s.id, s]));
    expect(status[row.id]).toMatchObject({ status: 'active', lastError: null });
    expect(status[bad.id]).toMatchObject({ status: 'error', lastError: 'telegram getMe failed: Unauthorized' });
    expect(status[missing.id]!.lastError).toContain('bot token is not configured');
    expect(tg.calls.some((c) => c.path.includes('987654321'))).toBe(true);
    expect(JSON.stringify(g.status())).not.toContain('BBwrong');

    tg.pushMessage(CHAT, USER, 'still there?');
    await sentText('echo: still there?');
  });
});
