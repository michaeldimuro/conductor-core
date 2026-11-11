import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServices } from '../../src/daemon/compose.js';
import { MemorySecretStore } from '../../src/kernel/index.js';
import { ConductorClient, createApiServer, type ApiServer } from '../../src/api/index.js';

/**
 * The real thing: every bounded context composed by the daemon's composition
 * root, behind the API, driven through the typed client over a real port.
 */
describe('API over the composed daemon', () => {
  let home: string;
  let services: Awaited<ReturnType<typeof createServices>>;
  let api: ApiServer;
  let client: ConductorClient;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'conductor-api-int-'));
    services = await createServices({ home, secrets: new MemorySecretStore(), config: { port: 0 }, runtime: { powerAssertion: false } });
    api = await createApiServer(services, { uiDir: join(home, 'no-ui') });
    await api.listen('127.0.0.1', 0);
    const { port } = api.app.server.address() as AddressInfo;
    client = new ConductorClient({ baseUrl: `http://127.0.0.1:${port}`, token: services.governance.tokens.issueOwnerToken('integration') });
  });

  afterAll(async () => {
    await api?.close();
    await services?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('creates an org from a template, hires, files an issue and lists it', async () => {
    const templates = await client.listOrgTemplates();
    expect(templates.length).toBeGreaterThan(0);

    const org = await client.createOrgFromTemplate({ templateId: templates[0]!.id, name: 'Integration Co' });
    expect(org.slug).toBe('integration-co');
    expect((await client.listOrgs()).map((o) => o.id)).toContain(org.id);

    const depts = await client.listDepartments(org.slug);
    expect(depts.length).toBeGreaterThan(0);
    const hired = await client.hireAgent(org.id, { deptId: depts[0]!.id, name: 'Integration Tester', role: 'QA Engineer' });
    expect(hired.agent?.orgId).toBe(org.id);
    const agent = hired.agent!;
    expect((await client.getAgent(org.slug, agent.slug)).id).toBe(agent.id);
    expect((await client.orgChart(org.id)).length).toBeGreaterThan(0);

    const issue = await client.createIssue(org.id, { title: 'Verify the API end to end', assigneeAgentId: agent.id });
    expect(issue.orgId).toBe(org.id);
    const page = await client.listIssues(org.id, { assigneeAgentId: agent.id });
    expect(page.items.map((i) => i.id)).toContain(issue.id);
    expect((await client.getIssue(org.id, issue.number)).title).toBe('Verify the API end to end');

    // A second org never sees the first org's issue.
    const other = await client.createOrg({ name: 'Other Co' });
    expect((await client.listIssues(other.id)).items).toEqual([]);
    await expect(client.getIssue(other.id, issue.id)).rejects.toMatchObject({ status: 404 });

    const activity = await client.activity(org.id, { limit: 50 });
    expect(activity.length).toBeGreaterThan(0);
    expect((await client.status()).counts.orgs).toBeGreaterThanOrEqual(2);
  });
});
