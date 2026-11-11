import { describe, expect, it, vi } from 'vitest';
import type { ConnectorTemplate } from '../../src/api/types.js';
import { agent, approval, connector, dept, harness, memory, skill } from './harness.js';

const ENV = { CONDUCTOR_ORG: 'acme' };
const agents = () => vi.fn(async () => [agent(), agent({ id: 'agt_sam', slug: 'sam', name: 'Sam' })]);

describe('skills', () => {
  const skills = () => vi.fn(async () => [skill(), skill({ id: 'skl_2', name: 'triage', scope: 'org', scopeId: 'org_1', status: 'draft', version: 1, useCount: 0, successCount: 0, evalScore: null })]);

  it('lists skills with usage and eval columns', async () => {
    const listSkills = skills();
    const h = harness({ env: ENV, client: { listSkills, listAgents: agents() } });
    const r = await h.run('skills', 'list');
    expect(r.stdout).toMatch(/release-notes\s+agent\s+v3\s+active\s+agent:riley\s+10\s+90%\s+0\.80\s+Write release notes/);
    expect(r.stdout).toMatch(/triage\s+org\s+v1\s+draft\s+agent:riley\s+0\s+-\s+-/);
    await h.run('--json', 'skills', 'list', '--scope', 'agent', '--agent', 'sam', '--status', 'draft');
    expect(listSkills).toHaveBeenLastCalledWith('acme', { scope: 'agent', scopeId: 'agt_sam', status: 'draft' });
  });

  it('shows a skill body resolved by name', async () => {
    const readSkill = vi.fn(async () => ({ skill: skill(), body: '# Release notes\nDo the thing.\n', files: ['SKILL.md', 'scripts/gen.sh'] }));
    const h = harness({ env: ENV, client: { listSkills: skills(), readSkill } });
    const r = await h.run('skills', 'show', 'release-notes');
    expect(readSkill).toHaveBeenCalledWith('acme', 'skl_1');
    expect(r.stdout).toMatch(/files:\s+SKILL\.md, scripts\/gen\.sh/);
    expect(r.stdout).toContain('# Release notes\nDo the thing.');
  });

  it('diffs versions and rolls back', async () => {
    const skillDiff = vi.fn(async () => ({ diff: '--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-old\n+new\n' }));
    const rollbackSkill = vi.fn(async () => skill({ version: 4 }));
    const h = harness({ env: ENV, client: { listSkills: skills(), skillDiff, rollbackSkill } });
    const d = await h.run('skills', 'diff', 'release', '--from', '1', '--to', '3');
    expect(skillDiff).toHaveBeenCalledWith('acme', 'skl_1', { from: 1, to: 3 });
    expect(d.stdout).toBe('--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-old\n+new\n');
    await h.run('skill', 'diff', 'skl_1');
    expect(skillDiff).toHaveBeenLastCalledWith('acme', 'skl_1', {});

    const rb = await h.run('skills', 'rollback', 'release-notes', 'v2');
    expect(rollbackSkill).toHaveBeenCalledWith('acme', 'skl_1', 2);
    expect(rb.stdout).toContain('release-notes rolled back to v2 (now v4, active)');
    expect((await h.run('skills', 'rollback', 'release-notes', 'latest')).code).toBe(2);
    expect(((await h.run('--json', 'skills', 'diff', 'release-notes')).json() as { diff: string }).diff).toContain('+new');
  });

  it('shows history, evaluates, activates and promotes', async () => {
    const evalResult = { ranAt: 1, passed: true, score: 0.91, baseline: { success: false, steps: 12, tokens: 9000, costUsd: 0.2, wallMs: 60_000 }, withSkill: { success: true, steps: 6, tokens: 4000, costUsd: 0.09, wallMs: 30_000 } };
    const activateSkill = vi.fn(async () => skill({ id: 'skl_2', name: 'triage', version: 1, status: 'active' }));
    const promoteSkill = vi.fn(async (_o: string, _id: string, to: string) => (to === 'dept' ? { skill: skill({ scope: 'dept' }) } : { approval: approval({ id: 'apr_5', kind: 'promote_skill', title: 'Promote release-notes to org' }) }));
    const h = harness({
      env: ENV,
      client: {
        listSkills: skills(), activateSkill, promoteSkill,
        skillHistory: vi.fn(async () => [{ id: 'skv_3', skillId: 'skl_1', orgId: 'org_1', version: 3, commitSha: 'abc', author: 'agent:riley', runId: null, message: 'tighten steps', contentHash: 'h', eval: evalResult, createdAt: 1_699_999_000_000 }]),
        evaluateSkill: vi.fn(async () => evalResult),
      },
    });
    expect((await h.run('skills', 'history', 'release-notes')).stdout).toMatch(/v3 \*\s+\d+m ago\s+agent:riley\s+pass 0\.91\s+tighten steps/);

    const ev = await h.run('skills', 'evaluate', 'release-notes');
    expect(ev.stdout).toContain('✓ passed  score 0.91');
    expect(ev.stdout).toMatch(/with skill\s+yes\s+6\s+4000\s+\$0\.0900\s+30s/);

    const act = await h.run('skills', 'activate', 'triage', '--force');
    expect(activateSkill).toHaveBeenCalledWith('acme', 'skl_2', { force: true });
    expect(act.stdout).toContain('triage v1 is active');

    expect((await h.run('skills', 'promote', 'release-notes', '--to', 'dept')).stdout).toContain('promoted to dept scope');
    const queued = await h.run('skills', 'promote', 'release-notes', '--to', 'org');
    expect(promoteSkill).toHaveBeenLastCalledWith('acme', 'skl_1', 'org');
    expect(queued.stdout).toContain('conductor approvals approve apr_5');
    expect((await h.run('skills', 'promote', 'release-notes', '--to', 'agent')).code).toBe(2);
  });

  it('imports a skill folder into a scope', async () => {
    const importSkill = vi.fn(async () => skill({ name: 'imported', status: 'draft', version: 1, scope: 'dept' }));
    const h = harness({ env: ENV, dirs: ['/skills/imported'], client: { importSkill, listDepartments: vi.fn(async () => [dept()]) } });
    const r = await h.run('skills', 'import', '/skills/imported', '--scope', 'dept', '--dept', 'engineering', '--source', 'https://example.com/skill');
    expect(importSkill).toHaveBeenCalledWith('acme', { sourceDir: '/skills/imported', scope: 'dept', scopeId: 'dept_eng', source: 'https://example.com/skill' });
    expect(r.stdout).toContain('imported imported v1 as draft (dept scope)');
    await h.run('skills', 'import', '/skills/imported', '--scope', 'global');
    expect(importSkill).toHaveBeenLastCalledWith('acme', { sourceDir: '/skills/imported', scope: 'global', scopeId: null });
    expect((await h.run('skills', 'import', '/skills/imported', '--scope', 'agent')).code).toBe(2);
    expect((await h.run('skills', 'import', '/nope', '--scope', 'org')).code).toBe(2);
  });
});

