import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateIssueInput, WorkService } from '../../src/contracts/org-work.js';
import { OWNER } from '../../src/contracts/types.js';
import { runs } from '../../src/db/schema/index.js';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { as, codeOf, recordEvents, setup, type Fixture } from './helpers.js';

describe('work: inbox, comments, delegation, escalation, review', () => {
  let k: TestKernel;
  let work: WorkService;
  let f: Fixture;
  beforeEach(() => {
    k = createTestKernel();
    ({ work, f } = setup(k));
  });
  afterEach(() => k.dispose());

  const titles = (agentId: string): string[] => work.inbox(f.org.id, agentId).issues.map((i) => i.title);

  it('orders the inbox by priority, then goal weight, then age', () => {
    const heavy = work.createGoal(f.org.id, { title: 'Heavy', weight: 5, deptId: f.eng.id }, OWNER);
    const light = work.createGoal(f.org.id, { title: 'Light', weight: 1, deptId: f.eng.id }, OWNER);
    const mk = (title: string, priority: number, goalId: string) => {
      k.clock.advance(1000);
      return work.createIssue(f.org.id, { title, priority, goalId, assigneeAgentId: f.dev.id }, OWNER);
    };
    mk('normal-light-old', 2, light.id);
    mk('normal-heavy', 2, heavy.id);
    mk('urgent-light', 0, light.id);
    mk('normal-light-new', 2, light.id);
    mk('high-heavy', 1, heavy.id);
    expect(titles(f.dev.id)).toEqual(['urgent-light', 'high-heavy', 'normal-heavy', 'normal-light-old', 'normal-light-new']);
  });

  it('lists only workable issues: assigned, right status, unlocked, blockers done', () => {
    const mk = (title: string, extra: Partial<CreateIssueInput> = {}) =>
      work.createIssue(f.org.id, { title, assigneeAgentId: f.dev.id, ...extra }, OWNER);
    const ready = mk('ready');
    mk('backlog', { status: 'backlog' });
    mk('blocked', { status: 'blocked' });
    mk('not mine', { assigneeAgentId: f.junior.id });
    const first = mk('first');
    mk('second', { blockedBy: [first.id] });
    const locked = mk('locked by another agent');
    const mine = mk('locked by my own run');
    const inReview = mk('in review');
    work.updateIssue(f.org.id, inReview.id, { status: 'in_review' }, OWNER);

    const now = k.clock.now();
    k.db.insert(runs).values([
      { id: 'run_other', orgId: f.org.id, agentId: f.junior.id, trigger: 'manual', createdAt: now },
      { id: 'run_mine', orgId: f.org.id, agentId: f.dev.id, trigger: 'manual', createdAt: now },
    ]).run();
    expect(work.checkout(f.org.id, locked.id, 'run_other')).toBe(true);
    expect(work.checkout(f.org.id, mine.id, 'run_mine')).toBe(true);

    expect(titles(f.dev.id).sort()).toEqual(['first', 'locked by my own run', 'ready'].sort());

    // Finishing the blocker releases the next step; a rejected review comes back.
    work.updateIssue(f.org.id, first.id, { status: 'done' }, OWNER);
    work.review(f.org.id, inReview.id, 'rejected', 'tests are missing', OWNER);
    work.release(f.org.id, locked.id, 'run_other', { status: 'todo' });
    expect(titles(f.dev.id).sort()).toEqual(['in review', 'locked by another agent', 'locked by my own run', 'ready', 'second'].sort());
    expect(ready.status).toBe('todo');
  });

  it('surfaces new comments and mentions since the cursor, excluding the agent\'s own', () => {
    const mine = work.createIssue(f.org.id, { title: 'Mine', assigneeAgentId: f.dev.id }, OWNER);
    const elsewhere = work.createIssue(f.org.id, { title: 'Elsewhere', assigneeAgentId: f.marketer.id }, OWNER);
    const filed = work.createIssue(f.org.id, { title: 'Filed by dev for nobody' }, as(f.dev));

    k.clock.advance(10);
    const c1 = work.addComment(f.org.id, mine.id, { body: 'How is it going?' }, OWNER);
    work.addComment(f.org.id, mine.id, { body: 'Working on it' }, as(f.dev));
    const c3 = work.addComment(f.org.id, elsewhere.id, { body: 'Need input from @dev and @june here' }, as(f.marketer));
    work.addComment(f.org.id, elsewhere.id, { body: 'unrelated chatter' }, OWNER);
    const c5 = work.addComment(f.org.id, filed.id, { body: 'Picked this up' }, as(f.lead));

    let box = work.inbox(f.org.id, f.dev.id);
    expect(box.newComments.map((c) => c.id)).toEqual([c1.id, c5.id]);
    expect(box.mentions.map((c) => c.id)).toEqual([c3.id]);
    expect(work.inbox(f.org.id, f.junior.id).mentions.map((c) => c.id)).toEqual([c3.id]);

    work.markInboxSeen(f.org.id, f.dev.id);
    box = work.inbox(f.org.id, f.dev.id);
    expect(box.newComments).toEqual([]);
    expect(box.mentions).toEqual([]);

    k.clock.advance(10);
    const c6 = work.addComment(f.org.id, mine.id, { body: 'ping @dev' }, as(f.lead));
    box = work.inbox(f.org.id, f.dev.id);
    expect(box.newComments.map((c) => c.id)).toEqual([c6.id]);
    expect(box.mentions.map((c) => c.id)).toEqual([c6.id]);

    // An explicit cursor can rewind.
    work.markInboxSeen(f.org.id, f.dev.id, 0);
    expect(work.inbox(f.org.id, f.dev.id).newComments).toHaveLength(3);
    expect(codeOf(() => work.markInboxSeen(f.org.id, f.dev.id, -1))).toBe('validation');
    // The junior's cursor is independent.
    expect(work.inbox(f.org.id, f.junior.id).mentions).toHaveLength(1);
  });

  it('threads comments, parses @mentions into agent ids and emits comment.created', () => {
    const issue = work.createIssue(f.org.id, { title: 'Thread' }, OWNER);
    const events = recordEvents(k);
    const root = work.addComment(
      f.org.id,
      issue.id,
      { body: 'cc @lena, @Dev. and @nobody — mail me at boss@dev.example, again @dev', attachments: [{ name: 'spec', path: 'docs/spec.md' }] },
      OWNER,
    );
    expect(root.mentions).toEqual([f.lead.id, f.dev.id]);
    expect(root).toMatchObject({ authorKind: 'human', authorId: 'owner', parentCommentId: null });
    expect(root.attachments).toEqual([{ name: 'spec', path: 'docs/spec.md' }]);

    k.clock.advance(5);
    const reply = work.addComment(f.org.id, issue.id, { body: 'on it', parentCommentId: root.id }, as(f.dev, 'run_7'));
    expect(reply).toMatchObject({ parentCommentId: root.id, authorKind: 'agent', authorId: f.dev.id, runId: 'run_7', mentions: [] });
    expect(events.of('comment.created')).toEqual([
      { orgId: f.org.id, issueId: issue.id, commentId: root.id, mentions: [f.lead.id, f.dev.id] },
      { orgId: f.org.id, issueId: issue.id, commentId: reply.id, mentions: [] },
    ]);
    expect(work.listComments(f.org.id, issue.id).map((c) => c.id)).toEqual([root.id, reply.id]);
    expect(work.listComments(f.org.id, issue.id, { since: root.createdAt }).map((c) => c.id)).toEqual([reply.id]);

    const other = work.createIssue(f.org.id, { title: 'Other' }, OWNER);
    expect(codeOf(() => work.addComment(f.org.id, other.id, { body: 'x', parentCommentId: root.id }, OWNER))).toBe('validation');
    expect(codeOf(() => work.addComment(f.org.id, issue.id, { body: '   ' }, OWNER))).toBe('validation');
    expect(codeOf(() => work.addComment(f.org.id, issue.id, { body: 'x', attachments: [{ name: 'p', path: '../../etc/passwd' }] }, OWNER))).toBe('validation');
  });

  it('delegates child issues down the reporting line, inheriting goal and project', () => {
    const goal = work.createGoal(f.org.id, { title: 'Ship', deptId: f.eng.id }, OWNER);
    const project = work.createProject(f.org.id, { name: 'App' }, OWNER);
    const parent = work.createIssue(
      f.org.id,
      { title: 'Build feature', goalId: goal.id, projectId: project.id, assigneeAgentId: f.lead.id },
      OWNER,
    );
    const events = recordEvents(k);
    const children = work.delegate(
      f.org.id,
      parent.id,
      [
        { title: 'Implement', expectedOutput: 'Merged PR', assigneeAgentId: f.dev.id },
        { title: 'Test', assigneeAgentId: f.junior.id, priority: 1 },
      ],
      as(f.lead),
    );
    expect(children).toHaveLength(2);
    for (const c of children) {
      expect(c).toMatchObject({ parentIssueId: parent.id, goalId: goal.id, projectId: project.id, status: 'todo', creatorId: f.lead.id });
    }
    expect(children[0]).toMatchObject({ assigneeAgentId: f.dev.id, expectedOutput: 'Merged PR' });
    expect(work.getIssue(f.org.id, parent.id).status).toBe('todo'); // the parent stays open
    expect(events.of('issue.assigned').map((e) => e.agentId)).toEqual([f.dev.id, f.junior.id]);
    expect(k.audit.query({ issueId: parent.id, action: 'issue.delegated' })).toHaveLength(1);

    // Outside the line: nothing is created (the split is atomic).
    const before = work.listIssues(f.org.id).length;
    expect(
      codeOf(() =>
        work.delegate(f.org.id, parent.id, [{ title: 'ok', assigneeAgentId: f.dev.id }, { title: 'sideways', assigneeAgentId: f.marketer.id }], as(f.lead)),
      ),
    ).toBe('forbidden');
    expect(work.listIssues(f.org.id)).toHaveLength(before);
    expect(recordEvents(k).all).toEqual([]);

    // Only someone entitled to the parent may split it; closed issues cannot be split.
    expect(codeOf(() => work.delegate(f.org.id, parent.id, [{ title: 'x', assigneeAgentId: f.marketer.id }], as(f.marketer)))).toBe('forbidden');
    expect(codeOf(() => work.delegate(f.org.id, parent.id, [], OWNER))).toBe('validation');
    work.updateIssue(f.org.id, parent.id, { status: 'cancelled' }, OWNER);
    expect(codeOf(() => work.delegate(f.org.id, parent.id, [{ title: 'x' }], OWNER))).toBe('conflict');
  });

  it('escalates up the reporting line and to the owner at the root', () => {
    const issue = work.createIssue(f.org.id, { title: 'Stuck', assigneeAgentId: f.dev.id }, OWNER);
    expect(work.checkout(f.org.id, issue.id, 'run_dev')).toBe(true);
    const events = recordEvents(k);

    const toLead = work.escalate(f.org.id, issue.id, 'need prod access', as(f.dev, 'run_dev'));
    expect(toLead).toMatchObject({ assigneeAgentId: f.lead.id, status: 'todo', checkoutLock: null });
    expect(events.of('issue.assigned')).toEqual([{ orgId: f.org.id, issueId: issue.id, agentId: f.lead.id }]);
    expect(work.inbox(f.org.id, f.lead.id).issues.map((i) => i.id)).toEqual([issue.id]);
    const note = work.listComments(f.org.id, issue.id).at(-1)!;
    expect(note.body).toContain('need prod access');
    expect(note.mentions).toEqual([f.lead.id]);

    expect(work.escalate(f.org.id, issue.id, 'above my pay grade', as(f.lead)).assigneeAgentId).toBe(f.ceo.id);
    expect(events.of('notification')).toEqual([]);

    const atRoot = work.escalate(f.org.id, issue.id, 'owner must decide', as(f.ceo));
    expect(atRoot).toMatchObject({ assigneeAgentId: f.ceo.id, status: 'blocked', blockedReason: 'escalated_to_owner' });
    const notifications = events.of('notification');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ orgId: f.org.id, kind: 'issue.escalated', body: 'owner must decide', data: { issueId: issue.id } });
    expect(k.audit.query({ issueId: issue.id, action: 'issue.escalated' })).toHaveLength(3);

    expect(codeOf(() => work.escalate(f.org.id, issue.id, '  ', OWNER))).toBe('validation');
    expect(codeOf(() => work.escalate(f.org.id, issue.id, 'not mine', as(f.marketer)))).toBe('forbidden');
    work.updateIssue(f.org.id, issue.id, { status: 'cancelled' }, OWNER);
    expect(codeOf(() => work.escalate(f.org.id, issue.id, 'too late', OWNER))).toBe('conflict');
  });

  it('reviews: accepted → done, edited → done (+flag), rejected → todo with rework', () => {
    const mk = (title: string) => {
      const i = work.createIssue(f.org.id, { title, assigneeAgentId: f.dev.id, reviewerAgentId: f.lead.id }, OWNER);
      work.updateIssue(f.org.id, i.id, { status: 'in_progress' }, as(f.dev));
      return work.updateIssue(f.org.id, i.id, { status: 'in_review' }, as(f.dev));
    };
    const events = recordEvents(k);
    const [a, b, c] = [mk('a'), mk('b'), mk('c')];

    const accepted = work.review(f.org.id, a!.id, 'accepted', undefined, as(f.lead));
    expect(accepted).toMatchObject({ status: 'done', reviewOutcome: 'accepted', reworkCount: 0 });
    expect(accepted.closedAt).toBe(k.clock.now());
    expect(work.listComments(f.org.id, a!.id)).toEqual([]);

    const edited = work.review(f.org.id, b!.id, 'edited', 'fixed the typo myself', OWNER);
    expect(edited).toMatchObject({ status: 'done', reviewOutcome: 'edited' });
    expect(work.listComments(f.org.id, b!.id)[0]!.body).toContain('fixed the typo myself');
    expect(events.of('issue.done').map((e) => e.issueId)).toEqual([a!.id, b!.id]);

    const rejected = work.review(f.org.id, c!.id, 'rejected', 'tests fail on CI', as(f.lead));
    expect(rejected).toMatchObject({ status: 'todo', reviewOutcome: 'rejected', reworkCount: 1, closedAt: null });
    const note = work.listComments(f.org.id, c!.id)[0]!;
    expect(note).toMatchObject({ authorKind: 'agent', authorId: f.lead.id });
    expect(note.body).toContain('tests fail on CI');
    expect(work.inbox(f.org.id, f.dev.id).issues.map((i) => i.id)).toEqual([c!.id]);

    // Second round: rework count accumulates.
    work.updateIssue(f.org.id, c!.id, { status: 'in_review' }, as(f.dev));
    expect(work.review(f.org.id, c!.id, 'rejected', undefined, OWNER).reworkCount).toBe(2);

    // Guards: must be in_review; no self-review; outsiders refused; verdict validated.
    expect(codeOf(() => work.review(f.org.id, a!.id, 'accepted', undefined, OWNER))).toBe('conflict');
    work.updateIssue(f.org.id, c!.id, { status: 'in_review' }, as(f.dev));
    expect(codeOf(() => work.review(f.org.id, c!.id, 'accepted', undefined, as(f.dev)))).toBe('forbidden');
    expect(codeOf(() => work.review(f.org.id, c!.id, 'accepted', undefined, as(f.marketer)))).toBe('forbidden');
    expect(codeOf(() => work.review(f.org.id, c!.id, 'meh' as never, undefined, OWNER))).toBe('validation');
    // The assignee's manager chain may review even when not the named reviewer.
    expect(work.review(f.org.id, c!.id, 'accepted', undefined, as(f.ceo)).status).toBe('done');
  });

  it('merges comments and audit records into one timeline, oldest first', () => {
    const issue = work.createIssue(f.org.id, { title: 'Timeline' }, OWNER);
    k.clock.advance(10);
    work.assign(f.org.id, issue.id, f.dev.id, OWNER);
    k.clock.advance(10);
    const comment = work.addComment(f.org.id, issue.id, { body: 'starting' }, as(f.dev));
    k.clock.advance(10);
    work.checkout(f.org.id, issue.id, 'run_1');
    k.clock.advance(10);
    k.audit.record({ orgId: f.org.id, actor: as(f.dev, 'run_1'), action: 'tool.called', issueId: issue.id, data: { tool: 'search' } });
    k.clock.advance(10);
    work.updateIssue(f.org.id, issue.id, { status: 'done' }, as(f.dev, 'run_1'));

    const timeline = work.timeline(f.org.id, issue.id);
    expect(timeline.map((e) => (e.kind === 'comment' ? `comment:${e.comment.id}` : e.activity.action))).toEqual([
      'issue.created',
      'issue.assigned',
      `comment:${comment.id}`,
      'issue.checked_out',
      'tool.called',
      'issue.updated',
    ]);
    expect(timeline.map((e) => e.ts)).toEqual([...timeline.map((e) => e.ts)].sort((x, y) => x - y));
  });
});

