import { join } from 'node:path';
import type { Command } from 'commander';
import type { Run, RunEvent, TranscriptEntry } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, arg, choice, compact, flag, num, str } from '../command.js';
import { CliError, EXIT, SilentExit, UsageError } from '../errors.js';
import { ago, clip, clock, duration, usd, type Style } from '../output.js';
import { agentNames, pick, resolveAgent, resolveIssue } from '../resolve.js';

const RUN_STATUSES = ['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'released'] as const;
const LIVE = new Set<string>(['queued', 'running', 'paused']);
const PINO_LEVELS: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const PINO_SKIP = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v', 'name']);

const compactJson = (v: unknown, max: number) => {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  } catch {
    s = String(v);
  }
  return clip(s, max);
};

/** One compact line (or block, for agent text) per transcript event. */
export function renderEvent(entry: TranscriptEntry, s: Style): string {
  const e: RunEvent = entry.event;
  const t = s.dim(clock(entry.ts));
  switch (e.type) {
    case 'text':
      return `${t} ${e.text.trimEnd()}`;
    case 'thinking':
      return `${t} ${s.dim(`~ ${clip(e.text, 200)}`)}`;
    case 'tool_call':
      return `${t} ${s.cyan('→')} ${e.name}(${compactJson(e.input, 160)})`;
    case 'tool_result':
      return `${t} ${e.isError ? s.red('← ERROR') : s.cyan('←')} ${e.name}: ${clip(e.output, 200) || '(empty)'}`;
    case 'usage':
      return `${t} ${s.dim(`usage: ${e.tokensIn} in / ${e.tokensOut} out · ${usd(e.costUsd)}`)}`;
    case 'session':
      return `${t} ${s.dim(`session ${e.sessionId}`)}`;
    case 'status':
      return `${t} ${s.dim(`· ${e.status}`)}`;
    case 'error':
      return `${t} ${s.red(`error [${e.kind}]`)} ${e.message}${e.retryable ? s.dim(' (retryable)') : ''}`;
    default:
      return `${t} ${compactJson(e, 200)}`;
  }
}

/** Daemon logs are pino JSON lines; render them compactly and pass anything else through. */
export function renderLogLine(raw: string, s: Style): string {
  if (!raw.startsWith('{')) return raw;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (typeof j.msg !== 'string') return raw;
    const level = typeof j.level === 'number' ? PINO_LEVELS[j.level] ?? String(j.level) : String(j.level ?? '');
    const extras = Object.entries(j).filter(([k]) => !PINO_SKIP.has(k)).map(([k, v]) => `${k}=${compactJson(v, 120)}`).join(' ');
    const paint = level === 'ERROR' || level === 'FATAL' ? s.red : level === 'WARN' ? s.yellow : s.dim;
    return `${s.dim(typeof j.time === 'number' ? clock(j.time) : '')} ${paint(level.padEnd(5))} ${j.msg}${extras ? ` ${s.dim(extras)}` : ''}`.trimStart();
  } catch {
    return raw;
  }
}

function runSummary(r: Run): string {
  const took = r.startedAt ? duration((r.endedAt ?? r.startedAt) - r.startedAt) : '-';
  return `${r.status}${r.outcome && r.outcome !== 'completed' ? ` (${r.outcome})` : ''} · ${r.steps} steps · ${took} · ${r.subscription ? 'subscription' : usd(r.costUsd)}`;
}

async function streamRun(ctx: Ctx, org: string, runId: string, follow: boolean): Promise<void> {
  const client = ctx.client();
  let after = 0;
  const collected: TranscriptEntry[] = [];
  for (;;) {
    // Read the status first so the final poll still drains events written just before the run ended.
    const run = await client.getRun(org, runId);
    const entries = await client.runTranscript(org, runId, after ? { afterSeq: after } : undefined);
    for (const entry of entries) {
      after = Math.max(after, entry.seq);
      if (!ctx.json) ctx.line(renderEvent(entry, ctx.style));
      else if (follow) ctx.line(JSON.stringify(entry));
      else collected.push(entry);
    }
    if (!follow || !LIVE.has(run.status)) {
      if (ctx.json && !follow) ctx.printJson(collected);
      else if (!ctx.json) ctx.note(ctx.style.dim(`run ${run.id}: ${runSummary(run)}${run.error ? ` · ${clip(run.error, 160)}` : ''}`));
      return;
    }
    if (ctx.deps.signal.aborted) return;
    await ctx.deps.sleep(1000);
    if (ctx.deps.signal.aborted) return;
  }
}

