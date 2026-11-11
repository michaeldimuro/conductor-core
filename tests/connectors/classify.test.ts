import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createConnectorGateway } from '../../src/connectors/index.js';
import { classifyAction, extractRecipients } from '../../src/connectors/actions.js';
import { isPayment, moneyShape, paymentByDescription, paymentByName } from '../../src/connectors/payment.js';
import { classifyRisk } from '../../src/connectors/risk.js';
import type { ConnectorGateway } from '../../src/contracts/services.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import { fakeApprovals, fakeOrg, runCtx, setPolicies, startHttpMcp, textOf, type FixtureTool, type HttpFixture } from './helpers.js';

describe('payment classification (unit)', () => {
  it('recognises payments by name well beyond pay/purchase', () => {
    const paying = [
      'pay_invoice', 'invoice_pay', 'create_payment', 'send_payment', 'refund_charge', 'place_order', 'create_order', 'STRIPE_CREATE_ORDER', 'submitOrder',
      'transfer', 'create_transfer', 'transfer_funds', 'send_money', 'payout', 'create_payout', 'refund', 'charge', 'charge_card', 'purchase', 'buy_credits',
      'subscribe', 'subscribe_to_plan', 'create_subscription', 'checkout', 'checkout_cart', 'withdraw', 'donate', 'capture_charge', 'confirm_payment',
    ];
    expect(paying.filter((n) => !paymentByName(n))).toEqual([]);
    expect(paying.filter((n) => classifyAction(n) !== 'payment')).toEqual([]);
    expect([classifyRisk('create_order'), classifyRisk('payout'), classifyRisk('transfer')]).toEqual(['high', 'high', 'high']);
  });

  it('does not flag lookups, cancellations or look-alike names', () => {
    const notPaying = [
      'list_payments', 'get_payment', 'get_order', 'list_orders', 'search_orders', 'get_charge', 'list_charges', 'get_refund', 'list_refunds', 'payment_status',
      'check_payment_status', 'get_payout', 'list_subscriptions', 'get_subscription', 'cancel_order', 'cancel_subscription', 'void_charge', 'update_order',
      'delete_payment_method', 'estimate_order', 'preview_invoice', 'transfer_file', 'transfer_ownership', 'transfer_issue', 'subscribe_to_channel',
      'subscribe_webhook', 'subscribe_newsletter', 'unsubscribe', 'set_sort_order', 'reorder_list', 'create_invoice', 'create_record', 'post_users',
      'export_payments', 'download_invoice', 'get_pay_stub',
    ];
    expect(notPaying.filter((n) => paymentByName(n))).toEqual([]);
    expect(notPaying.filter((n) => classifyAction(n) === 'payment')).toEqual([]);
    expect([classifyAction('list_payments'), classifyAction('get_order')]).toEqual(['other', 'other']);
    expect([classifyRisk('list_payments'), classifyRisk('get_order')]).toEqual(['external_read', 'external_read']);
    // A lookup stays a lookup whatever its description or arguments mention.
    expect(isPayment('list_payments', { description: 'Charges the customer card', args: { amount: 5, currency: 'usd' } })).toBe(false);
    expect(isPayment('get_order', { args: { total: 20, currency: 'eur' } })).toBe(false);
  });

  it('uses the argument shape: an amount with a currency or payment method, or an amount on an ambiguous name', () => {
    expect(moneyShape({ order: { items: [{ unit_amount: 30 }] }, currency: 'USD' })).toEqual({ amount: true, currency: true, method: false });
    expect(isPayment('execute', { args: { amount: 25, currency: 'usd' } })).toBe(true);
    expect(isPayment('run_action', { args: { total: '19.99', payment_method: 'pm_1' } })).toBe(true);
    expect(isPayment('STRIPE_CREATE_TRANSFER', { args: { amount: 500, destination: 'acct_1' } })).toBe(true);
    expect(isPayment('send', { args: { amount_cents: 1200, to: 'bob' } })).toBe(true);
    // No amount, or an amount on a catalog / bookkeeping record, is not a payment.
    expect(isPayment('execute', { args: { currency: 'usd' } })).toBe(false);
    expect(isPayment('run_action', { args: { price: 10 } })).toBe(false);
    expect(isPayment('create_product', { args: { price: 10, currency: 'usd' } })).toBe(false);
    expect(isPayment('create_invoice', { args: { amount: 900, currency: 'usd' } })).toBe(false);
    expect(isPayment('send_invoice', { args: { amount: 900, currency: 'usd' } })).toBe(false);
    expect(isPayment('create_expense', { args: { total: 40, currency: 'usd' } })).toBe(false);
    expect(isPayment('create_record', { args: { quantity: 3, memo: 'amount 500' } })).toBe(false);
    expect(classifyAction('send_email', { args: { to: 'a@b.co', subject: 'Invoice total 500 USD' } })).toBe('send');
  });

  it('uses the upstream description and annotations, which can add a gate but not remove one', () => {
    expect(paymentByDescription('Charges the customer\'s card on file.')).toBe(true);
    expect(paymentByDescription('Charges the card on file for the given amount.')).toBe(true);
    expect(paymentByDescription('Purchase a domain name.')).toBe(true);
    expect(paymentByDescription('Initiates a payout to the connected account.')).toBe(true);
    expect(paymentByDescription('Create an invoice the customer can pay later.')).toBe(false);
    expect(isPayment('execute_action', { description: 'Transfers funds between two accounts.' })).toBe(true);
    expect(classifyRisk('execute_action', undefined, 'Transfers funds between two accounts.')).toBe('high');
    expect(isPayment('run_workflow', { annotations: { title: 'Create order' } })).toBe(true);
    // A tool the upstream declares read-only is not turned into a payment by soft evidence…
    expect(isPayment('lookup_rate', { annotations: { readOnlyHint: true }, description: 'Purchase price lookup', args: { amount: 5, currency: 'usd' } })).toBe(false);
    // …but a read-only claim never lowers what the name says.
    expect(isPayment('create_payment', { annotations: { readOnlyHint: true } })).toBe(true);
    // Conductor's own servers are classified by name only.
    expect(classifyAction('set_budget', { builtin: true, args: { amount: 5, currency: 'usd' } })).not.toBe('payment');
  });
});

