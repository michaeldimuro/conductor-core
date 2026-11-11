import { describe, expect, it, vi } from 'vitest';
import { ConductorApiError } from '../../src/api/client.js';
import { buildProgram } from '../../src/cli/index.js';
import { issueKey, pick } from '../../src/cli/resolve.js';
import { table, makeStyle, colourEnabled } from '../../src/cli/output.js';
import { HOME, TOKEN, agent, harness, issue, org } from './harness.js';

const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7420'), { code: 'ECONNREFUSED' }) });

describe('program', () => {
  it('builds a commander program with every command group', () => {
    const names = buildProgram(harness().deps).commands.map((c) => c.name());
    for (const n of ['install', 'uninstall', 'restart', 'status', 'open', 'pair', 'doctor', 'quickstart', 'org', 'dept', 'agent', 'goal', 'issue', 'run', 'logs', 'approvals', 'budget', 'skills', 'memory', 'connector', 'secret', 'gateway', 'webhook', 'adapter', 'kill-switch', 'config']) {
      expect(names).toContain(n);
    }
  });

  it('prints help and the version with exit code 0', async () => {
    const h = harness();
    const help = await h.run('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: conductor');
    const sub = await h.run('issue', 'create', '--help');
    expect(sub.code).toBe(0);
    expect(sub.stdout).toContain('--expected-output');
    const v = await h.run('--version');
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('usage errors exit with code 2', () => {
  it.each([
    [['frobnicate']],
    [['issue', 'list', '--bogus']],
    [['issue', 'create']],
    [['agent', 'hire', '--role', 'Engineer']],
    [['org', 'import', 'bundle.json']],
    [['org']],
    [['skills', 'promote', 'x']],
  ])('commander rejects %j', async (argv) => {
    const r = await harness().run(...argv);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).not.toBe('');
  });

  it.each([
    [['issue', 'list', '--status', 'nope'], /--status must be one of/],
    [['issue', 'list', '--limit', 'many'], /--limit must be a number/],
    [['issue', 'show', 'not-a-ref!'], /not an issue reference/],
    [['issue', 'review', '12', 'maybe'], /<outcome> must be one of: accepted, edited, rejected/],
    [['org', 'create', 'Acme', '--budget', '-5'], /--budget must be at least 0/],
    [['org', 'create', 'Acme', '--provider', ':bad'], /adapter\[:model\]/],
    [['agent', 'update', 'riley'], /nothing to update/],
    [['kill-switch', 'maybe'], /<state> must be one of: on, off/],
    [['logs', '--run', 'r1', '--agent', 'riley'], /either --run or --agent/],
    [['secret', 'set', '../etc/passwd'], /invalid secret ref/],
    [['webhook', 'add', 'out', '--name', 'x'], /needs --target/],
    [['install', '--port', '99999'], /--port must be at most 65535/],
    [['install', '--out', 'x.plist'], /--out only applies to --headless/],
  ])('validation rejects %j', async (argv, message) => {
    const h = harness({ client: { listAgents: vi.fn(async () => [agent()]) }, env: { CONDUCTOR_ORG: 'acme' } });
    const r = await h.run(...argv);
    expect(r.stderr).toMatch(message);
    expect(r.code).toBe(2);
  });

  it('maps API validation errors to exit code 2 and other API errors to 1', async () => {
    const h = harness({
      env: { CONDUCTOR_ORG: 'acme' },
      client: {
        createDepartment: vi.fn(async () => {
          throw new ConductorApiError(400, 'validation', 'name: too long');
        }),
        listDepartments: vi.fn(async () => {
          throw new ConductorApiError(404, 'not_found', 'organization not found: acme');
        }),
      },
    });
    const bad = await h.run('dept', 'create', 'x');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('name: too long');
    const missing = await h.run('dept', 'list');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('organization not found: acme');
  });
});

describe('daemon connectivity and auth', () => {
  it('explains how to start the daemon when it is unreachable', async () => {
    const h = harness({ client: { listOrgs: vi.fn(async () => { throw refused(); }) } });
    const r = await h.run('org', 'list');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Cannot reach the Conductor daemon at http://127.0.0.1:7420');
    expect(r.stderr).toContain('conductor install');
    expect(r.stderr).toContain('conductor doctor');
    expect(r.stdout).toBe('');
  });

  it('reports unreachable as a JSON error object with --json', async () => {
    const h = harness({ client: { listOrgs: vi.fn(async () => { throw refused(); }) } });
    const r = await h.run('--json', '--url', 'http://127.0.0.1:9', 'org', 'list');
    expect(r.code).toBe(1);
    const body = JSON.parse(r.stderr) as { error: { code: string; message: string; hints: string[] } };
    expect(body.error.code).toBe('daemon_unreachable');
    expect(body.error.message).toContain('http://127.0.0.1:9');
    expect(body.error.hints.length).toBeGreaterThan(0);
  });

  it('gives next steps when the owner token file is missing', async () => {
    const h = harness({ token: null });
    const r = await h.run('org', 'list');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`No owner token found at ${HOME}/owner.token`);
    expect(r.stderr).toContain('conductor install');
    expect(h.clientOptions).toEqual([]);
  });

  it('explains a rejected token', async () => {
    const h = harness({ client: { listOrgs: vi.fn(async () => { throw new ConductorApiError(401, 'unauthorized', 'authentication required'); }) } });
    const r = await h.run('org', 'list');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('rejected the owner token');
    expect(r.stderr).toContain('conductor restart');
  });

  it('builds the client from the token file, --home, --url and the environment', async () => {
    const listOrgs = vi.fn(async () => []);
    const h = harness({ client: { listOrgs } });
    await h.run('org', 'list');
    expect(h.clientOptions.at(-1)).toEqual({ baseUrl: 'http://127.0.0.1:7420', token: TOKEN });

    const custom = harness({ client: { listOrgs }, token: null, files: { '/elsewhere/owner.token': 'cnd_owner_other-token-aaaaaaaaaaaaaaaaaaaa\n' }, env: { CONDUCTOR_PORT: '7999' } });
    await custom.run('--home', '/elsewhere', 'org', 'list');
    expect(custom.clientOptions.at(-1)).toEqual({ baseUrl: 'http://127.0.0.1:7999', token: 'cnd_owner_other-token-aaaaaaaaaaaaaaaaaaaa' });

    await custom.run('org', 'list', '--home', '/elsewhere', '--url', 'http://10.0.0.5:7420/');
    expect(custom.clientOptions.at(-1)?.baseUrl).toBe('http://10.0.0.5:7420');
  });

  it('never prints the owner token', async () => {
    const h = harness({ client: { listOrgs: vi.fn(async () => { throw new ConductorApiError(401, 'unauthorized', 'authentication required'); }) } });
    const r = await h.run('--json', 'org', 'list');
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });
});

describe('default organization', () => {
  it('uses --org, then CONDUCTOR_ORG, then cli.json, then the only org', async () => {
    const listDepartments = vi.fn(async (_org: string) => []);
    const listAgents = vi.fn(async (_org: string) => []);
    const listOrgs = vi.fn(async () => [org({ slug: 'solo' })]);
    const mocks = { listDepartments, listAgents, listOrgs };

    const h = harness({ client: mocks, files: { [`${HOME}/cli.json`]: JSON.stringify({ defaultOrg: 'from-config' }) }, env: { CONDUCTOR_ORG: 'from-env' } });
    await h.run('--org', 'from-flag', 'dept', 'list');
    expect(listDepartments).toHaveBeenLastCalledWith('from-flag');
    await h.run('dept', 'list');
    expect(listDepartments).toHaveBeenLastCalledWith('from-env');

    const cfg = harness({ client: mocks, files: { [`${HOME}/cli.json`]: JSON.stringify({ defaultOrg: 'from-config' }) } });
    await cfg.run('dept', 'list');
    expect(listDepartments).toHaveBeenLastCalledWith('from-config');

    const bare = harness({ client: mocks });
    await bare.run('dept', 'list');
    expect(listDepartments).toHaveBeenLastCalledWith('solo');
  });

  it('asks the user to choose when several orgs exist and none is selected', async () => {
    const h = harness({ client: { listOrgs: vi.fn(async () => [org({ slug: 'acme' }), org({ id: 'org_2', slug: 'globex' })]) } });
    const r = await h.run('dept', 'list');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('acme, globex');
    expect(r.stderr).toContain('conductor org use <slug>');
  });

  it('points at org create when there is no org at all', async () => {
    const r = await harness({ client: { listOrgs: vi.fn(async () => []) } }).run('agent', 'list');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('conductor org create');
  });

  it('`org use` validates the org and stores the slug in <home>/cli.json', async () => {
    const getOrg = vi.fn(async () => org({ slug: 'acme' }));
    const h = harness({ client: { getOrg } });
    const r = await h.run('org', 'use', 'org_1');
    expect(r.code).toBe(0);
    expect(getOrg).toHaveBeenCalledWith('org_1');
    expect(JSON.parse(h.files.get(`${HOME}/cli.json`)!)).toEqual({ defaultOrg: 'acme' });
    expect(r.stdout).toContain('default org is now acme');
  });

  it('ignores a corrupt cli.json', async () => {
    const listDepartments = vi.fn(async () => []);
    const h = harness({ client: { listDepartments, listAgents: vi.fn(async () => []), listOrgs: vi.fn(async () => [org()]) }, files: { [`${HOME}/cli.json`]: '{nope' } });
    expect((await h.run('dept', 'list')).code).toBe(0);
    expect(listDepartments).toHaveBeenCalledWith('acme');
  });
});

describe('entity resolution', () => {
  const agents = [
    agent({ id: 'agt_riley', slug: 'riley', name: 'Riley' }),
    agent({ id: 'agt_robin', slug: 'robin', name: 'Robin Chen' }),
    agent({ id: 'agt_robin2', slug: 'robin-2', name: 'Robin Park' }),
  ];
  const describeAgent = (a: (typeof agents)[number]) => `${a.slug} (${a.id})`;
  const find = (needle: string) => pick('agent', needle, agents, (a) => [a.id, a.slug, a.name], describeAgent);

  it('matches id, slug and name exactly (case-insensitive), then a unique prefix', () => {
    expect(find('agt_robin2').slug).toBe('robin-2');
    expect(find('riley').id).toBe('agt_riley');
    expect(find('ROBIN CHEN').id).toBe('agt_robin');
    expect(find('robin').id).toBe('agt_robin'); // exact slug beats the prefix of robin-2
    expect(find('ril').id).toBe('agt_riley');
  });

  it('refuses to guess between several candidates and lists them', () => {
    expect(() => find('rob')).toThrowError(/"rob" is ambiguous: 2 agents match/);
    expect(find('Robin P').id).toBe('agt_robin2');
    expect(() => find('nobody')).toThrowError(/No agent matches "nobody"/);
  });

  it('reports ambiguity through the CLI with the candidates and exit code 1', async () => {
    const h = harness({ env: { CONDUCTOR_ORG: 'acme' }, client: { listAgents: vi.fn(async () => agents) } });
    const r = await h.run('agent', 'pause', 'ro');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('"ro" is ambiguous: 2 agents match');
    expect(r.stderr).toContain('agt_robin');
    expect(r.stderr).toContain('agt_robin2');
    expect(r.stderr).toContain('use the id');
  });

  it('accepts issue numbers as 12, #12, ACME-12 and ids', async () => {
    expect(issueKey('12')).toBe('12');
    expect(issueKey('#12')).toBe('12');
    expect(issueKey('ACME-12')).toBe('12');
    expect(issueKey('integration-co-7')).toBe('7');
    expect(issueKey('iss_01HXYZ')).toBe('iss_01HXYZ');
    expect(() => issueKey('twelve')).toThrowError(/not an issue reference/);

    const getIssue = vi.fn(async () => issue());
    const h = harness({ env: { CONDUCTOR_ORG: 'acme' }, client: { getIssue, getOrg: vi.fn(async () => org()), listComments: vi.fn(async () => []), listAgents: vi.fn(async () => [agent()]) } });
    const r = await h.run('issue', 'show', 'ACME-12');
    expect(r.code).toBe(0);
    expect(getIssue).toHaveBeenCalledWith('acme', '12');
    expect(r.stdout).toContain('ACME-12  Fix the login bug');
  });
});

describe('human output', () => {
  it('renders compact aligned tables', () => {
    const lines = table(['slug', 'name', 'n'], [['a', 'Alpha', 1], ['bbbbbb', null, 22], ['', '', 3]], makeStyle(false));
    expect(lines).toEqual(['SLUG    NAME   N', 'a       Alpha  1', 'bbbbbb  -      22', '               3']);
  });

  it('uses colour only on a TTY without NO_COLOR', async () => {
    expect(colourEnabled(true, {})).toBe(true);
    expect(colourEnabled(false, {})).toBe(false);
    expect(colourEnabled(true, { NO_COLOR: '1' })).toBe(false);

    const mocks = { listOrgs: vi.fn(async () => [org()]) };
    const esc = String.fromCharCode(27);
    expect((await harness({ client: mocks, isTTY: true }).run('org', 'list')).stdout).toContain(esc);
    expect((await harness({ client: mocks, isTTY: false }).run('org', 'list')).stdout).not.toContain(esc);
    expect((await harness({ client: mocks, isTTY: true, env: { NO_COLOR: '1' } }).run('org', 'list')).stdout).not.toContain(esc);
    expect((await harness({ client: mocks, isTTY: true }).run('--json', 'org', 'list')).stdout).not.toContain(esc);
  });
});