async function tailDaemonLogs(ctx: Ctx, follow: boolean, lines: number): Promise<void> {
  const { fs } = ctx.deps;
  const dir = ctx.logDir;
  const files = fs.exists(dir) ? fs.readDir(dir).filter((f) => f.endsWith('.log')).sort().map((f) => join(dir, f)) : [];
  if (files.length === 0) {
    throw new CliError(`No daemon logs in ${dir}.`, EXIT.failure, ['the daemon writes them once it has started: conductor install', 'logs elsewhere? set CONDUCTOR_LOG_DIR'], 'no_logs');
  }
  const print = (file: string, text: string, header: boolean) => {
    const rows = text.split('\n').filter((l) => l.trim() !== '');
    if (rows.length === 0) return;
    if (header && !ctx.json) ctx.line(ctx.style.bold(`==> ${file} <==`));
    for (const row of rows) ctx.line(ctx.json ? row : renderLogLine(row, ctx.style));
  };
  const offsets = new Map<string, number>();
  for (const file of files) {
    const text = fs.readText(file);
    offsets.set(file, Buffer.byteLength(text));
    print(file, text.split('\n').filter((l) => l.trim() !== '').slice(-lines).join('\n'), files.length > 1);
  }
  if (!follow) return;
  let last = '';
  while (!ctx.deps.signal.aborted) {
    await ctx.deps.sleep(500);
    for (const file of files) {
      if (!fs.exists(file)) continue;
      const size = fs.size(file);
      let offset = offsets.get(file) ?? 0;
      if (size < offset) offset = 0; // rotated or truncated
      if (size === offset) continue;
      const chunk = fs.readFrom(file, offset);
      // Only whole lines are printed; a partial last line is picked up on the next poll.
      const end = chunk.lastIndexOf('\n');
      if (end === -1) continue;
      offsets.set(file, offset + Buffer.byteLength(chunk.slice(0, end + 1)));
      print(file, chunk.slice(0, end), files.length > 1 && last !== file);
      last = file;
    }
  }
}