describe('recipient extraction (unit)', () => {
  it('finds recipients under common key variants and inside nested arguments', () => {
    expect(extractRecipients({ message: { toRecipients: [{ emailAddress: { address: 'Ann@Example.com' } }], subject: 's' } }, 'outlook')).toEqual(['ann@example.com']);
    expect(extractRecipients({ payload: { recipient: { id: 'U123' } } }, 'slack')).toEqual(['slack:u123']);
    expect(extractRecipients({ to_number: '+15551230000' }, 'twilio')).toEqual(['twilio:+15551230000']);
    expect(extractRecipients({ thread_id: 'T-9', body: 'ok' }, 'gmail')).toEqual(['gmail:t-9']);
    expect(extractRecipients({ params: { destination: 'ops@example.com', toAddresses: ['x@example.com'] } }, 'ses')).toEqual(['ops@example.com', 'x@example.com']);
    expect(extractRecipients({ recipient_email: 'dan@example.com', conversationId: 'c1' }, 'crm')).toEqual(['dan@example.com', 'crm:c1']);
  });

  it('never takes the sender or free text for a recipient', () => {
    expect(extractRecipients({ from: 'me@example.com', sender: { email: 'me@example.com' }, body: 'write to eve@example.com', subject: 'x@y.z' }, 'gmail')).toEqual([]);
    expect(extractRecipients({ text: 'hi' }, 'slack')).toEqual([]);
    expect(extractRecipients({ raw: 'VG86IGFAYi5jbw==' }, 'gmail')).toEqual([]);
  });
});

