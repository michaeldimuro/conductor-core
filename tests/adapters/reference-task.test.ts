import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterRegistry, AgentAdapter } from '../../src/contracts/adapter.js';
import { createAdapterRegistry, priceFor } from '../../src/adapters/index.js';
import { AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END } from '../../src/adapters/sdk.js';
import { callTool } from './fixtures/mcp-call.mjs';
import { collect, createSandbox, makeCtx, REFERENCE_ANSWER, REFERENCE_PROMPT, RUN_TOKEN, type Loose, type Sandbox } from './helpers/context.js';
import { startTestGateway, TINY_PNG, type TestGateway } from './helpers/mcp-server.js';
import { ANTHROPIC_TEST_KEY, OPENAI_TEST_KEY, startMockProviders, type MockProviders } from './helpers/mock-providers.js';

let gateway: TestGateway;
let providers: MockProviders;
let registry: AdapterRegistry;
let sandbox: Sandbox;

const adapter = (id: string): AgentAdapter => {
  const a = registry.get(id);
  if (!a) throw new Error(`adapter ${id} missing`);
  return a;
};

beforeAll(async () => {
  gateway = await startTestGateway(RUN_TOKEN);
  providers = await startMockProviders();
});
afterAll(async () => {
  await gateway.close();
  await providers.close();
});
beforeEach(() => {
  sandbox = createSandbox();
  registry = createAdapterRegistry({ pluginDir: join(sandbox.root, 'adapters') });
  providers.reset();
  gateway.calls.length = 0;
});
afterEach(() => sandbox.dispose());

describe('registry', () => {
  it('registers the six built-in adapters with capabilities and config schemas', () => {
    const list = registry.list();
    expect(list.map((a) => a.id).sort()).toEqual(['claude_api', 'claude_local', 'codex_local', 'http', 'openai_api', 'process']);
    for (const a of list) {
      expect(a.builtin).toBe(true);
      expect(a.configSchema.type).toBe('object');
      expect(a.capabilities).toEqual(adapter(a.id).capabilities());
      expect(a.capabilities.mcp).toBe(true);
    }
  });
});

