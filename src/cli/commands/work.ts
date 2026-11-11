import type { Command } from 'commander';
import type { GoalNode, Issue } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, arg, choice, choices, compact, flag, num, oneOf, str } from '../command.js';
import { UsageError } from '../errors.js';
import { ago, clip } from '../output.js';
import { agentNames, issueKey, issueLabel, resolveAgent, resolveDept, resolveGoal, resolveIssue } from '../resolve.js';

const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'] as const;
const OPEN_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'] as const;
const GOAL_STATUSES = ['proposed', 'active', 'achieved', 'abandoned'] as const;
const GOAL_LEVELS = ['org', 'dept', 'agent'] as const;
const REVIEW_OUTCOMES = ['accepted', 'edited', 'rejected'] as const;

function parseDue(value: string): number {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) throw new UsageError(`--due must be a date such as 2026-03-31 (got "${value}")`);
  return ts;
}

function goalLines(nodes: GoalNode[], prefix = ''): string[] {
  return nodes.flatMap((n, i) => {
    const last = i === nodes.length - 1;
    const g = n.goal;
    const total = n.issueCounts.open + n.issueCounts.done;
    const progress = total ? `  ${n.issueCounts.done}/${total} issues done` : '';
    const metric = g.successMetric ? `  (${clip(g.successMetric, 50)}${g.target ? ` → ${clip(g.target, 30)}` : ''})` : '';
    return [`${prefix}${last ? '└─ ' : '├─ '}${g.title}${g.status !== 'active' ? ` [${g.status}]` : ''}${metric}${progress}`, ...goalLines(n.children, prefix + (last ? '   ' : '│  '))];
  });
}

async function showIssue(ctx: Ctx, org: string, issue: Issue): Promise<void> {
  const [o, comments, name] = await Promise.all([ctx.client().getOrg(org), ctx.client().listComments(org, issue.id), agentNames(ctx, org)]);
  ctx.emit({ issue, comments }, () => {
    ctx.line(ctx.style.bold(`${issueLabel(o.slug, issue)}  ${issue.title}`));
    ctx.fields([
      ['status', issue.status === 'blocked' && issue.blockedReason ? `blocked (${issue.blockedReason})` : issue.status],
      ['assignee', name(issue.assigneeAgentId)], ['reviewer', issue.reviewerAgentId ? name(issue.reviewerAgentId) : null],
      ['priority', `P${issue.priority}`], ['type', issue.taskType], ['goal', issue.goalId], ['labels', issue.labels.join(', ')],
      ['review', issue.reviewOutcome], ['rework', issue.reworkCount || null],
      ['created', ago(issue.createdAt, ctx.deps.now())], ['id', issue.id],
    ]);
    if (issue.body) ctx.lines(['', issue.body.trimEnd()]);
    if (issue.expectedOutput) ctx.lines(['', ctx.style.dim('expected output:'), issue.expectedOutput.trimEnd()]);
    for (const c of comments) {
      const who = c.authorKind === 'agent' ? name(c.authorId) : c.authorKind === 'human' ? 'you' : c.authorKind;
      ctx.lines(['', ctx.style.dim(`── ${who} · ${ago(c.createdAt, ctx.deps.now())}`), c.body.trimEnd()]);
    }
  });
}

