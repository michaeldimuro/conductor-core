import { describe, expect, it, vi } from 'vitest';
import { agent, approval, harness, org } from './harness.js';

const ENV = { CONDUCTOR_ORG: 'acme' };
const SECRET = 'sk-ant-super-secret-value-123456';

describe('approvals', () => {
  it('lists the cross-org pending inbox by default', async () => {
    const approvalInbox = vi.fn(async () => [approval(), approval({ id: 'apr_2', orgId: 'org_2', kind: 'hire_agent', title: 'Hire a designer' })]);
    const h = harness({ env: ENV, client: { approvalInbox, listOrgs: vi.fn(async () => [org(), org({ id: 'org_2', slug: 'globex' })]) } });
    const r = await h.run('approvals', 'list');
    expect(approvalInbox).toHaveBeenCalledWith({ status: 'pending', limit: 500 });
    expect(r.stdout).toMatch(/apr_1\s+acme\s+external_send\s+Send the launch email\s+pending/);
    expect(r.stdout).toMatch(/apr_2\s+globex\s+hire_agent\s+Hire a designer\s+pending/);
    expect(r.stderr).toContain('conductor approvals approve <id>');

    const j = await h.run('--json', 'approvals', 'list', '--status', 'all', '--kind', 'hire_agent');
    expect(approvalInbox).toHaveBeenLastCalledWith({ kind: 'hire_agent', limit: 500 });
    expect((j.json() as unknown[]).length).toBe(2);
  });

  it('narrows to one org with --org and says so when the inbox is empty', async () => {
    const listApprovals = vi.fn(async () => []);
    const h = harness({ client: { listApprovals, listOrgs: vi.fn(async () => [org()]) } });
    const r = await h.run('--org', 'acme', 'approvals', 'list', '--status', 'denied');
    expect(listApprovals).toHaveBeenCalledWith('acme', { status: 'denied', limit: 500 });
    expect(r.stdout).toContain('no approvals match');
    const empty = harness({ client: { approvalInbox: vi.fn(async () => []), listOrgs: vi.fn(async () => []) } });
    expect((await empty.run('approvals', 'list')).stdout).toContain('inbox zero');
  });

  it('shows an approval with its payload', async () => {
    const h = harness({ client: { approvalInbox: vi.fn(async () => [approval()]) } });
    const r = await h.run('approvals', 'show', 'apr_1');
    expect(r.stdout).toMatch(/kind:\s+external_send/);
    expect(r.stdout).toContain('"to": "a@b.c"');
  });

  it('approves and denies in the approval\'s own org', async () => {
    const decideApproval = vi.fn(async (_o: string, _id: string, input: { decision: string }) => approval({ status: input.decision as 'approved' }));
    const h = harness({ client: { approvalInbox: vi.fn(async () => [approval({ orgId: 'org_7' }), approval({ id: 'apr_done', status: 'approved' })]), decideApproval } });
    const ok = await h.run('approvals', 'approve', 'apr_1', '--note', 'go ahead');
    expect(decideApproval).toHaveBeenCalledWith('org_7', 'apr_1', { decision: 'approved', note: 'go ahead' });
    expect(ok.stdout).toContain('approved: Send the launch email');

    const no = await h.run('--json', 'approvals', 'deny', 'apr_1');
    expect(decideApproval).toHaveBeenLastCalledWith('org_7', 'apr_1', { decision: 'denied' });
    expect((no.json() as { status: string }).status).toBe('denied');

    const again = await h.run('approvals', 'approve', 'apr_done');
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already approved');
    const missing = await h.run('approvals', 'approve', 'apr_zzz');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No approval matches "apr_zzz"');
  });
});