describe('FR-6: the same reference task completes on every adapter with usage and cost recorded', () => {
  it('claude_api: Conductor-owned loop over the Messages API', async () => {
    const c = collect();
    const ctx = makeCtx(gateway, sandbox, { config: { baseURL: providers.anthropicBaseURL, maxRetries: 0 }, secrets: { apiKey: ANTHROPIC_TEST_KEY } });
    const result = await adapter('claude_api').run(ctx, c.onEvent);

    expect(result.outcome).toBe('completed');
    expect(result.finalText).toContain(REFERENCE_ANSWER);
    expect(result.steps).toBe(2);
    expect(gateway.calls).toEqual([{ tool: 'lookup_code', args: { key: 'alpha' } }]);
    expect(c.ofType('tool_call')[0]).toMatchObject({ name: 'lookup_code', input: { key: 'alpha' } });
    expect(c.ofType('tool_result')[0]).toMatchObject({ name: 'lookup_code', output: REFERENCE_ANSWER, isError: false });
    expect(c.ofType('usage')).toHaveLength(2);

    const perTurn = priceFor('claude-opus-5-5', { inputTokens: 1000, outputTokens: 50 });
    expect(perTurn).toBeCloseTo(0.005, 8);
    expect(result.usage).toMatchObject({ tokensIn: 2000, tokensOut: 100, subscription: false, seatSeconds: 0 });
    expect(result.usage.costUsd).toBeCloseTo(perTurn * 2, 8);

    // Wire format: default model, cached system prompt, sanitized tools, tool result sent back in one user message.
    const [first, second] = providers.anthropic.requests as Array<Record<string, Loose>>;
    expect(first?.model).toBe('claude-opus-5-5');
    expect(first?.system[0]).toMatchObject({ type: 'text', text: ctx.systemPrompt, cache_control: { type: 'ephemeral' } });
    expect(first?.tools.map((t: { name: string }) => t.name)).toEqual(['lookup_code', 'screenshot']);
    expect(first?.messages).toEqual([{ role: 'user', content: REFERENCE_PROMPT }]);
    expect(second?.messages).toHaveLength(3);
    expect(second?.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_mock_1' });
  });

  it('openai_api: Conductor-owned loop over the Responses API', async () => {
    const c = collect();
    const ctx = makeCtx(gateway, sandbox, { model: 'gpt-5.2', config: { baseURL: providers.openaiBaseURL, maxRetries: 0 }, secrets: { apiKey: OPENAI_TEST_KEY } });
    providers.openai.usage = { input: 1000, output: 50, cacheRead: 400 };
    const result = await adapter('openai_api').run(ctx, c.onEvent);

    expect(result.outcome).toBe('completed');
    expect(result.finalText).toContain(REFERENCE_ANSWER);
    expect(result.steps).toBe(2);
    expect(gateway.calls).toHaveLength(1);
    expect(c.ofType('tool_result')[0]).toMatchObject({ name: 'lookup_code', output: REFERENCE_ANSWER });
    const perTurn = priceFor('gpt-5.2', { inputTokens: 600, outputTokens: 50, cacheReadTokens: 400 });
    expect(perTurn).toBeGreaterThan(0);
    expect(result.usage.costUsd).toBeCloseTo(perTurn * 2, 8);
    expect(result.usage).toMatchObject({ tokensIn: 2000, tokensOut: 100, subscription: false });
    expect(c.ofType('usage')[0]).toMatchObject({ tokensIn: 1000, cacheReadTokens: 400 });

    const [first, second] = providers.openai.requests as Array<Record<string, Loose>>;
    expect(first?.instructions).toBe(ctx.systemPrompt);
    expect(first?.tools[0]).toMatchObject({ type: 'function', name: 'lookup_code' });
    expect(first?.store).toBe(false);
    expect(second?.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call_mock_1', output: REFERENCE_ANSWER });
    expect(second?.input.at(-2)).toMatchObject({ type: 'function_call', call_id: 'call_mock_1' });
  });

  it('claude_local: spawns the CLI with MCP config, skills and safe permissions; subscription run costs $0', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-daemon-env-must-not-leak-000000';
    process.env.CONDUCTOR_DAEMON_INTERNAL = 'daemon-internal-value';
    const c = collect();
    const ctx = makeCtx(gateway, sandbox, {
      model: 'claude-sonnet-5-5',
      skills: [sandbox.skill('triage', 'Always label the issue first.')],
      config: { command: sandbox.bin('fake-claude.mjs'), env: { FAKE_RECORD: sandbox.recordFile } },
    });
    let result;
    try {
      result = await adapter('claude_local').run(ctx, c.onEvent);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CONDUCTOR_DAEMON_INTERNAL;
    }

    expect(result.outcome).toBe('completed');
    expect(result.finalText).toBe(`The code is ${REFERENCE_ANSWER}`);
    expect(result.sessionId).toBe('sess-claude-fake-1');
    expect(result.steps).toBe(2);
    expect(gateway.calls).toHaveLength(1);
    // Subscription login: flagged, $0 marginal, seat time counted, CLI cost kept for information only.
    expect(result.usage.subscription).toBe(true);
    expect(result.usage.costUsd).toBe(0);
    expect(result.usage.seatSeconds).toBeGreaterThan(0);
    expect(result.usage).toMatchObject({ tokensIn: 1600, tokensOut: 80 });
    expect(c.ofType('status').some((s) => s.status.includes('0.0421'))).toBe(true);
    expect(c.ofType('session')[0]?.sessionId).toBe('sess-claude-fake-1');
    expect(c.ofType('tool_call')[0]).toMatchObject({ id: 'toolu_1', name: 'mcp__conductor__lookup_code' });
    expect(c.ofType('tool_result')[0]).toMatchObject({ id: 'toolu_1', name: 'mcp__conductor__lookup_code', output: REFERENCE_ANSWER, isError: false });

    const rec = sandbox.readRecord<{ argv: string[]; prompt: string; cwd: string; envKeys: string[]; anthropicApiKey: string | null; mcpConfigPath: string; mcpConfigMode: number; mcp: Loose; skills: string[] }>();
    const arg = (name: string): string | undefined => rec.argv[rec.argv.indexOf(name) + 1];
    expect(rec.prompt).toBe(REFERENCE_PROMPT);
    expect(rec.cwd.endsWith('workspace')).toBe(true);
    expect(arg('--output-format')).toBe('stream-json');
    expect(arg('--append-system-prompt')).toBe(ctx.systemPrompt);
    expect(arg('--model')).toBe('claude-sonnet-5-5');
    expect(arg('--max-turns')).toBe('20');
    expect(arg('--permission-mode')).toBe('acceptEdits');
    expect(arg('--allowedTools')?.split(',')).toEqual(expect.arrayContaining(['mcp__conductor', 'Read', 'Edit']));
    expect(arg('--allowedTools')).not.toContain('Bash');
    expect(rec.argv).toContain('--strict-mcp-config');
    expect(rec.argv).not.toContain('--dangerously-skip-permissions');
    expect(rec.argv).not.toContain('--resume');
    expect(rec.argv.join(' ')).not.toContain(RUN_TOKEN);
    expect(rec.mcp.mcpServers.conductor).toEqual({ type: 'http', url: gateway.url, headers: { Authorization: `Bearer ${RUN_TOKEN}` } });
    expect(rec.skills).toEqual(['triage']);
    // Minimal env: nothing from the daemon beyond the allowlist.
    expect(rec.anthropicApiKey).toBeNull();
    expect(rec.envKeys).not.toContain('CONDUCTOR_DAEMON_INTERNAL');
    expect(rec.envKeys).toEqual(expect.arrayContaining(['PATH', 'HOME']));
    // The temp MCP config held the run token: private while in use, gone afterwards.
    expect(rec.mcpConfigMode).toBe(0o600);
    expect(existsSync(rec.mcpConfigPath)).toBe(false);
    expect(c.json()).not.toContain(RUN_TOKEN);
  });

  it('claude_local: with an API key the run is metered and resumes the given session', async () => {
    const c = collect();
    const ctx = makeCtx(gateway, sandbox, {
      secrets: { apiKey: ANTHROPIC_TEST_KEY },
      resumeSessionId: 'sess-previous-9',
      budgetCapUsd: 5,
      config: { command: sandbox.bin('fake-claude.mjs'), env: { FAKE_RECORD: sandbox.recordFile }, dangerouslySkipPermissions: true },
    });
    const result = await adapter('claude_local').run(ctx, c.onEvent);
    expect(result.outcome).toBe('completed');
    expect(result.sessionId).toBe('sess-previous-9');
    expect(result.usage).toMatchObject({ subscription: false, costUsd: 0.0421, seatSeconds: 0 });
    const rec = sandbox.readRecord<{ argv: string[]; anthropicApiKey: string | null }>();
    expect(rec.anthropicApiKey).toBe(ANTHROPIC_TEST_KEY);
    expect(rec.argv[rec.argv.indexOf('--resume') + 1]).toBe('sess-previous-9');
    expect(rec.argv[rec.argv.indexOf('--max-budget-usd') + 1]).toBe('5');
    // Only present because the binding asked for it explicitly.
    expect(rec.argv).toContain('--dangerously-skip-permissions');
    expect(c.json()).not.toContain(ANTHROPIC_TEST_KEY);
  });

  it('codex_local: injects MCP through -c overrides and skills through a managed AGENTS.md block', async () => {
    const agentsFile = join(sandbox.workspace, 'AGENTS.md');
    writeFileSync(agentsFile, '# House rules\n\nNever force-push.\n');
    const c = collect();
    const base = { config: { command: sandbox.bin('fake-codex.mjs'), env: { FAKE_RECORD: sandbox.recordFile } } };
    const ctx = makeCtx(gateway, sandbox, { ...base, skills: [sandbox.skill('triage', 'Always label the issue first.')] });
    const result = await adapter('codex_local').run(ctx, c.onEvent);

    expect(result.outcome).toBe('completed');
    expect(result.finalText).toBe(`The code is ${REFERENCE_ANSWER}`);
    expect(result.sessionId).toBe('019a0000-fake-7000-8000-codexthread01');
    expect(gateway.calls).toHaveLength(1);
    expect(result.usage).toMatchObject({ tokensIn: 2000, tokensOut: 150, costUsd: 0, subscription: true });
    expect(result.usage.seatSeconds).toBeGreaterThan(0);
    expect(c.ofType('usage')[0]).toMatchObject({ tokensIn: 2000, tokensOut: 150, costUsd: 0, cacheReadTokens: 500 });
    expect(c.ofType('tool_call')[0]).toMatchObject({ id: 'item_0', name: 'lookup_code', input: { key: 'alpha' } });
    expect(c.ofType('tool_result')[0]).toMatchObject({ id: 'item_0', output: REFERENCE_ANSWER, isError: false });

    const rec = sandbox.readRecord<{ argv: string[]; overrides: Record<string, string>; prompt: string; envKeys: string[]; codexApiKey: string | null; agentsMd: string }>();
    expect(rec.argv.slice(0, 2)).toEqual(['exec', '--json']);
    expect(rec.overrides['mcp_servers.conductor.url']).toBe(JSON.stringify(gateway.url));
    expect(rec.overrides['mcp_servers.conductor.bearer_token_env_var']).toBe('"CONDUCTOR_MCP_BEARER_0"');
    expect(rec.overrides.sandbox_mode).toBe('"workspace-write"');
    expect(rec.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    // The token travels in the environment, never in argv.
    expect(rec.argv.join(' ')).not.toContain(RUN_TOKEN);
    expect(rec.codexApiKey).toBeNull();
    expect(rec.prompt).toContain(ctx.systemPrompt);
    expect(rec.prompt).toContain(REFERENCE_PROMPT);
    expect(rec.agentsMd.startsWith('# House rules\n\nNever force-push.\n')).toBe(true);
    expect(rec.agentsMd).toContain('### Skill: triage');
    expect(rec.agentsMd).toContain('Always label the issue first.');
    expect(rec.agentsMd).not.toContain('name: triage'); // frontmatter stripped

    // Next run: block replaced (not duplicated), user content untouched, session resumed.
    const again = await adapter('codex_local').run(
      makeCtx(gateway, sandbox, { ...base, skills: [sandbox.skill('deploy', 'Run the smoke test.')], resumeSessionId: result.sessionId }),
      collect().onEvent,
    );
    expect(again.outcome).toBe('completed');
    const md = readFileSync(agentsFile, 'utf8');
    expect(md.split(AGENTS_BLOCK_BEGIN)).toHaveLength(2);
    expect(md.split(AGENTS_BLOCK_END)).toHaveLength(2);
    expect(md).toContain('Never force-push.');
    expect(md).toContain('### Skill: deploy');
    expect(md).not.toContain('### Skill: triage');
    const rec2 = sandbox.readRecord<{ argv: string[]; resumed: string; prompt: string }>();
    expect(rec2.argv.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(rec2.resumed).toBe(result.sessionId);
    expect(rec2.prompt).toBe(REFERENCE_PROMPT);
    expect(c.json()).not.toContain(RUN_TOKEN);
  });

  it('process: prompt on stdin, CONDUCTOR_* env, JSON-lines RunEvents on stdout', async () => {
    const c = collect();
    const ctx = makeCtx(gateway, sandbox, {
      config: { command: sandbox.bin('fake-agent.mjs'), args: ['--flag'], output: 'jsonl', env: { FAKE_RECORD: sandbox.recordFile, FAKE_MODE: 'jsonl' } },
    });
    const result = await adapter('process').run(ctx, c.onEvent);
    expect(result.outcome).toBe('completed');
    expect(result.finalText).toBe(`The code is ${REFERENCE_ANSWER}`);
    expect(result.steps).toBe(1);
    expect(result.usage).toMatchObject({ tokensIn: 321, tokensOut: 45, costUsd: 0.0007, subscription: false });
    expect(gateway.calls).toHaveLength(1);
    expect(c.ofType('tool_call')).toHaveLength(1);
    expect(c.ofType('status').some((s) => s.status.startsWith('ignored non-event output line'))).toBe(true);

    const rec = sandbox.readRecord<{ argv: string[]; prompt: string; conductor: Record<string, string> }>();
    expect(rec.argv).toEqual(['--flag']);
    expect(rec.prompt).toBe(REFERENCE_PROMPT);
    expect(rec.conductor).toMatchObject({
      CONDUCTOR_API_URL: ctx.apiBaseUrl,
      CONDUCTOR_RUN_TOKEN: RUN_TOKEN,
      CONDUCTOR_RUN_ID: ctx.runId,
      CONDUCTOR_ISSUE_ID: 'iss_test',
      CONDUCTOR_MCP_URL: gateway.url,
    });
  });

  it('process: plain-text stdout is the final answer; a non-zero exit fails the run', async () => {
    const bin = sandbox.bin('fake-agent.mjs');
    const ok = await adapter('process').run(makeCtx(gateway, sandbox, { config: { command: bin, env: { FAKE_MODE: 'text' } } }), collect().onEvent);
    expect(ok).toMatchObject({ outcome: 'completed', finalText: `The code is ${REFERENCE_ANSWER}`, steps: 1 });

    const c = collect();
    const bad = await adapter('process').run(makeCtx(gateway, sandbox, { config: { command: bin, env: { FAKE_MODE: 'fail' } } }), c.onEvent);
    expect(bad.outcome).toBe('failed');
    expect(bad.error?.kind).toBe('other');
    expect(bad.error?.message).toContain('exited with code 3');
    expect(bad.error?.message).toContain('boom');
    expect(c.ofType('error')).toHaveLength(1);

    const missing = await adapter('process').run(makeCtx(gateway, sandbox, { config: {} }), collect().onEvent);
    expect(missing).toMatchObject({ outcome: 'failed', error: { kind: 'invalid_request' } });
  });

  describe('http', () => {
    let agent: Server;
    let agentUrl: string;
    const seen: Array<{ method: string; path: string; auth: string | undefined; body: Loose }> = [];
    let polls = 0;

    beforeAll(async () => {
      agent = createServer((req, res) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => {
          const body = data ? JSON.parse(data) : null;
          seen.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, body });
          const send = (status: number, payload: unknown): void => {
            res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
          };
          const solve = async (ctx: Loose): Promise<Record<string, unknown>> => {
            const code = await callTool(ctx.mcpUrl, { Authorization: `Bearer ${ctx.runToken}` }, 'lookup_code', { key: 'alpha' });
            return {
              finalText: `The code is ${code}`,
              usage: { tokensIn: 210, tokensOut: 30, costUsd: 0.002 },
              events: [
                { type: 'tool_call', id: 'h1', name: 'lookup_code', input: { key: 'alpha' } },
                { type: 'tool_result', id: 'h1', name: 'lookup_code', output: code, isError: false },
                { type: 'bogus', nope: true },
              ],
            };
          };
          if (req.method === 'POST' && req.url === '/sync') void solve(body).then((r) => send(200, r));
          else if (req.method === 'POST' && req.url === '/async') {
            polls = 0;
            void solve(body).then((r) => {
              asyncResult = r;
              send(202, { pollUrl: '/poll/job-1' });
            });
          } else if (req.method === 'GET' && req.url === '/poll/job-1') {
            polls++;
            if (polls < 3) send(202, { status: 'running' });
            else send(200, asyncResult);
          } else if (req.url === '/evil') send(202, { pollUrl: 'http://127.0.0.1:1/steal' });
          else if (req.url === '/limited') send(429, { error: 'slow down' });
          else send(404, {});
        });
      });
      let asyncResult: Record<string, unknown> = {};
      await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
      agentUrl = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => agent.close(() => resolve())));
    beforeEach(() => {
      seen.length = 0;
    });

    it('posts the run without secrets and accepts a synchronous result', async () => {
      const c = collect();
      const ctx = makeCtx(gateway, sandbox, { config: { url: `${agentUrl}/sync` }, secrets: { apiKey: 'webhook-secret-key-123456' } });
      const result = await adapter('http').run(ctx, c.onEvent);
      expect(result.outcome).toBe('completed');
      expect(result.finalText).toBe(`The code is ${REFERENCE_ANSWER}`);
      expect(result.usage).toMatchObject({ tokensIn: 210, tokensOut: 30, costUsd: 0.002 });
      expect(result.steps).toBe(1);
      expect(gateway.calls).toHaveLength(1);
      expect(c.ofType('tool_call')).toHaveLength(1);
      expect(c.ofType('usage')).toHaveLength(1);

      const post = seen[0];
      expect(post?.auth).toBe('Bearer webhook-secret-key-123456');
      expect(post?.body).not.toHaveProperty('secrets');
      expect(JSON.stringify(post?.body)).not.toContain('webhook-secret-key-123456');
      expect(post?.body).toMatchObject({ runId: ctx.runId, prompt: REFERENCE_PROMPT, runToken: RUN_TOKEN, apiBaseUrl: ctx.apiBaseUrl, mcpUrl: gateway.url });
      expect(c.json()).not.toContain('webhook-secret-key-123456');
    });

    it('polls a 202 { pollUrl } until the run is done', async () => {
      const ctx = makeCtx(gateway, sandbox, { config: { url: `${agentUrl}/async`, pollIntervalMs: 50 } });
      const result = await adapter('http').run(ctx, collect().onEvent);
      expect(result).toMatchObject({ outcome: 'completed', finalText: `The code is ${REFERENCE_ANSWER}` });
      expect(seen.filter((s) => s.method === 'GET' && s.path === '/poll/job-1')).toHaveLength(3);
    });

    it('refuses to follow a pollUrl on another origin and classifies HTTP failures', async () => {
      const evil = await adapter('http').run(makeCtx(gateway, sandbox, { config: { url: `${agentUrl}/evil`, pollIntervalMs: 50 } }), collect().onEvent);
      expect(evil.outcome).toBe('failed');
      expect(evil.error?.message).toContain('different origin');
      const limited = await adapter('http').run(makeCtx(gateway, sandbox, { config: { url: `${agentUrl}/limited` } }), collect().onEvent);
      expect(limited).toMatchObject({ outcome: 'failed', error: { kind: 'rate_limit' } });
      const down = await adapter('http').run(makeCtx(gateway, sandbox, { config: { url: 'http://127.0.0.1:1/nothing' } }), collect().onEvent);
      expect(down).toMatchObject({ outcome: 'failed', error: { kind: 'outage' } });
    });

    it('testConnection reports reachability', async () => {
      expect((await adapter('http').testConnection({ config: { url: `${agentUrl}/sync` }, secrets: {} })).ok).toBe(true);
      expect((await adapter('http').testConnection({ config: { url: 'http://127.0.0.1:1/x' }, secrets: {} })).ok).toBe(false);
      expect((await adapter('http').testConnection({ config: { url: 'file:///etc/passwd' }, secrets: {} })).ok).toBe(false);
    });
  });
});