export function workCommands(program: Command, deps: CliDeps): void {
  const goal = program.command('goal').description('goals: what the organization is trying to achieve');

  goal
    .command('list')
    .description('list goals')
    .option('--status <status>', `only goals with this status (${GOAL_STATUSES.join(', ')})`)
    .action(action(deps, async (ctx, _a, opts) => {
      const o = await ctx.org();
      const [goals, name] = await Promise.all([ctx.client().listGoals(o, compact({ status: choice(opts, 'status', GOAL_STATUSES) })), agentNames(ctx, o)]);
      ctx.emit(goals, () => ctx.table(
        ['title', 'level', 'status', 'owner', 'metric', 'id'],
        goals.map((g) => [clip(g.title, 60), g.level, g.status, name(g.ownerAgentId), clip(g.successMetric, 40), g.id]),
        'no goals yet — set one: conductor goal create "…"',
      ));
    }));

  goal
    .command('create <title>')
    .description('create a goal')
    .option('--description <text>', 'more detail')
    .option('--parent <goal>', 'parent goal (title or id)')
    .option('--level <level>', `${GOAL_LEVELS.join(' | ')} (default org)`)
    .option('--dept <dept>', 'owning department')
    .option('--owner <agent>', 'owning agent')
    .option('--metric <text>', 'how success is measured')
    .option('--target <text>', 'the target value')
    .option('--weight <n>', 'relative importance')
    .option('--due <date>', 'due date, e.g. 2026-03-31')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const g = await ctx.client().createGoal(o, compact({
        title: arg(args, 0, 'title'),
        description: str(opts, 'description'),
        parentGoalId: str(opts, 'parent') ? (await resolveGoal(ctx, o, str(opts, 'parent')!)).id : undefined,
        level: choice(opts, 'level', GOAL_LEVELS),
        deptId: str(opts, 'dept') ? (await resolveDept(ctx, o, str(opts, 'dept')!)).id : undefined,
        ownerAgentId: str(opts, 'owner') ? (await resolveAgent(ctx, o, str(opts, 'owner')!)).id : undefined,
        successMetric: str(opts, 'metric'),
        target: str(opts, 'target'),
        weight: num(opts, 'weight', { min: 0 }),
        due: str(opts, 'due') ? parseDue(str(opts, 'due')!) : undefined,
      }));
      ctx.emit(g, () => ctx.ok(`created goal "${g.title}" (${g.id})`));
    }));

  goal
    .command('tree')
    .description('print the goal tree with issue progress')
    .action(action(deps, async (ctx) => {
      const tree = await ctx.client().goalTree(await ctx.org());
      ctx.emit(tree, () => (tree.length ? ctx.lines(goalLines(tree)) : ctx.line(ctx.style.dim('no goals yet'))));
    }));

  const issue = program.command('issue').description('issues: units of work assigned to agents');

  issue
    .command('list')
    .description('list issues (open ones by default)')
    .option('--status <status,...>', `filter by status (${ISSUE_STATUSES.join(', ')})`)
    .option('--assignee <agent>', 'only issues assigned to this agent')
    .option('--goal <goal>', 'only issues under this goal')
    .option('--search <text>', 'full-text search')
    .option('--all', 'include done and cancelled issues')
    .option('--limit <n>', 'maximum rows', '100')
    .action(action(deps, async (ctx, _a, opts) => {
      const o = await ctx.org();
      const status = choices(opts, 'status', ISSUE_STATUSES) ?? (flag(opts, 'all') ? undefined : [...OPEN_STATUSES]);
      const page = await ctx.client().listIssues(o, compact({
        status,
        assigneeAgentId: str(opts, 'assignee') ? (await resolveAgent(ctx, o, str(opts, 'assignee')!)).id : undefined,
        goalId: str(opts, 'goal') ? (await resolveGoal(ctx, o, str(opts, 'goal')!)).id : undefined,
        search: str(opts, 'search'),
        limit: num(opts, 'limit', { int: true, min: 1, max: 500 }),
      }));
      if (ctx.json) return ctx.printJson(page);
      const [orgRow, name] = await Promise.all([ctx.client().getOrg(o), agentNames(ctx, o)]);
      ctx.table(
        ['key', 'status', 'pri', 'assignee', 'title', 'updated'],
        page.items.map((i) => [issueLabel(orgRow.slug, i), i.status, `P${i.priority}`, name(i.assigneeAgentId), clip(i.title, 70), ago(i.updatedAt, ctx.deps.now())]),
        'no matching issues — file one: conductor issue create "…" --assign <agent>',
      );
      if (page.nextOffset !== null) ctx.note(ctx.style.dim(`more issues exist; raise --limit (showing ${page.items.length})`));
    }));

  issue
    .command('create <title>')
    .description('create an issue')
    .option('--body <text>', 'description; "-" reads it from stdin')
    .option('--assign <agent>', 'assign to an agent (wakes it)')
    .option('--goal <goal>', 'goal this issue serves (title or id)')
    .option('--priority <0-3>', '0 urgent · 1 high · 2 normal (default) · 3 low')
    .option('--expected-output <text>', 'what "done" looks like')
    .option('--type <task-type>', 'task type, used for scorecards and memory recall')
    .option('--reviewer <agent>', 'agent that reviews the result')
    .option('--parent <issue>', 'parent issue')
    .option('--label <label...>', 'labels')
    .option('--status <status>', `initial status (${ISSUE_STATUSES.join(', ')})`)
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const assign = str(opts, 'assign');
      const labels = Array.isArray(opts.label) ? (opts.label as string[]).flatMap((l) => l.split(',')).map((l) => l.trim()).filter(Boolean) : undefined;
      const created = await ctx.client().createIssue(o, compact({
        title: arg(args, 0, 'title'),
        body: str(opts, 'body') === '-' ? await ctx.deps.readStdin() : str(opts, 'body'),
        assigneeAgentId: assign ? (await resolveAgent(ctx, o, assign)).id : undefined,
        goalId: str(opts, 'goal') ? (await resolveGoal(ctx, o, str(opts, 'goal')!)).id : undefined,
        priority: num(opts, 'priority', { int: true, min: 0, max: 3 }),
        expectedOutput: str(opts, 'expectedOutput'),
        taskType: str(opts, 'type'),
        reviewerAgentId: str(opts, 'reviewer') ? (await resolveAgent(ctx, o, str(opts, 'reviewer')!)).id : undefined,
        parentIssueId: str(opts, 'parent') ? (await resolveIssue(ctx, o, str(opts, 'parent')!)).id : undefined,
        labels,
        status: choice(opts, 'status', ISSUE_STATUSES),
      }));
      if (ctx.json) return ctx.printJson(created);
      const orgRow = await ctx.client().getOrg(o);
      ctx.ok(`created ${issueLabel(orgRow.slug, created)}: ${created.title}`);
      ctx.line(assign
        ? `  assigned to ${assign}; it picks the issue up on its next wake. Start now: conductor run now ${assign} --issue ${created.number}`
        : `  unassigned — assign it: conductor issue assign ${created.number} <agent>`);
    }));

  issue
    .command('show <issue>')
    .description('show an issue with its comments')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      await showIssue(ctx, o, await resolveIssue(ctx, o, arg(args, 0, 'issue')));
    }));

  issue
    .command('comment <issue> <body...>')
    .description('comment on an issue; @mention an agent to wake it ("-" reads the body from stdin)')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const text = arg(args, 1, 'body');
      const body = text === '-' ? await ctx.deps.readStdin() : text;
      if (!body.trim()) throw new UsageError('the comment body is empty');
      const c = await ctx.client().addComment(o, issueKey(arg(args, 0, 'issue')), { body });
      ctx.emit(c, () => ctx.ok(`commented on ${arg(args, 0, 'issue')}`));
    }));

  issue
    .command('assign <issue> <agent>')
    .description('assign an issue to an agent ("none" unassigns)')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const who = arg(args, 1, 'agent');
      const agent = ['none', 'nobody', '-'].includes(who.toLowerCase()) ? null : await resolveAgent(ctx, o, who);
      const updated = await ctx.client().assignIssue(o, issueKey(arg(args, 0, 'issue')), agent?.id ?? null);
      ctx.emit(updated, () => ctx.ok(agent ? `#${updated.number} assigned to ${agent.slug}` : `#${updated.number} unassigned`));
    }));

  issue
    .command('review <issue> <outcome>')
    .description(`record your verdict on an issue in review: ${REVIEW_OUTCOMES.join(' | ')}`)
    .option('--note <text>', 'feedback for the agent (it learns from this)')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const outcome = oneOf(arg(args, 1, 'outcome'), '<outcome>', REVIEW_OUTCOMES);
      const updated = await ctx.client().reviewIssue(o, issueKey(arg(args, 0, 'issue')), compact({ outcome, note: str(opts, 'note') }));
      ctx.emit(updated, () => ctx.ok(`#${updated.number} ${outcome} → ${updated.status}`));
    }));
}
