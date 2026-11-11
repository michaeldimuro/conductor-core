import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import type { OrgBundle, OrgChartNode } from '../../src/contracts/org-work.js';
import type { Connector, ConnectorGrant, Organization } from '../../src/contracts/rows.js';
import type { OrgImportDeps } from '../../src/org/index.js';
import { connectorGrants, connectors, goals, memories, playbooks, projects, skills } from '../../src/db/schema/index.js';
import { newId } from '../../src/shared/ids.js';
import type { OrgContext } from '../../src/org/index.js';
import { sanitize } from '../../src/org/sanitize.js';
import { codeOf, setup } from './fakes.js';

const SECRETS = {
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
  github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  bearer: 'Bearer abcdefghijklmnopqrstuvwxyz.0123456789',
  plain: 'hunter2-not-a-pattern',
};
const REFS = ['anthropic/main-key', 'openai/fallback-key', 'connectors/github-pat', 'connectors/github-sam-account'];

/** Records what the import asks the connector gateway to do, like the real one would persist it. */
function fakeGateway() {
  const installed: Connector[] = [];
  const grants: ConnectorGrant[] = [];
  const dep: NonNullable<OrgImportDeps['connectors']> = {
    install: vi.fn(async (orgId, input) => {
      const row = { id: newId('connector'), orgId, status: 'active', lastError: null, createdAt: 0, updatedAt: 0, scope: 'org', scopeId: null, authRef: null, toolAllowlist: null, templateId: null, ...input } as Connector;
      installed.push(row);
      return row;
    }),
    update: vi.fn(async (_orgId, connectorId, patch) => Object.assign(installed.find((c) => c.id === connectorId)!, patch)),
    grant: vi.fn((orgId, connectorId, agentId, input) => {
      const grant = { id: newId('grant'), orgId, connectorId, agentId, toolAllowlist: null, toolPolicies: {}, defaultPolicy: 'allowed', authRef: null, createdAt: 0, updatedAt: 0, ...input } as ConnectorGrant;
      grants.push(grant);
      return { grant };
    }),
  };
  return { dep, installed, grants };
}

/** Shape of the chart with ids erased: role, dept, lead flag, nested reports. */
const shape = (nodes: OrgChartNode[]): unknown[] =>
  nodes.map((n) => ({ slug: n.agent.slug, role: n.agent.role, dept: n.department.slug, isLead: n.isLead, reports: shape(n.reports) }));

