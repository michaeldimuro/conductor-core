import type { Command } from 'commander';
import type { Playbook, Project, UpdatePlaybookRequest, UpdateProjectRequest } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, arg, choice, compact, isEmpty, num, str } from '../command.js';
import { UsageError } from '../errors.js';
import { clip, usd } from '../output.js';
import { agentNames, pick, resolveAgent, resolveGoal } from '../resolve.js';

const PROCESSES = ['sequential', 'hierarchical'] as const;
const PROJECT_STATUSES = ['active', 'archived'] as const;

async function resolveProject(ctx: Ctx, org: string, needle: string): Promise<Project> {
  const projects = await ctx.client().listProjects(org);
  return pick('project', needle, projects, (p) => [p.id, p.name], (p) => `${p.name}  (${p.id})`, 'conductor project list');
}

async function resolvePlaybook(ctx: Ctx, org: string, needle: string): Promise<Playbook> {
  const playbooks = await ctx.client().listPlaybooks(org);
  return pick('playbook', needle, playbooks, (p) => [p.id, p.name], (p) => `${p.name}  (${p.id})`, 'conductor playbook list');
}

/** `null`/`none` clears a nullable field. */
const cleared = (v: string): boolean => ['null', 'none', ''].includes(v.trim().toLowerCase());

/** Projects (edit, archive) and playbooks (edit, delete): lifecycle beyond create. */
export function playbookCommands(program: Command, deps: CliDeps): void {
  const project = program.command('project').alias('projects').description('projects: workspaces and budgets that group issues under a goal');

  project
    .command('list')
    .description('list projects')
    .action(action(deps, async (ctx) => {
      const projects = await ctx.client().listProjects(await ctx.org());
      ctx.emit(projects, () => ctx.table(
        ['name', 'status', 'budget', 'workspace', 'id'],
        projects.map((p) => [p.name, p.status, p.budgetUsd === null ? '-' : usd(p.budgetUsd), p.workspacePath ? clip(p.workspacePath, 50) : '-', p.id]),
        'no projects yet',
      ));
    }));

  project
    .command('update <project>')
    .description('rename a project, move it under another goal, change its workspace or budget, or archive it')
    .option('--name <name>', 'new name')
    .option('--goal <goal>', 'goal it serves ("none" detaches it)')
    .option('--workspace <path>', 'working directory for its issues ("none" clears it)')
    .option('--budget <usd>', 'budget cap in USD ("none" removes the cap)')
    .option('--status <status>', PROJECT_STATUSES.join(' | '))
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const goal = str(opts, 'goal');
      const workspace = str(opts, 'workspace');
      const budget = str(opts, 'budget');
      const patch: UpdateProjectRequest = compact({
        name: str(opts, 'name'),
        goalId: goal === undefined ? undefined : cleared(goal) ? null : (await resolveGoal(ctx, o, goal)).id,
        workspacePath: workspace === undefined ? undefined : cleared(workspace) ? null : workspace,
        budgetUsd: budget === undefined ? undefined : cleared(budget) ? null : num(opts, 'budget', { min: 0 }),
        status: choice(opts, 'status', PROJECT_STATUSES),
      });
      if (isEmpty(patch)) throw new UsageError('nothing to change: pass --name, --goal, --workspace, --budget or --status');
      const p = await ctx.client().updateProject(o, (await resolveProject(ctx, o, arg(args, 0, 'project'))).id, patch);
      ctx.emit(p, () => ctx.ok(`updated project ${p.name}: ${Object.keys(patch).join(', ')}`));
    }));

  const playbook = program.command('playbook').alias('playbooks').description('playbooks: reusable multi-step processes run inside an issue');

  playbook
    .command('list')
    .description('list playbooks')
    .action(action(deps, async (ctx) => {
      const o = await ctx.org();
      const [playbooks, name] = await Promise.all([ctx.client().listPlaybooks(o), agentNames(ctx, o)]);
      ctx.emit(playbooks, () => ctx.table(
        ['name', 'process', 'steps', 'manager', 'description', 'id'],
        playbooks.map((p) => [p.name, p.process, p.steps.length, name(p.managerAgentId), clip(p.description, 50), p.id]),
        'no playbooks yet — create one in the web UI under Settings → Playbooks',
      ));
    }));

  playbook
    .command('update <playbook>')
    .description('change a playbook\'s name, description, process, manager or steps')
    .option('--name <name>', 'new name')
    .option('--description <text>', 'new description')
    .option('--process <process>', PROCESSES.join(' | '))
    .option('--manager <agent>', 'manager agent for hierarchical playbooks ("none" clears it)')
    .option('--steps-file <path>', 'JSON file with the full list of steps ("-" for stdin)')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const manager = str(opts, 'manager');
      const file = str(opts, 'stepsFile');
      let steps: Playbook['steps'] | undefined;
      if (file !== undefined) {
        if (file !== '-' && !ctx.deps.fs.exists(file)) throw new UsageError(`no such file: ${file}`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(file === '-' ? await ctx.deps.readStdin() : ctx.deps.fs.readText(file));
        } catch {
          throw new UsageError('--steps-file must contain valid JSON');
        }
        if (!Array.isArray(parsed) || parsed.length === 0) throw new UsageError('--steps-file must contain a non-empty JSON array of steps');
        steps = parsed as Playbook['steps'];
      }
      const patch: UpdatePlaybookRequest = compact({
        name: str(opts, 'name'),
        description: str(opts, 'description'),
        process: choice(opts, 'process', PROCESSES),
        managerAgentId: manager === undefined ? undefined : cleared(manager) ? null : (await resolveAgent(ctx, o, manager)).id,
        steps,
      });
      if (isEmpty(patch)) throw new UsageError('nothing to change: pass --name, --description, --process, --manager or --steps-file');
      const p = await ctx.client().updatePlaybook(o, (await resolvePlaybook(ctx, o, arg(args, 0, 'playbook'))).id, patch);
      ctx.emit(p, () => ctx.ok(`updated playbook ${p.name}: ${Object.keys(patch).join(', ')}`));
    }));

  playbook
    .command('delete <playbook>')
    .description('delete a playbook (issues it already created are kept)')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const p = await resolvePlaybook(ctx, o, arg(args, 0, 'playbook'));
      await ctx.client().deletePlaybook(o, p.id);
      ctx.emit({ ok: true, playbookId: p.id }, () => ctx.ok(`deleted playbook ${p.name}`));
    }));
}
