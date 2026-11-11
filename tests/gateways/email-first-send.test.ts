import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { createGovernance, type GovernanceHandle } from '../../src/governance/index.js';
import { startGateways, type Gateways } from '../../src/gateways/index.js';
import type { Organization } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import { organizations } from '../../src/db/schema/index.js';
import { eq } from 'drizzle-orm';
import { createFakeServices, createMemoryPlatform, insertGateway, type FakeServices, type MemoryPlatform } from './fake-services.js';

/** The email gateway against the REAL approval service: first send to a new recipient is board-gated. */
describe('gateways / email — first send to a new recipient', () => {
  let f: FakeServices;
  let gov: GovernanceHandle;
  let mail: MemoryPlatform;
  let chat: MemoryPlatform;
  let gw: Gateways | null;
  let acme: Organization;

  const notify = (title: string, orgId: string | null = acme.id) => f.k.bus.emit('notification', { orgId, kind: 'digest', title, body: 'body' });
  /** Subjects mailed to an address, leaving out the board's own "Approval needed" notices. */
  const mailed = (to: string) => mail.texts(to).map((t) => t.split('\n')[0]!).filter((t) => !t.startsWith('Approval needed'));
  const start = async () => {
    gw = await startGateways(f.services, { adapters: { email: mail.factory, telegram: chat.factory }, pollMs: 0 });
    return gw;
  };

  beforeEach(() => {
    f = createFakeServices();
    gov = createGovernance(f.k);
    (f.services as { governance: unknown }).governance = { ...f.services.governance, approvals: gov.approvals };
    mail = createMemoryPlatform({ kind: 'email', buttons: false, quietRefusals: true });
    chat = createMemoryPlatform();
    gw = null;
    acme = seedOrg(f.k, 'Acme');
    seedAgent(f.k, acme.id, seedDept(f.k, acme.id).id, 'Ada');
  });
  afterEach(async () => {
    await gw?.stop();
    gov.dispose();
    f.dispose();
  });

  it('holds mail to an address the owner never allow-listed, files one external_send approval, and delivers once approved', async () => {
    insertGateway(f.k, { kind: 'email', orgId: acme.id, name: 'mail', config: { allowedChatIds: ['owner@example.com'], notifyChatIds: ['Owner@Example.com', 'cfo@partner.example'] } });
    const g = await start();

    notify('Digest one');
    await g.idle();
    expect(mailed('Owner@Example.com')).toEqual(['Digest one']);
    expect(mail.texts('cfo@partner.example')).toEqual([]);
    // The owner is told, at the address they allow-listed, how to approve it.
    expect(mail.texts('Owner@Example.com').some((t) => t.startsWith('Approval needed: First email to cfo@partner.example') && t.includes('/approve apr_'))).toBe(true);
    const pending = gov.approvals.list(acme.id, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'external_send', title: 'First email to cfo@partner.example from gateway "mail"', requesterAgentId: null });
    expect(pending[0]!.payload).toMatchObject({ recipient: 'cfo@partner.example', reason: 'new_recipient', source: 'messaging_gateway' });
    expect(f.k.audit.query({ action: 'gateway.send_held' })).toHaveLength(1);

    // Still pending: nothing leaks, and no second approval is filed.
    notify('Digest two');
    await g.idle();
    expect(mail.texts('cfo@partner.example')).toEqual([]);
    expect(gov.approvals.list(acme.id, {})).toHaveLength(1);

    gov.approvals.decide(acme.id, pending[0]!.id, 'approved', OWNER);
    notify('Digest three');
    await g.idle();
    expect(mailed('cfo@partner.example')).toEqual(['Digest three']);
    expect(gov.approvals.isKnownRecipient(acme.id, 'CFO@partner.example')).toBe(true);
    expect(gov.approvals.get(acme.id, pending[0]!.id).consumedAt).not.toBeNull();
    // Remembered: later mail needs no approval.
    notify('Digest four');
    await g.idle();
    expect(mailed('cfo@partner.example')).toEqual(['Digest three', 'Digest four']);
    expect(gov.approvals.list(acme.id, {})).toHaveLength(1);
  });

  it('a denied recipient stays blocked without re-asking; a recipient the org already knows is mailed straight away', async () => {
    insertGateway(f.k, { kind: 'email', orgId: acme.id, config: { allowedChatIds: ['owner@example.com'], notifyChatIds: ['nope@elsewhere.example', 'known@vendor.example'] } });
    gov.approvals.rememberRecipient(acme.id, 'known@vendor.example');
    const g = await start();
    notify('One');
    await g.idle();
    expect(mailed('known@vendor.example')).toEqual(['One']);
    const [approval] = gov.approvals.list(acme.id, { status: 'pending' });
    gov.approvals.decide(acme.id, approval!.id, 'denied', OWNER);
    notify('Two');
    notify('Three');
    await g.idle();
    expect(mail.texts('nope@elsewhere.example')).toEqual([]);
    expect(gov.approvals.list(acme.id, {})).toHaveLength(1);
    expect(gov.approvals.isKnownRecipient(acme.id, 'nope@elsewhere.example')).toBe(false);
  });

  it('respects the org toggle, is per org, and never guesses an org for an install-level notice', async () => {
    const beta = seedOrg(f.k, 'Beta Labs');
    f.k.db.update(organizations).set({ policies: { approvalOverrides: { external_send: false } } }).where(eq(organizations.id, beta.id)).run();
    insertGateway(f.k, { kind: 'email', orgId: null, config: { allowedChatIds: ['owner@example.com'], notifyChatIds: ['ops@partner.example'] } });
    const g = await start();

    notify('Install notice', null);
    await g.idle();
    expect(mailed('ops@partner.example')).toEqual([]);
    expect(gov.approvals.list(null, {})).toEqual([]);

    // Beta loosened the gate; Acme did not.
    notify('Beta digest', beta.id);
    notify('Acme digest', acme.id);
    await g.idle();
    expect(mailed('ops@partner.example')).toEqual(['[Beta Labs] Beta digest']);
    expect(gov.approvals.list(null, { status: 'pending' }).map((a) => a.orgId)).toEqual([acme.id]);
  });

  it('does not gate chat platforms or allow-listed addresses', async () => {
    insertGateway(f.k, { kind: 'telegram', orgId: acme.id, config: { allowedChatIds: ['c1'], notifyChatIds: ['c1', 'c2'] } });
    insertGateway(f.k, { kind: 'email', orgId: acme.id, config: { allowedChatIds: ['owner@example.com'] } });
    const g = await start();
    notify('Hello');
    await g.idle();
    expect(chat.sent.map((s) => s.chatId)).toEqual(['c1', 'c2']);
    expect(mailed('owner@example.com')).toEqual(['Hello']);
    expect(gov.approvals.list(acme.id, {})).toEqual([]);
  });
});