describe('connector gateway — unknown recipients and argument-shaped payments', () => {
  let k: TestKernel;
  let gw: ConnectorGateway;
  let approvals: ReturnType<typeof fakeApprovals>;
  let upstream: HttpFixture;
  let org: Organization;
  let agent: Agent;

  const tools = (): FixtureTool[] => [
    { name: 'send_email', description: 'Send an email' },
    { name: 'reply_to_thread', description: 'Reply in a thread' },
    { name: 'list_payments', description: 'List payments' },
    { name: 'get_order', description: 'Fetch one order' },
    { name: 'create_order', description: 'Create an order' },
    { name: 'transfer', description: 'Move value' },
    { name: 'run_action', description: 'Run a named action' },
    { name: 'settle_up', description: 'Charges the card on file for the outstanding balance.' },
  ];

  beforeEach(async () => {
    k = createTestKernel();
    approvals = fakeApprovals(k);
    gw = createConnectorGateway(k, { approvals, org: fakeOrg(k) }, { toolCacheTtlMs: 1000 });
    upstream = await startHttpMcp(tools());
    org = seedOrg(k);
    agent = seedAgent(k, org.id, seedDept(k, org.id).id, 'Ada', { autonomyLevel: 3 });
    const ops = await gw.install(org.id, { name: 'ops', kind: 'mcp_http', config: { url: upstream.url } }, OWNER);
    // Everything explicitly Allowed: whatever still asks is a governance gate.
    gw.grant(org.id, ops.id, agent.id, { toolPolicies: { '*': 'allowed' } }, OWNER);
  });
  afterEach(async () => {
    await gw.close();
    await upstream.close();
    k.dispose();
  });
  const ctx = () => runCtx(k, agent, { autonomyLevel: 3 });
  const call = async (tool: string, args: Record<string, unknown>) => textOf(await gw.callTool(ctx(), `ops__${tool}`, args));

  it('gates a send whose recipient cannot be identified, every time, and remembers nothing', async () => {
    expect(await call('send_email', { raw: 'VG86IGFAYi5jbw==' })).toMatch(/Approval required/);
    const [approval] = approvals.all();
    expect(approval).toMatchObject({ kind: 'external_send', title: 'Send to an unidentified recipient: ops__send_email' });
    expect(approval!.payload).toMatchObject({ reason: 'unknown_recipient', recipientUnknown: true, newRecipients: [] });
    expect(upstream.calls).toEqual([]);

    const same = ctx();
    approvals.decide(org.id, approval!.id, 'approved', OWNER);
    expect(textOf(await gw.callTool({ ...same, agentId: agent.id }, 'ops__send_email', { raw: 'VG86IGFAYi5jbw==' }))).toContain('send_email ok');
    // Another recipient-less send asks again: there is no address to have become "known".
    expect(await call('send_email', { raw: 'b3RoZXI=' })).toMatch(/Approval required/);
    expect(await call('reply_to_thread', { body: 'thanks' })).toMatch(/Approval required/);
    expect(approvals.all()).toHaveLength(3);
  });

  it('a nested recipient is gated on first send and remembered once approved', async () => {
    const args = { message: { toRecipients: [{ emailAddress: { address: 'New@Example.com' } }], body: 'hi' } };
    expect(await call('send_email', args)).toMatch(/Approval required/);
    expect(approvals.all()[0]!.payload).toMatchObject({ reason: 'new_recipient', newRecipients: ['new@example.com'] });
    approvals.rememberRecipient(org.id, 'new@example.com');
    expect(await call('send_email', { message: { toRecipients: [{ emailAddress: { address: 'new@example.com' } }], body: 'again' } })).toContain('send_email ok');
  });

  it('the owner can still switch the external-send gate off for the org', async () => {
    setPolicies(k, org.id, { approvalOverrides: { external_send: false } });
    expect(await call('send_email', { raw: 'x' })).toContain('send_email ok');
  });

  it('gates payments recognised by name, description or argument shape, and leaves lookups alone', async () => {
    expect(await call('list_payments', { amount: 5, currency: 'usd' })).toContain('list_payments ok');
    expect(await call('get_order', { id: 'o1' })).toContain('get_order ok');
    expect(approvals.all()).toEqual([]);

    expect(await call('create_order', { sku: 'A1', quantity: 2 })).toMatch(/Approval required/);
    expect(await call('transfer', { to_account: 'acct_2' })).toMatch(/Approval required/);
    expect(await call('settle_up', {})).toMatch(/Approval required/);
    // A neutral name is a payment only when the arguments look like one.
    expect(await call('run_action', { action: 'sync' })).toContain('run_action ok');
    expect(await call('run_action', { action: 'pay', amount: 20, currency: 'usd' })).toMatch(/Approval required/);
    expect(approvals.all().map((a) => [a.kind, (a.payload as { tool: string }).tool])).toEqual([
      ['payment', 'ops__create_order'], ['payment', 'ops__transfer'], ['payment', 'ops__settle_up'], ['payment', 'ops__run_action'],
    ]);
    expect(approvals.all().at(-1)!.payload).toMatchObject({ reason: 'payment', category: 'payment', amountUsd: 20 });
    expect(upstream.calls.map((c) => c.tool)).toEqual(['list_payments', 'get_order', 'run_action']);
  });
});