export function runCommands(program: Command, deps: CliDeps): void {
  const run = program.command('run').description('runs: one agent working on one heartbeat');

  run
    .command('now <agent>')
    .description('wake an agent right now, optionally pinned to an issue')
    .option('--issue <issue>', 'work on this issue')
    .option('--prompt <text>', 'extra instruction for this run')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const a = await resolveAgent(ctx, o, arg(args, 0, 'agent'));
      const issue = str(opts, 'issue') ? await resolveIssue(ctx, o, str(opts, 'issue')!) : null;
      const r = await ctx.client().runAgent(o, a.id, compact({ issueId: issue?.id, prompt: str(opts, 'prompt') }));
      ctx.emit({ ...r, agentId: a.id, issueId: issue?.id ?? null }, () => {
        if (r.skipped) {
          // Say so instead of pretending a run is on its way.
          ctx.line(`${ctx.style.yellow('!')} no run started for ${a.name}: ${r.skipped.reason}`);
          ctx.line(r.skipped.temporary ? '  the wake stays queued and runs when that clears' : '  nothing was queued');
          return;
        }
        ctx.ok(`queued a run for ${a.name}${issue ? ` on #${issue.number}` : ''}`);
        ctx.line(`  watch it: conductor logs -f --agent ${a.slug}   ·   conductor run list --agent ${a.slug}`);
        ctx.line(ctx.style.dim('  an agent with nothing to do ends the wake without a run; `conductor run list` shows whether one started'));
      });
      if (r.skipped && !r.skipped.temporary) throw new SilentExit(EXIT.failure);
    }));

  run
    .command('list')
    .description('list recent runs')
    .option('--agent <agent>', 'only this agent')
    .option('--issue <issue>', 'only this issue')
    .option('--status <status>', `only runs with this status (${RUN_STATUSES.join(', ')})`)
    .option('--limit <n>', 'maximum rows', '20')
    .action(action(deps, async (ctx, _a, opts) => {
      const o = await ctx.org();
      const runs = await ctx.client().listRuns(o, compact({
        agentId: str(opts, 'agent') ? (await resolveAgent(ctx, o, str(opts, 'agent')!)).id : undefined,
        issueId: str(opts, 'issue') ? (await resolveIssue(ctx, o, str(opts, 'issue')!)).id : undefined,
        status: choice(opts, 'status', RUN_STATUSES),
        limit: num(opts, 'limit', { int: true, min: 1, max: 1000 }),
      }));
      if (ctx.json) return ctx.printJson(runs);
      const name = await agentNames(ctx, o);
      ctx.table(
        ['id', 'agent', 'trigger', 'status', 'steps', 'cost', 'started', 'took'],
        runs.map((r) => [r.id, name(r.agentId), r.trigger, r.outcome && r.outcome !== 'completed' ? `${r.status} (${r.outcome})` : r.status, r.steps, r.subscription ? 'sub' : usd(r.costUsd), ago(r.startedAt ?? r.createdAt, ctx.deps.now()), r.startedAt ? duration((r.endedAt ?? ctx.deps.now()) - r.startedAt) : '-']),
        'no runs yet — start one: conductor run now <agent>',
      );
    }));

  run
    .command('show <run>')
    .description('show one run: status, usage, capability snapshot')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const r = await ctx.client().getRun(o, arg(args, 0, 'run'));
      if (ctx.json) return ctx.printJson(r);
      const name = await agentNames(ctx, o);
      const snap = r.capabilitySnapshot;
      ctx.fields([
        ['id', r.id], ['agent', name(r.agentId)], ['issue', r.issueId], ['trigger', r.trigger], ['status', runSummary(r)],
        ['provider', r.provider ? `${r.provider}${r.model ? `:${r.model}` : ''}` : null], ['tokens', `${r.tokensIn} in / ${r.tokensOut} out`],
        ['started', r.startedAt ? new Date(r.startedAt).toISOString() : null], ['ended', r.endedAt ? new Date(r.endedAt).toISOString() : null],
        ['skills', snap?.skills.map((k) => `${k.name}@v${k.version}`).join(', ')], ['connectors', snap?.connectors.map((c) => c.name).join(', ')],
        ['error', r.error],
      ]);
      ctx.line(`  transcript: conductor logs --run ${r.id}`);
    }));

  run
    .command('cancel <run>')
    .description('cancel a queued or running run')
    .option('--reason <text>', 'why')
    .action(action(deps, async (ctx, args, opts) => {
      const id = arg(args, 0, 'run');
      await ctx.client().cancelRun(await ctx.org(), id, str(opts, 'reason'));
      ctx.emit({ ok: true, runId: id }, () => ctx.ok(`cancelled ${id}`));
    }));

  program
    .command('logs')
    .description('daemon logs, or a run transcript with --run / --agent')
    .option('-f, --follow', 'keep streaming')
    .option('--run <id>', 'show this run\'s transcript')
    .option('--agent <agent>', 'show the latest run of this agent')
    .option('-n, --lines <n>', 'daemon log lines to show first', '40')
    .action(action(deps, async (ctx, _a, opts) => {
      const follow = flag(opts, 'follow');
      const runId = str(opts, 'run');
      const agent = str(opts, 'agent');
      if (runId && agent) throw new UsageError('pass either --run or --agent, not both');
      if (!runId && !agent) return tailDaemonLogs(ctx, follow, num(opts, 'lines', { int: true, min: 0, max: 100_000 }) ?? 40);
      const o = await ctx.org();
      if (runId) {
        const runs = runId.startsWith('run_') && runId.length > 20 ? [] : await ctx.client().listRuns(o, { limit: 200 });
        const id = runs.length ? pick('run', runId, runs, (r) => [r.id], (r) => `${r.id}  ${r.status}`, 'conductor run list').id : runId;
        return streamRun(ctx, o, id, follow);
      }
      const a = await resolveAgent(ctx, o, agent!);
      // With -f this follows the agent, not one run: `run now` only queues a job, and the next heartbeat starts another run.
      let lastId: string | null = null;
      let announced = false;
      for (;;) {
        const latest = (await ctx.client().listRuns(o, { agentId: a.id, limit: 1 }))[0];
        if (latest && latest.id !== lastId) {
          await streamRun(ctx, o, latest.id, follow);
          lastId = latest.id;
          announced = false;
          if (!follow) return;
          continue;
        }
        if (!follow) throw new CliError(`${a.name} has no runs yet.`, EXIT.failure, [`start one: conductor run now ${a.slug}`], 'not_found');
        if (ctx.deps.signal.aborted) return;
        if (!announced && !ctx.json) ctx.note(ctx.style.dim(`waiting for ${a.slug}'s next run… (Ctrl-C to stop)`));
        announced = true;
        await ctx.deps.sleep(1000);
        if (ctx.deps.signal.aborted) return;
      }
    }));
}
