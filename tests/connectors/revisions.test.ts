import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createConnectorGateway } from '../../src/connectors/index.js';
import { isRevisionedConfig, type RevisionedConfig } from '../../src/contracts/revisions.js';
import type { ConnectorGateway } from '../../src/contracts/services.js';
import type { Agent, ConfigRevision, Connector, Organization } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import { configRevisions } from '../../src/db/schema/index.js';
import { fakeApprovals, fakeOrg, runCtx, STDIO_FIXTURE } from './helpers.js';

const stdioConfig = { command: process.execPath, args: [STDIO_FIXTURE], env: { FIXTURE_TOKEN: { secretRef: 'FIXTURE_TOKEN' } } };

describe('connector and grant revisions with rollback', () => {
  let k: TestKernel;
  let gw: ConnectorGateway & RevisionedConfig;
  let org: Organization;
  let other: Organization;
  let a: Agent;
  let notes: Connector;

  const history = (kind: string, id: string): ConfigRevision[] =>
    k.db.select().from(configRevisions).where(and(eq(configRevisions.entityKind, kind), eq(configRevisions.entityId, id))).orderBy(desc(configRevisions.revision)).all();
  const code = async (fn: () => Promise<unknown>): Promise<string | undefined> => fn().then(() => undefined, (e: { code?: string }) => e.code);

  beforeEach(async () => {
    k = createTestKernel();
    gw = createConnectorGateway(k, { approvals: fakeApprovals(k), org: fakeOrg(k) });
    org = seedOrg(k);
    other = seedOrg(k, 'Globex');
    a = seedAgent(k, org.id, seedDept(k, org.id).id, 'Ada', { autonomyLevel: 2 });
    await k.secrets.set('org/acme/notes/FIXTURE_TOKEN', 'tok-default-account');
    notes = await gw.install(org.id, { name: 'notes', kind: 'mcp_stdio', config: stdioConfig, authRef: 'org/acme/notes' }, OWNER);
  });
  afterEach(async () => {
    await gw.close();
    k.dispose();
  });

  it('is a revisioned config for connectors and their grants', () => {
    expect(isRevisionedConfig(gw)).toBe(true);
    expect(gw.revisionKinds).toEqual(['connector', 'connector_grant']);
  });

  it('restores a connector\'s allowlist and status, as a new audited revision', async () => {
    await gw.update(org.id, notes.id, { toolAllowlist: ['get_note'] }, OWNER);
    await gw.update(org.id, notes.id, { status: 'disabled' }, OWNER);
    expect(history('connector', notes.id).map((r) => r.revision)).toEqual([3, 2, 1]);

    await gw.rollbackRevision(org.id, 'connector', notes.id, 1, OWNER);
    expect(gw.get(org.id, notes.id)).toMatchObject({ toolAllowlist: null, status: 'active', authRef: 'org/acme/notes' });
    const [latest] = history('connector', notes.id);
    expect(latest).toMatchObject({ revision: 4, note: 'rollback to revision 1' });
    expect(k.audit.query({ orgId: org.id, action: 'config.changed', entityId: notes.id }).map((r) => r.data))
      .toContainEqual(expect.objectContaining({ change: 'rollback', rollbackTo: 1, revision: 4, restored: false }));

    // Back to the disabled state recorded in revision 3.
    await gw.rollbackRevision(org.id, 'connector', notes.id, 3, OWNER);
    expect(gw.get(org.id, notes.id)).toMatchObject({ toolAllowlist: ['get_note'], status: 'disabled' });
    // No revision ever holds a secret value, only the ref.
    expect(JSON.stringify(history('connector', notes.id))).not.toContain('tok-default-account');
  });

  it('brings a removed connector back under its id, and refuses the removal revision', async () => {
    await gw.remove(org.id, notes.id, OWNER);
    expect(gw.list(org.id)).toEqual([]);
    const [removal] = history('connector', notes.id);
    expect(removal!.snapshot).toMatchObject({ removed: true });
    expect(await code(() => gw.rollbackRevision(org.id, 'connector', notes.id, removal!.revision, OWNER))).toBe('validation');

    await gw.rollbackRevision(org.id, 'connector', notes.id, 1, OWNER);
    expect(gw.get(org.id, notes.id)).toMatchObject({ id: notes.id, name: 'notes', kind: 'mcp_stdio', status: 'active' });
    // The restored connector works again once granted (its credentials were never part of the revision).
    gw.grant(org.id, notes.id, a.id, {}, OWNER);
    expect((await gw.listTools(runCtx(k, a))).map((t) => t.name)).toContain('notes__get_note');
  });

  it('restores grant tool policies, and a revoked grant under its old id', async () => {
    const first = gw.grant(org.id, notes.id, a.id, { defaultPolicy: 'ask', toolPolicies: { send_message: 'off' } }, OWNER).grant!;
    gw.grant(org.id, notes.id, a.id, { defaultPolicy: 'allowed', toolPolicies: {} }, OWNER);
    expect(history('connector_grant', first.id).map((r) => r.revision)).toEqual([2, 1]);

    await gw.rollbackRevision(org.id, 'connector_grant', first.id, 1, OWNER);
    expect(gw.listGrants(org.id, { agentId: a.id })[0]).toMatchObject({ id: first.id, defaultPolicy: 'ask', toolPolicies: { send_message: 'off' } });
    expect((await gw.listTools(runCtx(k, a))).map((t) => t.name)).not.toContain('notes__send_message');

    gw.revokeGrant(org.id, notes.id, a.id, OWNER);
    expect(gw.listGrants(org.id)).toEqual([]);
    const [revocation] = history('connector_grant', first.id);
    expect(revocation!.snapshot).toMatchObject({ revoked: true });
    expect(await code(() => gw.rollbackRevision(org.id, 'connector_grant', first.id, revocation!.revision, OWNER))).toBe('validation');
    await gw.rollbackRevision(org.id, 'connector_grant', first.id, 1, OWNER);
    expect(gw.listGrants(org.id)).toEqual([expect.objectContaining({ id: first.id, agentId: a.id, defaultPolicy: 'ask' })]);
    expect(k.audit.query({ orgId: org.id, action: 'config.changed', entityId: first.id }).map((r) => r.data))
      .toContainEqual(expect.objectContaining({ change: 'rollback', restored: true }));
  });

  it('is a board action inside one org: agents, other orgs, unknown revisions and kinds are refused', async () => {
    await gw.update(org.id, notes.id, { toolAllowlist: ['get_note'] }, OWNER);
    expect(await code(() => gw.rollbackRevision(org.id, 'connector', notes.id, 1, { kind: 'agent', id: a.id }))).toBe('forbidden');
    expect(await code(() => gw.rollbackRevision(other.id, 'connector', notes.id, 1, OWNER))).toBe('not_found');
    expect(await code(() => gw.rollbackRevision(org.id, 'connector', notes.id, 99, OWNER))).toBe('not_found');
    expect(await code(() => gw.rollbackRevision(org.id, 'agent', a.id, 1, OWNER))).toBe('validation');
    expect(gw.get(org.id, notes.id).toolAllowlist).toEqual(['get_note']);
  });
});
