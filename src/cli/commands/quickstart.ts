import type { Command } from 'commander';
import type { OrgChartNode, OrgTemplate, ProviderBinding } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, flag, parseProvider, str } from '../command.js';
import { CliError, EXIT, UsageError, isUnreachable, unreachableError } from '../errors.js';
import { clip } from '../output.js';
import { issueLabel, pick, resolveAgent } from '../resolve.js';

const DEFAULT_TEMPLATE = 'saas-startup';

/** The first usable provider: local CLI logins (flat-rate) before metered API keys. */
async function detectProvider(ctx: Ctx): Promise<{ binding: ProviderBinding; why: string } | null> {
  for (const [bin, adapter] of [['claude', 'claude_local'], ['codex', 'codex_local']] as const) {
    const res = await ctx.deps.exec(bin, ['--version'], { timeoutMs: 10_000 });
    if (res.code === 0) return { binding: { adapter }, why: `found the ${bin} CLI (${clip(res.stdout, 40) || 'installed'}); runs use your local login` };
  }
  for (const [ref, adapter] of [['conductor/anthropic-api-key', 'claude_api'], ['conductor/openai-api-key', 'openai_api']] as const) {
    if ((await ctx.client().secretExists(ref)).exists) return { binding: { adapter, authRef: ref }, why: `found the API key ${ref}` };
  }
  return null;
}

