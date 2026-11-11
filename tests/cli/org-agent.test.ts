import { describe, expect, it, vi } from 'vitest';
import type { OrgChartNode, OrgTemplate } from '../../src/api/types.js';
import { HOME, agent, approval, dept, harness, issue, org } from './harness.js';

const ENV = { CONDUCTOR_ORG: 'acme' };
const template: OrgTemplate = {
  id: 'saas-startup', name: 'SaaS startup', description: 'A lean software company',
  departments: [{ name: 'Engineering', charter: 'Build', agents: [{ name: 'Riley', role: 'Head of Engineering' }, { name: 'Sam', role: 'Engineer' }] }],
};

describe('org', () => {
  it('lists orgs as a table and as JSON', async () => {
    const listOrgs = vi.fn(async () => [org(), org({ id: 'org_2', slug: 'globex', name: 'Globex', budgetMonthlyUsd: null, defaultProvider: { adapter: 'claude_api', model: 'claude-sonnet-4-5' }, killSwitch: true })]);
    const h = harness({ client: { listOrgs }, env: ENV });
    const r = await h.run('org', 'list');
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^\s+SLUG\s+NAME\s+STATUS\s+PROVIDER\s+BUDGET\s+KILL$/);
    expect(lines[1]).toMatch(/^\*\s+acme\s+Acme\s+active\s+claude_local\s+\$100\.00$/);
    expect(lines[2]).toMatch(/globex\s+Globex\s+active\s+claude_api:claude-sonnet-4-5\s+uncapped\s+ENGAGED$/);
    expect(listOrgs).toHaveBeenCalledWith(undefined);

    const j = await h.run('--json', 'org', 'list', '--all');
    expect(listOrgs).toHaveBeenLastCalledWith({ includeArchived: true });
    expect((j.json() as Array<{ slug: string }>).map((o) => o.slug)).toEqual(['acme', 'globex']);
  });

  it('creates from a template with mission, budget and provider, and makes it the default', async () => {
    const createOrgFromTemplate = vi.fn(async () => org({ budgetMonthlyUsd: null }));
    const updateOrg = vi.fn(async () => org({ budgetMonthlyUsd: 250 }));
    const h = harness({ client: { createOrgFromTemplate, updateOrg, listAgents: vi.fn(async () => [agent(), agent({ id: 'agt_2', slug: 'sam' })]) } });
    const r = await h.run('org', 'create', 'Acme', '--template', 'saas-startup', '--mission', 'Ship fast', '--budget', '250', '--provider', 'claude_api:claude-sonnet-4-5');
    expect(r.code).toBe(0);
    expect(createOrgFromTemplate).toHaveBeenCalledWith({ templateId: 'saas-startup', name: 'Acme', mission: 'Ship fast', defaultProvider: { adapter: 'claude_api', model: 'claude-sonnet-4-5' } });
    expect(updateOrg).toHaveBeenCalledWith('org_1', { budgetMonthlyUsd: 250 });
    expect(r.stdout).toContain('created Acme (acme) from saas-startup: 2 agents');
    expect(JSON.parse(h.files.get(`${HOME}/cli.json`)!)).toEqual({ defaultOrg: 'acme' });
  });

  it('creates a blank org and prints the row with --json', async () => {
    const createOrg = vi.fn(async () => org({ slug: 'blank', name: 'Blank' }));
    const h = harness({ client: { createOrg }, files: { [`${HOME}/cli.json`]: '{"defaultOrg":"acme"}' } });
    const r = await h.run('--json', 'org', 'create', 'Blank', '--slug', 'blank');
    expect(createOrg).toHaveBeenCalledWith({ name: 'Blank', slug: 'blank' });
    expect((r.json() as { slug: string }).slug).toBe('blank');
    // An existing default is kept unless --use is passed.
    expect(JSON.parse(h.files.get(`${HOME}/cli.json`)!)).toEqual({ defaultOrg: 'acme' });
  });

  it('shows, archives, lists templates and toggles the org kill switch', async () => {
    const h = harness({
      env: ENV,
      client: {
        getOrg: vi.fn(async () => org()),
        archiveOrg: vi.fn(async () => org({ status: 'archived' })),
        listOrgTemplates: vi.fn(async () => [template]),
        engageOrgKillSwitch: vi.fn(async () => ({ engaged: true })),
        releaseOrgKillSwitch: vi.fn(async () => ({ engaged: false })),
      },
    });
    const show = await h.run('org', 'show');
    expect(show.stdout).toMatch(/budget:\s+\$100\.00\/month/);
    expect((await h.run('org', 'archive', 'acme')).stdout).toContain('archived acme');
    const t = await h.run('org', 'templates');
    expect(t.stdout).toMatch(/saas-startup\s+SaaS startup\s+1\s+2\s+A lean software company/);
    expect((await h.run('org', 'kill')).stdout).toContain('kill switch engaged for acme');
    expect(h.client.engageOrgKillSwitch).toHaveBeenCalledWith('acme');
    expect(((await h.run('--json', 'org', 'unkill', 'globex')).json() as { org: string; engaged: boolean })).toEqual({ org: 'globex', engaged: false });
  });

  it('exports a bundle to a file and imports it under a new name', async () => {
    const bundle = { format: 'conductor-org-bundle', version: 1, exportedAt: 1, org: {}, departments: [{}], agents: [{}, {}], goals: [], playbooks: [], connectors: [], skills: [], memories: [] };
    const importOrg = vi.fn(async () => org({ slug: 'acme-copy', name: 'Acme Copy' }));
    const h = harness({ env: ENV, client: { exportOrg: vi.fn(async () => bundle), importOrg } });
    const ex = await h.run('org', 'export', '/tmp/acme.json');
    expect(ex.stdout).toContain('exported to /tmp/acme.json: 1 departments, 2 agents');
    expect(JSON.parse(h.files.get('/tmp/acme.json')!)).toEqual(bundle);

    const im = await h.run('org', 'import', '/tmp/acme.json', '--name', 'Acme Copy');
    expect(im.code).toBe(0);
    expect(importOrg).toHaveBeenCalledWith({ name: 'Acme Copy', bundle });

    h.files.set('/tmp/other.json', '{"hello":1}');
    const bad = await h.run('org', 'import', '/tmp/other.json', '--name', 'X');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('not a Conductor org bundle');
    expect((await h.run('org', 'import', '/tmp/missing.json', '--name', 'X')).code).toBe(2);
  });
});

