import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { startGateways, type Gateways } from '../../src/gateways/index.js';
import type { Organization } from '../../src/contracts/rows.js';
import { createFakeServices, createMemoryPlatform, getGateway, insertGateway, updateGateway, type FakeServices, type MemoryPlatform } from './fake-services.js';

describe('gateways / lifecycle and notifications', () => {
  let f: FakeServices;
  let gw: Gateways | null;
  let acme: Organization;
  let beta: Organization;

  beforeEach(() => {
    f = createFakeServices();
    gw = null;
    acme = seedOrg(f.k, 'Acme');
    beta = seedOrg(f.k, 'Beta Labs');
    seedAgent(f.k, acme.id, seedDept(f.k, acme.id).id, 'Ada');
  });
  afterEach(async () => {
    await gw?.stop();
    f.dispose();
  });

  describe('lifecycle', () => {
    it('marks an adapter that throws on start as error (secret redacted) without affecting the others', async () => {
      await f.k.secrets.set('gw-bad', 'super-secret-token-value');
      const good = createMemoryPlatform();
      const bad = createMemoryPlatform({ kind: 'discord', failStart: () => true });
      const ok = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['c1'] } });
      const broken = insertGateway(f.k, { kind: 'discord', authRef: 'gw-bad' });
      const disabled = insertGateway(f.k, { kind: 'telegram', status: 'disabled' });

      gw = await startGateways(f.services, { adapters: { telegram: good.factory, discord: bad.factory }, pollMs: 0 });

      const status = Object.fromEntries(gw.status().map((s) => [s.id, s]));
      expect(status[ok.id]).toEqual({ id: ok.id, kind: 'telegram', status: 'active', lastError: null });
      expect(status[broken.id]).toMatchObject({ kind: 'discord', status: 'error' });
      expect(status[broken.id]!.lastError).toContain('boom with');
      expect(status[broken.id]!.lastError).not.toContain('super-secret-token-value');
      expect(status[disabled.id]).toMatchObject({ status: 'disabled' });
      expect(getGateway(f.k, broken.id)).toMatchObject({ status: 'error' });
      expect(JSON.stringify(f.k.audit.query({ action: 'gateway.error' }))).not.toContain('super-secret-token-value');

      // The healthy gateway still serves its chat.
      await good.receive(ok.id, { chatId: 'c1', userId: 'u1', text: 'ping' });
      expect(good.texts()).toEqual(['echo: ping']);
      expect(good.contexts.has(disabled.id)).toBe(false);
    });

    it('reload() picks up added, disabled, re-enabled and reconfigured rows', async () => {
      const platform = createMemoryPlatform();
      const first = insertGateway(f.k, { kind: 'telegram', config: { allowedChatIds: ['c1'] } });
      gw = await startGateways(f.services, { adapters: { telegram: platform.factory }, pollMs: 0 });
      expect([...platform.contexts.keys()]).toEqual([first.id]);

      const second = insertGateway(f.k, { kind: 'telegram', config: { allowedChatIds: ['c2'] } });
      await gw.reload();
      expect([...platform.contexts.keys()].sort()).toEqual([first.id, second.id].sort());

      updateGateway(f.k, first.id, { status: 'disabled' });
      await gw.reload();
      expect([...platform.contexts.keys()]).toEqual([second.id]);
      expect(platform.stopped).toEqual([first.id]);
      expect(gw.status().find((s) => s.id === first.id)).toMatchObject({ status: 'disabled' });

      updateGateway(f.k, first.id, { status: 'active' });
      await gw.reload();
      expect(platform.contexts.has(first.id)).toBe(true);

      // Allow-list edits apply live without a restart; connection config changes restart the adapter.
      platform.stopped.length = 0;
      updateGateway(f.k, second.id, { config: { allowedChatIds: ['c2', 'c3'] } });
      await gw.reload();
      expect(platform.stopped).toEqual([]);
      await platform.receive(second.id, { chatId: 'c3', userId: 'u', text: '/help' });
      expect(platform.texts('c3')[0]).toContain('Conductor commands');
      updateGateway(f.k, second.id, { config: { allowedChatIds: ['c2', 'c3'], apiBaseUrl: 'http://127.0.0.1:9' } });
      await gw.reload();
      expect(platform.stopped).toEqual([second.id]);
      expect(platform.contexts.has(second.id)).toBe(true);
    });

    it('polls the table so API edits take effect, and stop() stops every adapter', async () => {
      const platform = createMemoryPlatform();
      gw = await startGateways(f.services, { adapters: { telegram: platform.factory }, pollMs: 20 });
      expect(platform.contexts.size).toBe(0);
      const row = insertGateway(f.k, { kind: 'telegram' });
      await expect.poll(() => platform.contexts.has(row.id), { timeout: 3_000 }).toBe(true);
      await gw.stop();
      expect(platform.contexts.size).toBe(0);
      gw = null;
    });

    it('retries a failed adapter on reload once its configuration is fixed', async () => {
      let healthy = false;
      const platform = createMemoryPlatform({ failStart: () => !healthy });
      const row = insertGateway(f.k, { kind: 'telegram' });
      gw = await startGateways(f.services, { adapters: { telegram: platform.factory }, pollMs: 0 });
      expect(gw.status()[0]).toMatchObject({ status: 'error' });
      healthy = true;
      await gw.reload();
      expect(gw.status()[0]).toEqual({ id: row.id, kind: 'telegram', status: 'active', lastError: null });
    });
  });

  describe('notifications', () => {
    let buttons: MemoryPlatform;
    let plain: MemoryPlatform;

    beforeEach(() => {
      buttons = createMemoryPlatform();
      plain = createMemoryPlatform({ kind: 'email', buttons: false });
    });

    const start = async () => {
      gw = await startGateways(f.services, { adapters: { telegram: buttons.factory, email: plain.factory }, pollMs: 0 });
      return gw;
    };

    it('delivers to every gateway serving the org and to no other org\'s gateway', async () => {
      const owner = insertGateway(f.k, { kind: 'telegram', config: { allowedChatIds: ['owner-chat'] } });
      const acmeOnly = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['acme-chat'] } });
      insertGateway(f.k, { kind: 'telegram', orgId: beta.id, config: { allowedChatIds: ['beta-chat'] } });
      const g = await start();

      f.k.bus.emit('notification', { orgId: acme.id, kind: 'digest', title: 'Morning digest — Acme', body: 'Runs: 3 (0 failed)' });
      await g.idle();
      expect(buttons.sent.map((s) => [s.gatewayId, s.chatId]).sort()).toEqual([[owner.id, 'owner-chat'], [acmeOnly.id, 'acme-chat']].sort());
      expect(buttons.texts('acme-chat')[0]).toBe('Morning digest — Acme\n\nRuns: 3 (0 failed)');
      expect(buttons.texts('beta-chat')).toEqual([]);
    });

    it('honours config.notify and config.notifyChatIds, and labels the org on an owner-level gateway', async () => {
      insertGateway(f.k, { kind: 'telegram', config: { allowedChatIds: ['a', 'b'], notifyChatIds: ['b'], notify: ['approval', 'takeover'] } });
      const g = await start();
      f.k.bus.emit('notification', { orgId: acme.id, kind: 'digest', title: 'Morning digest — Acme', body: 'x' });
      f.k.bus.emit('notification', { orgId: beta.id, kind: 'budget', title: 'Budget alert', body: 'x' });
      f.requestApproval(beta.id, 'Wire $500');
      await g.idle();
      expect(buttons.sent).toHaveLength(1);
      expect(buttons.sent[0]).toMatchObject({ chatId: 'b' });
      expect(buttons.sent[0]!.message.text).toContain('[Beta Labs] Approval needed: Wire $500');
    });

    it('renders approvals and reviews as buttons where supported and as reply-commands elsewhere', async () => {
      insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['tg'] } });
      insertGateway(f.k, { kind: 'email', orgId: acme.id, config: { allowedChatIds: ['owner@example.com'] } });
      const g = await start();
      const approval = f.requestApproval(acme.id, 'Send the newsletter');
      const issue = f.requestReview(acme.id, 'Homepage copy');
      await g.idle();

      expect(buttons.sent[0]!.message.buttons).toEqual([
        { label: 'Approve', action: `approval:approve:${approval.id}` },
        { label: 'Deny', action: `approval:deny:${approval.id}` },
      ]);
      expect(buttons.sent[1]!.message.buttons).toEqual([
        { label: 'Accept', action: `review:accepted:${issue.id}` },
        { label: 'Reject', action: `review:rejected:${issue.id}` },
      ]);
      expect(plain.sent[0]!.message.buttons).toBeUndefined();
      expect(plain.sent[0]!.message.text).toContain(`Reply "/approve ${approval.id}" to approve, or "/deny ${approval.id} [note]" to deny.`);
      expect(plain.sent[0]!.message.subject).toBe('Approval needed: Send the newsletter');
      expect(plain.sent[1]!.message.text).toContain(`/accept ${issue.id}`);
    });

    it('delivers budget alerts and takeover links, redacts credentials and drops unsafe links and unknown actions', async () => {
      insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['tg'] } });
      const g = await start();
      const share = 'https://conductor.example.ts.net/takeover/s/abc123?t=signed-token';
      f.k.bus.emit('notification', { orgId: acme.id, kind: 'takeover', title: 'Ada needs you in the browser', body: 'MFA prompt on the bank portal', link: share });
      f.k.bus.emit('notification', { orgId: acme.id, kind: 'budget', title: 'Budget hard stop: Ada at 100%', body: 'Raise the budget to resume.' });
      f.k.bus.emit('notification', {
        orgId: acme.id, kind: 'other', title: 'Leaky', body: 'key sk-ant-abcdefghijklmnopqrstuvwxyz012345', link: 'javascript:alert(1)',
        actions: [{ label: 'Run', action: 'shell:rm -rf /' }],
      });
      await g.idle();
      expect(buttons.texts()).toEqual([
        `Ada needs you in the browser\n\nMFA prompt on the bank portal\n\n${share}`,
        'Budget hard stop: Ada at 100%\n\nRaise the budget to resume.',
        'Leaky\n\nkey [REDACTED]',
      ]);
      expect(buttons.sent[2]!.message.buttons).toBeUndefined();
    });

    it('one press decides; a second press on any gateway is told it was already decided', async () => {
      const row = insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['tg'] } });
      const g = await start();
      const approval = f.requestApproval(acme.id, 'Hire a designer');
      await g.idle();
      const action = buttons.sent[0]!.message.buttons![0]!.action;
      const outcomes: Array<{ text: string; final: boolean; changed: boolean }> = [];
      const press = () => buttons.receive(row.id, { chatId: 'tg', userId: 'u1', text: '', action, respond: async (o) => void outcomes.push(o) });
      await Promise.all([press(), press()]);
      expect(outcomes).toEqual([
        { text: 'Approved: Hire a designer', final: true, changed: true },
        { text: 'Already decided — this approval is approved.', final: true, changed: false },
      ]);
      expect(f.decisions).toHaveLength(1);
      expect(f.decisions[0]).toMatchObject({ approvalId: approval.id, decision: 'approved', by: { kind: 'human', id: 'owner' } });
      expect(f.k.audit.query({ action: 'gateway.action' })[0]!.data).toMatchObject({ approvalId: approval.id, chatId: 'tg', decision: 'approved' });
    });
  });
});
