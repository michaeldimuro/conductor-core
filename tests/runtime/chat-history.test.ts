import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

describe('UI chat keeps its history', () => {
  let h: Harness;
  afterEach(() => h.dispose());

  it('stores both sides and replays earlier turns into the next one', async () => {
    h = await createHarness();
    let n = 0;
    h.script = () => ({ finalText: `reply ${++n}` });
    const first = await h.runtime.chat(h.acme.id, h.ada.id, 'what is the plan?', { history: true });
    expect(first.reply).toBe('reply 1');
    expect(first.messageId).toBeTruthy();
    expect(h.calls.at(-1)!.prompt).toContain('what is the plan?');
    expect(h.calls.at(-1)!.prompt).not.toContain('conversation so far');

    await h.runtime.chat(h.acme.id, h.ada.id, 'and after that?', { history: true });
    const prompt = h.calls.at(-1)!.prompt;
    expect(prompt).toContain('The conversation so far');
    expect(prompt).toContain('Operator: what is the plan?');
    expect(prompt).toContain(`${h.ada.name}: reply 1`);
    expect(prompt).toContain('Operator: and after that?');

    const log = h.runtime.chatHistory(h.acme.id, h.ada.id);
    expect(log.map((m) => [m.role, m.body])).toEqual([
      ['user', 'what is the plan?'], ['agent', 'reply 1'], ['user', 'and after that?'], ['agent', 'reply 2'],
    ]);
    expect(log[1]!.runId).toBe(first.runId);
    // Another agent's conversation is separate.
    expect(h.runtime.chatHistory(h.acme.id, h.lead.id)).toEqual([]);
  });

  it('records a failed turn and can be cleared', async () => {
    h = await createHarness({ runtime: { chatRunsPerHour: 1 } });
    await h.runtime.chat(h.acme.id, h.ada.id, 'one', { history: true });
    await expect(h.runtime.chat(h.acme.id, h.ada.id, 'two', { history: true })).rejects.toThrow(/max chat runs per hour/);
    const log = h.runtime.chatHistory(h.acme.id, h.ada.id);
    expect(log.at(-1)).toMatchObject({ role: 'agent', body: '' });
    expect(log.at(-1)!.error).toMatch(/max chat runs per hour/);
    h.runtime.clearChat(h.acme.id, h.ada.id);
    expect(h.runtime.chatHistory(h.acme.id, h.ada.id)).toEqual([]);
  });

  it('gateway chats (no history flag) are not recorded', async () => {
    h = await createHarness();
    await h.runtime.chat(h.acme.id, h.ada.id, 'from slack');
    expect(h.runtime.chatHistory(h.acme.id, h.ada.id)).toEqual([]);
  });
});

describe('agent groups for the sidebar', () => {
  it('nests reports under their manager inside each department', async () => {
    const { buildAgentGroups } = await import('../../ui/src/lib/agent-groups.js');
    const a = (id: string, deptId: string, reportsTo: string | null, name = id) => ({ id, deptId, reportsTo, name, slug: id, status: 'active', role: 'r' }) as never;
    const groups = buildAgentGroups(
      [a('ceo', 'exec', null), a('eng-lead', 'eng', 'ceo'), a('dev1', 'eng', 'eng-lead'), a('dev2', 'eng', 'dev1'), a('loop1', 'eng', 'loop2'), a('loop2', 'eng', 'loop1')],
      [{ id: 'eng', name: 'Engineering', leadAgentId: 'eng-lead' }, { id: 'exec', name: 'Executive', leadAgentId: 'ceo' }] as never,
    );
    expect(groups.map((g) => g.name)).toEqual(['Executive', 'Engineering']); // the CEO's department first
    const eng = groups[1]!;
    expect(eng.size).toBe(5);
    expect(eng.roots[0]!.agent.id).toBe('eng-lead');
    expect(eng.roots[0]!.children[0]!.agent.id).toBe('dev1');
    expect(eng.roots[0]!.children[0]!.children[0]!.agent.id).toBe('dev2');
    // A reporting cycle still shows everyone.
    const flat = (ns: typeof eng.roots): string[] => ns.flatMap((n) => [n.agent.id, ...flat(n.children)]);
    expect(flat(eng.roots).sort()).toEqual(['dev1', 'dev2', 'eng-lead', 'loop1', 'loop2']);
  });
});