describe('vision, resume and secret hygiene', () => {
  it('claude_api passes MCP image content through as vision input and resumes from priorMessages', async () => {
    providers.anthropic.tool = { name: 'screenshot', args: {} };
    const c = collect();
    const ctx = makeCtx(gateway, sandbox, {
      secrets: { apiKey: ANTHROPIC_TEST_KEY },
      config: {
        baseURL: providers.anthropicBaseURL,
        maxRetries: 0,
        priorMessages: [
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: 'Earlier answer' },
        ],
      },
    });
    const result = await adapter('claude_api').run(ctx, c.onEvent);
    expect(result.outcome).toBe('completed');
    const [first, second] = providers.anthropic.requests as Array<Record<string, Loose>>;
    expect(first?.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user']);
    const toolResult = second?.messages.at(-1).content[0];
    expect(toolResult.content).toEqual([
      { type: 'text', text: 'page captured' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
    ]);
    expect(c.ofType('tool_result')[0]?.output).toMatch(/page captured\n\[image image\/png, \d+ bytes\]/);
  });

  it('openai_api passes MCP image content through as input_image', async () => {
    providers.openai.tool = { name: 'screenshot', args: {} };
    const ctx = makeCtx(gateway, sandbox, { model: 'gpt-5.2', secrets: { apiKey: OPENAI_TEST_KEY }, config: { baseURL: providers.openaiBaseURL, maxRetries: 0 } });
    const result = await adapter('openai_api').run(ctx, collect().onEvent);
    expect(result.outcome).toBe('completed');
    const output = (providers.openai.requests[1] as Record<string, Loose>).input.at(-1).output;
    expect(output[1]).toMatchObject({ type: 'input_image', image_url: `data:image/png;base64,${TINY_PNG}` });
  });

  it('never lets a secret reach emitted events, the final text or error messages', async () => {
    const c = collect();
    const ctx = makeCtx(gateway, sandbox, { config: { command: sandbox.bin('fake-agent.mjs'), output: 'jsonl', env: { FAKE_MODE: 'leak' } } });
    const result = await adapter('process').run(ctx, c.onEvent);
    expect(result.outcome).toBe('completed');
    expect(result.finalText).toBe('my token is [REDACTED]');
    expect(c.ofType('text')[0]?.text).toBe('my token is [REDACTED]');
    expect(c.json()).not.toContain(RUN_TOKEN);
  });

  it('testConnection: CLI version, authenticated API call, command presence', async () => {
    const claude = await adapter('claude_local').testConnection({ config: { command: sandbox.bin('fake-claude.mjs') }, secrets: {} });
    expect(claude).toMatchObject({ ok: true, version: '2.1.999 (Claude Code)' });
    const codex = await adapter('codex_local').testConnection({ config: { command: sandbox.bin('fake-codex.mjs') }, secrets: {} });
    expect(codex).toMatchObject({ ok: true, version: 'codex-cli 0.999.0' });
    expect((await adapter('codex_local').testConnection({ config: { command: join(sandbox.root, 'no-such-binary') }, secrets: {} })).ok).toBe(false);

    const api = adapter('claude_api');
    expect((await api.testConnection({ config: { baseURL: providers.anthropicBaseURL }, secrets: { apiKey: ANTHROPIC_TEST_KEY } })).ok).toBe(true);
    const badKey = await api.testConnection({ config: { baseURL: providers.anthropicBaseURL }, secrets: { apiKey: 'sk-ant-wrong-key-000000000000' } });
    expect(badKey.ok).toBe(false);
    expect(badKey.detail).toContain('auth');
    expect((await adapter('openai_api').testConnection({ config: { baseURL: providers.openaiBaseURL }, secrets: { apiKey: OPENAI_TEST_KEY }, model: 'gpt-5.2' })).ok).toBe(true);

    expect((await adapter('process').testConnection({ config: { command: sandbox.bin('fake-agent.mjs') }, secrets: {} })).ok).toBe(true);
    expect((await adapter('process').testConnection({ config: { command: 'definitely-not-a-real-command-xyz' }, secrets: {} })).ok).toBe(false);
  });
});
