import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterRegistry, AgentAdapter, RunEvent } from '../../src/contracts/adapter.js';
import { createAdapterRegistry } from '../../src/adapters/index.js';
import { buildCodexPrompt, CODEX_SKILL_MARKER, skillsUsedIn } from '../../src/adapters/builtin/codex-local.js';
import { buildResumeHistory, conductorSessionId } from '../../src/adapters/builtin/resume-history.js';
import { collect, createSandbox, makeCtx, REFERENCE_ANSWER, REFERENCE_PROMPT, RUN_TOKEN, type Loose, type Sandbox } from './helpers/context.js';
import { startTestGateway, type TestGateway } from './helpers/mcp-server.js';
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

/** The journal of a run that looked the code up and was then interrupted (as the tool loop emits it). */
const INTERRUPTED_RUN: RunEvent[] = [
  { type: 'session', sessionId: 'conductor-run:run_prev' },
  { type: 'thinking', text: 'I should look the code up.' },
  { type: 'text', text: 'Let me check.' },
  { type: 'usage', tokensIn: 1000, tokensOut: 50, costUsd: 0.01 },
  { type: 'tool_call', id: 'toolu_prev_1', name: 'lookup_code', input: { key: 'alpha' } },
  { type: 'tool_result', id: 'toolu_prev_1', name: 'lookup_code', output: REFERENCE_ANSWER, isError: false },
];

describe('resume history from the run journal', () => {
  it('groups events into turns, closes an unanswered tool call, and keeps the newest turns under the size cap', () => {
    const events: RunEvent[] = [
      ...INTERRUPTED_RUN,
      { type: 'usage', tokensIn: 10, tokensOut: 5, costUsd: 0 }, // a turn with tool calls only
      { type: 'tool_call', id: 'c2', name: 'files.read', input: { path: 'a.txt' } },
      { type: 'tool_result', id: 'c2', name: 'files.read', output: '', isError: false },
      { type: 'tool_call', id: 'c3', name: 'deploy', input: 'not-an-object' },
    ];
    const h = buildResumeHistory(events);
    expect(h.dropped).toBe(0);
    expect(h.turns).toHaveLength(2);
    expect(h.turns[0]).toEqual({ text: 'Let me check.', calls: [{ id: 'toolu_prev_1', name: 'lookup_code', input: { key: 'alpha' }, output: REFERENCE_ANSWER, isError: false }] });
    expect(h.turns[1]!.calls).toMatchObject([
      { id: 'c2', name: 'files_read', output: '(no output)', isError: false }, // provider-safe name
      { id: 'c3', name: 'deploy', input: {}, isError: true },
    ]);
    expect(h.turns[1]!.calls[1]!.output).toContain('interrupted before this tool returned');

    const capped = buildResumeHistory(events, [], 60);
    expect(capped).toMatchObject({ dropped: 1 });
    expect(capped.turns).toHaveLength(1);
    expect(buildResumeHistory([])).toEqual({ turns: [], dropped: 0 });
  });
});

describe('API adapters resume from the journaled transcript', () => {
  it('claude_api: rebuilds the messages, does not redo finished tool calls, reports a Conductor session id', async () => {
    const c = collect();
    const ctx = makeCtx(gateway, sandbox, {
      config: { baseURL: providers.anthropicBaseURL, maxRetries: 0 }, secrets: { apiKey: ANTHROPIC_TEST_KEY },
      resumeSessionId: 'conductor-run:run_prev', priorEvents: INTERRUPTED_RUN,
    });
    const result = await adapter('claude_api').run(ctx, c.onEvent);

    expect(result).toMatchObject({ outcome: 'completed', finalText: `The code is ${REFERENCE_ANSWER}`, steps: 1 });
    // The lookup already happened in the interrupted run: it is not executed again.
    expect(gateway.calls).toHaveLength(0);
    expect(providers.anthropic.requests).toHaveLength(1);
    const messages = providers.anthropic.requests[0]!.messages as Loose[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0].content).toContain('resuming a run that was interrupted');
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'toolu_prev_1', name: expect.stringContaining('lookup_code'), input: { key: 'alpha' } },
    ]);
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_prev_1', content: REFERENCE_ANSWER },
      { type: 'text', text: REFERENCE_PROMPT },
    ]);
    expect(JSON.stringify(messages)).not.toContain('I should look the code up'); // thinking is not replayed
    expect(c.ofType('session')[0]?.sessionId).toBe(conductorSessionId(ctx.runId));
    expect(adapter('claude_api').capabilities().resume).toBe(true);
  });

  it('claude_api: a fresh run is unchanged, and a resume without a transcript says so and starts over', async () => {
    const fresh = collect();
    const base = { config: { baseURL: providers.anthropicBaseURL, maxRetries: 0 }, secrets: { apiKey: ANTHROPIC_TEST_KEY } };
    await adapter('claude_api').run(makeCtx(gateway, sandbox, base), fresh.onEvent);
    expect((providers.anthropic.requests[0]!.messages as Loose[])).toEqual([{ role: 'user', content: REFERENCE_PROMPT }]);
    expect(fresh.ofType('status').map((s) => s.status).join()).not.toContain('resume requested');

    providers.reset();
    const c = collect();
    const result = await adapter('claude_api').run(makeCtx(gateway, sandbox, { ...base, resumeSessionId: 'conductor-run:run_gone' }), c.onEvent);
    expect(result.outcome).toBe('completed');
    expect(c.ofType('status').map((s) => s.status)).toContain('resume requested but no prior transcript was supplied; starting from the task prompt');
    expect((providers.anthropic.requests[0]!.messages as Loose[])).toEqual([{ role: 'user', content: REFERENCE_PROMPT }]);
  });

  it('openai_api: rebuilds the Responses input with function_call / function_call_output pairs', async () => {
    const c = collect();
    const ctx = makeCtx(gateway, sandbox, {
      config: { baseURL: providers.openaiBaseURL, maxRetries: 0 }, secrets: { apiKey: OPENAI_TEST_KEY },
      resumeSessionId: 'conductor-run:run_prev',
      priorEvents: [...INTERRUPTED_RUN, { type: 'usage', tokensIn: 1, tokensOut: 1, costUsd: 0 }, { type: 'tool_call', id: 'call_cut', name: 'lookup_code', input: { key: 'beta' } }],
    });
    const result = await adapter('openai_api').run(ctx, c.onEvent);

    expect(result.outcome).toBe('completed');
    const input = providers.openai.requests[0]!.input as Loose[];
    expect(input[0]).toMatchObject({ role: 'user', content: expect.stringContaining('resuming a run that was interrupted') });
    expect(input[1]).toEqual({ role: 'assistant', content: 'Let me check.' });
    expect(input[2]).toMatchObject({ type: 'function_call', call_id: 'toolu_prev_1', arguments: '{"key":"alpha"}' });
    expect(input[2].id).toBeUndefined();
    expect(input[3]).toEqual({ type: 'function_call_output', call_id: 'toolu_prev_1', output: REFERENCE_ANSWER });
    // The call that was cut off by the crash is answered with an explicit "interrupted" error.
    expect(input[5]).toMatchObject({ type: 'function_call_output', call_id: 'call_cut', output: expect.stringContaining('ERROR: No result was recorded') });
    expect(input.at(-1)).toEqual({ role: 'user', content: REFERENCE_PROMPT });
    expect(c.ofType('session')[0]?.sessionId).toBe(conductorSessionId(ctx.runId));
    expect(adapter('openai_api').capabilities().resume).toBe(true);
  });
});

