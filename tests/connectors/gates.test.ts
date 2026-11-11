import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createConnectorGateway } from '../../src/connectors/index.js';
import { classifyAction, extractAmountUsd, extractRecipients } from '../../src/connectors/actions.js';
import { preferToolkit } from '../../src/connectors/access.js';
import { classifyRisk, escalatePolicy } from '../../src/connectors/risk.js';
import type { ToolEntry } from '../../src/connectors/types.js';
import type { ConnectorGateway } from '../../src/contracts/services.js';
import type { Agent, Connector, Organization } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import { toolCalls } from '../../src/db/schema/index.js';
import { fakeApprovals, fakeOrg, runCtx, setPolicies, startHttpMcp, textOf, type FixtureTool, type HttpFixture } from './helpers.js';

const tools = (): FixtureTool[] => [
  { name: 'search_inbox', description: 'Search mail', annotations: { readOnlyHint: true } },
  { name: 'send_email', description: 'Send an email' },
  { name: 'create_post', description: 'Publish a post to the company page' },
  { name: 'create_payment', description: 'Pay a vendor' },
  { name: 'create_record', description: 'Create a CRM record' },
  { name: 'translate', description: 'Translate text', annotations: { readOnlyHint: true }, handler: () => ({ text: 'hola', meta: { costUsd: 0.0125 } }) },
];

