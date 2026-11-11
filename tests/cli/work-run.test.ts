import { describe, expect, it, vi } from 'vitest';
import type { GoalNode, TranscriptEntry } from '../../src/api/types.js';
import { renderEvent, renderLogLine } from '../../src/cli/commands/run.js';
import { makeStyle } from '../../src/cli/output.js';
import { LOGS, agent, goal, harness, issue, org, run } from './harness.js';

const ENV = { CONDUCTOR_ORG: 'acme' };
const base = () => ({
  listAgents: vi.fn(async () => [agent(), agent({ id: 'agt_sam', slug: 'sam', name: 'Sam', role: 'Engineer' })]),
  getOrg: vi.fn(async () => org()),
  listGoals: vi.fn(async () => [goal()]),
});
const page = <T,>(items: T[], nextOffset: number | null = null) => ({ items, limit: 100, offset: 0, nextOffset });

describe('goal', () => {
  it('lists, creates and prints the tree', async () => {
    const createGoal = vi.fn(async () => goal({ id: 'goal_2', title: 'Launch v2' }));
    const tree: GoalNode[] = [{ goal: goal(), issueCounts: { open: 3, done: 1 }, children: [{ goal: goal({ id: 'goal_2', title: 'Launch v2', status: 'proposed', successMetric: '' }), issueCounts: { open: 0, done: 0 }, children: [] }] }];
    const h = harness({ env: ENV, client: { ...base(), createGoal, goalTree: vi.fn(async () => tree) } });

    const l = await h.run('goal', 'list', '--status', 'active');
    expect(h.client.listGoals).toHaveBeenLastCalledWith('acme', { status: 'active' });
    expect(l.stdout).toMatch(/Reach 100 customers\s+org\s+active\s+-\s+customers\s+goal_1/);

    const c = await h.run('goal', 'create', 'Launch v2', '--parent', 'Reach 100', '--level', 'dept', '--owner', 'sam', '--metric', 'shipped', '--target', 'yes', '--weight', '2', '--due', '2026-03-31');
    expect(createGoal).toHaveBeenCalledWith('acme', { title: 'Launch v2', parentGoalId: 'goal_1', level: 'dept', ownerAgentId: 'agt_sam', successMetric: 'shipped', target: 'yes', weight: 2, due: Date.parse('2026-03-31') });
    expect(c.stdout).toContain('created goal "Launch v2" (goal_2)');
    expect((await h.run('goal', 'create', 'X', '--due', 'someday')).code).toBe(2);

    const t = await h.run('goal', 'tree');
    expect(t.stdout.trimEnd().split('\n')).toEqual(['└─ Reach 100 customers  (customers → 100)  1/4 issues done', '   └─ Launch v2 [proposed]']);
    expect(((await h.run('--json', 'goal', 'tree')).json() as unknown[]).length).toBe(1);
  });
});

