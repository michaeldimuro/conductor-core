import { isAbsolute, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Skill } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, arg, choice, compact, flag, list as listOpt, num, parseNumber, str, type Opts } from '../command.js';
import { UsageError } from '../errors.js';
import { ago, clip, percent } from '../output.js';
import { resolveAgent, resolveDept, resolveSkill } from '../resolve.js';

const SCOPES = ['global', 'org', 'dept', 'agent'] as const;
const STATUSES = ['draft', 'active', 'deprecated', 'quarantined'] as const;

/** `--scope dept|agent` needs to know which department or agent. */
async function scopeTarget(ctx: Ctx, org: string, scope: Skill['scope'], opts: Opts): Promise<string | undefined> {
  if (scope === 'dept') {
    if (!str(opts, 'dept')) throw new UsageError('--scope dept needs --dept <dept>');
    return (await resolveDept(ctx, org, str(opts, 'dept')!)).id;
  }
  if (scope === 'agent') {
    if (!str(opts, 'agent')) throw new UsageError('--scope agent needs --agent <agent>');
    return (await resolveAgent(ctx, org, str(opts, 'agent')!)).id;
  }
  return undefined;
}

const successRate = (s: Skill) => (s.useCount ? percent(s.successCount / s.useCount) : '-');

function colourDiff(ctx: Ctx, diff: string): string[] {
  const s = ctx.style;
  return diff.replace(/\n$/, '').split('\n').map((l) => (l.startsWith('+++') || l.startsWith('---') ? s.bold(l) : l.startsWith('+') ? s.green(l) : l.startsWith('-') ? s.red(l) : l.startsWith('@@') ? s.cyan(l) : l));
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export function skillCommands(program: Command, deps: CliDeps): void {
  const skills = program.command('skills').alias('skill').description('skills: versioned procedures agents load on demand (and write themselves)');

  skills
    .command('list')
    .description('list skills visible to the org')
    .option('--scope <scope>', SCOPES.join(' | '))
    .option('--status <status>', STATUSES.join(' | '))
    .option('--dept <dept>', 'with --scope dept: only this department')
    .option('--agent <agent>', 'with --scope agent: only this agent')
    .action(action(deps, async (ctx, _a, opts) => {
      const o = await ctx.org();
      const scope = choice(opts, 'scope', SCOPES);
      const scopeId = scope && (str(opts, 'dept') || str(opts, 'agent')) ? await scopeTarget(ctx, o, scope, opts) : undefined;
      const list = await ctx.client().listSkills(o, compact({ scope, scopeId, status: choice(opts, 'status', STATUSES) }));
      ctx.emit(list, () => ctx.table(
        ['name', 'scope', 'version', 'status', 'author', 'uses', 'success', 'eval', 'description'],
        list.map((s) => [s.name, s.scope, `v${s.version}`, s.status, s.author, s.useCount, successRate(s), s.evalScore === null ? '-' : s.evalScore.toFixed(2), clip(s.description, 60)]),
        'no skills yet — import one: conductor skills import <dir> --scope org',
      ));
    }));

  skills
    .command('show <skill>')
    .description('print a skill\'s SKILL.md and file list')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const sk = await resolveSkill(ctx, o, arg(args, 0, 'skill'));
      const detail = await ctx.client().readSkill(o, sk.id);
      ctx.emit(detail, () => {
        const s = detail.skill;
        ctx.fields([
          ['name', s.name], ['id', s.id], ['scope', `${s.scope}${s.scopeId ? ` (${s.scopeId})` : ''}`], ['version', `v${s.version}`], ['status', s.status],
          ['author', s.author], ['source', s.source], ['used', `${s.useCount} times, ${successRate(s)} success`], ['last used', s.lastUsedAt ? ago(s.lastUsedAt, ctx.deps.now()) : 'never'],
          ['files', detail.files.join(', ')], ['description', s.description],
        ]);
        ctx.lines(['', detail.body.trimEnd()]);
      });
    }));

  skills
    .command('diff <skill>')
    .description('unified diff between two versions (default: previous → current)')
    .option('--from <version>', 'older version')
    .option('--to <version>', 'newer version')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const sk = await resolveSkill(ctx, o, arg(args, 0, 'skill'));
      const r = await ctx.client().skillDiff(o, sk.id, compact({ from: num(opts, 'from', { int: true, min: 1 }), to: num(opts, 'to', { int: true, min: 1 }) }));
      ctx.emit(r, () => (r.diff.trim() ? ctx.lines(colourDiff(ctx, r.diff)) : ctx.line(ctx.style.dim('no differences'))));
    }));

  skills
    .command('rollback <skill> <version>')
    .description('restore an earlier version (recorded as a new version)')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const sk = await resolveSkill(ctx, o, arg(args, 0, 'skill'));
      const to = parseNumber(arg(args, 1, 'version').replace(/^v/i, ''), '<version>', { int: true, min: 1 });
      const r = await ctx.client().rollbackSkill(o, sk.id, to);
      ctx.emit(r, () => ctx.ok(`${r.name} rolled back to v${to} (now v${r.version}, ${r.status})`));
    }));

  skills
    .command('history <skill>')
    .description('version history of a skill')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const sk = await resolveSkill(ctx, o, arg(args, 0, 'skill'));
      const versions = await ctx.client().skillHistory(o, sk.id);
      ctx.emit(versions, () => ctx.table(
        ['version', 'when', 'author', 'eval', 'message'],
        versions.map((v) => [`v${v.version}${v.version === sk.version ? ' *' : ''}`, ago(v.createdAt, ctx.deps.now()), v.author, v.eval ? `${v.eval.passed ? 'pass' : 'fail'} ${v.eval.score.toFixed(2)}` : '-', clip(v.message, 70)]),
      ));
    }));

  skills
    .command('evaluate <skill>')
    .description('replay the eval with and without the skill (uses provider budget)')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const sk = await resolveSkill(ctx, o, arg(args, 0, 'skill'));
      if (!ctx.json) ctx.note(ctx.style.dim(`evaluating ${sk.name}… this runs the agent twice`));
      const r = await ctx.client().evaluateSkill(o, sk.id);
      ctx.emit(r, () => {
        ctx.line(`${r.passed ? ctx.style.green('✓ passed') : ctx.style.red('✗ failed')}  score ${r.score.toFixed(2)}${r.notes ? `  — ${clip(r.notes, 120)}` : ''}`);
        ctx.table(['', 'success', 'steps', 'tokens', 'cost', 'time'], [
          ['baseline', r.baseline.success, r.baseline.steps, r.baseline.tokens, `$${r.baseline.costUsd.toFixed(4)}`, `${Math.round(r.baseline.wallMs / 1000)}s`],
          ['with skill', r.withSkill.success, r.withSkill.steps, r.withSkill.tokens, `$${r.withSkill.costUsd.toFixed(4)}`, `${Math.round(r.withSkill.wallMs / 1000)}s`],
        ]);
      });
    }));

  const cases = skills.command('eval-cases').alias('eval-case').description('the cases a skill is evaluated on');

  cases
    .command('list <skill>')
    .description('list the eval cases of a skill')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const sk = await resolveSkill(ctx, o, arg(args, 0, 'skill'));
      const rows = await ctx.client().listSkillEvalCases(o, sk.id);
      ctx.emit(rows, () => ctx.table(
        ['id', 'source', 'prompt', 'criteria', 'checks'],
        rows.map((c) => [c.id, c.issueId ? `${c.source} ${c.issueId}` : c.source, clip(c.prompt, 50), clip(c.criteria, 40), Object.entries(c.expect).map(([k, v]) => `${k}:${(v as string[]).length}`).join(' ') || '-']),
        `no eval cases — add one: conductor skills eval-cases add ${sk.name} "<prompt>" --criteria "<what success looks like>"`,
      ));
    }));

  cases
    .command('add <skill> <prompt...>')
    .description('add a manual eval case ("-" reads the prompt from stdin)')
    .option('--criteria <text>', 'what a successful answer looks like (judged by the utility model)')
    .option('--contains <text,...>', 'strings the answer must contain', collect, [])
    .option('--not-contains <text,...>', 'strings the answer must not contain', collect, [])
    .option('--regex <pattern>', 'regular expression the answer must match (repeatable)', collect, [])
    .option('--file <path,...>', 'files the run must leave in its workspace', collect, [])
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const sk = await resolveSkill(ctx, o, arg(args, 0, 'skill'));
      const text = arg(args, 1, 'prompt');
      const prompt = text === '-' ? await ctx.deps.readStdin() : text;
      if (!prompt.trim()) throw new UsageError('the prompt is empty');
      // A regular expression may itself contain commas, so `--regex` is repeat-only.
      const regex = Array.isArray(opts.regex) ? opts.regex.map(String).filter(Boolean) : [];
      const pick = (key: string) => (listOpt(opts, key).length ? listOpt(opts, key) : undefined);
      const expect = compact({ contains: pick('contains'), notContains: pick('notContains'), regex: regex.length ? regex : undefined, files: pick('file') });
      const criteria = str(opts, 'criteria');
      if (!criteria && Object.keys(expect).length === 0) throw new UsageError('give --criteria or at least one check (--contains, --not-contains, --regex, --file)');
      const created = await ctx.client().addSkillEvalCase(o, sk.id, compact({ prompt, criteria, expect: Object.keys(expect).length ? expect : undefined }));
      ctx.emit(created, () => ctx.ok(`added eval case ${created.id} to ${sk.name}`));
    }));

  cases
    .command('remove <skill> <caseId>')
    .description('remove an eval case')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const sk = await resolveSkill(ctx, o, arg(args, 0, 'skill'));
      const r = await ctx.client().removeSkillEvalCase(o, sk.id, arg(args, 1, 'caseId'));
      ctx.emit(r, () => ctx.ok(`removed eval case ${arg(args, 1, 'caseId')} from ${sk.name}`));
    }));

  skills
    .command('activate <skill>')
    .description('make a draft skill active (runs the scan and eval gate)')
    .option('--force', 'skip the eval gate')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const sk = await resolveSkill(ctx, o, arg(args, 0, 'skill'));
      const r = await ctx.client().activateSkill(o, sk.id, flag(opts, 'force') ? { force: true } : {});
      ctx.emit(r, () => ctx.ok(`${r.name} v${r.version} is ${r.status}`));
    }));

  skills
    .command('promote <skill>')
    .description('promote a skill to a wider scope')
    .requiredOption('--to <scope>', 'dept | org | global')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const sk = await resolveSkill(ctx, o, arg(args, 0, 'skill'));
      const to = choice(opts, 'to', ['dept', 'org', 'global'] as const)!;
      const r = await ctx.client().promoteSkill(o, sk.id, to);
      ctx.emit(r, () => {
        if (r.skill) ctx.ok(`${r.skill.name} promoted to ${r.skill.scope} scope`);
        else if (r.approval) ctx.line(`queued for approval: ${r.approval.title}\n  decide with: conductor approvals approve ${r.approval.id}`);
      });
    }));

  skills
    .command('import <dir>')
    .description('import a skill folder (containing SKILL.md); it starts as a draft pinned by hash')
    .requiredOption('--scope <scope>', SCOPES.join(' | '))
    .option('--dept <dept>', 'target department for --scope dept')
    .option('--agent <agent>', 'target agent for --scope agent')
    .option('--source <text>', 'where it came from (URL, author)')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const dir = arg(args, 0, 'dir');
      const sourceDir = isAbsolute(dir) ? dir : resolve(dir);
      if (!ctx.deps.fs.exists(sourceDir)) throw new UsageError(`no such directory: ${sourceDir}`);
      const scope = choice(opts, 'scope', SCOPES)!;
      const r = await ctx.client().importSkill(o, compact({ sourceDir, scope, scopeId: (await scopeTarget(ctx, o, scope, opts)) ?? null, source: str(opts, 'source') }));
      ctx.emit(r, () => {
        ctx.ok(`imported ${r.name} v${r.version} as ${r.status} (${r.scope} scope)`);
        if (r.status === 'draft') ctx.line(`  review it: conductor skills show ${r.name}   ·   then: conductor skills activate ${r.name}`);
      });
    }));
}