describe('action categories (unit)', () => {
  it('classifies sends, publishes, payments, destructive and exec tools, and plain writes', () => {
    const cat = (n: string, builtin = false) => classifyAction(n, { builtin });
    expect(['GMAIL_SEND_EMAIL', 'reply_to_thread', 'chat_postMessage', 'sendDm'].map((n) => cat(n))).toEqual(['send', 'send', 'send', 'send']);
    expect(['publish_page', 'create_post', 'LINKEDIN_CREATE_POST', 'post_tweet', 'post_to_feed'].map((n) => cat(n))).toEqual(['publish', 'publish', 'publish', 'publish', 'publish']);
    expect(['pay_invoice', 'create_payment', 'refund_charge', 'place_order', 'send_payment'].map((n) => cat(n))).toEqual(['payment', 'payment', 'payment', 'payment', 'payment']);
    expect([cat('delete_record'), cat('exec_sql'), cat('evaluate', true)]).toEqual(['destructive', 'exec', 'exec']);
    // An HTTP-verb style name, reads and a payment *lookup* are not gates.
    expect([cat('post_users'), cat('create_record'), cat('list_payments'), cat('get_payment'), cat('search_docs')]).toEqual(['write', 'write', 'other', 'other', 'other']);
    // Page interaction is only recognised on Conductor's own servers.
    expect([cat('click', true), cat('type', true), cat('upload', true), cat('fill_secret', true), cat('upload')]).toEqual(['interaction', 'interaction', 'interaction', 'credential', 'write']);
    expect([classifyRisk('create_payment'), classifyRisk('create_post'), classifyRisk('list_payments')]).toEqual(['high', 'external_write', 'external_read']);
  });

  it('extracts the amount a payment would spend', () => {
    expect(extractAmountUsd({ amount: 120 })).toBe(120);
    expect(extractAmountUsd({ amount_cents: 4999, currency: 'usd' })).toBeCloseTo(49.99);
    expect(extractAmountUsd({ total: '$1,250.50' })).toBeCloseTo(1250.5);
    expect(extractAmountUsd({ order: { line_items: [{ unit_amount: 30 }, { unit_amount: 75 }] } })).toBe(75);
    expect(extractAmountUsd({ memo: 'amount 500', quantity: 3 })).toBeNull();
    expect(extractAmountUsd({ amount: 'lots' })).toBeNull();
  });

  it('extracts recipients as stable keys: bare addresses for email, server-qualified ids otherwise', () => {
    expect(extractRecipients({ to: 'Ann <Ann@Example.com>, bob@example.com', cc: ['carol@example.com'], subject: 'x@y.z is not a recipient' }, 'gmail'))
      .toEqual(['ann@example.com', 'bob@example.com', 'carol@example.com']);
    expect(extractRecipients({ channel: 'C012AB', text: 'hi' }, 'slack')).toEqual(['slack:c012ab']);
    expect(extractRecipients({ recipients: [{ email: 'dan@example.com' }], phone_number: '+15551234567' }, 'twilio')).toEqual(['dan@example.com', 'twilio:+15551234567']);
    expect(extractRecipients({ text: 'hi' }, 'slack')).toEqual([]);
  });

  it('escalates after untrusted content only for high-risk actions, and by autonomy level', () => {
    const esc = (risk: Parameters<typeof escalatePolicy>[1], level: number, untrusted: boolean, cat: Parameters<typeof escalatePolicy>[4]) => escalatePolicy('allowed', risk, level, untrusted, cat);
    // Untrusted content: sends, payments, publishes, destructive ops, exec — not page interaction or plain writes.
    expect((['send', 'publish', 'destructive'] as const).map((c) => esc('external_write', 3, true, c))).toEqual(['ask', 'ask', 'ask']);
    expect([esc('high', 3, true, 'payment'), esc('high', 3, true, 'exec'), esc('high', 3, true, 'other')]).toEqual(['ask', 'ask', 'ask']);
    expect((['interaction', 'credential', 'write'] as const).map((c) => esc('external_write', 2, true, c))).toEqual(['allowed', 'allowed', 'allowed']);
    // Autonomy: level 0 asks before any external change; level 1 not before page interaction; level 2 follows policy.
    expect([esc('external_write', 0, false, 'interaction'), esc('external_write', 1, false, 'interaction'), esc('external_write', 1, false, 'write'), esc('external_write', 2, false, 'write')])
      .toEqual(['ask', 'allowed', 'ask', 'allowed']);
    expect([escalatePolicy('off', 'high', 0, true, 'payment'), esc('external_read', 0, true, 'other')]).toEqual(['off', 'allowed']);
  });

  it('toolkitDefault keeps only the preferred source when Composio and Arcade offer the same tool', () => {
    const entry = (name: string) => ({ def: { name } }) as ToolEntry;
    const per: Array<{ server: { connector: Connector | null }; tools: ToolEntry[] }> = [
      { server: { connector: { kind: 'composio' } as Connector }, tools: [entry('GMAIL_SEND_EMAIL'), entry('GMAIL_LIST')] },
      { server: { connector: { kind: 'arcade' } as Connector }, tools: [entry('Gmail.SendEmail'), entry('Gmail.Archive')] },
      { server: { connector: null }, tools: [entry('gmail_send_email')] },
    ];
    const names = (r: typeof per) => r.map((p) => p.tools.map((t) => t.def.name));
    expect(names(preferToolkit(per, undefined))).toEqual(names(per));
    expect(names(preferToolkit(per, 'composio'))).toEqual([['GMAIL_SEND_EMAIL', 'GMAIL_LIST'], ['Gmail.Archive'], ['gmail_send_email']]);
    expect(names(preferToolkit(per, 'arcade'))).toEqual([['GMAIL_LIST'], ['Gmail.SendEmail', 'Gmail.Archive'], ['gmail_send_email']]);
  });
});