describe('issue', () => {
  it('lists open issues by default and applies filters', async () => {
    const listIssues = vi.fn(async () => page([issue(), issue({ id: 'iss_2', number: 13, title: 'Write docs', assigneeAgentId: null, status: 'backlog' })], 100));
    const h = harness({ env: ENV, client: { ...base(), listIssues } });
    const r = await h.run('issue', 'list');
    expect(listIssues).toHaveBeenLastCalledWith('acme', { status: ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'], limit: 100 });
    expect(r.stdout).toMatch(/ACME-12\s+todo\s+P2\s+riley\s+Fix the login bug/);
    expect(r.stdout).toMatch(/ACME-13\s+backlog\s+P2\s+-\s+Write docs/);
    expect(r.stderr).toContain('more issues exist');

    await h.run('issue', 'list', '--status', 'done,cancelled', '--assignee', 'Sam', '--goal', 'goal_1', '--search', 'login', '--limit', '5');
    expect(listIssues).toHaveBeenLastCalledWith('acme', { status: ['done', 'cancelled'], assigneeAgentId: 'agt_sam', goalId: 'goal_1', search: 'login', limit: 5 });
    await h.run('issue', 'list', '--all');
    expect(listIssues).toHaveBeenLastCalledWith('acme', { limit: 100 });

    const j = (await h.run('--json', 'issue', 'list')).json() as { items: unknown[]; nextOffset: number };
    expect(j.items.length).toBe(2);
    expect(j.nextOffset).toBe(100);
  });

  it('creates an issue with every option', async () => {
    const createIssue = vi.fn(async () => issue({ number: 14, title: 'Ship it' }));
    const h = harness({ env: ENV, client: { ...base(), createIssue, getIssue: vi.fn(async () => issue({ id: 'iss_parent', number: 3 })) }, stdin: 'body from stdin' });
    const r = await h.run('issue', 'create', 'Ship it', '--body', '-', '--assign', 'sam', '--goal', 'Reach 100 customers', '--priority', '1', '--expected-output', 'A merged PR', '--type', 'feature',
      '--reviewer', 'riley', '--parent', 'ACME-3', '--label', 'urgent', 'backend', '--status', 'todo');
    expect(r.code).toBe(0);
    expect(createIssue).toHaveBeenCalledWith('acme', {
      title: 'Ship it', body: 'body from stdin', assigneeAgentId: 'agt_sam', goalId: 'goal_1', priority: 1, expectedOutput: 'A merged PR', taskType: 'feature',
      reviewerAgentId: 'agt_riley', parentIssueId: 'iss_parent', labels: ['urgent', 'backend'], status: 'todo',
    });
    expect(r.stdout).toContain('created ACME-14: Ship it');
    expect(r.stdout).toContain('conductor run now sam --issue 14');

    const plain = await h.run('--json', 'issue', 'create', 'Minimal');
    expect(createIssue).toHaveBeenLastCalledWith('acme', { title: 'Minimal' });
    expect((plain.json() as { number: number }).number).toBe(14);
    expect((await h.run('issue', 'create', 'X', '--priority', '4')).code).toBe(2);
  });

  it('shows an issue with comments', async () => {
    const h = harness({
      env: ENV,
      client: {
        ...base(), getIssue: vi.fn(async () => issue({ status: 'blocked', blockedReason: 'needs_human', expectedOutput: 'Green CI' })),
        listComments: vi.fn(async () => [{ id: 'cmt_1', orgId: 'org_1', issueId: 'iss_1', parentCommentId: null, authorKind: 'agent', authorId: 'agt_sam', runId: null, body: 'Found the cause.', mentions: [], attachments: [], createdAt: 1_699_999_500_000 }]),
      },
    });
    const r = await h.run('issue', 'show', '12');
    expect(r.stdout).toMatch(/status:\s+blocked \(needs_human\)/);
    expect(r.stdout).toMatch(/assignee:\s+riley/);
    expect(r.stdout).toContain('It fails.');
    expect(r.stdout).toContain('Green CI');
    expect(r.stdout).toMatch(/── sam · \d+m ago\nFound the cause\./);
    expect(Object.keys((await h.run('--json', 'issue', 'show', '12')).json() as object)).toEqual(['issue', 'comments']);
  });

  it('comments, assigns, unassigns and reviews', async () => {
    const addComment = vi.fn(async () => ({ id: 'cmt_2' }));
    const assignIssue = vi.fn(async () => issue());
    const reviewIssue = vi.fn(async () => issue({ status: 'done' }));
    const h = harness({ env: ENV, client: { ...base(), addComment, assignIssue, reviewIssue } });

    expect((await h.run('issue', 'comment', 'ACME-12', 'looks', 'good', '@sam')).code).toBe(0);
    expect(addComment).toHaveBeenCalledWith('acme', '12', { body: 'looks good @sam' });

    expect((await h.run('issue', 'assign', '12', 'sam')).stdout).toContain('#12 assigned to sam');
    expect(assignIssue).toHaveBeenLastCalledWith('acme', '12', 'agt_sam');
    expect((await h.run('issue', 'assign', 'iss_1', 'none')).stdout).toContain('#12 unassigned');
    expect(assignIssue).toHaveBeenLastCalledWith('acme', 'iss_1', null);

    const rev = await h.run('issue', 'review', '#12', 'rejected', '--note', 'missing tests');
    expect(reviewIssue).toHaveBeenCalledWith('acme', '12', { outcome: 'rejected', note: 'missing tests' });
    expect(rev.stdout).toContain('#12 rejected → done');
    expect(((await h.run('--json', 'issue', 'review', '12', 'accepted')).json() as { status: string }).status).toBe('done');
  });
});

describe('run', () => {
  it('queues a run now, optionally pinned to an issue', async () => {
    const runAgent = vi.fn(async () => ({ jobId: 'job_1' }));
    const h = harness({ env: ENV, client: { ...base(), runAgent, getIssue: vi.fn(async () => issue()) } });
    const r = await h.run('run', 'now', 'sam', '--issue', 'ACME-12', '--prompt', 'be brief');
    expect(runAgent).toHaveBeenCalledWith('acme', 'agt_sam', { issueId: 'iss_1', prompt: 'be brief' });
    expect(r.stdout).toContain('queued a run for Sam on #12');
    expect(r.stdout).toContain('conductor logs -f --agent sam');

    const j = await h.run('--json', 'run', 'now', 'riley');
    expect(runAgent).toHaveBeenLastCalledWith('acme', 'agt_riley', {});
    expect(j.json()).toEqual({ jobId: 'job_1', agentId: 'agt_riley', issueId: null });
  });

  it('lists, shows and cancels runs', async () => {
    const listRuns = vi.fn(async () => [run(), run({ id: 'run_2', status: 'failed', outcome: 'timeout', subscription: true })]);
    const cancelRun = vi.fn(async () => ({ ok: true }));
    const h = harness({ env: ENV, client: { ...base(), listRuns, getRun: vi.fn(async () => run({ error: 'boom' })), cancelRun } });
    const l = await h.run('run', 'list', '--agent', 'riley', '--status', 'failed', '--limit', '5');
    expect(listRuns).toHaveBeenCalledWith('acme', { agentId: 'agt_riley', status: 'failed', limit: 5 });
    expect(l.stdout).toMatch(/run_01HZ\w+\s+riley\s+manual\s+succeeded\s+7\s+\$0\.04/);
    expect(l.stdout).toMatch(/run_2\s+riley\s+manual\s+failed \(timeout\)\s+7\s+sub/);

    const s = await h.run('run', 'show', 'run_2');
    expect(s.stdout).toMatch(/status:\s+succeeded · 7 steps · 1m · \$0\.04/);
    expect(s.stdout).toMatch(/error:\s+boom/);

    expect((await h.run('run', 'cancel', 'run_2', '--reason', 'wrong issue')).stdout).toContain('cancelled run_2');
    expect(cancelRun).toHaveBeenCalledWith('acme', 'run_2', 'wrong issue');
    expect(((await h.run('--json', 'run', 'list')).json() as unknown[]).length).toBe(2);
  });
});

describe('logs', () => {
  const entries: TranscriptEntry[] = [
    { seq: 1, ts: Date.UTC(2026, 0, 1, 9, 30, 0), event: { type: 'status', status: 'started' } },
    { seq: 2, ts: Date.UTC(2026, 0, 1, 9, 30, 1), event: { type: 'text', text: 'Looking at the bug.\n' } },
    { seq: 3, ts: Date.UTC(2026, 0, 1, 9, 30, 2), event: { type: 'tool_call', id: 't1', name: 'conductor__issue_comment', input: { issue: 12, body: 'x'.repeat(400) } } },
    { seq: 4, ts: Date.UTC(2026, 0, 1, 9, 30, 3), event: { type: 'tool_result', id: 't1', name: 'conductor__issue_comment', output: 'no such issue', isError: true } },
    { seq: 5, ts: Date.UTC(2026, 0, 1, 9, 30, 4), event: { type: 'usage', tokensIn: 900, tokensOut: 120, costUsd: 0.0123 } },
    { seq: 6, ts: Date.UTC(2026, 0, 1, 9, 30, 5), event: { type: 'error', kind: 'rate_limit', message: 'slow down', retryable: true } },
  ];

  it('renders transcript events compactly', () => {
    const s = makeStyle(false);
    const lines = entries.map((e) => renderEvent(e, s));
    expect(lines[0]).toBe('09:30:00 · started');
    expect(lines[1]).toBe('09:30:01 Looking at the bug.');
    expect(lines[2]).toMatch(/^09:30:02 → conductor__issue_comment\(\{"issue":12,"body":"x+…\)$/);
    expect(lines[2]!.length).toBeLessThan(220);
    expect(lines[3]).toBe('09:30:03 ← ERROR conductor__issue_comment: no such issue');
    expect(lines[4]).toBe('09:30:04 usage: 900 in / 120 out · $0.01');
    expect(lines[5]).toBe('09:30:05 error [rate_limit] slow down (retryable)');
  });

  it('prints a finished run transcript once', async () => {
    const runTranscript = vi.fn(async () => entries);
    const h = harness({ env: ENV, client: { getRun: vi.fn(async () => run({ id: 'run_abc' })), runTranscript, listRuns: vi.fn(async () => [run({ id: 'run_abc' })]) } });
    const r = await h.run('logs', '--run', 'run_abc');
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split('\n').length).toBe(6);
    expect(r.stderr).toContain('run run_abc: succeeded · 7 steps');
    expect(runTranscript).toHaveBeenCalledTimes(1);
    expect(((await h.run('--json', 'logs', '--run', 'run_abc')).json() as unknown[]).length).toBe(6);
  });

  it('follows a live run with afterSeq until it ends', async () => {
    const getRun = vi.fn()
      .mockResolvedValueOnce(run({ id: 'run_live', status: 'running' }))
      .mockResolvedValueOnce(run({ id: 'run_live', status: 'running' }))
      .mockResolvedValue(run({ id: 'run_live', status: 'succeeded' }));
    const runTranscript = vi.fn()
      .mockResolvedValueOnce(entries.slice(0, 2))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(entries.slice(2));
    const h = harness({ env: ENV, client: { getRun, runTranscript, listRuns: vi.fn(async () => [run({ id: 'run_live', status: 'running' })]) } });
    const r = await h.run('logs', '-f', '--run', 'run_live');
    expect(r.code).toBe(0);
    expect(runTranscript.mock.calls.map((c) => c[2])).toEqual([undefined, { afterSeq: 2 }, { afterSeq: 2 }]);
    expect(r.stdout.trimEnd().split('\n').length).toBe(6);
    expect(r.stdout.indexOf('started')).toBeLessThan(r.stdout.indexOf('slow down'));
  });

  it('streams NDJSON when following with --json', async () => {
    const h = harness({ env: ENV, client: { getRun: vi.fn(async () => run({ id: 'run_abc' })), runTranscript: vi.fn(async () => entries.slice(0, 2)), listRuns: vi.fn(async () => [run({ id: 'run_abc' })]) } });
    const r = await h.run('--json', 'logs', '-f', '--run', 'run_abc');
    expect(r.stdout.trimEnd().split('\n').map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([1, 2]);
  });

  it('shows the latest run of an agent, and fails clearly when there is none', async () => {
    const listRuns = vi.fn(async () => [run({ id: 'run_latest' })]);
    const h = harness({ env: ENV, client: { ...base(), listRuns, getRun: vi.fn(async () => run({ id: 'run_latest' })), runTranscript: vi.fn(async () => entries.slice(0, 1)) } });
    const r = await h.run('logs', '--agent', 'sam');
    expect(listRuns).toHaveBeenCalledWith('acme', { agentId: 'agt_sam', limit: 1 });
    expect(r.stdout).toContain('· started');

    const none = harness({ env: ENV, client: { ...base(), listRuns: vi.fn(async () => []) } });
    const n = await none.run('logs', '--agent', 'sam');
    expect(n.code).toBe(1);
    expect(n.stderr).toContain('Sam has no runs yet');
  });

  it('formats pino lines and passes other text through', () => {
    const s = makeStyle(false);
    expect(renderLogLine(JSON.stringify({ level: 30, time: Date.UTC(2026, 0, 1, 8, 0, 0), pid: 1, hostname: 'mac', msg: 'conductord ready', port: 7420 }), s)).toBe('08:00:00 INFO  conductord ready port=7420');
    expect(renderLogLine('Error: plain stack line', s)).toBe('Error: plain stack line');
    expect(renderLogLine('{broken', s)).toBe('{broken');
  });

  it('tails the daemon log files, last N lines each', async () => {
    const out = Array.from({ length: 5 }, (_, i) => JSON.stringify({ level: 30, time: Date.UTC(2026, 0, 1, 8, 0, i), msg: `line ${i}` })).join('\n') + '\n';
    const h = harness({ files: { [`${LOGS}/conductord.out.log`]: out, [`${LOGS}/conductord.err.log`]: 'boom\n', [`${LOGS}/notes.txt`]: 'ignored' } });
    const r = await h.run('logs', '-n', '2');
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split('\n')).toEqual([`==> ${LOGS}/conductord.err.log <==`, 'boom', `==> ${LOGS}/conductord.out.log <==`, '08:00:03 INFO  line 3', '08:00:04 INFO  line 4']);
    // --json passes raw lines through.
    expect((await h.run('--json', 'logs', '-n', '1')).stdout).toContain('"msg":"line 4"');
  });

  it('follows appended log lines until interrupted', async () => {
    const file = `${LOGS}/conductord.out.log`;
    const h = harness({ files: { [file]: 'first\n' } });
    let ticks = 0;
    h.deps.sleep = async () => {
      ticks += 1;
      if (ticks === 1) h.files.set(file, 'first\nsecond\nthi');
      if (ticks === 2) h.files.set(file, 'first\nsecond\nthird\n');
      if (ticks === 3) h.abort.abort();
    };
    const r = await h.run('logs', '-f');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('first\nsecond\nthird\n');
  });

  it('explains where logs come from when there are none', async () => {
    const r = await harness().run('logs');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`No daemon logs in ${LOGS}`);
  });
});