describe('FR-18: org export / import', () => {
  let k: TestKernel;
  let org: OrgContext;
  let source: Organization;
  let ids: { eng: string; ceo: string; lead: string; dev: string; goalRoot: string; goalChild: string };

  beforeEach(async () => {
    k = createTestKernel();
    ({ org } = setup(k));
    const now = k.clock.now();
    await k.secrets.set(REFS[0]!, SECRETS.anthropic);

    source = org.createOrg({
      name: 'Acme',
      mission: 'Ship great software',
      budgetMonthlyUsd: 900,
      defaultProvider: { adapter: 'claude_api', model: 'sonnet', authRef: REFS[0], fallback: [{ adapter: 'openai_api', authRef: REFS[1] }] },
      policies: { extraGated: ['deploy'] },
    }, OWNER);
    org.updateOrg(source.id, { defaultSkills: ['house-style'], defaultConnectors: ['con_github'], maxConcurrentRuns: 2 }, OWNER);
    const exec = org.createDept(source.id, { name: 'Executive' }, OWNER);
    const eng = org.createDept(source.id, { name: 'Engineering', charter: 'Build', budgetUsd: 300, sharedSkills: ['task-prioritisation-and-planning'] }, OWNER);
    const ceo = org.hireAgent(source.id, { deptId: exec.id, name: 'Morgan', role: 'CEO', autonomyLevel: 3, isLead: true, heartbeatCron: '*/30 * * * *' }, OWNER).agent!;
    const lead = org.hireAgent(source.id, {
      deptId: eng.id, name: 'Riley', role: 'Head of Engineering', reportsTo: ceo.id, isLead: true, autonomyLevel: 3, budgetUsd: 50,
      providerBinding: { adapter: 'openai_api', model: 'gpt', authRef: REFS[1], config: { temperature: 0.2 } },
    }, OWNER).agent!;
    const dev = org.hireAgent(source.id, { deptId: eng.id, name: 'Sam', role: 'Engineer', goal: 'Ship', backstory: 'Pragmatic', reportsTo: lead.id, skills: ['rust'], heartbeatCron: '0 * * * *' }, OWNER).agent!;
    org.updateAgent(source.id, dev.id, { denySkills: ['house-style'], maxSteps: 25, connectors: ['con_github', 'con_gone'], denyConnectors: ['con_local'] }, OWNER);
    org.updateDept(source.id, eng.id, { sharedConnectors: ['con_local'] }, OWNER);
    const fired = org.hireAgent(source.id, { deptId: eng.id, name: 'Gone', role: 'Contractor', reportsTo: lead.id }, OWNER).agent!;
    org.terminateAgent(source.id, fired.id, OWNER);

    const goalRoot = newId('goal');
    const goalChild = newId('goal');
    k.db.insert(goals).values([
      { id: goalRoot, orgId: source.id, title: 'Grow', level: 'org', createdAt: now, updatedAt: now },
      { id: goalChild, orgId: source.id, title: 'Ship v2', level: 'agent', parentGoalId: goalRoot, deptId: eng.id, ownerAgentId: lead.id, weight: 2, createdAt: now, updatedAt: now },
    ]).run();
    k.db.insert(playbooks).values({
      id: newId('playbook'), orgId: source.id, name: 'Release', process: 'hierarchical', managerAgentId: lead.id,
      steps: [{ title: 'Build', description: 'Compile', expectedOutput: 'Artifact', agentId: dev.id }, { title: 'Review', description: '', expectedOutput: 'LGTM', agentRole: 'Head of Engineering' }],
      createdAt: now, updatedAt: now,
    }).run();
    k.db.insert(connectors).values({
      id: 'con_github', orgId: source.id, kind: 'mcp_http', name: 'GitHub', authRef: REFS[2],
      config: {
        url: `https://mcp.example.com/?key=${SECRETS.anthropic}`,
        headers: { Authorization: SECRETS.bearer },
        env: { GITHUB_TOKEN: SECRETS.plain, secretRef: REFS[2] },
        timeoutMs: 5000,
      },
      createdAt: now, updatedAt: now,
    }).run();
    k.db.insert(connectors).values({
      id: 'con_local', orgId: source.id, kind: 'mcp_stdio', name: 'Local files', scope: 'dept', scopeId: eng.id,
      config: { command: 'npx', args: ['files-mcp'] }, toolAllowlist: ['read_file', 'get_token'], createdAt: now, updatedAt: now,
    }).run();
    k.db.insert(connectorGrants).values([
      {
        id: newId('grant'), orgId: source.id, connectorId: 'con_github', agentId: dev.id, authRef: REFS[3],
        toolAllowlist: ['search', 'create_issue'], toolPolicies: { create_issue: 'ask', get_token: 'off' }, defaultPolicy: 'allowed', createdAt: now, updatedAt: now,
      },
      { id: newId('grant'), orgId: source.id, connectorId: 'con_local', agentId: lead.id, defaultPolicy: 'ask', createdAt: now, updatedAt: now },
      { id: newId('grant'), orgId: source.id, connectorId: 'con_github', agentId: fired.id, createdAt: now, updatedAt: now },
    ]).run();
    k.db.insert(projects).values([
      { id: newId('project'), orgId: source.id, name: 'Website', goalId: goalChild, budgetUsd: 40, workspacePath: join(k.paths.org(source.slug), 'repos', 'website'), createdAt: now, updatedAt: now },
      { id: newId('project'), orgId: source.id, name: 'Legacy', status: 'archived', workspacePath: '/Users/someone/code/legacy', createdAt: now, updatedAt: now },
    ]).run();
    writeFileSync(k.paths.agentMemoryFile(source.slug, dev.slug), `# Standing rules\n- Always cc ops@ on vendor emails.\n- Deploy token: ${SECRETS.github}\n`);
    writeFileSync(k.paths.ownerModelFile(source.slug), 'Owner rejects designs with stock photos.\n');

    const skillDir = join(k.paths.orgSkills(source.slug), 'house-style');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    mkdirSync(join(skillDir, '.git'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: house-style\ndescription: Write in the house style\n---\nAlways be concise.\nNever paste ${SECRETS.github} anywhere.\n`);
    writeFileSync(join(skillDir, 'scripts', 'get_token'), '#!/bin/sh\necho ok\n');
    writeFileSync(join(skillDir, '.git', 'config'), SECRETS.github);
    k.db.insert(skills).values({
      id: newId('skill'), orgId: source.id, scope: 'org', scopeId: source.id, name: 'house-style', description: 'Write in the house style',
      status: 'active', path: skillDir, contentHash: 'h', createdAt: now, updatedAt: now,
    }).run();
    const agentSkillDir = join(k.paths.agentSkills(source.slug, dev.slug), 'rust');
    mkdirSync(agentSkillDir, { recursive: true });
    writeFileSync(join(agentSkillDir, 'SKILL.md'), '---\nname: rust\ndescription: Rust idioms\n---\nPrefer iterators.\n');
    k.db.insert(skills).values({
      id: newId('skill'), orgId: source.id, scope: 'agent', scopeId: dev.id, name: 'rust', status: 'draft', path: agentSkillDir, contentHash: 'h2', createdAt: now, updatedAt: now,
    }).run();

    const mem = (scope: 'org' | 'dept' | 'agent', scopeId: string, kind: 'owner_model' | 'semantic' | 'lesson', content: string, status: 'active' | 'forgotten' = 'active') =>
      ({ id: newId('memory'), orgId: source.id, scope, scopeId, kind, content, status, createdAt: now, updatedAt: now });
    k.db.insert(memories).values([
      mem('org', source.id, 'owner_model', `Owner prefers short updates. Their key is ${SECRETS.anthropic}.`),
      mem('agent', dev.id, 'lesson', 'Run the tests before opening a PR.'),
      mem('dept', eng.id, 'semantic', 'Staging lives at staging.example.com.'),
      mem('agent', dev.id, 'semantic', 'FORGOTTEN-FACT', 'forgotten'),
      mem('agent', fired.id, 'lesson', 'ORPHANED-LESSON'),
    ]).run();

    ids = { eng: eng.id, ceo: ceo.id, lead: lead.id, dev: dev.id, goalRoot, goalChild };
  });
  afterEach(() => {
    org.dispose();
    k.dispose();
  });

  it('exports a bundle with the chart, configs, goals, playbooks, connectors, skills and memories', () => {
    const b = org.exportOrg(source.id);
    expect(b).toMatchObject({ format: 'conductor-org-bundle', version: 1, exportedAt: k.clock.now() });
    expect(b.org).toMatchObject({ name: 'Acme', mission: 'Ship great software', budgetMonthlyUsd: 900, maxConcurrentRuns: 2, defaultSkills: ['house-style'] });
    expect(b.departments.map((d) => d.slug)).toEqual(['executive', 'engineering']);
    // Budgets and non-secret config are kept; terminated agents are not exported.
    expect(b.departments[1]).toMatchObject({ budgetUsd: 300, leadAgentId: ids.lead, sharedSkills: ['task-prioritisation-and-planning'] });
    expect(b.agents.map((a) => a.slug)).toEqual(['morgan', 'riley', 'sam']);
    expect(b.agents[1]).toMatchObject({ budgetUsd: 50, reportsTo: ids.ceo, providerBinding: { adapter: 'openai_api', model: 'gpt', config: { temperature: 0.2 } } });
    expect(b.goals).toHaveLength(2);
    expect(b.playbooks).toHaveLength(1);
    expect(b.connectors).toEqual([
      expect.objectContaining({ name: 'GitHub', kind: 'mcp_http', needsCredential: true, config: expect.objectContaining({ timeoutMs: 5000 }) }),
      expect.objectContaining({ name: 'Local files', kind: 'mcp_stdio', scope: 'dept', scopeId: ids.eng, needsCredential: false, toolAllowlist: ['read_file', 'get_token'] }),
    ]);
    // Grants keep their tool policies (as data, so a tool called get_token is not mistaken for a secret); a terminated agent's grant is dropped.
    expect(b.grants).toEqual([
      {
        connectorId: 'con_github', agentId: ids.dev, toolAllowlist: ['search', 'create_issue'], defaultPolicy: 'allowed', needsCredential: true,
        policies: [{ tool: 'create_issue', policy: 'ask' }, { tool: 'get_token', policy: 'off' }],
      },
      { connectorId: 'con_local', agentId: ids.lead, toolAllowlist: null, policies: [], defaultPolicy: 'ask', needsCredential: false },
    ]);
    expect(b.agents[2]).toMatchObject({ connectors: ['con_github', 'con_gone'], denyConnectors: ['con_local'], needsCredential: false });
    expect(b.agents[1]).toMatchObject({ needsCredential: true });
    expect(b.org).toMatchObject({ needsCredential: true, defaultConnectors: ['con_github'], policies: { extraGated: ['deploy'] } });
    // Only a workspace inside the org directory is portable.
    expect(b.projects).toEqual([
      expect.objectContaining({ name: 'Website', goalId: ids.goalChild, budgetUsd: 40, status: 'active', workspaceRel: 'repos/website' }),
      expect.objectContaining({ name: 'Legacy', goalId: null, status: 'archived', workspaceRel: null }),
    ]);
    expect(b.profileDocs).toEqual([{ agentId: ids.dev, content: expect.stringContaining('Always cc ops@ on vendor emails.') }]);
    expect(b.ownerModel).toBe('Owner rejects designs with stock photos.\n');
    expect(b.skills.map((s) => [s.name, s.status, s.author])).toEqual([['house-style', 'active', 'human'], ['rust', 'draft', 'human']]);
    expect(b.skills.map((s) => [s.scope, s.scopeSlug, s.name, Object.keys(s.files).sort()])).toEqual([
      ['org', null, 'house-style', ['SKILL.md', 'scripts/get_token']],
      ['agent', 'sam', 'rust', ['SKILL.md']],
    ]);
    expect(b.skills[0]?.files['scripts/get_token']).toContain('echo ok');
    expect(b.memories.map((m) => m.kind)).toEqual(['owner_model', 'lesson', 'semantic']);
  });

  it('never puts secret material in the bundle', () => {
    const json = JSON.stringify(org.exportOrg(source.id));
    for (const secret of Object.values(SECRETS)) expect(json).not.toContain(secret);
    expect(json).not.toContain('abcdefghijklmnopqrstuvwxyz');
    for (const ref of REFS) expect(json).not.toContain(ref);
    expect(json).not.toMatch(/auth_?ref|secret_?ref|cookie_?vault_?ref/i);
    expect(json).toContain('[REDACTED]');
    // Sanitized, not dropped: the surrounding memory text survives.
    expect(json).toContain('Owner prefers short updates.');
    expect(json).not.toContain('FORGOTTEN-FACT');
    expect(json).not.toContain('ORPHANED-LESSON');
  });

  it('sanitize strips refs at any depth without mangling identifiers', () => {
    const out = sanitize({
      authRef: 'a', auth_ref: 'b', nested: [{ secretRef: 'c', cookieVaultRef: 'd', keep: 1 }],
      skills: ['task-prioritisation-and-planning', SECRETS.github],
      note: `token ${SECRETS.github}`,
      password: 'plain',
      maxTokens: 4096,
    });
    expect(out).toEqual({
      nested: [{ keep: 1 }],
      skills: ['task-prioritisation-and-planning', '[REDACTED]'],
      note: 'token [REDACTED]',
      password: '[REDACTED]',
      maxTokens: 4096,
    });
  });

  it('export → import recreates the org chart under a new name with fresh, remapped ids', async () => {
    const upsert = vi.fn(async () => ({}) as never);
    const write = vi.fn(async () => ({}) as never);
    const setProfileDoc = vi.fn();
    const setOwnerModel = vi.fn();
    const gateway = fakeGateway();
    org.setImportDeps({ skills: { upsert }, memory: { write, setProfileDoc, setOwnerModel }, connectors: gateway.dep });
    const notifications: Array<Record<string, unknown>> = [];
    k.bus.on('notification', (n) => void notifications.push(n));

    // Round-trip through JSON, as a real bundle file would.
    const bundle = JSON.parse(JSON.stringify(org.exportOrg(source.id))) as OrgBundle;
    const copy = org.importOrg(bundle, { name: 'Acme Clone' }, OWNER);
    await org.whenIdle();

    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      name: 'Acme Clone', slug: 'acme-clone', mission: 'Ship great software', budgetMonthlyUsd: 900, maxConcurrentRuns: 2,
      defaultSkills: ['house-style'], policies: { extraGated: ['deploy'] },
      // Credentials are not portable; connector ids belong to the source org.
      defaultProvider: { adapter: 'claude_api', model: 'sonnet', fallback: [{ adapter: 'openai_api' }] },
      defaultConnectors: [],
    });

    // The org chart is recreated exactly.
    expect(shape(org.orgChart(copy.id))).toEqual(shape(org.orgChart(source.id)));
    expect(shape(org.orgChart(copy.id))).toEqual([{
      slug: 'morgan', role: 'CEO', dept: 'executive', isLead: true,
      reports: [{ slug: 'riley', role: 'Head of Engineering', dept: 'engineering', isLead: true, reports: [{ slug: 'sam', role: 'Engineer', dept: 'engineering', isLead: false, reports: [] }] }],
    }]);

    // Every id is fresh and every internal reference points inside the new org.
    const oldIds = new Set([source.id, ...org.listDepts(source.id).map((d) => d.id), ...org.listAgents(source.id).map((a) => a.id), ids.goalRoot, ids.goalChild]);
    const newAgents = org.listAgents(copy.id);
    const newDepts = org.listDepts(copy.id);
    const bySlug = (slug: string) => newAgents.find((a) => a.slug === slug)!;
    for (const a of newAgents) {
      expect(oldIds.has(a.id)).toBe(false);
      expect(newDepts.map((d) => d.id)).toContain(a.deptId);
      if (a.reportsTo) expect(newAgents.map((x) => x.id)).toContain(a.reportsTo);
      expect(a.status).toBe('active');
    }
    expect(bySlug('sam')).toMatchObject({ goal: 'Ship', backstory: 'Pragmatic', skills: ['rust'], denySkills: ['house-style'], maxSteps: 25, heartbeatCron: '0 * * * *' });
    expect(bySlug('riley')).toMatchObject({ autonomyLevel: 3, budgetUsd: 50, providerBinding: { adapter: 'openai_api', model: 'gpt', config: { temperature: 0.2 } } });
    expect(bySlug('riley').providerBinding).not.toHaveProperty('authRef');
    const newEng = newDepts.find((d) => d.slug === 'engineering')!;
    expect(newEng).toMatchObject({ charter: 'Build', budgetUsd: 300, leadAgentId: bySlug('riley').id, sharedSkills: ['task-prioritisation-and-planning'] });

    const newGoals = k.db.select().from(goals).where(eq(goals.orgId, copy.id)).all();
    const root = newGoals.find((g) => g.title === 'Grow')!;
    const child = newGoals.find((g) => g.title === 'Ship v2')!;
    expect(newGoals).toHaveLength(2);
    expect(oldIds.has(root.id) || oldIds.has(child.id)).toBe(false);
    expect(child).toMatchObject({ parentGoalId: root.id, deptId: newEng.id, ownerAgentId: bySlug('riley').id, weight: 2, level: 'agent' });

    const [pb] = k.db.select().from(playbooks).where(eq(playbooks.orgId, copy.id)).all();
    expect(pb).toMatchObject({ name: 'Release', process: 'hierarchical', managerAgentId: bySlug('riley').id });
    expect(pb?.steps).toEqual([
      { title: 'Build', description: 'Compile', expectedOutput: 'Artifact', agentId: bySlug('sam').id },
      { title: 'Review', description: '', expectedOutput: 'LGTM', agentRole: 'Head of Engineering' },
    ]);

    // Projects come back with their goal remapped; a portable workspace lands inside the NEW org's directory.
    const newProjects = k.db.select().from(projects).where(eq(projects.orgId, copy.id)).all();
    expect(newProjects.map((p) => [p.name, p.goalId, p.budgetUsd, p.status, p.workspacePath])).toEqual([
      ['Website', child.id, 40, 'active', join(k.paths.org(copy.slug), 'repos', 'website')],
      ['Legacy', null, null, 'archived', null],
    ]);
    expect(org.listRevisions(copy.id, 'project', newProjects[0]!.id)).toHaveLength(1);
    expect(org.listRevisions(copy.id, 'playbook', pb!.id)).toHaveLength(1);
    expect(org.listRevisions(copy.id, 'goal', root.id)).toHaveLength(1);

    // Skills are re-created through the skills service: an active skill stays active, a draft stays a draft.
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith(copy.id, expect.objectContaining({
      scope: 'org', scopeId: copy.id, name: 'house-style', description: 'Write in the house style', status: 'active',
      body: expect.stringContaining('Always be concise.'), files: { 'scripts/get_token': '#!/bin/sh\necho ok\n' },
    }), OWNER);
    expect(upsert).toHaveBeenCalledWith(copy.id, expect.objectContaining({ scope: 'agent', scopeId: bySlug('sam').id, name: 'rust', status: 'draft', body: 'Prefer iterators.\n' }), OWNER);

    // Connectors are re-installed through the gateway, without credentials; the one that had a credential is disabled.
    const [github, local] = gateway.installed;
    expect(gateway.installed).toHaveLength(2);
    expect(github).toMatchObject({ orgId: copy.id, name: 'GitHub', kind: 'mcp_http', scope: 'org', authRef: null, status: 'disabled', config: expect.objectContaining({ timeoutMs: 5000 }) });
    expect(local).toMatchObject({ orgId: copy.id, name: 'Local files', kind: 'mcp_stdio', scope: 'dept', scopeId: newEng.id, status: 'active', toolAllowlist: ['read_file', 'get_token'], config: { command: 'npx', args: ['files-mcp'] } });
    expect(gateway.dep.update).toHaveBeenCalledTimes(1);
    expect(oldIds.has(github!.id) || github!.id === 'con_github').toBe(false);

    // Grants and their per-tool policies point at the new connector and agent ids.
    expect(gateway.grants).toHaveLength(2);
    expect(gateway.grants[0]).toMatchObject({
      orgId: copy.id, connectorId: github!.id, agentId: bySlug('sam').id, authRef: null,
      toolAllowlist: ['search', 'create_issue'], toolPolicies: { create_issue: 'ask', get_token: 'off' }, defaultPolicy: 'allowed',
    });
    expect(gateway.grants[1]).toMatchObject({ connectorId: local!.id, agentId: bySlug('riley').id, defaultPolicy: 'ask', toolPolicies: {} });
    expect(gateway.dep.grant).toHaveBeenCalledWith(copy.id, github!.id, bySlug('sam').id, expect.anything(), OWNER);

    // Connector lists on the org, department and agent follow the new ids; unknown ids are dropped.
    expect(org.getOrg(copy.id).defaultConnectors).toEqual([github!.id]);
    expect(org.getDept(copy.id, newEng.id).sharedConnectors).toEqual([local!.id]);
    expect(org.getAgent(copy.id, bySlug('sam').id)).toMatchObject({ connectors: [github!.id], denyConnectors: [local!.id] });
    expect(org.resolveCapabilityRefs(copy.id, bySlug('sam').id).connectorIds).toEqual([github!.id]);

    // MEMORY.md and the owner model are restored through the memory service, sanitized.
    expect(setProfileDoc).toHaveBeenCalledTimes(1);
    expect(setProfileDoc).toHaveBeenCalledWith(copy.id, bySlug('sam').id, expect.stringContaining('Always cc ops@ on vendor emails.'), OWNER);
    expect(setProfileDoc.mock.calls[0]?.[2]).toContain('[REDACTED]');
    expect(setOwnerModel).toHaveBeenCalledWith(copy.id, 'Owner rejects designs with stock photos.\n', OWNER);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledWith(copy.id, expect.objectContaining({ scope: 'org', scopeId: copy.id, kind: 'owner_model', content: expect.stringContaining('[REDACTED]') }), OWNER);
    expect(write).toHaveBeenCalledWith(copy.id, expect.objectContaining({ scope: 'agent', scopeId: bySlug('sam').id, kind: 'lesson' }), OWNER);
    expect(write).toHaveBeenCalledWith(copy.id, expect.objectContaining({ scope: 'dept', scopeId: newEng.id, kind: 'semantic' }), OWNER);
    const everything = JSON.stringify([upsert.mock.calls, write.mock.calls, setProfileDoc.mock.calls, gateway.installed, gateway.grants]);
    expect(everything).not.toContain('abcdefghijklmnopqrstuvwxyz');
    for (const ref of REFS) expect(everything).not.toContain(ref);

    // The source org is untouched and the import is audited.
    expect(org.listAgents(source.id)).toHaveLength(4);
    expect(k.audit.query({ orgId: copy.id, action: 'org.imported' })[0]?.data).toMatchObject({ departments: 2, agents: 3, goals: 2, playbooks: 1 });
    const completed = k.audit.query({ orgId: copy.id, action: 'org.import_completed' })[0]?.data;
    expect(completed).toMatchObject({ skills: 2, connectors: 2, grants: 2, memories: 3, profileDocs: 2, skipped: 0, failed: 0 });

    // No credential travelled: everything that needs one is flagged for the owner.
    const gaps = [
      { kind: 'provider', name: 'organization default provider / utility model' },
      { kind: 'provider', name: 'agent riley' },
      { kind: 'connector', name: 'GitHub' },
      { kind: 'grant', name: 'GitHub → sam' },
    ];
    expect(completed?.needsCredential).toEqual(gaps);
    expect(notifications).toEqual([expect.objectContaining({ orgId: copy.id, kind: 'org.import_needs_credentials', data: { needsCredential: gaps } })]);
    expect(String(notifications[0]?.body)).toContain('connector: GitHub');
  });

  it('imports structure without the optional deps, and tolerates a failing dep', async () => {
    const bundle = org.exportOrg(source.id);
    const first = org.importOrg(bundle, { name: 'No Deps' }, OWNER);
    await org.whenIdle();
    expect(org.listAgents(first.id)).toHaveLength(3);
    // 2 skills + 2 connectors + 2 grants + 3 memories + MEMORY.md + owner model: nothing to hand them to.
    expect(k.audit.query({ orgId: first.id, action: 'org.import_completed' })[0]?.data).toMatchObject({ skills: 0, connectors: 0, grants: 0, memories: 0, skipped: 11 });
    expect(org.getAgent(first.id, org.findAgent(first.id, 'sam')!.id).connectors).toEqual([]);

    org.setImportDeps({ memory: { write: vi.fn(async () => { throw new Error('embedder offline'); }) } });
    const second = org.importOrg(bundle, { name: 'Flaky Deps' }, OWNER);
    await org.whenIdle();
    expect(org.listAgents(second.id)).toHaveLength(3);
    expect(k.audit.query({ orgId: second.id, action: 'org.import_completed' })[0]?.data).toMatchObject({ memories: 0, failed: 3 });

    // A gateway that refuses one connector still gets the other, and the refused one's grant is skipped.
    const gateway = fakeGateway();
    vi.mocked(gateway.dep.install).mockRejectedValueOnce(new Error('kind not supported'));
    org.setImportDeps({ connectors: gateway.dep });
    const third = org.importOrg(bundle, { name: 'Picky Gateway' }, OWNER);
    await org.whenIdle();
    expect(gateway.installed.map((c) => c.name)).toEqual(['Local files']);
    expect(gateway.grants).toHaveLength(1);
    const data = k.audit.query({ orgId: third.id, action: 'org.import_completed' })[0]?.data as { failures: string[]; connectors: number; grants: number };
    expect(data).toMatchObject({ connectors: 1, grants: 1 });
    expect(data.failures).toContainEqual(expect.stringContaining('connector GitHub: kind not supported'));
  });

  it('strips secret refs from an untrusted bundle and rejects malformed ones atomically', () => {
    const bundle = org.exportOrg(source.id);
    const tampered = structuredClone(bundle);
    (tampered.agents[1] as { providerBinding: Record<string, unknown> }).providerBinding.authRef = 'someone-elses/secret';
    (tampered.org as { defaultProvider: Record<string, unknown> }).defaultProvider.authRef = REFS[0];
    const imported = org.importOrg(tampered, { name: 'Tampered' }, OWNER);
    expect(imported.defaultProvider).not.toHaveProperty('authRef');
    expect(org.findAgent(imported.id, 'riley')?.providerBinding).not.toHaveProperty('authRef');

    const before = org.listOrgs().length;
    expect(codeOf(() => org.importOrg({ ...bundle, format: 'nope' } as never, { name: 'Bad' }, OWNER))).toBe('validation');
    expect(codeOf(() => org.importOrg({ ...bundle, version: 2 } as never, { name: 'Bad' }, OWNER))).toBe('validation');
    expect(codeOf(() => org.importOrg(bundle, { name: '' }, OWNER))).toBe('validation');
    expect(codeOf(() => org.importOrg(bundle, { name: 'Bad' }, { kind: 'agent', id: ids.lead }))).toBe('forbidden');

    // A reporting cycle or a dangling department fails the whole import: no half-built org.
    const cyclic = structuredClone(bundle);
    cyclic.agents[0]!.reportsTo = cyclic.agents[2]!.id;
    expect(codeOf(() => org.importOrg(cyclic, { name: 'Cyclic' }, OWNER))).toBe('validation');
    const dangling = structuredClone(bundle);
    dangling.agents[2]!.deptId = 'dept_nowhere';
    expect(codeOf(() => org.importOrg(dangling, { name: 'Dangling' }, OWNER))).toBe('validation');
    // A project workspace may not climb out of the new org's directory.
    const escaping = structuredClone(bundle);
    escaping.projects![0]!.workspaceRel = '../../../../etc';
    expect(codeOf(() => org.importOrg(escaping, { name: 'Escaping' }, OWNER))).toBe('validation');
    expect(org.getOrgBySlug('escaping')).toBeNull();
    const badLevel = structuredClone(bundle);
    badLevel.agents[2]!.autonomyLevel = 9;
    expect(codeOf(() => org.importOrg(badLevel, { name: 'Bad Level' }, OWNER))).toBe('validation');

    expect(org.listOrgs()).toHaveLength(before);
    expect(org.getOrgBySlug('cyclic')).toBeNull();
    expect(org.getOrgBySlug('dangling')).toBeNull();
  });

  it('refuses to export another org\'s data through a foreign id', () => {
    expect(codeOf(() => org.exportOrg('org_missing'))).toBe('not_found');
    const other = org.createOrg({ name: 'Other' }, OWNER);
    const b = org.exportOrg(other.id);
    expect(b.agents).toEqual([]);
    expect(b.memories).toEqual([]);
    expect(b.skills).toEqual([]);
    expect(b.connectors).toEqual([]);
    expect(b.goals).toEqual([]);
  });
});