describe('work: playbooks', () => {
  let k: TestKernel;
  let work: WorkService;
  let f: Fixture;
  beforeEach(() => {
    k = createTestKernel();
    ({ work, f } = setup(k));
  });
  afterEach(() => k.dispose());

  const steps = [
    { title: 'Research', description: 'Collect sources', expectedOutput: 'A list of 10 sources', agentRole: 'engineer' },
    { title: 'Draft', description: 'Write it', expectedOutput: 'A 500-word draft', agentRole: 'QA' },
    { title: 'Publish', description: 'Ship it', expectedOutput: 'A live URL' },
  ];

  it('validates and stores playbooks', () => {
    const pb = work.createPlaybook(f.org.id, { name: 'Content', description: 'Blog pipeline', steps }, OWNER);
    expect(pb).toMatchObject({ process: 'sequential', managerAgentId: null });
    expect(pb.steps).toHaveLength(3);
    expect(work.listPlaybooks(f.org.id).map((p) => p.id)).toEqual([pb.id]);
    expect(codeOf(() => work.createPlaybook(f.org.id, { name: 'Content', steps }, OWNER))).toBe('conflict');
    expect(codeOf(() => work.createPlaybook(f.org.id, { name: 'Empty', steps: [] }, OWNER))).toBe('validation');
    expect(codeOf(() => work.createPlaybook(f.org.id, { name: 'Bad', managerAgentId: 'agt_missing', steps }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.createPlaybook(f.org.id, { name: 'Junior', steps }, as(f.junior)))).toBe('forbidden');
  });

  it('sequential: one child per step, each blocked by the previous, released in order', () => {
    const goal = work.createGoal(f.org.id, { title: 'Content', deptId: f.eng.id }, OWNER);
    const pb = work.createPlaybook(f.org.id, { name: 'Content', steps }, OWNER);
    const parent = work.createIssue(f.org.id, { title: 'Blog post', goalId: goal.id, assigneeAgentId: f.lead.id, priority: 1 }, OWNER);

    const children = work.runPlaybook(f.org.id, pb.id, parent.id, as(f.lead));
    expect(children.map((c) => c.title)).toEqual(['Research', 'Draft', 'Publish']);
    expect(children.map((c) => c.expectedOutput)).toEqual(['A list of 10 sources', 'A 500-word draft', 'A live URL']);
    expect(children.map((c) => c.body)).toEqual(['Collect sources', 'Write it', 'Ship it']);
    // role match within the org; the unmatched step falls to the issue's assignee
    expect(children.map((c) => c.assigneeAgentId)).toEqual([f.dev.id, f.junior.id, f.lead.id]);
    expect(children.map((c) => c.blockedBy)).toEqual([[], [children[0]!.id], [children[1]!.id]]);
    for (const c of children) {
      expect(c).toMatchObject({ parentIssueId: parent.id, goalId: goal.id, playbookId: pb.id, priority: 1, reviewerAgentId: null, status: 'todo' });
    }
    expect(work.getIssue(f.org.id, parent.id)).toMatchObject({ playbookId: pb.id, status: 'todo' });
    expect(k.audit.query({ issueId: parent.id, action: 'playbook.run' })).toHaveLength(1);

    // Only the first step is workable until it is done.
    expect(work.inbox(f.org.id, f.junior.id).issues).toEqual([]);
    expect(work.checkout(f.org.id, children[1]!.id, 'run_j')).toBe(false);
    expect(work.checkout(f.org.id, children[0]!.id, 'run_d')).toBe(true);
    work.updateIssue(f.org.id, children[0]!.id, { status: 'done' }, as(f.dev, 'run_d'));
    expect(work.inbox(f.org.id, f.junior.id).issues.map((i) => i.id)).toEqual([children[1]!.id]);
  });

  it('hierarchical: the manager delegates each step and reviews it', () => {
    const pb = work.createPlaybook(
      f.org.id,
      {
        name: 'Release',
        process: 'hierarchical',
        managerAgentId: f.lead.id,
        steps: [
          { title: 'Build', description: '', expectedOutput: 'Artifact', agentRole: 'Engineer' },
          { title: 'Verify', description: '', expectedOutput: 'Test report', agentId: f.junior.id },
          { title: 'Announce', description: '', expectedOutput: 'Changelog', agentRole: 'Astronaut' },
        ],
      },
      OWNER,
    );
    const parent = work.createIssue(f.org.id, { title: 'Release 2.0', assigneeAgentId: f.lead.id }, OWNER);
    const children = work.runPlaybook(f.org.id, pb.id, parent.id, OWNER);

    expect(children.map((c) => c.assigneeAgentId)).toEqual([f.dev.id, f.junior.id, f.lead.id]);
    // The manager reviews the work it delegated (not its own).
    expect(children.map((c) => c.reviewerAgentId)).toEqual([f.lead.id, f.lead.id, null]);
    expect(children.map((c) => c.blockedBy)).toEqual([[], [], []]);
    expect(children.map((c) => c.expectedOutput)).toEqual(['Artifact', 'Test report', 'Changelog']);
    expect(work.inbox(f.org.id, f.junior.id).issues.map((i) => i.id)).toEqual([children[1]!.id]);

    work.updateIssue(f.org.id, children[0]!.id, { status: 'in_review' }, as(f.dev));
    expect(work.review(f.org.id, children[0]!.id, 'accepted', undefined, as(f.lead)).status).toBe('done');
  });

  it('applies the reporting line and actor rules when agents run playbooks', () => {
    const pb = work.createPlaybook(
      f.org.id,
      { name: 'Cross-team', steps: [{ title: 'Campaign', description: '', expectedOutput: 'Plan', agentRole: 'Marketing Lead' }] },
      OWNER,
    );
    const hier = work.createPlaybook(
      f.org.id,
      { name: 'No manager', process: 'hierarchical', steps: [{ title: 'Solo', description: '', expectedOutput: 'x' }] },
      OWNER,
    );
    const parent = work.createIssue(f.org.id, { title: 'Launch', assigneeAgentId: f.lead.id }, OWNER);
    const before = work.listIssues(f.org.id).length;

    // The engineering lead cannot assign to marketing; the CEO can.
    expect(codeOf(() => work.runPlaybook(f.org.id, pb.id, parent.id, as(f.lead)))).toBe('forbidden');
    expect(work.listIssues(f.org.id)).toHaveLength(before);
    expect(work.runPlaybook(f.org.id, pb.id, parent.id, as(f.ceo))[0]!.assigneeAgentId).toBe(f.marketer.id);

    // Not entitled to the parent issue / autonomy 0.
    expect(codeOf(() => work.runPlaybook(f.org.id, pb.id, parent.id, as(f.marketer)))).toBe('forbidden');
    const internIssue = work.createIssue(f.org.id, { title: 'Intern task', assigneeAgentId: f.intern.id }, OWNER);
    expect(codeOf(() => work.runPlaybook(f.org.id, pb.id, internIssue.id, as(f.intern)))).toBe('forbidden');

    // A hierarchical playbook without a manager uses the issue's assignee; with neither it is invalid.
    expect(work.runPlaybook(f.org.id, hier.id, parent.id, OWNER)[0]).toMatchObject({ assigneeAgentId: f.lead.id, reviewerAgentId: null });
    const orphan = work.createIssue(f.org.id, { title: 'Unassigned' }, OWNER);
    expect(codeOf(() => work.runPlaybook(f.org.id, hier.id, orphan.id, OWNER))).toBe('validation');
  });
});
