import type { Command } from 'commander';
import type { Agent, AgentActionResponse, HireAgentInput, OrgChartNode, ProviderBinding, UpdateAgentRequest } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, arg, choice, compact, flag, isEmpty, num, oneOf, parseProvider, str, type Opts } from '../command.js';
import { UsageError } from '../errors.js';
import { percent, usd } from '../output.js';
import { resolveAgent, resolveDept, resolveIssue } from '../resolve.js';

const AUTONOMY = ['assist', 'supervised', 'autonomous', 'lead'];
const STATUSES = ['active', 'paused', 'terminated'] as const;

const binding = (a: Agent) => (a.providerBinding ? `${a.providerBinding.adapter}${a.model ?? a.providerBinding.model ? `:${a.model ?? a.providerBinding.model}` : ''}` : a.model ? `(org default):${a.model}` : '(org default)');

/** Flags shared by `hire` and `update`. */
function configOptions(cmd: Command): Command {
  return cmd
    .option('--name <name>', 'display name')
    .option('--goal <text>', 'what this agent is trying to achieve')
    .option('--backstory <text>', 'persona and working style')
    .option('--reports-to <agent>', 'manager (slug, name or id); "none" for the top of the chart')
    .option('--provider <adapter[:model]>', 'provider binding, e.g. claude_local or claude_api:claude-sonnet-4-5')
    .option('--model <model>', 'model override (see: conductor adapter models <adapter>)')
    .option('--auth <mode>', 'with --provider claude_local|codex_local: login (this Mac\'s CLI login) | token (stored long-lived Claude token) | api_key (stored key, metered)')
    .option('--effort <level>', 'with --provider: effort / reasoning level (see: conductor adapter models <adapter>)')
    .option('--cron <expr>', 'heartbeat schedule, e.g. "*/30 * * * *"; "none" disables it')
    .option('--budget <usd>', 'monthly budget cap in USD')
    .option('--autonomy <0-3>', '0 assist · 1 supervised · 2 autonomous · 3 lead')
    .option('--lead', 'make the agent the department lead');
}

async function configPatch(ctx: Ctx, org: string, opts: Opts): Promise<Partial<HireAgentInput>> {
  const none = (v: string | undefined) => v !== undefined && ['none', 'null', '-'].includes(v.toLowerCase());
  const reportsTo = str(opts, 'reportsTo');
  const cron = str(opts, 'cron');
  return compact({
    name: str(opts, 'name'),
    goal: str(opts, 'goal'),
    backstory: str(opts, 'backstory'),
    reportsTo: reportsTo === undefined ? undefined : none(reportsTo) ? null : (await resolveAgent(ctx, org, reportsTo)).id,
    providerBinding: bindingFrom(opts),
    model: str(opts, 'model'),
    heartbeatCron: cron === undefined ? undefined : none(cron) ? null : cron,
    budgetUsd: num(opts, 'budget', { min: 0 }),
    autonomyLevel: num(opts, 'autonomy', { int: true, min: 0, max: 3 }),
    isLead: flag(opts, 'lead') ? true : undefined,
  });
}

/** `--provider adapter[:model]` plus `--auth` / `--effort`, which only make sense on an explicit binding. */
function bindingFrom(opts: Opts): ProviderBinding | undefined {
  const provider = str(opts, 'provider');
  const auth = str(opts, 'auth');
  const effort = str(opts, 'effort');
  if (!provider) {
    if (auth || effort) throw new UsageError('--auth and --effort set part of a provider binding; pass --provider too');
    return undefined;
  }
  const b = parseProvider(provider);
  if (auth) {
    const mode = oneOf(auth, '--auth', ['login', 'token', 'api_key'] as const);
    if (!['claude_local', 'codex_local'].includes(b.adapter)) throw new UsageError('--auth applies to the local CLI adapters (claude_local, codex_local)');
    if (mode === 'token' && b.adapter !== 'claude_local') throw new UsageError('--auth token is only for claude_local (Codex has no long-lived token)');
    if (mode !== 'login') b.auth = mode;
  }
  if (effort) b.config = { ...(b.config ?? {}), [/^(codex_local|openai_api)$/.test(b.adapter) ? 'reasoningEffort' : 'effort']: effort };
  return b;
}

