import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { configRevisions, gateways } from '../../src/db/schema/index.js';
import type { ConfigRevision, Skill } from '../../src/contracts/rows.js';
import type { IssueArtifact } from '../../src/contracts/org-work.js';
import { OWNER } from '../../src/contracts/types.js';
import { notFound } from '../../src/shared/errors.js';
import type { GatewayDto, WebhookDto } from '../../src/api/types.js';
import { createHarness, type Harness } from './fake-services.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = h.owner) =>
  h.api.app.inject({ method, url: `/api/v1${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const revs = async (url: string): Promise<ConfigRevision[]> => (await call('GET', url)).json() as ConfigRevision[];

/** What `mintPairingCode` leaves in the row (the adapters that mint codes do not run in this harness). */
function mintCode(gatewayId: string): void {
  const row = h.kernel.db.select().from(gateways).where(eq(gateways.id, gatewayId)).get()!;
  const config = { ...row.config, pairingCodeHash: 'a'.repeat(64), pairingExpiresAt: h.kernel.clock.now() + 600_000, pairingAttempts: 0 };
  h.kernel.db.update(gateways).set({ config }).where(eq(gateways.id, gatewayId)).run();
}

describe('gateway config revisions and the pairing DTO', () => {
  it('records a revision per change and rolls back by revision id without touching pairing state', async () => {
    const gw = (await call('POST', '/gateways', { kind: 'telegram', name: 'Owner bot', config: { allowedChatIds: [1] }, authRef: 'gw/telegram' })).json() as GatewayDto;
    await call('PATCH', `/gateways/${gw.id}`, { name: 'Renamed', config: { allowedChatIds: [2, 3] } });
    const list = await revs(`/gateways/${gw.id}/revisions`);
    expect(list.map((r) => r.revision)).toEqual([2, 1]);
    expect(list[1]!.snapshot).toMatchObject({ name: 'Owner bot', authRef: 'gw/telegram', config: { allowedChatIds: [1] } });

    // A pairing code minted since is live state, not config: a rollback keeps it.
    mintCode(gw.id);
    const res = await call('POST', `/revisions/${list[1]!.id}/rollback`);
    expect(res.json()).toEqual({ ok: true, entityKind: 'gateway', entityId: gw.id, rolledBackTo: 1, revision: 3 });
    const now = (await call('GET', `/gateways/${gw.id}`)).json() as GatewayDto;
    expect(now).toMatchObject({ name: 'Owner bot', config: { allowedChatIds: [1] }, pairingPending: true });
    const stored = h.kernel.db.select().from(gateways).where(eq(gateways.id, gw.id)).get()!;
    expect(typeof (stored.config as Record<string, unknown>).pairingCodeHash).toBe('string');
    // No revision ever holds the pairing hash.
    expect(JSON.stringify(await revs(`/gateways/${gw.id}/revisions`))).not.toContain('pairingCodeHash');
    expect(h.kernel.audit.query({ action: 'config.changed', entityId: gw.id }).map((a) => a.data)).toContainEqual(expect.objectContaining({ change: 'rollback', rollbackTo: 1 }));
  });

  it('restores a deleted gateway under its old id and refuses the removal revision itself', async () => {
    const gw = (await call('POST', '/gateways', { orgId: 'acme', kind: 'slack', name: 'Acme Slack', authRef: 'gw/slack' })).json() as GatewayDto;
    await call('DELETE', `/gateways/${gw.id}`);
    const [removal, first] = await revs(`/gateways/${gw.id}/revisions`);
    expect(removal!.snapshot).toMatchObject({ removed: true });
    expect((await call('POST', `/revisions/${removal!.id}/rollback`)).statusCode).toBe(400);
    expect((await call('POST', `/revisions/${first!.id}/rollback`)).statusCode).toBe(200);
    expect((await call('GET', `/gateways/${gw.id}`)).json()).toMatchObject({ id: gw.id, name: 'Acme Slack', orgId: h.orgA.id, authRef: 'gw/slack' });
    // Org-scoped listing sees the org's gateway; another org does not.
    expect(await revs(`/orgs/acme/revisions?entityKind=gateway&entityId=${gw.id}`)).toHaveLength(3);
    expect(await revs(`/orgs/globex/revisions?entityKind=gateway&entityId=${gw.id}`)).toEqual([]);
  });

  it('GET /gateways never returns the pairing hash: pairingPending and its expiry replace it', async () => {
    const gw = (await call('POST', '/gateways', { kind: 'telegram', name: 'Bot' })).json() as GatewayDto;
    expect(gw).toMatchObject({ pairingPending: false, pairingExpiresAt: null });
    mintCode(gw.id);
    const res = await call('GET', '/gateways');
    const [row] = res.json() as GatewayDto[];
    expect(row!.pairingPending).toBe(true);
    expect(row!.pairingExpiresAt).toBeGreaterThan(h.kernel.clock.now());
    for (const key of ['pairingCodeHash', 'pairingExpiresAt', 'pairingAttempts']) expect(key in row!.config).toBe(false);
    expect(res.body).not.toContain('pairingCodeHash');
    expect((await call('GET', `/gateways/${gw.id}`)).body).not.toContain('pairingCodeHash');
    expect((await call('PATCH', `/gateways/${gw.id}`, { name: 'Bot 2' })).body).not.toContain('pairingCodeHash');
    // An expired code is no longer pending.
    h.kernel.clock.advance(24 * 3_600_000);
    expect(((await call('GET', '/gateways')).json() as GatewayDto[])[0]).toMatchObject({ pairingPending: false, pairingExpiresAt: null });
  });
});

describe('webhook config revisions', () => {
  it('lists revisions, rolls a change back and restores a deleted webhook, inside one org only', async () => {
    const hook = (await call('POST', '/orgs/acme/webhooks', { direction: 'out', name: 'Zap', url: 'https://hooks.example.test/x', events: ['issue.done'], secretRef: 'wh/zap' })).json() as WebhookDto;
    await call('PATCH', `/orgs/acme/webhooks/${hook.id}`, { status: 'disabled', events: ['issue.created'] });
    const url = `/orgs/acme/revisions?entityKind=webhook&entityId=${hook.id}`;
    const list = await revs(url);
    expect(list.map((r) => r.revision)).toEqual([2, 1]);
    expect(list[1]!.snapshot).toMatchObject({ name: 'Zap', events: ['issue.done'], secretRef: 'wh/zap', status: 'active' });

    // Another org can neither see nor roll back this webhook's history.
    expect(await revs(`/orgs/globex/revisions?entityKind=webhook&entityId=${hook.id}`)).toEqual([]);
    expect((await call('POST', '/orgs/globex/revisions/rollback', { entityKind: 'webhook', entityId: hook.id, revision: 1 })).statusCode).toBe(404);

    expect((await call('POST', '/orgs/acme/revisions/rollback', { entityKind: 'webhook', entityId: hook.id, revision: 1 })).json()).toEqual({ ok: true });
    expect((await call('GET', `/orgs/acme/webhooks/${hook.id}`)).json()).toMatchObject({ status: 'active', events: ['issue.done'] });
    expect((await call('POST', '/orgs/acme/revisions/rollback', { entityKind: 'webhook', entityId: hook.id, revision: 9 })).statusCode).toBe(404);

    await call('DELETE', `/orgs/acme/webhooks/${hook.id}`);
    expect((await call('GET', `/orgs/acme/webhooks/${hook.id}`)).statusCode).toBe(404);
    const afterDelete = await revs(url);
    expect(afterDelete[0]!.snapshot).toMatchObject({ removed: true });
    expect((await call('POST', `/revisions/${afterDelete[0]!.id}/rollback`)).statusCode).toBe(400);
    const restored = await call('POST', `/revisions/${afterDelete[1]!.id}/rollback`);
    expect(restored.json()).toMatchObject({ ok: true, entityKind: 'webhook', entityId: hook.id });
    expect((await call('GET', `/orgs/acme/webhooks/${hook.id}`)).json()).toMatchObject({ id: hook.id, name: 'Zap', url: 'https://hooks.example.test/x' });
  });

  it('keeps credential-shaped URLs out of snapshots', async () => {
    const hook = (await call('POST', '/orgs/acme/webhooks', { direction: 'out', name: 'Signed', url: 'https://hooks.example.test/x?token=s3cr3t-value-123456', events: ['issue.done'] })).json() as WebhookDto;
    const list = await revs(`/orgs/acme/revisions?entityKind=webhook&entityId=${hook.id}`);
    expect(JSON.stringify(list)).not.toContain('s3cr3t-value-123456');
    // Rolling back keeps the URL that is in place now.
    await call('PATCH', `/orgs/acme/webhooks/${hook.id}`, { name: 'Renamed' });
    expect((await call('POST', `/revisions/${list[0]!.id}/rollback`)).statusCode).toBe(200);
    expect((await call('GET', `/orgs/acme/webhooks/${hook.id}`)).json()).toMatchObject({ name: 'Signed', url: 'https://hooks.example.test/x?token=s3cr3t-value-123456' });
  });
});

describe('revisions of kinds owned by other contexts', () => {
  const seed = (kind: string, entityId: string, orgId: string): ConfigRevision[] => {
    const rows = [1, 2].map((revision) => ({ id: `rvn_${kind}_${revision}`, orgId, entityKind: kind, entityId, revision, snapshot: { name: `v${revision}` }, author: 'owner', note: null, ts: h.kernel.clock.now() }));
    h.kernel.db.insert(configRevisions).values(rows).run();
    return rows as ConfigRevision[];
  };
  it('dispatches connector, grant and browser-profile rollbacks to the owning service as OWNER', async () => {
    const connectorRollback = vi.fn(async () => {});
    const browserRollback = vi.fn(async () => {});
    Object.assign(h.connectors, { revisionKinds: ['connector', 'connector_grant'], rollbackRevision: connectorRollback });
    Object.assign(h.browser, { revisionKinds: ['browser_profile'], rollbackRevision: browserRollback });
    seed('connector', 'con_1', h.orgA.id);
    seed('connector_grant', 'grt_1', h.orgA.id);
    seed('browser_profile', 'bp_1', h.orgA.id);

    expect(await revs('/orgs/acme/revisions?entityKind=connector&entityId=con_1')).toHaveLength(2);
    expect(await revs('/orgs/globex/revisions?entityKind=connector&entityId=con_1')).toEqual([]);
    expect((await call('GET', '/revisions/rvn_connector_1')).json()).toMatchObject({ entityKind: 'connector', entityId: 'con_1', revision: 1 });

    expect((await call('POST', '/revisions/rvn_connector_1/rollback')).json()).toMatchObject({ ok: true, entityKind: 'connector', rolledBackTo: 1 });
    expect(connectorRollback).toHaveBeenCalledWith(h.orgA.id, 'connector', 'con_1', 1, OWNER);
    await call('POST', '/orgs/acme/revisions/rollback', { entityKind: 'connector_grant', entityId: 'grt_1', revision: 2 });
    expect(connectorRollback).toHaveBeenLastCalledWith(h.orgA.id, 'connector_grant', 'grt_1', 2, OWNER);
    await call('POST', '/revisions/rvn_browser_profile_2/rollback');
    expect(browserRollback).toHaveBeenCalledWith(h.orgA.id, 'browser_profile', 'bp_1', 2, OWNER);

    // The other org's path cannot reach these revisions.
    expect((await call('POST', '/orgs/globex/revisions/rollback', { entityKind: 'connector', entityId: 'con_1', revision: 1 })).statusCode).toBe(404);
    connectorRollback.mockRejectedValueOnce(notFound('connector revision', 'con_1@1'));
    expect((await call('POST', '/revisions/rvn_connector_1/rollback')).statusCode).toBe(404);
  });

  it('answers 503 when the service cannot roll back, 400 for unknown kinds and 404 for unknown ids; owner only', async () => {
    seed('connector', 'con_1', h.orgA.id);
    expect((await call('POST', '/revisions/rvn_connector_1/rollback')).statusCode).toBe(503);
    expect((await call('GET', '/orgs/acme/revisions?entityKind=secret&entityId=x')).statusCode).toBe(400);
    expect((await call('GET', '/revisions/rvn_missing')).statusCode).toBe(404);
    expect((await call('POST', '/revisions/rvn_missing/rollback')).statusCode).toBe(404);
    expect((await call('POST', '/revisions/rvn_connector_1/rollback', undefined, {})).statusCode).toBe(401);
    const run = h.startRun();
    expect((await call('POST', '/revisions/rvn_connector_1/rollback', undefined, { authorization: `Bearer ${run.token}` })).statusCode).toBe(403);
    expect((await call('GET', '/revisions/rvn_connector_1', undefined, { authorization: `Bearer ${run.token}` })).statusCode).toBe(403);
  });
});

describe('embedder, utility model and skill eval cases', () => {
  const skill = (id: string, orgId: string | null): Skill => ({ id, orgId, scope: orgId ? 'org' : 'global', scopeId: orgId, name: id, version: 1, status: 'active' }) as unknown as Skill;

  it('reports the embedder and the utility model, and clears embeddings.provider with null', async () => {
    const embedder = { provider: 'local', id: 'hash-256', dims: 256, semantic: false, mode: 'auto', authRef: null, reason: 'no OpenAI key stored' };
    h.memory.embedderStatus.mockReturnValue(embedder as never);
    expect((await call('GET', '/memory/embedder')).json()).toEqual(embedder);
    const utility = { backend: 'offline', model: null, subscription: false, reason: 'no provider key' };
    Object.assign(h.services.utility, { status: vi.fn(() => utility) });
    expect((await call('GET', '/orgs/acme/utility-model')).json()).toEqual(utility);
    expect(h.services.utility.status).toHaveBeenCalledWith(h.orgA.id);
    expect((await call('GET', '/orgs/nope/utility-model')).statusCode).toBe(404);

    expect((await call('PUT', '/settings/embeddings.provider', { value: 'openai' })).json().value).toBe('openai');
    expect((await call('PUT', '/settings/embeddings.provider', { value: null })).statusCode).toBe(200);
    expect((await call('GET', '/settings/embeddings.provider')).json().value).toBeNull();
    expect((await call('PUT', '/settings/embeddings.provider', { value: 'cohere' })).statusCode).toBe(400);
  });

  it('lists, adds and removes eval cases of a skill inside its org', async () => {
    h.skillRows.set('skl_a', skill('skl_a', h.orgA.id));
    const row = { id: 'evc_1', skillId: 'skl_a', source: 'manual', issueId: null, prompt: 'Write notes', criteria: 'mentions fixes', expect: { contains: ['Fixed'] }, createdAt: 1 };
    h.skills.evalCases.mockReturnValue([row] as never);
    h.skills.addEvalCase.mockReturnValue(row as never);
    expect((await call('GET', '/orgs/acme/skills/skl_a/eval-cases')).json()).toEqual([row]);
    expect((await call('GET', '/orgs/globex/skills/skl_a/eval-cases')).statusCode).toBe(404);

    const added = await call('POST', '/orgs/acme/skills/skl_a/eval-cases', { prompt: 'Write notes', criteria: 'mentions fixes', expect: { contains: ['Fixed'] } });
    expect(added.json()).toEqual(row);
    expect(h.skills.addEvalCase).toHaveBeenCalledWith('skl_a', { prompt: 'Write notes', criteria: 'mentions fixes', expect: { contains: ['Fixed'] }, issueId: null }, OWNER);
    expect((await call('POST', '/orgs/acme/skills/skl_a/eval-cases', { prompt: '' })).statusCode).toBe(400);
    expect((await call('POST', '/orgs/acme/skills/skl_a/eval-cases', { prompt: 'x', expect: { shell: ['rm'] } })).statusCode).toBe(400);
    expect((await call('POST', '/orgs/globex/skills/skl_a/eval-cases', { prompt: 'x' })).statusCode).toBe(404);

    expect((await call('DELETE', '/orgs/acme/skills/skl_a/eval-cases/evc_1')).json()).toEqual({ ok: true });
    expect(h.skills.removeEvalCase).toHaveBeenCalledWith('skl_a', 'evc_1', OWNER);
    expect((await call('DELETE', '/orgs/acme/skills/skl_a/eval-cases/evc_other')).statusCode).toBe(404);
    expect(h.skills.removeEvalCase).toHaveBeenCalledTimes(1);
  });
});

describe('issue artifacts', () => {
  it('lists what the issue\'s runs saved and serves each file, confined to the issue folder', async () => {
    await call('POST', '/orgs/acme/issues', { title: 'Pull the report' });
    await call('POST', '/orgs/globex/issues', { title: 'Other org' });
    const issue = h.issues.find((i) => i.orgId === h.orgA.id)!;
    const other = h.issues.find((i) => i.orgId === h.orgB.id)!;
    const file = h.kernel.paths.artifactFile(h.orgA.slug, issue.id, 'run_1/report q3.csv');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'a,b\n1,2\n');
    const secret = join(h.kernel.paths.artifactDir(h.orgA.slug, other.id), 'secret.txt');
    mkdirSync(dirname(secret), { recursive: true });
    writeFileSync(secret, 'not this issue');
    const artifact: IssueArtifact = { name: 'report q3.csv', path: 'run_1/report q3.csv', file, bytes: 8, modifiedAt: 5, origin: 'run', originId: 'run_1' };
    h.work.listIssueArtifacts.mockReturnValue([artifact]);

    const list = (await call('GET', `/orgs/acme/issues/${issue.number}/artifacts`)).json() as Array<IssueArtifact & { contentType: string; downloadPath: string }>;
    expect(h.work.listIssueArtifacts).toHaveBeenCalledWith(h.orgA.id, issue.id);
    expect(list).toEqual([{ ...artifact, contentType: 'text/csv; charset=utf-8', downloadPath: `/api/v1/orgs/${h.orgA.id}/issues/${issue.id}/artifacts/run_1/report%20q3.csv` }]);

    const res = await h.api.app.inject({ method: 'GET', url: list[0]!.downloadPath, headers: h.owner });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('a,b\n1,2\n');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);

    const base = `/orgs/acme/issues/${issue.id}/artifacts`;
    expect((await call('GET', `${base}/run_1/missing.csv`)).statusCode).toBe(404);
    for (const escape of [`..%2F${other.id}%2Fsecret.txt`, `run_1/..%2F..%2F${other.id}/secret.txt`, '%2E%2E/secret.txt']) {
      const out = await call('GET', `${base}/${escape}`);
      expect(out.statusCode, escape).toBeGreaterThanOrEqual(400);
      expect(out.body).not.toContain('not this issue');
    }
    // Another org's path, anonymous callers and run tokens get nothing.
    expect((await call('GET', `/orgs/globex/issues/${issue.id}/artifacts`)).statusCode).toBe(404);
    expect((await call('GET', `/orgs/globex/issues/${issue.id}/artifacts/run_1/report%20q3.csv`)).statusCode).toBe(404);
    expect((await call('GET', `${base}/run_1/report%20q3.csv`, undefined, {})).statusCode).toBe(401);
    const run = h.startRun();
    expect((await call('GET', `${base}/run_1/report%20q3.csv`, undefined, { authorization: `Bearer ${run.token}` })).statusCode).toBe(403);
  });
});
