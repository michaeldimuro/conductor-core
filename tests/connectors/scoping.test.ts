import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createConnectorGateway } from '../../src/connectors/index.js';
import type { ConnectorGateway } from '../../src/contracts/services.js';
import type { Agent, Connector, Organization } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import { agents, configRevisions, departments, organizations, toolCalls } from '../../src/db/schema/index.js';
import { fakeApprovals, fakeOrg, runCtx, STDIO_FIXTURE, textOf } from './helpers.js';

const stdioConfig = { command: process.execPath, args: [STDIO_FIXTURE], env: { FIXTURE_TOKEN: { secretRef: 'FIXTURE_TOKEN' } } };

describe('connector gateway — per-agent scoping over a real stdio MCP server (FR-10)', () => {
  let k: TestKernel;
  let gw: ConnectorGateway;
  let org: Organization;
  let a: Agent;
  let b: Agent;
  let notes: Connector;

  beforeEach(async () => {
    k = createTestKernel();
    gw = createConnectorGateway(k, { approvals: fakeApprovals(k), org: fakeOrg(k) });
    org = seedOrg(k);
    const dept = seedDept(k, org.id);
    a = seedAgent(k, org.id, dept.id, 'Ada', { autonomyLevel: 2 });
    b = seedAgent(k, org.id, dept.id, 'Bob', { autonomyLevel: 2 });
    await k.secrets.set('org/acme/notes/FIXTURE_TOKEN', 'tok-default-account');
    notes = await gw.install(org.id, { name: 'notes', kind: 'mcp_stdio', config: stdioConfig, authRef: 'org/acme/notes' }, OWNER);
  });
  afterEach(async () => {
    await gw.close();
    k.dispose();
  });

  it('lets agent A call a granted tool while agent B can neither see nor call it', async () => {
    expect(gw.grant(org.id, notes.id, a.id, {}, OWNER).grant?.agentId).toBe(a.id);
    const ctxA = runCtx(k, a);
    const ctxB = runCtx(k, b);

    const names = (await gw.listTools(ctxA)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['notes__get_note', 'notes__whoami', 'notes__send_message']));
    const ok = await gw.callTool(ctxA, 'notes__get_note', { id: '7' });
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok)).toContain('note 7: remember the milk');

    expect(await gw.listTools(ctxB)).toEqual([]);
    const denied = await gw.callTool(ctxB, 'notes__get_note', { id: '7' });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain('not available');
    const rows = k.db.select().from(toolCalls).where(eq(toolCalls.agentId, b.id)).all();
    expect(rows.map((r) => r.status)).toEqual(['denied']);
  });

  it('hides Off tools and makes them uncallable', async () => {
    gw.grant(org.id, notes.id, a.id, { toolPolicies: { send_message: 'off' } }, OWNER);
    const ctx = runCtx(k, a);
    const names = (await gw.listTools(ctx)).map((t) => t.name);
    expect(names).toContain('notes__get_note');
    expect(names).not.toContain('notes__send_message');
    const r = await gw.callTool(ctx, 'notes__send_message', { to: 'x@example.com', body: 'hi' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain('sent to');
  });

  it('intersects the connector allowlist with the grant allowlist', async () => {
    await gw.update(org.id, notes.id, { toolAllowlist: ['get_note', 'whoami', 'send_message'] }, OWNER);
    gw.grant(org.id, notes.id, a.id, { toolAllowlist: ['get_note', 'delete_note'] }, OWNER);
    const ctx = runCtx(k, a);
    expect((await gw.listTools(ctx)).map((t) => t.name)).toEqual(['notes__get_note']);
    expect((await gw.callTool(ctx, 'notes__whoami', {})).isError).toBe(true);
    expect((await gw.callTool(ctx, 'notes__delete_note', { id: '1' })).isError).toBe(true);
    expect((await gw.snapshot(org.id, a.id)).find((c) => c.id === notes.id)?.tools).toEqual(['get_note']);
  });

  it('grants implicitly through org defaults and department shared connectors, minus the deny list', async () => {
    k.db.update(organizations).set({ defaultConnectors: [notes.id] }).where(eq(organizations.id, org.id)).run();
    const ctxA = runCtx(k, a);
    expect((await gw.listTools(ctxA)).map((t) => t.name)).toContain('notes__get_note');
    expect(gw.listGrants(org.id)).toEqual([]);

    k.db.update(agents).set({ denyConnectors: [notes.id] }).where(eq(agents.id, b.id)).run();
    expect(await gw.listTools(runCtx(k, b))).toEqual([]);

    k.db.update(organizations).set({ defaultConnectors: [] }).where(eq(organizations.id, org.id)).run();
    expect(await gw.listTools(runCtx(k, a))).toEqual([]);
    k.db.update(departments).set({ sharedConnectors: [notes.id] }).where(eq(departments.id, a.deptId)).run();
    expect((await gw.listTools(runCtx(k, a))).length).toBeGreaterThan(0);
    // An explicit grant never overrides the agent's deny list.
    gw.grant(org.id, notes.id, b.id, {}, OWNER);
    expect(await gw.listTools(runCtx(k, b))).toEqual([]);
  });

  it('injects per-grant credentials: two agents, one connector, different accounts', async () => {
    await k.secrets.set('org/acme/notes-bob/FIXTURE_TOKEN', 'tok-bobs-account');
    gw.grant(org.id, notes.id, a.id, {}, OWNER);
    gw.grant(org.id, notes.id, b.id, { authRef: 'org/acme/notes-bob' }, OWNER);
    process.env.CONDUCTOR_TEST_PARENT_SECRET = 'daemon-only-value';
    try {
      const fromA = textOf(await gw.callTool(runCtx(k, a), 'notes__whoami', {}));
      const fromB = textOf(await gw.callTool(runCtx(k, b), 'notes__whoami', {}));
      expect(fromA).toContain('account=tok-default-account');
      expect(fromB).toContain('account=tok-bobs-account');
      // The subprocess gets a minimal environment, not the daemon's.
      expect(fromA).toContain('inheritedSecret=none');
    } finally {
      delete process.env.CONDUCTOR_TEST_PARENT_SECRET;
    }
  });

  it('refuses secret refs that point into another org\'s namespace', async () => {
    await k.secrets.set('org/other/notes/FIXTURE_TOKEN', 'tok-other-org');
    const leaky = await gw.install(org.id, {
      name: 'leaky', kind: 'mcp_stdio', config: { ...stdioConfig, env: { FIXTURE_TOKEN: { secretRef: 'org/other/notes/FIXTURE_TOKEN' } } },
    }, OWNER);
    gw.grant(org.id, leaky.id, a.id, {}, OWNER);
    const r = await gw.callTool(runCtx(k, a), 'leaky__whoami', {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain('tok-other-org');
  });

  it('isolates organizations: another org cannot read, grant, list or call', async () => {
    const other = seedOrg(k, 'Globex');
    const otherDept = seedDept(k, other.id);
    const mallory = seedAgent(k, other.id, otherDept.id, 'Mallory', { autonomyLevel: 3 });
    gw.grant(org.id, notes.id, a.id, {}, OWNER);

    expect(() => gw.get(other.id, notes.id)).toThrow(/not found/);
    expect(gw.list(other.id)).toEqual([]);
    expect(gw.listGrants(other.id)).toEqual([]);
    expect(() => gw.grant(other.id, notes.id, mallory.id, {}, OWNER)).toThrow(/not found/);
    expect(() => gw.grant(org.id, notes.id, mallory.id, {}, OWNER)).toThrow(/not found/);
    await expect(gw.update(other.id, notes.id, { status: 'disabled' }, OWNER)).rejects.toThrow(/not found/);
    await expect(gw.remove(other.id, notes.id, OWNER)).rejects.toThrow(/not found/);
    await expect(gw.discoverTools(other.id, notes.id)).rejects.toThrow(/not found/);
    expect(() => gw.revokeGrant(other.id, notes.id, a.id, OWNER)).toThrow(/not found/);

    expect(await gw.listTools(runCtx(k, mallory))).toEqual([]);
    expect((await gw.callTool(runCtx(k, mallory), 'notes__get_note', { id: '1' })).isError).toBe(true);
    // A forged context (agent A's id presented under another org) resolves to nothing.
    expect(await gw.listTools({ ...runCtx(k, mallory), agentId: a.id })).toEqual([]);
    expect(await gw.snapshot(other.id, a.id)).toEqual([]);
    // The same connector name is free in the other org.
    expect((await gw.install(other.id, { name: 'notes', kind: 'mcp_stdio', config: stdioConfig }, OWNER)).orgId).toBe(other.id);
  });

  it('logs every call to tool_calls and the audit trail without raw secrets', async () => {
    gw.grant(org.id, notes.id, a.id, {}, OWNER);
    const ctx = runCtx(k, a);
    const secretArg = 'sk-ant-supersecretvalue1234567890';
    await gw.callTool(ctx, 'notes__send_message', { to: 'eve@example.com', body: 'hello', password: 'hunter2-plain', note: secretArg });

    const [row] = k.db.select().from(toolCalls).where(eq(toolCalls.runId, ctx.runId)).all();
    expect(row).toMatchObject({ orgId: org.id, agentId: a.id, runId: ctx.runId, issueId: ctx.issueId, connectorId: notes.id, tool: 'notes__send_message', status: 'ok' });
    expect(row!.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.resultSize).toBeGreaterThan(0);

    const [audit] = k.audit.query({ orgId: org.id, issueId: ctx.issueId!, action: 'tool.called' });
    expect(audit).toMatchObject({ runId: ctx.runId, entityKind: 'tool_call', entityId: row!.id });
    const dump = JSON.stringify([row, audit, k.audit.query({ orgId: org.id })]);
    expect(dump).not.toContain('hunter2-plain');
    expect(dump).not.toContain(secretArg);
    expect(dump).not.toContain('tok-default-account');
    expect(dump).toContain('eve@example.com');
  });

  it('revisions config changes and removes grants with the connector', async () => {
    gw.grant(org.id, notes.id, a.id, { defaultPolicy: 'ask' }, OWNER);
    await gw.update(org.id, notes.id, { toolAllowlist: ['get_note'] }, OWNER);
    const revs = k.db.select().from(configRevisions).where(eq(configRevisions.entityId, notes.id)).all();
    expect(revs.map((r) => r.revision)).toEqual([1, 2]);
    expect(JSON.stringify(revs)).not.toContain('tok-default-account');
    expect(k.db.select().from(configRevisions).where(eq(configRevisions.entityKind, 'connector_grant')).all()).toHaveLength(1);

    gw.revokeGrant(org.id, notes.id, a.id, OWNER);
    expect(await gw.listTools(runCtx(k, a))).toEqual([]);
    gw.grant(org.id, notes.id, a.id, {}, OWNER);
    await gw.remove(org.id, notes.id, OWNER);
    expect(gw.list(org.id)).toEqual([]);
    expect(gw.listGrants(org.id)).toEqual([]);
  });

  it('rejects invalid input and agent actors at the boundary', async () => {
    const agentActor = { kind: 'agent' as const, id: a.id };
    await expect(gw.install(org.id, { name: 'bad__name', kind: 'mcp_stdio', config: stdioConfig }, OWNER)).rejects.toThrow(/invalid connector/);
    await expect(gw.install(org.id, { name: 'x', kind: 'mcp_stdio', config: {} }, OWNER)).rejects.toThrow(/invalid mcp_stdio config/);
    await expect(gw.install(org.id, { name: 'notes', kind: 'mcp_stdio', config: stdioConfig }, OWNER)).rejects.toThrow(/already exists/);
    await expect(gw.install(org.id, { name: 'leak', kind: 'mcp_http', config: { url: 'https://x.test/mcp', headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' } } }, OWNER))
      .rejects.toThrow(/appears to contain a secret/);
    await expect(gw.install(org.id, { name: 'evil', kind: 'mcp_stdio', config: stdioConfig }, agentActor)).rejects.toThrow(/agents may not/);
    await expect(gw.install('org_missing', { name: 'x', kind: 'mcp_stdio', config: stdioConfig }, OWNER)).rejects.toThrow(/not found/);
    await expect(gw.install(org.id, { name: 'd', kind: 'mcp_stdio', scope: 'dept', scopeId: 'dept_nope', config: stdioConfig }, OWNER)).rejects.toThrow(/not found/);
    expect(() => gw.grant(org.id, notes.id, a.id, { defaultPolicy: 'maybe' as never }, OWNER)).toThrow(/invalid grant/);
    const bad = await gw.callTool(runCtx(k, a), 'notes__get_note', 'not-an-object' as never);
    expect(bad.isError).toBe(true);
  });
});