/** Hire/terminate either happen directly (owner) or come back as a pending approval. */
function reportAction(ctx: Ctx, r: AgentActionResponse, verb: string): void {
  ctx.emit(r, () => {
    if (r.agent) ctx.ok(`${verb} ${r.agent.name} (${r.agent.slug}) — ${r.agent.role}`);
    else if (r.approval) ctx.line(`queued for approval: ${r.approval.title}\n  decide with: conductor approvals approve ${r.approval.id}`);
  });
}

function chartLines(nodes: OrgChartNode[], prefix = ''): string[] {
  return nodes.flatMap((n, i) => {
    const last = i === nodes.length - 1;
    const a = n.agent;
    const tags = [n.department.name, n.isLead ? 'lead' : '', a.status !== 'active' ? a.status : ''].filter(Boolean).join(', ');
    return [`${prefix}${last ? '└─ ' : '├─ '}${a.name} — ${a.role}  [${a.slug}; ${tags}]`, ...chartLines(n.reports, prefix + (last ? '   ' : '│  '))];
  });
}

export function agentCommands(program: Command, deps: CliDeps): void {
  const agent = program.command('agent').description('agents: hire, configure, pause and talk to them');

  agent
    .command('list')
    .description('list agents')
    .option('--dept <dept>', 'only this department')
    .option('--status <status>', `only agents with this status (${STATUSES.join(', ')})`)
    .action(action(deps, async (ctx, _a, opts) => {
      const o = await ctx.org();
      const status = choice(opts, 'status', STATUSES);
      const dept = str(opts, 'dept') ? await resolveDept(ctx, o, str(opts, 'dept')!) : undefined;
      const [agents, depts] = await Promise.all([ctx.client().listAgents(o, compact({ deptId: dept?.id, status })), ctx.client().listDepartments(o)]);
      const deptSlug = new Map(depts.map((d) => [d.id, d.slug]));
      const slugOf = new Map(agents.map((a) => [a.id, a.slug]));
      ctx.emit(agents, () => ctx.table(
        ['slug', 'name', 'role', 'dept', 'reports to', 'provider', 'heartbeat', 'status'],
        agents.map((a) => [a.slug, a.name, a.role, deptSlug.get(a.deptId) ?? a.deptId, a.reportsTo ? slugOf.get(a.reportsTo) ?? a.reportsTo : '-', binding(a), a.heartbeatCron, a.status === 'paused' && a.pausedReason ? `paused (${a.pausedReason})` : a.status]),
        'no agents yet — hire one: conductor agent hire --dept <dept> --role "…"',
      ));
    }));

  configOptions(agent.command('hire').description('hire an agent into a department'))
    .requiredOption('--dept <dept>', 'department (slug, name or id)')
    .requiredOption('--role <role>', 'job title, e.g. "Backend Engineer"')
    .action(action(deps, async (ctx, _a, opts) => {
      const o = await ctx.org();
      const role = str(opts, 'role')!;
      const dept = await resolveDept(ctx, o, str(opts, 'dept')!);
      const patch = await configPatch(ctx, o, opts);
      const r = await ctx.client().hireAgent(o, { ...patch, deptId: dept.id, role, name: patch.name ?? role });
      reportAction(ctx, r, 'hired');
      if (!ctx.json && r.agent) ctx.line(`  next: conductor issue create "…" --assign ${r.agent.slug}   ·   conductor run now ${r.agent.slug}`);
    }));

  agent
    .command('show <agent>')
    .description('show an agent with its effective skills, connectors and budget')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const a = await resolveAgent(ctx, o, arg(args, 0, 'agent'));
      const [capabilities, budget] = await Promise.all([ctx.client().agentCapabilities(o, a.id), ctx.client().agentBudget(o, a.id)]);
      ctx.emit({ agent: a, capabilities, budget }, () => {
        ctx.fields([
          ['name', a.name], ['slug', a.slug], ['id', a.id], ['role', a.role], ['status', a.status === 'paused' && a.pausedReason ? `paused (${a.pausedReason})` : a.status],
          ['goal', a.goal], ['backstory', a.backstory], ['provider', binding(a)], ['heartbeat', a.heartbeatCron ?? 'none (event-driven only)'],
          ['autonomy', `${a.autonomyLevel} (${AUTONOMY[a.autonomyLevel] ?? 'custom'})`],
          ['budget', a.budgetUsd === null ? 'uncapped' : `${usd(a.budgetUsd)}/month`],
          ['remaining', budget.remainingUsd === null ? 'uncapped' : `${usd(budget.remainingUsd)}${budget.allowed ? '' : `  BLOCKED: ${budget.reason ?? 'over budget'}`}`],
          ['skills', capabilities.skillNames.join(', ') || 'none'],
          ['connectors', capabilities.connectorIds.join(', ') || 'none'],
        ]);
      });
    }));

  configOptions(agent.command('update <agent>').description('change an agent\'s configuration'))
    .option('--dept <dept>', 'move to another department')
    .option('--role <role>', 'new job title')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const a = await resolveAgent(ctx, o, arg(args, 0, 'agent'));
      const patch: UpdateAgentRequest = {
        ...(await configPatch(ctx, o, opts)),
        ...compact({ role: str(opts, 'role'), deptId: str(opts, 'dept') ? (await resolveDept(ctx, o, str(opts, 'dept')!)).id : undefined }),
      };
      if (isEmpty(patch)) throw new UsageError('nothing to update: pass at least one option (see `conductor agent update --help`)');
      const updated = await ctx.client().updateAgent(o, a.id, patch);
      ctx.emit(updated, () => ctx.ok(`updated ${updated.slug}: ${Object.keys(patch).join(', ')}`));
    }));

  agent
    .command('pause <agent>')
    .description('pause an agent (no new runs)')
    .option('--reason <text>', 'why')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const a = await resolveAgent(ctx, o, arg(args, 0, 'agent'));
      const r = await ctx.client().pauseAgent(o, a.id, str(opts, 'reason'));
      ctx.emit(r, () => ctx.ok(`paused ${r.slug}; resume with: conductor agent resume ${r.slug}`));
    }));

  agent
    .command('resume <agent>')
    .description('resume a paused agent')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const a = await resolveAgent(ctx, o, arg(args, 0, 'agent'));
      const r = await ctx.client().resumeAgent(o, a.id);
      ctx.emit(r, () => ctx.ok(`resumed ${r.slug}`));
    }));

  agent
    .command('terminate <agent>')
    .description('terminate an agent for good (history is kept)')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const a = await resolveAgent(ctx, o, arg(args, 0, 'agent'));
      reportAction(ctx, await ctx.client().terminateAgent(o, a.id), 'terminated');
    }));

  agent
    .command('chart')
    .description('print the org chart')
    .action(action(deps, async (ctx) => {
      const chart = await ctx.client().orgChart(await ctx.org());
      ctx.emit(chart, () => (chart.length ? ctx.lines(chartLines(chart)) : ctx.line(ctx.style.dim('no agents yet'))));
    }));

  agent
    .command('scorecard <agent>')
    .description('success rate, rework and cost trend for an agent')
    .option('--days <n>', 'window in days', '30')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const a = await resolveAgent(ctx, o, arg(args, 0, 'agent'));
      const sc = await ctx.client().agentScorecard(o, a.id, { days: num(opts, 'days', { int: true, min: 1, max: 365 }) });
      ctx.emit(sc, () => {
        ctx.line(`${ctx.style.bold(a.name)} — last ${sc.days} days`);
        ctx.fields([['runs', sc.runs], ['issues closed', sc.issuesClosed], ['success', percent(sc.successRate)], ['rework', percent(sc.reworkRate)], ['cost/issue', usd(sc.costPerIssue)]]);
        if (sc.trend.length) {
          ctx.line();
          ctx.table(['week of', 'runs', 'success', 'cost/issue'], sc.trend.map((t) => [new Date(t.weekStart).toISOString().slice(0, 10), t.runs, percent(t.successRate), usd(t.costPerIssue)]));
        }
        if (sc.byTaskType.length) {
          ctx.line();
          ctx.table(['task type', 'runs', 'success', 'cost/issue'], sc.byTaskType.map((t) => [t.taskType, t.runs, percent(t.successRate), usd(t.costPerIssue)]));
        }
      });
    }));

  agent
    .command('chat <agent> <message...>')
    .description('send one message to an agent and print its reply')
    .option('--issue <issue>', 'talk in the context of an issue')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const a = await resolveAgent(ctx, o, arg(args, 0, 'agent'));
      const issueId = str(opts, 'issue') ? (await resolveIssue(ctx, o, str(opts, 'issue')!)).id : undefined;
      if (!ctx.json) ctx.note(ctx.style.dim(`${a.name} is thinking…`));
      const r = await ctx.client().chatWithAgent(o, a.id, compact({ message: arg(args, 1, 'message'), issueId }));
      ctx.emit(r, () => {
        ctx.line(r.reply);
        ctx.note(ctx.style.dim(`run ${r.runId} · transcript: conductor logs --run ${r.runId}`));
      });
    }));

}