async function ask(ctx: Ctx, question: string, fallback: string | undefined, interactive: boolean): Promise<string | undefined> {
  if (!interactive) return fallback;
  const answer = (await ctx.deps.prompt(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
  return answer || fallback;
}

async function chooseTemplate(ctx: Ctx, templates: OrgTemplate[], wanted: string | undefined, interactive: boolean): Promise<OrgTemplate> {
  if (templates.length === 0) throw new CliError('The daemon offers no organization templates.');
  const fallback = templates.find((t) => t.id === DEFAULT_TEMPLATE) ?? templates[0]!;
  if (wanted) return pick('template', wanted, templates, (t) => [t.id, t.name], (t) => `${t.id}  ${t.name}`, 'conductor org templates');
  if (!interactive) return fallback;
  ctx.note('Templates:');
  templates.forEach((t, i) => ctx.note(`  ${i + 1}. ${t.id.padEnd(18)} ${clip(t.description, 80)}`));
  const answer = (await ask(ctx, 'Template (number or id)', fallback.id, true)) ?? fallback.id;
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= templates.length) return templates[n - 1]!;
  return pick('template', answer, templates, (t) => [t.id, t.name], (t) => `${t.id}  ${t.name}`, 'conductor org templates');
}

/** The top of the chart: the agent that turns the owner's goal into delegated work. */
function chartRoot(chart: OrgChartNode[]): OrgChartNode | undefined {
  return chart.find((n) => n.agent.status === 'active') ?? chart[0];
}

/**
 * The 15-minute path (PRD success metric): org from a template → provider →
 * goal → first issue → run, then where to watch it close.
 */
async function quickstart(ctx: Ctx, opts: Record<string, unknown>): Promise<void> {
  const interactive = ctx.deps.stdinIsTTY && !flag(opts, 'yes') && !ctx.json;
  const say = (text: string) => {
    if (!ctx.json) ctx.line(text);
  };

  // 1. Daemon.
  try {
    const health = await ctx.anonymous().health();
    say(`${ctx.style.green('✓')} daemon ${health.version} is running at ${ctx.baseUrl}`);
  } catch (err) {
    throw isUnreachable(err) ? unreachableError(ctx.baseUrl) : err;
  }
  const client = ctx.client();

  // 2. Organization from a template.
  const template = await chooseTemplate(ctx, await client.listOrgTemplates(), str(opts, 'template'), interactive);
  const name = str(opts, 'name') ?? (await ask(ctx, 'Organization name', undefined, interactive));
  if (!name) throw new UsageError('an organization name is required', ['pass --name "Acme"']);
  const mission = str(opts, 'mission') ?? (await ask(ctx, 'Mission (one sentence, optional)', undefined, interactive));

  // 3. Provider.
  let binding: ProviderBinding;
  if (str(opts, 'provider')) {
    binding = parseProvider(str(opts, 'provider')!);
  } else {
    const found = await detectProvider(ctx);
    if (!found) {
      throw new CliError('No provider is ready, so agents could not run.', EXIT.failure, [
        'log in to a local CLI: run `claude` (Claude Code) or `codex login` once',
        'or store an API key: conductor secret set conductor/anthropic-api-key',
        'then re-run: conductor quickstart   (or force one with --provider adapter[:model])',
      ], 'no_provider');
    }
    binding = found.binding;
    say(`${ctx.style.green('✓')} provider ${binding.adapter}: ${found.why}`);
  }

  const org = await client.createOrgFromTemplate({ templateId: template.id, name, ...(mission ? { mission } : {}), defaultProvider: binding });
  ctx.saveConfig({ defaultOrg: org.slug });
  const [agents, chart] = await Promise.all([client.listAgents(org.id), client.orgChart(org.id)]);
  say(`${ctx.style.green('✓')} created ${org.name} (${org.slug}) from ${template.id}: ${agents.length} agents — now your default org`);

  // 4. Goal.
  const goalTitle = str(opts, 'goal') ?? (await ask(ctx, 'First goal for this org', mission || `Get ${org.name} off the ground`, interactive)) ?? `Get ${org.name} off the ground`;
  const goal = await client.createGoal(org.id, { title: goalTitle, level: 'org' });
  say(`${ctx.style.green('✓')} goal: ${goal.title}`);

  // 5. First issue, assigned.
  const assignee = str(opts, 'assign') ? await resolveAgent(ctx, org.id, str(opts, 'assign')!) : chartRoot(chart)?.agent ?? agents.find((a) => a.status === 'active');
  if (!assignee) throw new CliError(`The template ${template.id} created no agents.`, EXIT.failure, ['hire one: conductor agent hire --dept <dept> --role "…"']);
  const defaultIssue = `Write a short plan for the goal "${clip(goal.title, 120)}" and post it as a comment`;
  const title = str(opts, 'issue') ?? (await ask(ctx, `First issue for ${assignee.name} (${assignee.role})`, defaultIssue, interactive)) ?? defaultIssue;
  const issue = await client.createIssue(org.id, {
    title, goalId: goal.id, assigneeAgentId: assignee.id, status: 'todo',
    expectedOutput: 'A concise result posted as a comment on this issue, then the issue moved to done (or in_review if a reviewer is set).',
  });
  say(`${ctx.style.green('✓')} issue ${issueLabel(org.slug, issue)} assigned to ${assignee.name}: ${issue.title}`);

  // 6. Run.
  let jobId: string | null = null;
  if (opts.run !== false) {
    jobId = (await client.runAgent(org.id, assignee.id, { issueId: issue.id })).jobId;
    say(`${ctx.style.green('✓')} ${assignee.name} is starting on it now`);
  }

  if (ctx.json) return ctx.printJson({ org, provider: binding, goal, issue, agent: assignee, jobId });
  ctx.lines([
    '',
    'Watch it work:',
    `  conductor logs -f --agent ${assignee.slug}     live transcript`,
    `  conductor issue show ${issue.number}                 the result and comments`,
    '  conductor approvals list               anything waiting for you',
    `  conductor open                         the web UI (${ctx.baseUrl})`,
    ...(jobId ? [] : [`Start it when you are ready: conductor run now ${assignee.slug} --issue ${issue.number}`]),
  ]);
}

export function quickstartCommand(program: Command, deps: CliDeps): void {
  program
    .command('quickstart')
    .description('from a running daemon to a first autonomous issue in one command')
    .option('--name <name>', 'organization name')
    .option('--template <id>', `organization template (default ${DEFAULT_TEMPLATE})`)
    .option('--mission <text>', 'what the organization is for')
    .option('--provider <adapter[:model]>', 'provider for every agent (default: detect installed CLIs and stored keys)')
    .option('--goal <text>', 'the first org goal')
    .option('--issue <title>', 'title of the first issue')
    .option('--assign <agent>', 'agent that gets the first issue (default: the top of the org chart)')
    .option('--no-run', 'create everything but do not start the first run')
    .option('-y, --yes', 'never prompt; use flags and defaults')
    .action(action(deps, (ctx, _a, opts) => quickstart(ctx, opts)));
}