describe('codex_local records which skills a run used', () => {
  /** A minimal `codex exec --json` stand-in that follows a skill the way the prompt asks it to announce. */
  const fakeCodex = (lines: Array<Record<string, unknown>>): string => {
    const script = join(sandbox.root, 'codex-skill.mjs');
    writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => { for (const l of ${JSON.stringify(lines)}) console.log(JSON.stringify(l)); });\n`);
    const bin = join(sandbox.root, 'codex-skill');
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(bin, 0o755);
    return bin;
  };

  it('turns a skill announcement (or a touch of the skill folder) into the Skill tool call usage attribution reads', async () => {
    const triage = sandbox.skill('triage', 'Always label the issue first.');
    const deploy = { ...sandbox.skill('deploy', 'Run scripts/smoke.sh.'), hasScripts: true };
    const unused = sandbox.skill('billing', 'Never used here.');
    const command = fakeCodex([
      { type: 'thread.started', thread_id: 'thread-skill-1' },
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `${CODEX_SKILL_MARKER} triage\nLabelling the issue first.` } },
      { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: `bash ${deploy.path}/scripts/smoke.sh`, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: `bash ${deploy.path}/scripts/smoke.sh`, aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Using skill: triage again. Done.' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    ]);
    const c = collect();
    const ctx = makeCtx(gateway, sandbox, { config: { command }, skills: [triage, deploy, unused] });
    const result = await adapter('codex_local').run(ctx, c.onEvent);

    expect(result).toMatchObject({ outcome: 'completed', steps: 1 }); // attribution events are not steps
    const skillCalls = c.ofType('tool_call').filter((e) => e.name === 'Skill');
    // Each used skill once — in exactly the shape the runtime matches (`/skill/i` tool name, `input.skill` = name).
    expect(skillCalls).toEqual([
      { type: 'tool_call', id: 'skill_triage', name: 'Skill', input: { skill: 'triage' } },
      { type: 'tool_call', id: 'skill_deploy', name: 'Skill', input: { skill: 'deploy' } },
    ]);
    expect(c.ofType('tool_result').filter((e) => e.name === 'Skill')).toHaveLength(2);
  });

  it('asks Codex to announce skills on a fresh session only when the run has skills', () => {
    const skills = [sandbox.skill('triage', 'x')];
    expect(buildCodexPrompt({ systemPrompt: 'sys', prompt: 'task', skills })).toContain('`Using skill: <skill name>`');
    expect(buildCodexPrompt({ systemPrompt: 'sys', prompt: 'task', skills: [] })).toBe('# Operating instructions\n\nsys\n\n# Task\n\ntask');
    expect(buildCodexPrompt({ systemPrompt: 'sys', prompt: 'task', skills, resumeSessionId: 't1' })).toBe('task');
    expect(skillsUsedIn('using skill: `Triage`', skills)).toEqual(['triage']);
    expect(skillsUsedIn('I considered the triage skill', skills)).toEqual([]);
    expect(skillsUsedIn(`cat ${skills[0]!.path}/SKILL.md`, skills)).toEqual([]); // no scripts: a path mention is not use
  });
});
