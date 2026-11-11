import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './fake-services.js';
import { ConductorApiError, ConductorClient } from '../../src/api/index.js';

let h: Harness;
let url: string;
let client: ConductorClient;

beforeAll(async () => {
  h = await createHarness();
  url = await h.listen();
  client = new ConductorClient({ baseUrl: `${url}/`, token: h.ownerToken });
});
afterAll(async () => {
  await h.close();
});

describe('ConductorClient against a running server', () => {
  it('reads health and status', async () => {
    expect(await new ConductorClient({ baseUrl: url }).health()).toMatchObject({ status: 'ok', version: '0.0.0-test' });
    const status = await client.status();
    expect(status.counts.orgs).toBe(2);
    expect((await client.me()).principal.kind).toBe('owner');
    expect((await client.doctor()).adapters[0]!.id).toBe('fake');
  });

  it('round-trips orgs, agents and issues', async () => {
    const orgs = await client.listOrgs();
    expect(orgs.map((o) => o.slug).sort()).toEqual(['acme', 'globex']);
    expect((await client.getOrg('acme')).id).toBe(h.orgA.id);
    expect((await client.listOrgTemplates())[0]!.id).toBe('startup');

    const hired = await client.hireAgent('acme', { deptId: h.dept.id, name: 'Linus', role: 'Engineer' });
    expect(hired.agent?.name).toBe('Linus');
    expect((await client.getAgent('acme', 'ada')).id).toBe(h.agent.id);
    expect(await client.runAgent('acme', 'ada')).toEqual({ jobId: 'job_1' });
    expect((await client.chatWithAgent('acme', 'ada', { message: 'ping' })).reply).toBe('echo: ping');

    const created = await client.createIssue('acme', { title: 'Write docs', labels: ['docs'] });
    await client.createIssue('acme', { title: 'Second' });
    expect((await client.getIssue('acme', created.number)).id).toBe(created.id);
    expect((await client.updateIssue('acme', created.id, { status: 'done' })).status).toBe('done');
    const page = await client.listIssues('acme', { status: ['done', 'todo'], limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextOffset).toBe(1);
    const done = await client.listIssues('acme', { status: 'done' });
    expect(done.items.map((i) => i.title)).toEqual(['Write docs']);
  });

  it('surfaces API errors as ConductorApiError with status, code and details', async () => {
    const err = await client.getOrg('missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConductorApiError);
    expect(err).toMatchObject({ status: 404, code: 'not_found' });

    const invalid = (await client.createIssue('acme', { title: '' }).catch((e: unknown) => e)) as ConductorApiError;
    expect(invalid.status).toBe(400);
    expect(invalid.code).toBe('validation');
    expect(invalid.details?.issues).toBeDefined();

    const anon = await new ConductorClient({ baseUrl: url }).listOrgs().catch((e: unknown) => e);
    expect(anon).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('writes secrets without ever reading them back, including refs with slashes', async () => {
    expect(await client.putSecret('org/acme/openai-api-key', 'sk-test-key-value')).toEqual({ ref: 'org/acme/openai-api-key', exists: true });
    expect((await client.secretExists('org/acme/openai-api-key')).exists).toBe(true);
    expect(await h.kernel.secrets.get('org/acme/openai-api-key')).toBe('sk-test-key-value');
    expect(await client.testAdapter('fake', { authRef: 'org/acme/openai-api-key' })).toEqual({ ok: true, detail: 'key present' });
    expect((await client.deleteSecret('org/acme/openai-api-key')).exists).toBe(false);
  });

  it('manages settings, kill switches, approvals and webhooks', async () => {
    expect((await client.putSetting('embeddings.provider', 'local')).value).toBe('local');
    expect((await client.listSettings()).map((s) => s.key)).toContain('daemon.public_url');
    expect(await client.engageOrgKillSwitch('acme')).toEqual({ engaged: true });
    expect(await client.releaseOrgKillSwitch('acme')).toEqual({ engaged: false });

    const approval = h.services.governance.approvals.request({ orgId: h.orgA.id, kind: 'publish', title: 'Tweet' });
    expect((await client.approvalInbox({ status: 'pending' })).map((a) => a.id)).toContain(approval.id);
    expect((await client.decideApproval('acme', approval.id, { decision: 'denied', note: 'no' })).status).toBe('denied');

    const hook = await client.createWebhook('acme', { direction: 'out', name: 'Zap', url: 'https://hooks.example.test/x', events: ['issue.done'] });
    expect((await client.listWebhooks('acme', { direction: 'out' })).map((w) => w.id)).toEqual([hook.id]);
    expect((await client.updateWebhook('acme', hook.id, { status: 'disabled' })).status).toBe('disabled');
    expect(await client.deleteWebhook('acme', hook.id)).toEqual({ ok: true });

    const gw = await client.createGateway({ kind: 'telegram', name: 'Bot' });
    expect((await client.listGateways()).map((g) => g.id)).toEqual([gw.id]);
    expect(await client.deleteGateway(gw.id)).toEqual({ ok: true });
  });

  it('mints a login code the browser can exchange', async () => {
    const { url: loginUrl } = await client.createLoginCode({ label: 'cli' });
    const res = await fetch(loginUrl, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie()[0]).toMatch(/^conductor_session=/);
  });

  it('acts as an agent with a run token', async () => {
    const run = h.startRun();
    const agent = new ConductorClient({ baseUrl: url, token: run.token });
    expect((await agent.agentMe()).agent.id).toBe(h.agent.id);
    expect((await agent.agentTools()).map((t) => t.name)).toEqual(['conductor-tasks__create_issue']);
    const result = await agent.callAgentTool('conductor-tasks__create_issue', { title: 'From agent' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ name: 'conductor-tasks__create_issue', args: { title: 'From agent' }, agentId: h.agent.id });
    await expect(agent.listOrgs()).rejects.toMatchObject({ status: 403 });
  });
});