describe('memory', () => {
  it('searches with agent scope and kinds', async () => {
    const searchMemory = vi.fn(async () => [{ memory: memory(), score: 0.8123, similarity: 0.9 }]);
    const h = harness({ env: ENV, client: { searchMemory, listAgents: agents() } });
    const r = await h.run('memory', 'search', 'run', 'the', 'tests', '--agent', 'sam', '--kind', 'lesson,procedural', '--limit', '3', '--review');
    expect(searchMemory).toHaveBeenCalledWith('acme', { text: 'run the tests', agentId: 'agt_sam', kinds: ['lesson', 'procedural'], limit: 3, includeReview: true });
    expect(r.stdout).toMatch(/0\.81\s+lesson\s+agent\s+Always run the tests before pushing\.\s+mem_1/);
    await h.run('--json', 'memory', 'search', 'tests');
    expect(searchMemory).toHaveBeenLastCalledWith('acme', { text: 'tests', limit: 10 });
    expect((await h.run('memory', 'search', 'x', '--kind', 'gossip')).code).toBe(2);
  });

  it('lists memories and the review queue', async () => {
    const listMemory = vi.fn(async () => [memory({ status: 'review', confidence: 0.4, pinned: true })]);
    const h = harness({ env: ENV, client: { listMemory, listAgents: agents() } });
    const r = await h.run('memory', 'list', '--review');
    expect(listMemory).toHaveBeenCalledWith('acme', { status: 'review', limit: 50 });
    expect(r.stdout).toMatch(/mem_1\s+lesson\s+agent\s+review\s+0\.40\s+\*\s+Always run the tests/);
    expect(r.stderr).toContain('conductor memory approve <id>');
    await h.run('memory', 'list', '--agent', 'sam', '--kind', 'semantic');
    expect(listMemory).toHaveBeenLastCalledWith('acme', { scope: 'agent', scopeId: 'agt_sam', kind: 'semantic', limit: 50 });
    expect((await h.run('memory', 'list', '--review', '--status', 'active')).code).toBe(2);
  });

  it('shows, edits, pins, approves and forgets', async () => {
    const updateMemory = vi.fn(async (_o: string, _id: string, patch: object) => memory({ ...patch }));
    const forgetMemory = vi.fn(async () => ({ ok: true }));
    const h = harness({ env: ENV, client: { getMemory: vi.fn(async () => memory()), updateMemory, forgetMemory } });
    expect((await h.run('memory', 'show', 'mem_1')).stdout).toContain('Always run the tests before pushing.');

    await h.run('memory', 'edit', 'mem_1', '--content', 'Run tests and lint.', '--importance', '0.9', '--kind', 'procedural');
    expect(updateMemory).toHaveBeenLastCalledWith('acme', 'mem_1', { content: 'Run tests and lint.', importance: 0.9, kind: 'procedural' });
    expect((await h.run('memory', 'edit', 'mem_1', '--confidence', '2')).code).toBe(2);
    expect((await h.run('memory', 'edit', 'mem_1')).code).toBe(2); // not a terminal: no editor

    expect((await h.run('memory', 'pin', 'mem_1')).stdout).toContain('pinned mem_1');
    expect(updateMemory).toHaveBeenLastCalledWith('acme', 'mem_1', { pinned: true });
    await h.run('memory', 'pin', 'mem_1', '--off');
    expect(updateMemory).toHaveBeenLastCalledWith('acme', 'mem_1', { pinned: false });
    expect((await h.run('memory', 'approve', 'mem_1')).stdout).toContain('approved mem_1');
    expect(updateMemory).toHaveBeenLastCalledWith('acme', 'mem_1', { status: 'active' });
    expect((await h.run('--json', 'memory', 'forget', 'mem_1')).json()).toEqual({ ok: true, id: 'mem_1' });
    expect(forgetMemory).toHaveBeenCalledWith('acme', 'mem_1');
  });

  it('opens the editor for `memory edit` on a terminal', async () => {
    const updateMemory = vi.fn(async () => memory());
    const h = harness({ env: ENV, stdinIsTTY: true, client: { getMemory: vi.fn(async () => memory({ content: 'old' })), updateMemory } });
    await h.run('memory', 'edit', 'mem_1');
    expect(updateMemory).toHaveBeenCalledWith('acme', 'mem_1', { content: 'old (edited)' });
  });

  it('prints and edits the owner model', async () => {
    const putOwnerModel = vi.fn(async (_o: string, content: string) => ({ content }));
    const h = harness({ env: ENV, files: { '/tmp/USER.md': '# Owner\nPrefers short updates.\n' }, client: { getOwnerModel: vi.fn(async () => ({ content: '# Owner\n' })), putOwnerModel } });
    expect((await h.run('memory', 'owner-model')).stdout).toBe('# Owner\n');
    expect((await h.run('--json', 'memory', 'owner-model')).json()).toEqual({ content: '# Owner\n' });
    const e = await h.run('memory', 'owner-model', '--edit', '--file', '/tmp/USER.md');
    expect(putOwnerModel).toHaveBeenCalledWith('acme', '# Owner\nPrefers short updates.\n');
    expect(e.stdout).toContain('owner model updated');
    expect((await h.run('memory', 'owner-model', '--file', '/tmp/USER.md')).code).toBe(2);
  });
});

