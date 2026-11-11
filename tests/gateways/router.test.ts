import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { startGateways, mintPairingCode, type Gateways } from '../../src/gateways/index.js';
import { chunkText } from '../../src/gateways/util.js';
import { parseCommand } from '../../src/gateways/commands.js';
import { parseAction } from '../../src/gateways/actions.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { createFakeServices, createMemoryPlatform, getChatRow, getGateway, insertGateway, type FakeServices, type MemoryPlatform } from './fake-services.js';

describe('gateways / shared router', () => {
  let f: FakeServices;
  let platform: MemoryPlatform;
  let gw: Gateways | null;
  let acme: Organization;
  let beta: Organization;
  let ada: Agent;
  let grace: Agent;
  let bob: Agent;

  const start = async () => {
    gw = await startGateways(f.services, { adapters: { telegram: platform.factory }, pollMs: 0 });
    return gw;
  };
  const say = (gatewayId: string, text: string, chatId = 'c1', userId = 'u1') => platform.receive(gatewayId, { chatId, userId, text });
  const last = () => platform.sent.at(-1)!.message.text;

  beforeEach(() => {
    f = createFakeServices();
    platform = createMemoryPlatform();
    gw = null;
    acme = seedOrg(f.k, 'Acme');
    beta = seedOrg(f.k, 'Beta Labs');
    const eng = seedDept(f.k, acme.id);
    ada = seedAgent(f.k, acme.id, eng.id, 'Ada');
    grace = seedAgent(f.k, acme.id, eng.id, 'Grace');
    bob = seedAgent(f.k, beta.id, seedDept(f.k, beta.id).id, 'Bob');
  });
  afterEach(async () => {
    await gw?.stop();
    f.dispose();
  });

  describe('authorization', () => {
    it('refuses chats that are not allow-listed, once per minute, with an audit entry and no agent call', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', config: { allowedChatIds: ['c1'] } });
      await start();
      await say(row.id, 'hello there', 'stranger', 'u9');
      await say(row.id, '/approvals', 'stranger', 'u9');
      expect(platform.texts('stranger')).toEqual(['This chat is not authorized to talk to Conductor.']);
      expect(f.chats).toHaveLength(0);
      const audit = f.k.audit.query({ action: 'gateway.message_refused' });
      expect(audit).toHaveLength(2);
      expect(audit[0]!.data).toMatchObject({ chatId: 'stranger', userId: 'u9' });
      expect(JSON.stringify(audit)).not.toContain('hello there');
    });

    it('requires both lists to match when both are configured, and compares numeric ids as strings', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', config: { allowedChatIds: [42], allowedUserIds: ['7'] } });
      await start();
      await say(row.id, '/help', '42', '8');
      expect(last()).toContain('not authorized');
      await say(row.id, '/help', '42', '7');
      expect(last()).toContain('Conductor commands');
    });

    it('refuses button presses from strangers without deciding anything', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', config: { allowedChatIds: ['c1'] } });
      await start();
      const approval = f.requestApproval(acme.id, 'Send the invoice');
      const outcomes: string[] = [];
      await platform.receive(row.id, { chatId: 'evil', userId: 'u9', text: '', action: `approval:approve:${approval.id}`, respond: async (o) => void outcomes.push(o.text) });
      expect(outcomes).toEqual(['This chat is not authorized to talk to Conductor.']);
      expect(f.decisions).toHaveLength(0);
    });

    it('with no allow-list refuses everyone until the owner-minted pairing code is redeemed — once', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', orgId: beta.id });
      await start();
      await say(row.id, 'hi', 'phone');
      expect(last()).toContain('not authorized');

      const code = mintPairingCode(f.k, row.id);
      expect(code).toMatch(/^[A-Z2-9]{8}$/);
      const stored = getGateway(f.k, row.id).config;
      expect(typeof stored.pairingCodeHash).toBe('string');
      expect(stored.pairingExpiresAt).toBe(f.k.clock.now() + 10 * 60_000);
      expect(JSON.stringify(stored)).not.toContain(code);

      await say(row.id, '/pair WRONGCDE', 'phone');
      expect(last()).toBe('That pairing code is not valid.');
      await say(row.id, `/pair ${code.toLowerCase()}`, 'phone');
      expect(last()).toContain('Paired');
      expect(getGateway(f.k, row.id).config).toMatchObject({ allowedChatIds: ['phone'] });
      expect(getGateway(f.k, row.id).config.pairingCodeHash).toBeUndefined();
      expect(f.k.audit.query({ action: 'gateway.paired' })).toHaveLength(1);

      // One-time: a second chat cannot reuse it.
      await say(row.id, `/pair ${code}`, 'other-phone');
      expect(platform.texts('other-phone').at(-1)).toBe('That pairing code is not valid.');
      // The paired chat now works.
      await say(row.id, 'hello', 'phone');
      expect(last()).toBe('echo: hello');
    });

    it('rejects an expired pairing code and burns a code after five wrong guesses', async () => {
      const row = insertGateway(f.k, { kind: 'telegram' });
      const g = await start();
      const expired = g.mintPairingCode(row.id, 1_000);
      f.k.clock.advance(1_001);
      await say(row.id, `/pair ${expired}`);
      expect(last()).toBe('That pairing code is not valid.');
      expect(getGateway(f.k, row.id).config.allowedChatIds ?? []).toEqual([]);

      const code = g.mintPairingCode(row.id);
      for (let i = 0; i < 5; i++) await say(row.id, '/pair AAAAAAAA', `guesser${i}`);
      await say(row.id, `/pair ${code}`, 'late');
      expect(platform.texts('late').at(-1)).toBe('That pairing code is not valid.');
      expect(() => mintPairingCode(f.k, 'gw_missing')).toThrowError(/not found/);
    });
  });

  describe('org / agent selection', () => {
    it('persists the selected org and agent in gateway_chats and scopes later commands to them', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', config: { allowedChatIds: ['c1'] } });
      await start();
      await say(row.id, 'hello');
      expect(last()).toContain('Choose an organization first');
      await say(row.id, '/orgs');
      expect(last()).toContain('acme — Acme');
      expect(last()).toContain('beta-labs — Beta Labs');

      await say(row.id, '/org acme');
      expect(getChatRow(f.k, row.id, 'c1')).toMatchObject({ orgId: acme.id, agentId: null });
      await say(row.id, '/agents');
      expect(last()).toContain('ada — Ada');
      expect(last()).not.toContain('bob');
      await say(row.id, '/agent bob');
      expect(last()).toContain('No agent "bob"');
      await say(row.id, '/agent grace');
      expect(getChatRow(f.k, row.id, 'c1')).toMatchObject({ orgId: acme.id, agentId: grace.id });

      await say(row.id, 'status?');
      expect(f.chats.at(-1)).toMatchObject({ orgId: acme.id, agentId: grace.id, message: 'status?' });
      const firstIssue = getChatRow(f.k, row.id, 'c1')!.issueId;
      expect(firstIssue).toBeTruthy();

      // Switching org resets the agent and the conversation thread.
      await say(row.id, '/org beta-labs');
      expect(getChatRow(f.k, row.id, 'c1')).toMatchObject({ orgId: beta.id, agentId: null, issueId: null });
      await say(row.id, 'hi bob');
      expect(f.chats.at(-1)).toMatchObject({ orgId: beta.id, agentId: bob.id });
      // A different chat on the same gateway has its own selection.
      expect(getChatRow(f.k, row.id, 'c2')).toBeNull();
    });

    it('an org-bound gateway never exposes or selects another org', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['c1'] } });
      await start();
      await say(row.id, '/orgs');
      expect(last()).toContain('acme');
      expect(last()).not.toContain('beta-labs');
      await say(row.id, '/org beta-labs');
      expect(last()).toContain('No organization "beta-labs"');

      const foreign = f.requestApproval(beta.id, 'Beta wire transfer');
      await say(row.id, `/approve ${foreign.id}`);
      expect(last()).toContain('Not found');
      expect(f.decisions).toHaveLength(0);
      await say(row.id, '/approvals');
      expect(last()).toBe('No pending approvals.');
    });
  });

  describe('chat', () => {
    it('keeps one unassigned backlog "chat" issue per conversation with both sides recorded as comments', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['c1'] } });
      await start();
      await say(row.id, '/agent ada');
      await say(row.id, 'What shipped today?');
      await say(row.id, 'And tomorrow?');

      const issueId = getChatRow(f.k, row.id, 'c1')!.issueId!;
      const issue = f.services.work.findIssue(acme.id, issueId)!;
      expect(issue).toMatchObject({ status: 'backlog', assigneeAgentId: null, labels: ['chat'] });
      expect(f.chats.map((c) => c.issueId)).toEqual([issueId, issueId]);
      expect(f.comments.map((c) => [c.actor.kind, c.body])).toEqual([
        ['human', 'What shipped today?'], ['agent', 'echo: What shipped today?'],
        ['human', 'And tomorrow?'], ['agent', 'echo: And tomorrow?'],
      ]);
      expect(f.comments[1]).toMatchObject({ issueId, actor: { kind: 'agent', id: ada.id } });
      expect(f.comments[1]!.runId).toMatch(/^run_/);

      // Talking to someone else starts a new thread.
      await say(row.id, '/agent grace');
      await say(row.id, 'hi grace');
      expect(getChatRow(f.k, row.id, 'c1')!.issueId).not.toBe(issueId);
    });

    it('chunks long replies to the platform limit and reports agent failures kindly', async () => {
      platform = createMemoryPlatform({ maxLength: 100 });
      const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['c1'] } });
      await start();
      await say(row.id, '/agent ada');
      platform.sent.length = 0;
      const long = Array.from({ length: 40 }, (_, i) => `sentence number ${i}`).join(' ');
      f.reply = () => long;
      await say(row.id, 'tell me everything');
      expect(platform.sent.length).toBeGreaterThan(1);
      expect(platform.sent.every((s) => s.message.text.length <= 100)).toBe(true);
      expect(platform.texts().join(' ')).toBe(long);

      f.reply = () => {
        throw new Error('adapter exploded at /secret/path');
      };
      await say(row.id, 'again');
      expect(last()).toBe('Ada could not reply: an internal error');
    });

    it('never treats slash text as chat and never sends unknown commands to an agent', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['c1'] } });
      await start();
      await say(row.id, '/agent ada');
      await say(row.id, '/rm -rf /');
      expect(last()).toContain('Unknown command');
      await say(row.id, '/approve not-an-id; drop table');
      expect(last()).toContain('Usage: /approve');
      expect(f.chats).toHaveLength(0);
    });
  });

  describe('commands', () => {
    it('/status, /issue, /run, /digest and /help work against the selected org and agent', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['c1'] } });
      await start();
      await say(row.id, '/agent@conductor_bot ada');
      await say(row.id, '/status');
      expect(last()).toContain('Organization: Acme (acme)');
      expect(last()).toContain('Talking to: Ada');

      await say(row.id, '/issue Draft the Q3 report');
      expect(last()).toContain('Created #1 "Draft the Q3 report" for Ada');
      expect(f.services.work.findIssue(acme.id, 1)).toMatchObject({ assigneeAgentId: ada.id, status: 'todo', creatorKind: 'human' });

      await say(row.id, '/run');
      expect(f.runNow).toEqual([{ orgId: acme.id, agentId: ada.id }]);

      await say(row.id, '/digest');
      expect(last()).toContain('Acme — last 24 hours');
      await say(row.id, '/help');
      expect(last()).toContain('/approve <id>');
    });

    it('/stop engages the org kill switch only after "/stop confirm"', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['c1'] } });
      await start();
      await say(row.id, '/stop confirm');
      expect(last()).toContain('Nothing to confirm');
      await say(row.id, '/stop');
      expect(last()).toContain('/stop confirm');
      expect(f.killSwitch.size).toBe(0);
      await say(row.id, '/stop confirm');
      expect([...f.killSwitch]).toEqual([acme.id]);
      expect(last()).toContain('Kill switch engaged for Acme');

      // A stale confirmation does nothing.
      f.killSwitch.clear();
      await say(row.id, '/stop');
      f.k.clock.advance(3 * 60_000);
      await say(row.id, '/stop confirm');
      expect(f.killSwitch.size).toBe(0);
    });

    it('/approvals lists pending items; /approve and /deny decide exactly once; reviews work by command', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['c1'] } });
      await start();
      const a = f.requestApproval(acme.id, 'Pay the hosting bill');
      const b = f.requestApproval(acme.id, 'Publish the blog post');
      await say(row.id, '/approvals');
      expect(last()).toContain(a.id);
      expect(last()).toContain('Publish the blog post');

      await say(row.id, `/approve ${a.id.toLowerCase()}`);
      expect(last()).toBe('Approved: Pay the hosting bill');
      await say(row.id, `/deny ${b.id} not this week`);
      expect(last()).toBe('Denied: Publish the blog post');
      await say(row.id, `/deny ${a.id}`);
      expect(last()).toBe('Already decided — this approval is approved.');
      expect(f.decisions).toEqual([
        { orgId: acme.id, approvalId: a.id, decision: 'approved', by: { kind: 'human', id: 'owner' }, note: undefined },
        { orgId: acme.id, approvalId: b.id, decision: 'denied', by: { kind: 'human', id: 'owner' }, note: 'not this week' },
      ]);

      const issue = f.requestReview(acme.id, 'Landing page copy');
      await say(row.id, `/reject #${issue.number} tone is off`);
      expect(last()).toContain('Sent back for rework');
      expect(f.reviews).toEqual([{ orgId: acme.id, issueId: issue.id, outcome: 'rejected', note: 'tone is off' }]);
      await say(row.id, `/accept ${issue.id}`);
      expect(last()).toContain('Already reviewed');
    });
  });

  describe('parsing', () => {
    it('parses commands and actions strictly', () => {
      expect(parseCommand('/Approve@bot  apr_1 note')).toEqual({ name: 'approve', args: 'apr_1 note' });
      expect(parseCommand('approve x')).toBeNull();
      expect(parseCommand('/unknown')).toBeNull();
      expect(parseAction('approval:approve:apr_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual({ type: 'approval', decision: 'approved', id: 'apr_01ARZ3NDEKTSV4RRFFQ69G5FAV' });
      expect(parseAction('review:rejected:iss_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toMatchObject({ type: 'review', outcome: 'rejected' });
      for (const bad of ['approval:approve:apr_1', 'approval:delete:apr_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'review:accepted:apr_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'approval:approve:apr_01ARZ3NDEKTSV4RRFFQ69G5FAV:x', '']) {
        expect(parseAction(bad)).toBeNull();
      }
    });

    it('chunks on paragraph, line and word boundaries without splitting surrogate pairs', () => {
      expect(chunkText('short', 10)).toEqual(['short']);
      expect(chunkText('aaaa bbbb cccc', 9)).toEqual(['aaaa bbbb', 'cccc']);
      expect(chunkText('para one\n\npara two is here', 12)).toEqual(['para one', 'para two is', 'here']);
      const emoji = '😀'.repeat(10);
      const chunks = chunkText(emoji, 5);
      expect(chunks.join('')).toBe(emoji);
      expect(chunks.every((c) => c.length <= 5 && !/^[\udc00-\udfff]/.test(c))).toBe(true);
      expect(chunkText('x'.repeat(4097), 4096).map((c) => c.length)).toEqual([4096, 1]);
    });
  });
});
