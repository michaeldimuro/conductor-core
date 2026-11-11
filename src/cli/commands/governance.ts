import type { Command } from 'commander';
import type { Approval, Organization } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, arg, compact, flag, oneOf, optArg, str } from '../command.js';
import { CliError, EXIT, SilentExit, UsageError } from '../errors.js';
import { ago, clip, usd } from '../output.js';
import { agentNames, resolveAgent, resolveApproval } from '../resolve.js';

const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'cancelled'] as const;
const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,200}$/;

function secretRef(ref: string): string {
  if (!SECRET_REF.test(ref) || ref.includes('..')) throw new UsageError(`invalid secret ref "${ref}"`, ['refs look like conductor/anthropic-api-key or org/<slug>/<name>']);
  return ref;
}

/**
 * Where a secret value comes from, safest first: piped stdin, a hidden prompt,
 * and only then `--value` (which lands in shell history). The value is never
 * written to stdout, stderr or `--json` output.
 */
async function readSecretValue(ctx: Ctx, ref: string, fromFlag: string | undefined): Promise<string> {
  if (fromFlag !== undefined) {
    ctx.warn('--value puts the secret in your shell history and process list; prefer piping it: `pbpaste | conductor secret set <ref>`');
    return fromFlag;
  }
  if (!ctx.deps.stdinIsTTY) return (await ctx.deps.readStdin()).replace(/\r?\n$/, '');
  return ctx.deps.prompt(`Value for ${ref} (input hidden): `, { hidden: true });
}

async function decide(ctx: Ctx, id: string, decision: 'approved' | 'denied', note: string | undefined): Promise<void> {
  const approval = await resolveApproval(ctx, id);
  if (approval.status !== 'pending') throw new CliError(`Approval ${approval.id} is already ${approval.status}.`, EXIT.failure, [], 'conflict');
  const decided = await ctx.client().decideApproval(approval.orgId, approval.id, compact({ decision, note }));
  ctx.emit(decided, () => ctx.ok(`${decision}: ${decided.title}`));
}

function parseSettingValue(raw: string): unknown {
  if (raw === 'null' || raw === 'none' || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Bare numbers and booleans are valid JSON; strings like URLs are not and stay strings.
    return parsed;
  } catch {
    return raw;
  }
}