describe('connector', () => {
  const github: ConnectorTemplate = { id: 'github', name: 'GitHub', description: 'Repos, issues and PRs', kind: 'mcp_http', category: 'dev', config: {}, requiredSecrets: ['GITHUB_TOKEN'], docsUrl: 'https://example.com/docs' };
  const TOKEN_VALUE = 'ghp_very-secret-token-value';

  it('lists the catalog and installed connectors', async () => {
    const h = harness({
      env: ENV,
      client: {
        connectorCatalog: vi.fn(async () => [github]),
        listConnectors: vi.fn(async () => [connector(), connector({ id: 'con_2', name: 'Linear', status: 'error', lastError: 'connection refused', templateId: 'linear' })]),
        listGrants: vi.fn(async () => [{ connectorId: 'con_1' }]),
      },
    });
    expect((await h.run('connector', 'catalog')).stdout).toMatch(/github\s+GitHub\s+dev\s+mcp_http\s+GITHUB_TOKEN\s+Repos, issues and PRs/);
    const l = await h.run('connector', 'list');
    expect(l.stdout).toMatch(/GitHub\s+mcp_http\s+org\s+active\s+1\s+github\s+con_1/);
    expect(l.stdout).toMatch(/Linear\s+mcp_http\s+org\s+error: connection refused\s+0\s+linear\s+con_2/);
  });

  it('installs from a template taking the secret from the environment, never echoing it', async () => {
    const installConnectorFromTemplate = vi.fn(async () => connector());
    const h = harness({ env: { ...ENV, GITHUB_TOKEN: TOKEN_VALUE }, client: { connectorCatalog: vi.fn(async () => [github]), installConnectorFromTemplate } });
    const r = await h.run('connector', 'install', 'github', '--name', 'GitHub', '--config', '{"org":"acme"}');
    expect(r.code).toBe(0);
    expect(installConnectorFromTemplate).toHaveBeenCalledWith('acme', { templateId: 'github', name: 'GitHub', secrets: { GITHUB_TOKEN: TOKEN_VALUE }, config: { org: 'acme' } });
    expect(r.stdout + r.stderr).not.toContain(TOKEN_VALUE);
    expect(r.stdout).toContain('conductor connector grant GitHub <agent>');
    const j = await h.run('--json', 'connector', 'install', 'github');
    expect(j.stdout + j.stderr).not.toContain(TOKEN_VALUE);
  });

  it('accepts --secret KEY=VALUE with a warning, prompts hidden on a terminal, and fails clearly otherwise', async () => {
    const installConnectorFromTemplate = vi.fn(async () => connector());
    const mocks = { connectorCatalog: vi.fn(async () => [github]), installConnectorFromTemplate };

    const inline = harness({ env: ENV, client: mocks });
    const a = await inline.run('connector', 'install', 'github', '--secret', `GITHUB_TOKEN=${TOKEN_VALUE}`, '--secret', 'EXTRA=a=b');
    expect(installConnectorFromTemplate).toHaveBeenLastCalledWith('acme', { templateId: 'github', secrets: { GITHUB_TOKEN: TOKEN_VALUE, EXTRA: 'a=b' } });
    expect(a.stderr).toContain('shell history');
    expect(a.stdout + a.stderr).not.toContain(TOKEN_VALUE);

    const tty = harness({ env: ENV, client: mocks, stdinIsTTY: true, answers: [TOKEN_VALUE] });
    await tty.run('connector', 'install', 'github');
    expect(tty.prompts).toEqual([{ question: 'GITHUB_TOKEN for GitHub (input hidden): ', hidden: true }]);
    expect(installConnectorFromTemplate).toHaveBeenLastCalledWith('acme', { templateId: 'github', secrets: { GITHUB_TOKEN: TOKEN_VALUE } });

    const piped = harness({ env: ENV, client: mocks });
    const c = await piped.run('connector', 'install', 'github');
    expect(c.code).toBe(2);
    expect(c.stderr).toContain('GitHub needs the secret GITHUB_TOKEN');
    expect(c.stderr).toContain('https://example.com/docs');
    expect((await piped.run('connector', 'install', 'nope')).stderr).toContain('No connector template matches "nope"');
  });

  it('grants with per-tool policies, revokes, lists tools, re-trusts and removes', async () => {
    const grantConnector = vi.fn(async () => ({ grant: { toolAllowlist: ['search', 'read', 'send'], defaultPolicy: 'off' } }));
    const h = harness({
      env: ENV,
      client: {
        listConnectors: vi.fn(async () => [connector()]), listAgents: agents(), grantConnector,
        revokeGrant: vi.fn(async () => ({ ok: true })), retrustTool: vi.fn(async () => ({ ok: true })), removeConnector: vi.fn(async () => ({ ok: true })),
        connectorTools: vi.fn(async () => [{ name: 'search', description: 'Search repos', inputSchema: {}, quarantined: false }, { name: 'send', description: 'Send', inputSchema: {}, quarantined: true }]),
      },
    });
    const g = await h.run('connector', 'grant', 'github', 'sam', '--allow', 'search,read', '--ask', 'send', '--off', 'delete', '--default', 'off');
    expect(grantConnector).toHaveBeenCalledWith('acme', 'con_1', 'agt_sam', {
      toolAllowlist: ['search', 'read', 'send'], toolPolicies: { search: 'allowed', read: 'allowed', send: 'ask', delete: 'off' }, defaultPolicy: 'off',
    });
    expect(g.stdout).toContain('sam can use GitHub: 3 tools, default policy off');
    await h.run('connector', 'grant', 'GitHub', 'sam');
    expect(grantConnector).toHaveBeenLastCalledWith('acme', 'con_1', 'agt_sam', {});
    expect((await h.run('connector', 'grant', 'github', 'sam', '--allow', 'send', '--off', 'send')).code).toBe(2);
    expect((await h.run('connector', 'grant', 'github', 'sam', '--default', 'sometimes')).code).toBe(2);

    expect((await h.run('connector', 'revoke', 'github', 'sam')).stdout).toContain('sam can no longer use GitHub');
    expect(h.client.revokeGrant).toHaveBeenCalledWith('acme', 'con_1', 'agt_sam');

    const t = await h.run('connector', 'tools', 'con_1');
    expect(t.stdout).toMatch(/send\s+QUARANTINED\s+Send/);
    expect(t.stderr).toContain('conductor connector retrust GitHub <tool>');
    expect((await h.run('connector', 'retrust', 'github', 'send')).stdout).toContain('send on GitHub is trusted again');
    expect(h.client.retrustTool).toHaveBeenCalledWith('acme', 'con_1', 'send');
    expect((await h.run('--json', 'connector', 'remove', 'github')).json()).toEqual({ ok: true, connectorId: 'con_1' });
  });
});

