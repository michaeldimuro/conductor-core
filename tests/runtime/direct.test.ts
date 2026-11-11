import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHarness, type Harness } from './harness.js';
import { McpToolset } from '../../src/adapters/shared/mcp-tools.js';
import { hashSkillFolder } from '../../src/runtime/snapshot.js';
import type { ResolvedSkillRef } from '../../src/contracts/adapter.js';
import type { RuntimeOptions } from '../../src/runtime/types.js';
import { OWNER } from '../../src/contracts/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('chat and eval runs are admitted, not unlimited', () => {
  let h: Harness;
  const boot = async (runtime: RuntimeOptions = {}) => {
    h = await createHarness({ runtime });
    return h;
  };
  afterEach(() => h.dispose());

  it('counts chat turns against the org limit (plus one slot of headroom) and makes the rest wait', async () => {
    await boot({ chatWaitMs: 60 });
    h.org.updateOrg(h.acme.id, { maxConcurrentRuns: 1 }, OWNER);
    const third = h.org.hireAgent(h.acme.id, { deptId: h.dept.id, name: 'Cy', role: 'Engineer', reportsTo: h.lead.id }, OWNER).agent!;
    let live = 0;
    let peak = 0;
    h.script = async () => {
      peak = Math.max(peak, ++live);
      await sleep(150);
      live--;
      return { finalText: 'hi' };
    };
    const results = await Promise.allSettled([
      h.runtime.chat(h.acme.id, h.ada.id, 'one'),
      h.runtime.chat(h.acme.id, h.lead.id, 'two'),
      h.runtime.chat(h.acme.id, third.id, 'three'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(String((results[2] as PromiseRejectedResult).reason)).toMatch(/organization concurrency limit reached/);
    expect(peak).toBe(2); // limit 1 + headroom 1 — never 3
    expect(h.runtime.status().running).toBe(0); // slots released
  });

  it('queues a chat turn for a slot instead of failing when one frees up in time', async () => {
    await boot({ chatWaitMs: 2_000, directHeadroom: 0 });
    h.org.updateOrg(h.acme.id, { maxConcurrentRuns: 1 }, OWNER);
    let peak = 0;
    let live = 0;
    h.script = async () => {
      peak = Math.max(peak, ++live);
      await sleep(80);
      live--;
      return { finalText: 'ok' };
    };
    const replies = await Promise.all([h.runtime.chat(h.acme.id, h.ada.id, 'a'), h.runtime.chat(h.acme.id, h.lead.id, 'b')]);
    expect(replies.map((r) => r.reply)).toEqual(['ok', 'ok']);
    expect(peak).toBe(1);
  });

  it('a chat turn and a loop run share the provider limit', async () => {
    await boot({ providerLimits: { fake: 1 }, directHeadroom: 0, chatWaitMs: 40 });
    h.work.createIssue(h.acme.id, { title: 'Long', assigneeAgentId: h.ada.id }, OWNER);
    let chatError: unknown = null;
    h.script = async (ctx) => {
      if (ctx.agentId !== h.ada.id) return;
      await h.runtime.chat(h.acme.id, h.lead.id, 'are you there?').catch((e) => (chatError = e));
    };
    await h.drain();
    expect(String(chatError)).toMatch(/provider fake concurrency limit reached/);
    expect(h.calls).toHaveLength(1);
  });

  it('applies an hourly allowance to chat turns', async () => {
    await boot({ chatRunsPerHour: 2 });
    h.script = () => ({ finalText: 'ok' });
    await h.runtime.chat(h.acme.id, h.ada.id, '1');
    await h.runtime.chat(h.acme.id, h.ada.id, '2');
    await expect(h.runtime.chat(h.acme.id, h.ada.id, '3')).rejects.toThrow(/max chat runs per hour reached \(2\)/);
    // Chat turns do not eat the heartbeat loop's own allowance.
    h.org.updateAgent(h.acme.id, h.ada.id, { maxRunsPerHour: 1 }, OWNER);
    h.work.createIssue(h.acme.id, { title: 'Real work', assigneeAgentId: h.ada.id }, OWNER);
    await h.drain();
    expect(h.calls.at(-1)!.prompt).toContain('Real work');
  });

  it('applies concurrency and an hourly allowance to skill-eval runs', async () => {
    await boot({ evalRunsPerHour: 3, evalConcurrency: 1, evalWaitMs: 5_000 });
    let live = 0;
    let peak = 0;
    h.script = async () => {
      peak = Math.max(peak, ++live);
      await sleep(40);
      live--;
    };
    const run = (agentId: string, label: string) => h.runtime.run({ orgId: h.acme.id, agentId, prompt: 'replay', skills: [], label });
    await Promise.all([run(h.ada.id, 'a'), run(h.lead.id, 'b'), run(h.ada.id, 'c')]);
    expect(peak).toBe(1); // serialized by evalConcurrency
    await run(h.ada.id, 'd');
    await expect(run(h.ada.id, 'e')).rejects.toThrow(/max eval runs per hour reached \(3\)/);
    expect(h.calls).toHaveLength(4);
  });
});

describe('skill eval sandbox gateway', () => {
  let h: Harness;
  let dir: string;
  let skill: ResolvedSkillRef;
  const boot = async () => {
    h = await createHarness();
    dir = mkdtempSync(join(tmpdir(), 'conductor-evalskill-'));
    const path = join(dir, 'deploy-check');
    mkdirSync(join(path, 'references'), { recursive: true });
    writeFileSync(join(path, 'SKILL.md'), '---\nname: deploy-check\ndescription: Verify a deploy\n---\nRun the smoke suite, then report.\n');
    writeFileSync(join(path, 'references', 'checklist.md'), '- smoke\n- canary\n');
    skill = { id: 'skl_eval_1', name: 'deploy-check', description: 'Verify a deploy', path, scope: 'agent', version: 3, hasScripts: false };
  };
  afterEach(async () => {
    await h.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives eval runs a real, read-only MCP endpoint that serves the skill under test to any adapter', async () => {
    await boot();
    const seen: Record<string, unknown> = {};
    h.script = async (ctx) => {
      seen.endpoints = ctx.mcpEndpoints.length;
      seen.url = ctx.mcpEndpoints[0]!.url;
      // Exactly what the API adapters do.
      const tools = await McpToolset.connect(ctx.mcpEndpoints);
      try {
        seen.tools = tools.tools.map((t) => t.name);
        seen.list = (await tools.call('conductor-skills__list_skills', {})).text;
        const loaded = await tools.call('conductor-skills__load_skill', { name: 'deploy-check' });
        seen.body = loaded.text;
        seen.file = (await tools.call('conductor-skills__read_skill_file', { name: 'deploy-check', path: 'references/checklist.md' })).text;
        seen.escape = await tools.call('conductor-skills__read_skill_file', { name: 'deploy-check', path: '../../etc/passwd' });
        seen.write = await tools.call('conductor-tasks__create_issue', { title: 'nope' });
      } finally {
        await tools.close();
      }
      // The eval run's token does not open the real gateway.
      seen.realGateway = h.runtime.toolContext(ctx.runId);
      return { finalText: 'evaluated' };
    };
    const out = await h.runtime.run({ orgId: h.acme.id, agentId: h.ada.id, prompt: 'Replay the deploy check', skills: [skill], label: 'with-skill' });

    expect(out.finalText).toBe('evaluated');
    expect(seen.endpoints).toBe(1);
    expect(String(seen.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // The skill under test, plus file tools confined to the throwaway eval workspace — nothing with external side effects.
    expect(seen.tools).toEqual(expect.arrayContaining(['conductor-skills__list_skills', 'conductor-skills__load_skill', 'conductor-skills__read_skill_file']));
    expect((seen.tools as string[]).every((t) => t.startsWith('conductor-skills__') || t.startsWith('conductor-files__'))).toBe(true);
    expect(String(seen.list)).toContain('deploy-check');
    expect(String(seen.body)).toContain('Run the smoke suite, then report.');
    expect(String(seen.body)).toContain('references/checklist.md');
    expect(String(seen.file)).toContain('canary');
    expect(seen.escape).toMatchObject({ isError: true });
    expect(seen.write).toMatchObject({ isError: true });
    expect(seen.realGateway).toBeNull();

    // Snapshot records exactly which bytes were evaluated.
    const run = h.runtime.listRuns(h.acme.id, { agentId: h.ada.id })[0]!;
    expect(run.capabilitySnapshot!.skills).toEqual([{ id: 'skl_eval_1', name: 'deploy-check', scope: 'agent', version: 3, contentHash: hashSkillFolder(skill.path) }]);
    expect(run.capabilitySnapshot!.skills[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // The endpoint dies with the run.
    const stale = new Client({ name: 'late', version: '1.0.0' });
    await expect(stale.connect(new StreamableHTTPClientTransport(new URL(String(seen.url)), { requestInit: { headers: { Authorization: `Bearer ${h.calls[0]!.runToken}` } } }))).rejects.toThrow();
  });

  it('refuses tokens that are not a live eval run', async () => {
    await boot();
    let url = '';
    let loopToken = '';
    const statuses: number[] = [];
    h.work.createIssue(h.acme.id, { title: 'Normal work', assigneeAgentId: h.lead.id }, OWNER);
    h.script = async (ctx) => {
      if (ctx.issueId) {
        loopToken = ctx.runToken; // a normal run, live at the same time
        await sleep(300);
        return;
      }
      url = ctx.mcpEndpoints[0]!.url;
      const tryWith = async (token: string) => (await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status;
      statuses.push(await tryWith('cnd_run_not-a-real-token-xxxxxxxxxxxxxxxx'), await tryWith(loopToken), (await fetch(url, { method: 'POST' })).status, await tryWith(ctx.runToken));
    };
    await h.runtime.tick(); // start the loop run
    await sleep(30);
    await h.runtime.run({ orgId: h.acme.id, agentId: h.ada.id, prompt: 'x', skills: [skill], label: 'auth' });
    await h.drain();
    expect(loopToken).not.toBe('');
    expect(statuses).toEqual([401, 401, 401, 200]); // bogus token, a live NON-eval run's token, no token, the eval run's own
  });

  it('snapshots the registry content hash of every skill on a normal run', async () => {
    await boot();
    h.skillRefs = [skill, { ...skill, id: 'skl_2', name: 'other', version: 2 }];
    h.skillRows.set('skl_eval_1', { version: 3, contentHash: 'a'.repeat(64) });
    h.skillRows.set('skl_2', { version: 1, contentHash: 'b'.repeat(64) }); // registry is on another version
    h.work.createIssue(h.acme.id, { title: 'Work', assigneeAgentId: h.ada.id }, OWNER);
    await h.drain();
    const snap = h.runtime.listRuns(h.acme.id, { agentId: h.ada.id })[0]!.capabilitySnapshot!;
    expect(snap.skills.map((s) => s.contentHash)).toEqual(['a'.repeat(64), hashSkillFolder(skill.path)]);
    expect(snap.skills.every((s) => s.contentHash.length === 64)).toBe(true);
  });
});