describe('budget', () => {
  it('summarises org spend', async () => {
    const budgetSummary = vi.fn(async () => ({
      totalUsd: 12.345, seatSeconds: 5400,
      lines: [{ scope: 'org', id: 'org_1', capUsd: 100, spentUsd: 12.345, pct: 12.345 }, { scope: 'agent', id: 'agt_riley', capUsd: null, spentUsd: 4, pct: null }],
      byAgent: [{ agentId: 'agt_riley', costUsd: 4, tokensIn: 1000, tokensOut: 200, runs: 3 }], byDay: [],
    }));
    const h = harness({ env: ENV, client: { budgetSummary, listAgents: vi.fn(async () => [agent()]), listDepartments: vi.fn(async () => []) } });
    const r = await h.run('budget');
    expect(r.stdout).toMatch(/spent:\s+\$12\.35/);
    expect(r.stdout).toMatch(/seat time:\s+90 min/);
    expect(r.stdout).toMatch(/org\s+org_1\s+\$100\.00\s+\$12\.35\s+12%/);
    expect(r.stdout).toMatch(/agent\s+riley\s+uncapped\s+\$4\.00\s+-/);
    expect(r.stdout).toMatch(/riley\s+3\s+1000\s+200\s+\$4\.00/);
    expect(((await h.run('--json', 'budget')).json() as { totalUsd: number }).totalUsd).toBe(12.345);
  });

  it('shows one agent\'s budget status', async () => {
    const agentBudget = vi.fn(async () => ({
      allowed: false, remainingUsd: 0, reason: 'agent cap reached', tightest: null,
      lines: [{ scope: 'agent', id: 'agt_riley', capUsd: 5, spentUsd: 5, pct: 100 }], seat: { capSeconds: 3600, usedSeconds: 600, allowed: true },
    }));
    const h = harness({ env: ENV, client: { agentBudget, listAgents: vi.fn(async () => [agent()]) } });
    const r = await h.run('budget', '--agent', 'riley');
    expect(agentBudget).toHaveBeenCalledWith('acme', 'agt_riley');
    expect(r.stdout).toMatch(/allowed:\s+no — agent cap reached/);
    expect(r.stdout).toMatch(/seat time:\s+10 min used of 60/);
    expect(r.stdout).toMatch(/agent\s+agt_riley\s+\$5\.00\s+\$5\.00\s+100%/);
  });
});

describe('kill-switch and config', () => {
  it('engages and releases the global kill switch', async () => {
    const h = harness({ client: { engageKillSwitch: vi.fn(async () => ({ engaged: true })), releaseKillSwitch: vi.fn(async () => ({ engaged: false })) } });
    expect((await h.run('kill-switch', 'on')).stdout).toContain('global kill switch ENGAGED');
    expect((await h.run('kill-switch', 'off')).stdout).toContain('global kill switch released');
    expect((await h.run('--json', 'kill-switch', 'on')).json()).toEqual({ engaged: true });
  });

  it('gets and sets settings', async () => {
    const putSetting = vi.fn(async (key: string, value: unknown) => ({ key, value }));
    const h = harness({
      client: {
        listSettings: vi.fn(async () => [{ key: 'daemon.public_url', value: null }, { key: 'embeddings.provider', value: 'local' }]),
        getSetting: vi.fn(async (key: string) => ({ key, value: 'local' })),
        putSetting,
      },
    });
    const all = await h.run('config', 'get');
    expect(all.stdout).toMatch(/daemon\.public_url\s+\(unset\)/);
    expect(all.stdout).toMatch(/embeddings\.provider\s+local/);
    expect((await h.run('--json', 'config', 'get', 'embeddings.provider')).json()).toEqual({ key: 'embeddings.provider', value: 'local' });

    const set = await h.run('config', 'set', 'daemon.public_url', 'https://mac.tail1234.ts.net');
    expect(putSetting).toHaveBeenLastCalledWith('daemon.public_url', 'https://mac.tail1234.ts.net');
    expect(set.stdout).toContain('conductor restart');
    await h.run('config', 'set', 'daemon.public_url');
    expect(putSetting).toHaveBeenLastCalledWith('daemon.public_url', null);
    await h.run('config', 'set', 'embeddings.authRef', 'null');
    expect(putSetting).toHaveBeenLastCalledWith('embeddings.authRef', null);
  });
});

