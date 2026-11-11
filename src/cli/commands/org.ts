import type { Command } from 'commander';
import type { OrgBundle, Organization } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, arg, compact, flag, num, optArg, parseProvider, str } from '../command.js';
import { CliError, UsageError } from '../errors.js';
import { clip, usd } from '../output.js';
import { resolveDept } from '../resolve.js';

const provider = (o: Organization) => (o.defaultProvider ? `${o.defaultProvider.adapter}${o.defaultProvider.model ? `:${o.defaultProvider.model}` : ''}` : '-');

function showOrg(ctx: Ctx, o: Organization): void {
  ctx.fields([
    ['name', o.name], ['slug', o.slug], ['id', o.id], ['status', o.status], ['mission', o.mission],
    ['provider', provider(o)], ['budget', o.budgetMonthlyUsd === null ? 'uncapped' : `${usd(o.budgetMonthlyUsd)}/month`],
    ['max runs', o.maxConcurrentRuns], ['kill switch', o.killSwitch ? ctx.style.red('ENGAGED') : 'off'],
  ]);
}

/** Org named on the command line, else the current one. */
const target = (ctx: Ctx, explicit: string | undefined) => (explicit ? Promise.resolve(explicit) : ctx.org());

export function orgCommands(program: Command, deps: CliDeps): void {
  const org = program.command('org').description('organizations: isolated companies of agents');

  org
    .command('list')
    .description('list organizations')
    .option('--all', 'include archived organizations')
    .action(action(deps, async (ctx, _a, opts) => {
      const orgs = await ctx.client().listOrgs(flag(opts, 'all') ? { includeArchived: true } : undefined);
      const current = ctx.chosenOrg();
      ctx.emit(orgs, () => ctx.table(
        ['', 'slug', 'name', 'status', 'provider', 'budget', 'kill'],
        orgs.map((o) => [o.slug === current || o.id === current ? '*' : '', o.slug, o.name, o.status, provider(o), o.budgetMonthlyUsd === null ? 'uncapped' : usd(o.budgetMonthlyUsd), o.killSwitch ? 'ENGAGED' : '']),
        'no organizations yet — create one: conductor org create "Acme" --template saas-startup',
      ));
    }));

  org
    .command('create <name>')
    .description('create an organization, optionally from a template (see `org templates`)')
    .option('--template <id>', 'start from a template: departments, agents and goals included')
    .option('--mission <text>', 'what the organization is for')
    .option('--budget <usd>', 'monthly budget cap in USD')
    .option('--provider <adapter[:model]>', 'default provider for every agent, e.g. claude_local')
    .option('--slug <slug>', 'URL-safe short name (derived from the name by default)')
    .option('--use', 'make it the default org for later commands')
    .action(action(deps, async (ctx, args, opts) => {
      const name = arg(args, 0, 'name');
      const template = str(opts, 'template');
      const budget = num(opts, 'budget', { min: 0 });
      const binding = str(opts, 'provider') ? parseProvider(str(opts, 'provider')!) : undefined;
      const mission = str(opts, 'mission');
      const c = ctx.client();
      let created: Organization;
      if (template) {
        if (str(opts, 'slug')) throw new UsageError('--slug cannot be combined with --template (the slug is derived from the name)');
        created = await c.createOrgFromTemplate(compact({ templateId: template, name, mission, defaultProvider: binding }));
        if (budget !== undefined) created = await c.updateOrg(created.id, { budgetMonthlyUsd: budget });
      } else {
        created = await c.createOrg(compact({ name, slug: str(opts, 'slug'), mission, budgetMonthlyUsd: budget, defaultProvider: binding }));
      }
      const makeDefault = flag(opts, 'use') || !ctx.config().defaultOrg;
      if (makeDefault) ctx.saveConfig({ defaultOrg: created.slug });
      if (ctx.json) return ctx.printJson(created);
      const agents = template ? await c.listAgents(created.id) : [];
      ctx.ok(`created ${created.name} (${created.slug})${template ? ` from ${template}: ${agents.length} agents` : ''}`);
      if (makeDefault) ctx.line(`  now the default org (change with: conductor org use <slug>)`);
      if (!created.defaultProvider) ctx.line('  no default provider yet: conductor org create … --provider claude_local, or set one per agent');
      ctx.line(`  next: conductor agent list   ·   conductor issue create "…" --assign <agent>`);
    }));

  org
    .command('use <org>')
    .description('set the default organization for later commands')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.client().getOrg(arg(args, 0, 'org'));
      ctx.saveConfig({ defaultOrg: o.slug });
      ctx.emit({ defaultOrg: o.slug }, () => ctx.ok(`default org is now ${o.slug} (${o.name})`));
    }));

  org
    .command('show [org]')
    .description('show an organization')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.client().getOrg(await target(ctx, optArg(args, 0)));
      ctx.emit(o, () => showOrg(ctx, o));
    }));

  org
    .command('archive <org>')
    .description('archive an organization (its agents stop running; data is kept)')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.client().archiveOrg(arg(args, 0, 'org'));
      if (ctx.config().defaultOrg === o.slug) ctx.saveConfig({ defaultOrg: undefined });
      ctx.emit(o, () => ctx.ok(`archived ${o.slug}`));
    }));

  org
    .command('unarchive <org>')
    .description('bring an archived organization back (its agents can run again)')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.client().unarchiveOrg(arg(args, 0, 'org'));
      ctx.emit(o, () => ctx.ok(`restored ${o.slug}`));
    }));

  org
    .command('templates')
    .description('list organization templates')
    .action(action(deps, async (ctx) => {
      const templates = await ctx.client().listOrgTemplates();
      ctx.emit(templates, () => ctx.table(
        ['id', 'name', 'depts', 'agents', 'description'],
        templates.map((t) => [t.id, t.name, t.departments.length, t.departments.reduce((n, d) => n + d.agents.length, 0), clip(t.description, 80)]),
      ));
    }));

  org
    .command('export <file>')
    .description('export the organization as a portable bundle (never includes secrets); "-" writes to stdout')
    .action(action(deps, async (ctx, args) => {
      const file = arg(args, 0, 'file');
      const bundle = await ctx.client().exportOrg(await ctx.org());
      const text = `${JSON.stringify(bundle, null, 2)}\n`;
      if (file === '-') return void ctx.deps.stdout(text);
      ctx.deps.fs.writeText(file, text);
      const summary = { file, departments: bundle.departments.length, agents: bundle.agents.length, skills: bundle.skills.length, memories: bundle.memories.length };
      ctx.emit(summary, () => ctx.ok(`exported to ${file}: ${summary.departments} departments, ${summary.agents} agents, ${summary.skills} skills, ${summary.memories} memories`));
    }));

  org
    .command('import <file>')
    .description('create a new organization from an exported bundle')
    .requiredOption('--name <name>', 'name of the new organization')
    .action(action(deps, async (ctx, args, opts) => {
      const file = arg(args, 0, 'file');
      if (!ctx.deps.fs.exists(file)) throw new UsageError(`no such file: ${file}`);
      let bundle: OrgBundle;
      try {
        bundle = JSON.parse(ctx.deps.fs.readText(file)) as OrgBundle;
      } catch {
        throw new CliError(`${file} is not valid JSON.`);
      }
      if (!bundle || bundle.format !== 'conductor-org-bundle') throw new CliError(`${file} is not a Conductor org bundle.`, 1, ['create one with: conductor org export <file>']);
      const o = await ctx.client().importOrg({ name: str(opts, 'name')!, bundle });
      ctx.emit(o, () => ctx.ok(`imported as ${o.name} (${o.slug})`));
    }));

  org
    .command('kill [org]')
    .description('engage the kill switch for one organization: cancel its runs and stop new ones')
    .action(action(deps, async (ctx, args) => {
      const o = await target(ctx, optArg(args, 0));
      const r = await ctx.client().engageOrgKillSwitch(o);
      ctx.emit({ org: o, ...r }, () => ctx.line(`${ctx.style.red('■')} kill switch engaged for ${o}; release with: conductor org unkill ${o}`));
    }));

  org
    .command('unkill [org]')
    .description('release the kill switch for one organization')
    .action(action(deps, async (ctx, args) => {
      const o = await target(ctx, optArg(args, 0));
      const r = await ctx.client().releaseOrgKillSwitch(o);
      ctx.emit({ org: o, ...r }, () => ctx.ok(`kill switch released for ${o}`));
    }));

  const dept = program.command('dept').description('departments');

  dept
    .command('list')
    .description('list departments')
    .action(action(deps, async (ctx) => {
      const o = await ctx.org();
      const [depts, agents] = await Promise.all([ctx.client().listDepartments(o), ctx.client().listAgents(o)]);
      const slugOf = new Map(agents.map((a) => [a.id, a.slug]));
      ctx.emit(depts, () => ctx.table(
        ['slug', 'name', 'lead', 'agents', 'budget', 'charter'],
        depts.map((d) => [d.slug, d.name, d.leadAgentId ? slugOf.get(d.leadAgentId) ?? d.leadAgentId : '-', agents.filter((a) => a.deptId === d.id && a.status !== 'terminated').length, d.budgetUsd === null ? '-' : usd(d.budgetUsd), clip(d.charter, 60)]),
        'no departments yet — create one: conductor dept create "Engineering"',
      ));
    }));

  dept
    .command('create <name>')
    .description('create a department')
    .option('--charter <text>', 'what the department is responsible for')
    .option('--budget <usd>', 'monthly budget cap in USD')
    .option('--slug <slug>', 'URL-safe short name')
    .action(action(deps, async (ctx, args, opts) => {
      const d = await ctx.client().createDepartment(await ctx.org(), compact({ name: arg(args, 0, 'name'), slug: str(opts, 'slug'), charter: str(opts, 'charter'), budgetUsd: num(opts, 'budget', { min: 0 }) }));
      ctx.emit(d, () => {
        ctx.ok(`created department ${d.name} (${d.slug})`);
        ctx.line(`  next: conductor agent hire --dept ${d.slug} --role "…"`);
      });
    }));

  dept
    .command('archive <dept>')
    .description('archive a department (refused while it still has agents that are not terminated)')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const d = await ctx.client().archiveDepartment(o, (await resolveDept(ctx, o, arg(args, 0, 'dept'))).id);
      ctx.emit(d, () => ctx.ok(`archived department ${d.name}`));
    }));

  dept
    .command('unarchive <dept>')
    .description('bring an archived department back')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const d = await ctx.client().unarchiveDepartment(o, (await resolveDept(ctx, o, arg(args, 0, 'dept'))).id);
      ctx.emit(d, () => ctx.ok(`restored department ${d.name}`));
    }));
}