export function governanceCommands(program: Command, deps: CliDeps): void {
  const approvals = program.command('approvals').description('the approval inbox: actions agents may not take without you');

  approvals
    .command('list')
    .description('list approvals across every org (pending by default); --org narrows to one')
    .option('--status <status>', `${APPROVAL_STATUSES.join(' | ')} | all`, 'pending')
    .option('--kind <kind>', 'only this kind, e.g. hire_agent, external_send')
    .action(action(deps, async (ctx, _a, opts) => {
      const raw = str(opts, 'status') ?? 'pending';
      const query = compact({ status: raw === 'all' ? undefined : oneOf(raw, '--status', APPROVAL_STATUSES), kind: str(opts, 'kind'), limit: 500 });
      const scoped = ctx.globals.org;
      const [rows, orgs] = await Promise.all([scoped ? ctx.client().listApprovals(scoped, query) : ctx.client().approvalInbox(query), ctx.json ? Promise.resolve<Organization[]>([]) : ctx.client().listOrgs({ includeArchived: true })]);
      const slug = new Map(orgs.map((o) => [o.id, o.slug]));
      ctx.emit(rows, () => {
        ctx.table(
          ['id', 'org', 'kind', 'title', 'status', 'requested'],
          rows.map((a: Approval) => [a.id, slug.get(a.orgId) ?? a.orgId, a.kind, clip(a.title, 70), a.status, ago(a.createdAt, ctx.deps.now())]),
          raw === 'pending' ? 'inbox zero: nothing is waiting for you' : 'no approvals match',
        );
        if (rows.some((a) => a.status === 'pending')) ctx.note(ctx.style.dim('decide: conductor approvals approve <id>   ·   conductor approvals deny <id> --note "…"'));
      });
    }));

  approvals
    .command('show <id>')
    .description('show one approval with its payload')
    .action(action(deps, async (ctx, args) => {
      const a = await resolveApproval(ctx, arg(args, 0, 'id'));
      ctx.emit(a, () => {
        ctx.fields([
          ['id', a.id], ['kind', a.kind], ['title', a.title], ['status', a.status], ['org', a.orgId], ['requested by', a.requesterAgentId ?? 'system'],
          ['issue', a.issueId], ['run', a.runId], ['requested', ago(a.createdAt, ctx.deps.now())], ['expires', a.expiresAt ? ago(a.expiresAt, ctx.deps.now()) : null],
          ['decided by', a.decidedBy], ['note', a.decisionNote],
        ]);
        if (Object.keys(a.payload).length) ctx.lines(['', ctx.style.dim('payload:'), JSON.stringify(a.payload, null, 2)]);
      });
    }));

  for (const [verb, decision] of [['approve', 'approved'], ['deny', 'denied']] as const) {
    approvals
      .command(`${verb} <id>`)
      .description(`${verb} a pending approval`)
      .option('--note <text>', 'reason, shown to the requesting agent')
      .action(action(deps, (ctx, args, opts) => decide(ctx, arg(args, 0, 'id'), decision, str(opts, 'note'))));
  }

  program
    .command('budget')
    .description('spend against caps for the org, or one agent with --agent')
    .option('--agent <agent>', 'show one agent\'s budget status')
    .action(action(deps, async (ctx, _a, opts) => {
      const o = await ctx.org();
      if (str(opts, 'agent')) {
        const a = await resolveAgent(ctx, o, str(opts, 'agent')!);
        const b = await ctx.client().agentBudget(o, a.id);
        return ctx.emit(b, () => {
          ctx.fields([
            ['agent', a.slug], ['allowed', b.allowed ? 'yes' : ctx.style.red(`no — ${b.reason ?? 'over budget'}`)],
            ['remaining', b.remainingUsd === null ? 'uncapped' : usd(b.remainingUsd)],
            ['seat time', `${Math.round(b.seat.usedSeconds / 60)} min used${b.seat.capSeconds === null ? '' : ` of ${Math.round(b.seat.capSeconds / 60)}`}`],
          ]);
          ctx.table(['scope', 'id', 'cap', 'spent', 'used'], b.lines.map((l) => [l.scope, l.id, l.capUsd === null ? 'uncapped' : usd(l.capUsd), usd(l.spentUsd), l.pct === null ? '-' : `${Math.round(l.pct)}%`]));
        });
      }
      const summary = await ctx.client().budgetSummary(o);
      if (ctx.json) return ctx.printJson(summary);
      const [agentName, depts] = await Promise.all([agentNames(ctx, o), ctx.client().listDepartments(o)]);
      const deptSlug = new Map(depts.map((d) => [d.id, d.slug]));
      const name = (id: string | null | undefined, scope = 'agent') => (scope === 'dept' ? deptSlug.get(id ?? '') ?? id ?? '-' : scope === 'agent' ? agentName(id) : id ?? '-');
      ctx.emit(summary, () => {
        ctx.fields([['spent', usd(summary.totalUsd)], ['seat time', `${Math.round(summary.seatSeconds / 60)} min`]]);
        if (summary.lines.length) {
          ctx.line();
          ctx.table(['scope', 'id', 'cap', 'spent', 'used'], summary.lines.map((l) => [l.scope, name(l.id, l.scope), l.capUsd === null ? 'uncapped' : usd(l.capUsd), usd(l.spentUsd), l.pct === null ? '-' : `${Math.round(l.pct)}%`]));
        }
        if (summary.byAgent.length) {
          ctx.line();
          ctx.table(['agent', 'runs', 'tokens in', 'tokens out', 'cost'], summary.byAgent.map((r) => [name(r.agentId), r.runs, r.tokensIn, r.tokensOut, usd(r.costUsd)]));
        }
      });
    }));

  program
    .command('kill-switch <state>')
    .description('global kill switch: `on` cancels every run in every org and blocks new ones; `off` releases it')
    .action(action(deps, async (ctx, args) => {
      const state = oneOf(arg(args, 0, 'state'), '<state>', ['on', 'off'] as const);
      const r = state === 'on' ? await ctx.client().engageKillSwitch() : await ctx.client().releaseKillSwitch();
      ctx.emit(r, () => (r.engaged ? ctx.line(`${ctx.style.red('■')} global kill switch ENGAGED — all runs stopped. Release with: conductor kill-switch off`) : ctx.ok('global kill switch released')));
    }));

  const config = program.command('config').description('daemon settings');
  config
    .command('get [key]')
    .description('show one setting, or all of them')
    .action(action(deps, async (ctx, args) => {
      const key = optArg(args, 0);
      const settings = key ? [await ctx.client().getSetting(key)] : await ctx.client().listSettings();
      ctx.emit(key ? settings[0] : settings, () => ctx.table(['key', 'value'], settings.map((s) => [s.key, s.value === null ? '(unset)' : typeof s.value === 'string' ? s.value : JSON.stringify(s.value)])));
    }));
  config
    .command('set <key> [value]')
    .description('change a setting (omit the value, or pass "null", to unset it)')
    .action(action(deps, async (ctx, args) => {
      const key = arg(args, 0, 'key');
      const s = await ctx.client().putSetting(key, parseSettingValue(optArg(args, 1) ?? 'null'));
      ctx.emit(s, () => {
        ctx.ok(`${s.key} = ${s.value === null ? '(unset)' : typeof s.value === 'string' ? s.value : JSON.stringify(s.value)}`);
        if (key === 'daemon.public_url') ctx.line('  takes effect after: conductor restart');
      });
    }));

  const secret = program.command('secret').description('secrets live in the macOS Keychain; the CLI can write them but never read them back');
  secret
    .command('set <ref>')
    .description('store a secret; the value is read from stdin or a hidden prompt and never echoed')
    .option('--value <value>', 'pass the value inline (discouraged: it lands in shell history)')
    .action(action(deps, async (ctx, args, opts) => {
      const ref = secretRef(arg(args, 0, 'ref'));
      const value = await readSecretValue(ctx, ref, str(opts, 'value'));
      if (!value) throw new UsageError('the secret value is empty');
      const r = await ctx.client().putSecret(ref, value);
      ctx.emit({ ref: r.ref, exists: r.exists }, () => ctx.ok(`stored ${r.ref}`));
    }));
  secret
    .command('delete <ref>')
    .description('delete a secret')
    .action(action(deps, async (ctx, args) => {
      const r = await ctx.client().deleteSecret(secretRef(arg(args, 0, 'ref')));
      ctx.emit({ ref: r.ref, exists: r.exists }, () => ctx.ok(`deleted ${r.ref}`));
    }));
  secret
    .command('has <ref>')
    .description('check whether a secret exists (exit code 1 when it does not)')
    .action(action(deps, async (ctx, args) => {
      const r = await ctx.client().secretExists(secretRef(arg(args, 0, 'ref')));
      ctx.emit({ ref: r.ref, exists: r.exists }, () => ctx.line(r.exists ? `${ctx.style.green('✓')} ${r.ref} is set` : `${ctx.style.red('✗')} ${r.ref} is not set`));
      if (!r.exists) throw new SilentExit(EXIT.failure);
    }));

  const adapter = program.command('adapter').description('provider adapters');
  adapter
    .command('list')
    .description('list installed adapters')
    .action(action(deps, async (ctx) => {
      const adapters = await ctx.client().listAdapters();
      ctx.emit(adapters, () => ctx.table(
        ['id', 'name', 'origin', 'tools', 'mcp', 'resume', 'vision', 'browser'],
        adapters.map((a) => [a.id, a.name, a.builtin ? 'builtin' : 'plugin', a.capabilities.tools, a.capabilities.mcp, a.capabilities.resume, a.capabilities.vision, a.capabilities.browser]),
      ));
    }));
  adapter
    .command('models <id>')
    .description('models an adapter can run (from the CLI, the provider API with a stored key, or the built-in list)')
    .option('--all', 'include models the provider hides by default')
    .option('--refresh', 'ask the CLI / provider again instead of the cached list')
    .action(action(deps, async (ctx, args, opts) => {
      const id = arg(args, 0, 'id');
      const org = ctx.chosenOrg();
      const cat = await ctx.client().listModels(id, { ...(org ? { orgId: org } : {}), refresh: flag(opts, 'refresh') });
      const shown = flag(opts, 'all') ? cat.models : cat.models.filter((m) => !m.hidden);
      ctx.emit(cat, () => {
        ctx.table(['model', 'name', 'kind', 'effort'], shown.map((m) => [
          m.id, m.label, m.kind === 'alias' ? 'alias (latest)' : m.hidden ? 'hidden' : '',
          (m.efforts ?? cat.efforts).map((e) => (e === m.defaultEffort ? `${e}*` : e)).join(' '),
        ]), `${id} publishes no model list; any model id it understands works`);
        const tail: string[] = [`source: ${cat.sources.join(', ') || 'none'}`];
        if (cat.defaultModel) tail.push(`default when unset: ${cat.defaultModel}`);
        if (cat.effortKey) tail.push(`effort goes in config.${cat.effortKey} (agent --effort)`);
        ctx.note(ctx.style.dim(tail.join(' · ')));
        for (const n of cat.notes) ctx.note(ctx.style.dim(n));
      });
    }));
  adapter
    .command('rescan')
    .description('load adapter plugins added to the plugin folder (<home>/adapters) without restarting the daemon')
    .action(action(deps, async (ctx) => {
      const r = await ctx.client().rescanAdapters();
      ctx.emit(r, () => {
        ctx.line(`added: ${r.added.join(', ') || 'none'}; removed: ${r.removed.join(', ') || 'none'}`);
        for (const sk of r.skipped) ctx.line(`skipped ${sk.folder}: ${sk.error}`);
      });
    }));
  adapter
    .command('test <id>')
    .description('test an adapter\'s connection (exit code 1 when it fails)')
    .option('--auth-ref <ref>', 'secret ref of the API key to test with (default: org/<org>/…-api-key, then conductor/…-api-key)')
    .option('--model <model>', 'model to check')
    .action(action(deps, async (ctx, args, opts) => {
      const id = arg(args, 0, 'id');
      const authRef = str(opts, 'authRef') ? secretRef(str(opts, 'authRef')!) : undefined;
      // Without an explicit key the daemon resolves the conventional refs, the chosen org's first.
      const h = await ctx.client().testAdapter(id, compact({ authRef, model: str(opts, 'model'), orgId: authRef ? undefined : ctx.chosenOrg() }));
      ctx.emit({ adapter: id, ...h }, () => ctx.line(`${h.ok ? ctx.style.green('✓') : ctx.style.red('✗')} ${id}${h.version ? ` ${h.version}` : ''}: ${h.detail ?? (h.ok ? 'ok' : 'failed')}`));
      if (!h.ok) throw new SilentExit(EXIT.failure);
    }));

}