describe('dept', () => {
  it('lists and creates departments', async () => {
    const createDepartment = vi.fn(async () => dept({ slug: 'support', name: 'Support' }));
    const h = harness({ env: ENV, client: { listDepartments: vi.fn(async () => [dept()]), listAgents: vi.fn(async () => [agent()]), createDepartment } });
    const l = await h.run('dept', 'list');
    expect(l.stdout).toMatch(/engineering\s+Engineering\s+riley\s+1\s+-\s+Build/);
    const c = await h.run('dept', 'create', 'Support', '--charter', 'Help customers', '--budget', '40');
    expect(createDepartment).toHaveBeenCalledWith('acme', { name: 'Support', charter: 'Help customers', budgetUsd: 40 });
    expect(c.stdout).toContain('created department Support (support)');
    expect(((await h.run('--json', 'dept', 'list')).json() as unknown[]).length).toBe(1);
  });
});

describe('agent', () => {
  const sam = agent({ id: 'agt_sam', slug: 'sam', name: 'Sam', role: 'Backend Engineer', reportsTo: 'agt_riley', heartbeatCron: '*/30 * * * *', providerBinding: { adapter: 'codex_local' }, model: 'gpt-5' });
  const base = () => ({
    listAgents: vi.fn(async () => [agent(), sam]),
    listDepartments: vi.fn(async () => [dept(), dept({ id: 'dept_mkt', slug: 'marketing', name: 'Marketing' })]),
  });

  it('lists agents with department, manager and provider', async () => {
    const mocks = base();
    const h = harness({ env: ENV, client: mocks });
    const r = await h.run('agent', 'list', '--dept', 'eng', '--status', 'active');
    expect(mocks.listAgents).toHaveBeenLastCalledWith('acme', { deptId: 'dept_eng', status: 'active' });
    expect(r.stdout).toMatch(/sam\s+Sam\s+Backend Engineer\s+engineering\s+riley\s+codex_local:gpt-5\s+\*\/30 \* \* \* \*\s+active/);
    expect(((await h.run('--json', 'agent', 'list')).json() as unknown[]).length).toBe(2);
  });

  it('hires with every option resolved to ids', async () => {
    const hireAgent = vi.fn(async () => ({ agent: agent({ id: 'agt_new', slug: 'casey', name: 'Casey', role: 'Copywriter' }) }));
    const h = harness({ env: ENV, client: { ...base(), hireAgent } });
    const r = await h.run('agent', 'hire', '--dept', 'Marketing', '--role', 'Copywriter', '--name', 'Casey', '--goal', 'Write', '--backstory', 'Ex-journalist', '--reports-to', 'riley',
      '--provider', 'claude_local', '--model', 'opus', '--cron', '0 9 * * 1-5', '--budget', '25', '--autonomy', '1', '--lead');
    expect(r.code).toBe(0);
    expect(hireAgent).toHaveBeenCalledWith('acme', {
      deptId: 'dept_mkt', role: 'Copywriter', name: 'Casey', goal: 'Write', backstory: 'Ex-journalist', reportsTo: 'agt_riley',
      providerBinding: { adapter: 'claude_local' }, model: 'opus', heartbeatCron: '0 9 * * 1-5', budgetUsd: 25, autonomyLevel: 1, isLead: true,
    });
    expect(r.stdout).toContain('hired Casey (casey) — Copywriter');
  });

  it('defaults the name to the role and reports a queued approval', async () => {
    const hireAgent = vi.fn(async () => ({ approval: approval({ id: 'apr_9', kind: 'hire_agent', title: 'Hire QA Engineer' }) }));
    const h = harness({ env: ENV, client: { ...base(), hireAgent } });
    const r = await h.run('agent', 'hire', '--dept', 'engineering', '--role', 'QA Engineer');
    expect(hireAgent).toHaveBeenCalledWith('acme', { deptId: 'dept_eng', role: 'QA Engineer', name: 'QA Engineer' });
    expect(r.stdout).toContain('queued for approval: Hire QA Engineer');
    expect(r.stdout).toContain('conductor approvals approve apr_9');
    expect((await h.run('agent', 'hire', '--dept', 'engineering', '--role', 'QA', '--autonomy', '7')).code).toBe(2);
  });

  it('shows an agent with capabilities and budget', async () => {
    const h = harness({
      env: ENV,
      client: {
        ...base(),
        agentCapabilities: vi.fn(async () => ({ skillNames: ['release-notes'], connectorIds: ['con_1'], denySkills: [], denyConnectors: [] })),
        agentBudget: vi.fn(async () => ({ allowed: true, remainingUsd: 12.5, tightest: null, lines: [], seat: { capSeconds: null, usedSeconds: 0, allowed: true } })),
      },
    });
    const r = await h.run('agent', 'show', 'Sam');
    expect(r.stdout).toMatch(/provider:\s+codex_local:gpt-5/);
    expect(r.stdout).toMatch(/remaining:\s+\$12\.50/);
    expect(r.stdout).toMatch(/skills:\s+release-notes/);
    expect(Object.keys((await h.run('--json', 'agent', 'show', 'sam')).json() as object)).toEqual(['agent', 'capabilities', 'budget']);
  });

  it('updates, pauses, resumes and terminates by slug or name', async () => {
    const updateAgent = vi.fn(async () => sam);
    const pauseAgent = vi.fn(async () => agent({ ...sam, status: 'paused' }));
    const resumeAgent = vi.fn(async () => sam);
    const terminateAgent = vi.fn(async () => ({ agent: agent({ ...sam, status: 'terminated' }) }));
    const h = harness({ env: ENV, client: { ...base(), updateAgent, pauseAgent, resumeAgent, terminateAgent } });

    const u = await h.run('agent', 'update', 'sam', '--cron', 'none', '--reports-to', 'none', '--dept', 'marketing', '--role', 'Growth Engineer');
    expect(updateAgent).toHaveBeenCalledWith('acme', 'agt_sam', { reportsTo: null, heartbeatCron: null, role: 'Growth Engineer', deptId: 'dept_mkt' });
    expect(u.stdout).toContain('updated sam');

    expect((await h.run('agent', 'pause', 'Sam', '--reason', 'vacation')).stdout).toContain('paused sam');
    expect(pauseAgent).toHaveBeenCalledWith('acme', 'agt_sam', 'vacation');
    expect((await h.run('agent', 'resume', 'agt_sam')).stdout).toContain('resumed sam');
    expect((await h.run('agent', 'terminate', 'sam')).stdout).toContain('terminated Sam (sam)');
    expect(terminateAgent).toHaveBeenCalledWith('acme', 'agt_sam');
  });

  it('prints the org chart as a tree', async () => {
    const chart: OrgChartNode[] = [{ agent: agent(), department: dept(), isLead: true, reports: [{ agent: sam, department: dept(), isLead: false, reports: [] }] }];
    const h = harness({ env: ENV, client: { orgChart: vi.fn(async () => chart) } });
    const r = await h.run('agent', 'chart');
    expect(r.stdout.trimEnd().split('\n')).toEqual([
      '└─ Riley — Head of Engineering  [riley; Engineering, lead]',
      '   └─ Sam — Backend Engineer  [sam; Engineering]',
    ]);
    expect(((await h.run('--json', 'agent', 'chart')).json() as unknown[]).length).toBe(1);
  });

  it('prints a scorecard', async () => {
    const agentScorecard = vi.fn(async () => ({
      agentId: 'agt_sam', days: 14, runs: 20, issuesClosed: 8, successRate: 0.75, reworkRate: 0.1, costPerIssue: 0.42,
      trend: [{ weekStart: Date.UTC(2026, 0, 5), runs: 9, successRate: 0.6, costPerIssue: 0.5 }], byTaskType: [{ taskType: 'bugfix', runs: 5, successRate: 0.8, costPerIssue: 0.3 }],
    }));
    const h = harness({ env: ENV, client: { ...base(), agentScorecard } });
    const r = await h.run('agent', 'scorecard', 'sam', '--days', '14');
    expect(agentScorecard).toHaveBeenCalledWith('acme', 'agt_sam', { days: 14 });
    expect(r.stdout).toMatch(/success:\s+75%/);
    expect(r.stdout).toMatch(/2026-01-05\s+9\s+60%\s+\$0\.50/);
    expect(r.stdout).toMatch(/bugfix\s+5\s+80%\s+\$0\.30/);
  });

  it('chats with an agent, joining the message words', async () => {
    const chatWithAgent = vi.fn(async () => ({ reply: 'On it.', runId: 'run_9' }));
    const h = harness({ env: ENV, client: { ...base(), chatWithAgent, getIssue: vi.fn(async () => issue()) } });
    const r = await h.run('agent', 'chat', 'sam', 'how', 'is', 'it', 'going?', '--issue', '#12');
    expect(chatWithAgent).toHaveBeenCalledWith('acme', 'agt_sam', { message: 'how is it going?', issueId: 'iss_1' });
    expect(r.stdout).toBe('On it.\n');
    expect(r.stderr).toContain('conductor logs --run run_9');
    expect((await h.run('--json', 'agent', 'chat', 'sam', 'hi')).json()).toEqual({ reply: 'On it.', runId: 'run_9' });
  });
});