describe('connector gateway — default approval gates, spend threshold and call cost', () => {
  let k: TestKernel;
  let gw: ConnectorGateway;
  let approvals: ReturnType<typeof fakeApprovals>;
  let upstream: HttpFixture;
  let org: Organization;
  let agent: Agent;
  let ops: Connector;

  beforeEach(async () => {
    k = createTestKernel();
    approvals = fakeApprovals(k);
    gw = createConnectorGateway(k, { approvals, org: fakeOrg(k) }, { toolCacheTtlMs: 1000 });
    upstream = await startHttpMcp(tools());
    org = seedOrg(k);
    agent = seedAgent(k, org.id, seedDept(k, org.id).id, 'Ada', { autonomyLevel: 2 });
    ops = await gw.install(org.id, { name: 'ops', kind: 'mcp_http', config: { url: upstream.url } }, OWNER);
    // Every tool explicitly Allowed: whatever still asks below is a governance gate, not tool policy.
    gw.grant(org.id, ops.id, agent.id, { toolPolicies: { '*': 'allowed' } }, OWNER);
  });
  afterEach(async () => {
    await gw.close();
    await upstream.close();
    k.dispose();
  });
  const upstreamCalls = () => upstream.calls.map((c) => c.tool);
  /** A new run of the same agent: nothing untrusted ingested yet. */
  const fresh = () => runCtx(k, agent, { autonomyLevel: 3 });

  it('first send to a new recipient raises an external_send approval; once approved the recipient is remembered', async () => {
    const ctx = runCtx(k, agent, { autonomyLevel: 3 });
    const args = { to: 'New.Customer@Example.com', body: 'hello' };
    expect(textOf(await gw.callTool(ctx, 'ops__send_email', args))).toMatch(/Approval required/);
    const [approval] = approvals.all();
    expect(approval).toMatchObject({ kind: 'external_send', status: 'pending', requesterAgentId: agent.id });
    expect(approval!.payload).toMatchObject({ reason: 'new_recipient', category: 'send', newRecipients: ['new.customer@example.com'], tool: 'ops__send_email' });
    expect(approval!.title).toBe('First send to a new recipient: ops__send_email');
    expect(textOf(await gw.callTool(ctx, 'ops__send_email', args))).toMatch(/Still pending/);
    expect(approvals.isKnownRecipient(org.id, 'new.customer@example.com')).toBe(false);
    expect(upstreamCalls()).toEqual([]);

    approvals.decide(org.id, approval!.id, 'approved', OWNER);
    expect(textOf(await gw.callTool(ctx, 'ops__send_email', args))).toContain('send_email ok');
    expect(approvals.isKnownRecipient(org.id, 'new.customer@example.com')).toBe(true);

    // Not a first send any more: a different message to the same person just goes.
    // (Fresh runs: this one has by now read outside content — the send's own result — which makes every later send Ask-first.)
    expect(textOf(await gw.callTool(fresh(), 'ops__send_email', { to: 'new.customer@example.com', body: 'follow-up' }))).toContain('send_email ok');
    // A new address on the same message asks again, naming only the new one.
    expect(textOf(await gw.callTool(fresh(), 'ops__send_email', { to: 'new.customer@example.com', cc: 'boss@example.com', body: 'x' }))).toMatch(/Approval required/);
    expect(approvals.all().at(-1)!.payload).toMatchObject({ newRecipients: ['boss@example.com'] });
    expect(approvals.all()).toHaveLength(2);
    expect(upstreamCalls()).toEqual(['send_email', 'send_email']);
  });

  it('a denied first send is not remembered, and the owner can loosen the gate per org', async () => {
    const ctx = runCtx(k, agent);
    await gw.callTool(ctx, 'ops__send_email', { to: 'stranger@example.com' });
    approvals.decide(org.id, approvals.all()[0]!.id, 'denied', OWNER);
    expect((await gw.callTool(ctx, 'ops__send_email', { to: 'stranger@example.com' })).isError).toBe(true);
    expect(approvals.isKnownRecipient(org.id, 'stranger@example.com')).toBe(false);

    setPolicies(k, org.id, { approvalOverrides: { external_send: false } });
    expect(textOf(await gw.callTool(runCtx(k, agent), 'ops__send_email', { to: 'anyone@example.com' }))).toContain('send_email ok');
  });

  it('publishing is gated by default under its own approval kind, and can be loosened', async () => {
    const ctx = runCtx(k, agent, { autonomyLevel: 3 });
    expect(textOf(await gw.callTool(ctx, 'ops__create_post', { text: 'We are hiring' }))).toMatch(/Approval required/);
    expect(approvals.all()[0]).toMatchObject({ kind: 'publish', title: 'Publish: ops__create_post' });
    expect(approvals.all()[0]!.payload).toMatchObject({ reason: 'publish', category: 'publish' });
    // An ordinary external write is not a default gate.
    expect(textOf(await gw.callTool(ctx, 'ops__create_record', { name: 'Acme' }))).toContain('create_record ok');

    setPolicies(k, org.id, { approvalOverrides: { publish: false } });
    expect(textOf(await gw.callTool(fresh(), 'ops__create_post', { text: 'We are hiring' }))).toContain('create_post ok');
  });

  it('any payment is gated by default; with the gate loosened the spend threshold (default $50) still applies', async () => {
    const ctx = runCtx(k, agent, { autonomyLevel: 3 });
    expect(textOf(await gw.callTool(ctx, 'ops__create_payment', { vendor: 'aws', amount: 12 }))).toMatch(/Approval required/);
    expect(approvals.all()[0]).toMatchObject({ kind: 'payment' });
    expect(approvals.all()[0]!.payload).toMatchObject({ reason: 'payment', amountUsd: 12 });

    setPolicies(k, org.id, { approvalOverrides: { payment: false } });
    expect(textOf(await gw.callTool(ctx, 'ops__create_payment', { vendor: 'aws', amount: 49.5 }))).toContain('create_payment ok');
    expect(textOf(await gw.callTool(fresh(), 'ops__create_payment', { vendor: 'aws', amount_cents: 5001 }))).toMatch(/Approval required/);
    expect(approvals.all().at(-1)).toMatchObject({ kind: 'payment', title: 'Spend over threshold: ops__create_payment' });
    expect(approvals.all().at(-1)!.payload).toMatchObject({ reason: 'spend_threshold', amountUsd: 50.01 });

    // The org's own threshold replaces the default, in both directions.
    setPolicies(k, org.id, { approvalOverrides: { payment: false }, approvalSpendThresholdUsd: 500 });
    expect(textOf(await gw.callTool(fresh(), 'ops__create_payment', { vendor: 'aws', amount: 499 }))).toContain('create_payment ok');
    setPolicies(k, org.id, { approvalOverrides: { payment: false }, approvalSpendThresholdUsd: 5 });
    expect(textOf(await gw.callTool(fresh(), 'ops__create_payment', { vendor: 'aws', amount: 6 }))).toMatch(/Approval required/);
    expect(approvals.all().at(-1)!.payload).toMatchObject({ reason: 'spend_threshold', amountUsd: 6 });
    expect(upstreamCalls()).toEqual(['create_payment', 'create_payment']);
  });

  it('extraGated tightens by tool name, qualified name or category', async () => {
    const ctx = runCtx(k, agent, { autonomyLevel: 3 });
    expect(textOf(await gw.callTool(ctx, 'ops__create_record', { n: 1 }))).toContain('create_record ok');
    for (const gated of ['create_record', 'ops__create_record', 'write']) {
      setPolicies(k, org.id, { extraGated: [gated] });
      expect(textOf(await gw.callTool(ctx, 'ops__create_record', { n: gated }))).toMatch(/Approval required/);
      expect(approvals.all().at(-1)).toMatchObject({ kind: 'tool_call' });
      expect(approvals.all().at(-1)!.payload).toMatchObject({ reason: 'org_policy', gatedBy: gated });
    }
    // Reads are never gated this way.
    setPolicies(k, org.id, { extraGated: ['search_inbox', 'other'] });
    expect(textOf(await gw.callTool(ctx, 'ops__search_inbox', {}))).toContain('search_inbox ok');
  });

  it('records the cost a tool result reports, else the connector\'s per-call price, else zero', async () => {
    const ctx = runCtx(k, agent);
    await gw.callTool(ctx, 'ops__translate', { text: 'hello' });
    await gw.callTool(ctx, 'ops__search_inbox', {});
    await gw.update(org.id, ops.id, { config: { url: upstream.url, costPerCallUsd: 0.002 } }, OWNER);
    await gw.callTool(ctx, 'ops__search_inbox', { q: 'priced' });
    await gw.callTool(ctx, 'ops__translate', { text: 'again' });
    // A call that never ran (pending approval) costs nothing.
    await gw.callTool(ctx, 'ops__create_post', { text: 'x' });

    const rows = k.db.select().from(toolCalls).where(eq(toolCalls.runId, ctx.runId)).all().sort((a, b) => a.id.localeCompare(b.id));
    expect(rows.map((r) => [r.tool, r.status, r.costUsd])).toEqual([
      ['ops__translate', 'ok', 0.0125], ['ops__search_inbox', 'ok', 0], ['ops__search_inbox', 'ok', 0.002], ['ops__translate', 'ok', 0.0125], ['ops__create_post', 'approval_pending', 0],
    ]);
    const audited = k.audit.query({ orgId: org.id, action: 'tool.called' }).map((a) => (a.data as { costUsd: number }).costUsd).sort();
    expect(audited).toEqual([0, 0, 0.002, 0.0125, 0.0125]);
    await expect(gw.update(org.id, ops.id, { config: { url: upstream.url, costPerCallUsd: -1 } }, OWNER)).rejects.toThrow(/costPerCallUsd/);
  });

  it('a department-scoped connector cannot be granted, inherited or used across departments', async () => {
    const sales = seedDept(k, org.id, 'Sales');
    const seller = seedAgent(k, org.id, sales.id, 'Sam', { autonomyLevel: 2 });
    const crm = await gw.install(org.id, { name: 'salescrm', kind: 'mcp_http', scope: 'dept', scopeId: sales.id, config: { url: upstream.url } }, OWNER);

    expect(() => gw.grant(org.id, crm.id, agent.id, {}, OWNER)).toThrow(/scoped to another department/);
    expect(() => gw.grant(org.id, crm.id, agent.id, {}, { kind: 'agent', id: agent.id })).toThrow(/scoped to another department/);
    expect(approvals.all()).toEqual([]);
    expect(gw.listGrants(org.id, { connectorId: crm.id })).toEqual([]);
    expect(gw.grant(org.id, crm.id, seller.id, {}, OWNER).grant?.agentId).toBe(seller.id);
    expect((await gw.listTools(runCtx(k, seller))).some((t) => t.name === 'salescrm__search_inbox')).toBe(true);

    // An approval filed while the agent was in the department does not apply after it moved out.
    const mover = seedAgent(k, org.id, sales.id, 'Mo', { autonomyLevel: 2 });
    const pending = gw.grant(org.id, crm.id, mover.id, {}, { kind: 'agent', id: mover.id });
    const { agents } = await import('../../src/db/schema/index.js');
    k.db.update(agents).set({ deptId: agent.deptId }).where(eq(agents.id, mover.id)).run();
    approvals.decide(org.id, pending.approval!.id, 'approved', OWNER);
    expect(gw.listGrants(org.id, { agentId: mover.id })).toEqual([]);

    // Re-scoping an org connector to a department drops grants outside it, and it stops resolving for them.
    expect((await gw.listTools(runCtx(k, agent))).some((t) => t.name === 'ops__search_inbox')).toBe(true);
    await gw.update(org.id, ops.id, { scope: 'dept', scopeId: sales.id }, OWNER);
    expect(gw.listGrants(org.id, { connectorId: ops.id })).toEqual([]);
    expect(await gw.listTools(runCtx(k, agent))).toEqual([]);
    expect((await gw.callTool(runCtx(k, agent), 'ops__search_inbox', {})).isError).toBe(true);
    expect(k.audit.query({ orgId: org.id, action: 'connector.grant_revoked' })).toHaveLength(1);
  });
});