describe('secret', () => {
  const noLeak = (r: { stdout: string; stderr: string }) => {
    expect(r.stdout).not.toContain(SECRET);
    expect(r.stderr).not.toContain(SECRET);
  };

  it('reads the value from piped stdin and never prints it', async () => {
    const putSecret = vi.fn(async (ref: string) => ({ ref, exists: true }));
    const h = harness({ client: { putSecret }, stdin: `${SECRET}\n`, stdinIsTTY: false });
    const r = await h.run('secret', 'set', 'conductor/anthropic-api-key');
    expect(r.code).toBe(0);
    expect(putSecret).toHaveBeenCalledWith('conductor/anthropic-api-key', SECRET);
    expect(r.stdout).toContain('stored conductor/anthropic-api-key');
    expect(h.prompts).toEqual([]);
    noLeak(r);

    const j = await h.run('--json', 'secret', 'set', 'org/acme/stripe');
    expect(j.json()).toEqual({ ref: 'org/acme/stripe', exists: true });
    noLeak(j);
  });

  it('uses a hidden prompt on a terminal', async () => {
    const putSecret = vi.fn(async (ref: string) => ({ ref, exists: true }));
    const h = harness({ client: { putSecret }, stdinIsTTY: true, answers: [SECRET] });
    const r = await h.run('secret', 'set', 'conductor/openai-api-key');
    expect(h.prompts).toEqual([{ question: 'Value for conductor/openai-api-key (input hidden): ', hidden: true }]);
    expect(putSecret).toHaveBeenCalledWith('conductor/openai-api-key', SECRET);
    noLeak(r);
  });

  it('accepts --value with a shell-history warning, still without echoing it', async () => {
    const putSecret = vi.fn(async (ref: string) => ({ ref, exists: true }));
    const h = harness({ client: { putSecret } });
    const r = await h.run('secret', 'set', 'conductor/x', '--value', SECRET);
    expect(r.code).toBe(0);
    expect(putSecret).toHaveBeenCalledWith('conductor/x', SECRET);
    expect(r.stderr).toContain('shell history');
    noLeak(r);
  });

  it('does not leak the value when the daemon rejects or is down', async () => {
    const h = harness({ client: { putSecret: vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) }, stdin: SECRET });
    const r = await h.run('--json', 'secret', 'set', 'conductor/x');
    expect(r.code).toBe(1);
    noLeak(r);
  });

  it('rejects an empty value', async () => {
    const h = harness({ client: { putSecret: vi.fn() }, stdin: '\n' });
    const r = await h.run('secret', 'set', 'conductor/x');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('empty');
    expect(h.client.putSecret).not.toHaveBeenCalled();
  });

  it('checks and deletes secrets', async () => {
    const h = harness({
      client: {
        secretExists: vi.fn(async (ref: string) => ({ ref, exists: ref.endsWith('yes') })),
        deleteSecret: vi.fn(async (ref: string) => ({ ref, exists: false })),
      },
    });
    const yes = await h.run('secret', 'has', 'conductor/yes');
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain('conductor/yes is set');
    const no = await h.run('secret', 'has', 'conductor/no');
    expect(no.code).toBe(1);
    expect(no.stdout).toContain('conductor/no is not set');
    expect(no.stderr).toBe('');
    expect((await h.run('--json', 'secret', 'has', 'conductor/no')).json()).toEqual({ ref: 'conductor/no', exists: false });
    expect((await h.run('secret', 'delete', 'conductor/yes')).stdout).toContain('deleted conductor/yes');
  });
});

describe('adapter', () => {
  it('lists adapters and tests one', async () => {
    const caps = { tools: true, mcp: true, resume: true, vision: false, browser: 'via_mcp' as const };
    const testAdapter = vi.fn(async (id: string) => (id === 'claude_local' ? { ok: true, version: '2.1.0', detail: 'CLI present' } : { ok: false, detail: 'auth: invalid x-api-key' }));
    const h = harness({ client: { listAdapters: vi.fn(async () => [{ id: 'claude_local', name: 'Claude Code (local)', capabilities: caps, configSchema: {}, builtin: true }]), testAdapter } });
    expect((await h.run('adapter', 'list')).stdout).toMatch(/claude_local\s+Claude Code \(local\)\s+builtin\s+yes\s+yes\s+yes\s+no\s+via_mcp/);

    const ok = await h.run('adapter', 'test', 'claude_local');
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('✓ claude_local 2.1.0: CLI present');

    const bad = await h.run('adapter', 'test', 'claude_api', '--auth-ref', 'conductor/anthropic-api-key', '--model', 'claude-sonnet-4-5');
    expect(testAdapter).toHaveBeenLastCalledWith('claude_api', { authRef: 'conductor/anthropic-api-key', model: 'claude-sonnet-4-5' });
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('✗ claude_api: auth: invalid x-api-key');
    expect((await h.run('--json', 'adapter', 'test', 'claude_local')).json()).toEqual({ adapter: 'claude_local', ok: true, version: '2.1.0', detail: 'CLI present' });
  });
});