describe('gateway and webhook', () => {
  const gw = { id: 'gw_1', orgId: null, kind: 'telegram', name: 'My bot', config: {}, authRef: 'conductor/telegram', status: 'active', lastError: null, createdAt: 1, updatedAt: 1 };

  it('lists, adds and removes gateways', async () => {
    const createGateway = vi.fn(async () => gw);
    const deleteGateway = vi.fn(async () => ({ ok: true }));
    const listGateways = vi.fn(async () => [gw]);
    const h = harness({ client: { listGateways, createGateway, deleteGateway, secretExists: vi.fn(async (ref: string) => ({ ref, exists: false })) } });
    expect((await h.run('gateway', 'list')).stdout).toMatch(/My bot\s+telegram\s+all orgs\s+active\s+conductor\/telegram\s+gw_1/);
    expect(listGateways).toHaveBeenLastCalledWith(undefined);

    const a = await h.run('gateway', 'add', 'telegram', '--name', 'My bot', '--config', '{"allowedChatIds":[42]}', '--secret-ref', 'conductor/telegram');
    expect(createGateway).toHaveBeenCalledWith({ kind: 'telegram', name: 'My bot', config: { allowedChatIds: [42] }, authRef: 'conductor/telegram' });
    expect(a.stdout).toContain('added telegram gateway My bot (all orgs)');
    expect(a.stdout).toContain('conductor secret set conductor/telegram');

    await h.run('--org', 'acme', 'gateway', 'add', 'slack', '--name', 'Team');
    expect(createGateway).toHaveBeenLastCalledWith({ kind: 'slack', name: 'Team', orgId: 'acme' });
    expect((await h.run('gateway', 'add', 'pager', '--name', 'x')).code).toBe(2);
    expect((await h.run('gateway', 'add', 'slack', '--name', 'x', '--config', '[1]')).code).toBe(2);
    expect((await h.run('gateway', 'add', 'slack')).code).toBe(2);

    expect((await h.run('gateway', 'remove', 'my bot')).stdout).toContain('removed My bot');
    expect(deleteGateway).toHaveBeenCalledWith('gw_1');
  });

  it('lists, adds and removes webhooks', async () => {
    const hook = { id: 'wh_1', orgId: 'org_1', direction: 'in', name: 'GitHub', source: 'github', agentId: 'agt_sam', url: null, events: [], secretRef: null, status: 'active', createdAt: 1, inboundUrl: 'https://mac.ts.net/hooks/wh_1' };
    const createWebhook = vi.fn(async (_o: string, input: { direction: string }) => ({ ...hook, direction: input.direction, inboundUrl: input.direction === 'in' ? hook.inboundUrl : null }));
    const deleteWebhook = vi.fn(async () => ({ ok: true }));
    const h = harness({ env: ENV, client: { listWebhooks: vi.fn(async () => [hook]), createWebhook, deleteWebhook, listAgents: agents() } });
    expect((await h.run('webhook', 'list')).stdout).toMatch(/GitHub\s+in\s+github\s+sam\s+active\s+https:\/\/mac\.ts\.net\/hooks\/wh_1\s+wh_1/);

    const i = await h.run('webhook', 'add', 'in', '--name', 'GitHub', '--source', 'github', '--agent', 'sam', '--secret-ref', 'org/acme/github-webhook');
    expect(createWebhook).toHaveBeenLastCalledWith('acme', { direction: 'in', name: 'GitHub', source: 'github', agentId: 'agt_sam', secretRef: 'org/acme/github-webhook' });
    expect(i.stdout).toContain('point the external service at: https://mac.ts.net/hooks/wh_1');

    await h.run('webhook', 'add', 'out', '--name', 'Zapier', '--target', 'https://hooks.example.com/x', '--events', 'issue.done,approval.requested');
    expect(createWebhook).toHaveBeenLastCalledWith('acme', { direction: 'out', name: 'Zapier', url: 'https://hooks.example.com/x', events: ['issue.done', 'approval.requested'] });
    expect((await h.run('webhook', 'add', 'sideways', '--name', 'x')).code).toBe(2);
    expect((await h.run('webhook', 'add', 'in', '--name', 'x', '--target', 'https://x')).code).toBe(2);

    expect((await h.run('--json', 'webhook', 'remove', 'GitHub')).json()).toEqual({ ok: true, webhookId: 'wh_1' });
    expect(deleteWebhook).toHaveBeenCalledWith('acme', 'wh_1');
  });
});
