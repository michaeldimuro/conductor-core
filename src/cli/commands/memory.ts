import type { Command } from 'commander';
import type { Memory, UpdateMemoryRequest } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, arg, choice, choices, compact, flag, isEmpty, list, num, oneOf, str } from '../command.js';
import { UsageError } from '../errors.js';
import { ago, clip } from '../output.js';
import { resolveAgent } from '../resolve.js';

const KINDS = ['profile', 'owner_model', 'procedural', 'semantic', 'episodic', 'lesson'] as const;
const SCOPES = ['org', 'dept', 'agent'] as const;
const STATUSES = ['active', 'review', 'superseded', 'forgotten'] as const;
const BACKENDS = ['honcho', 'mem0', 'zep', 'supermemory'] as const;

function showMemory(ctx: Ctx, m: Memory): void {
  ctx.fields([
    ['id', m.id], ['kind', m.kind], ['scope', `${m.scope} (${m.scopeId})`], ['status', m.status], ['pinned', m.pinned ? 'yes' : null],
    ['importance', m.importance.toFixed(2)], ['confidence', m.confidence.toFixed(2)], ['entity', m.entity], ['task type', m.taskType],
    ['author', m.author], ['source run', m.sourceRunId], ['used', `${m.useCount} times`], ['superseded by', m.supersededBy],
    ['updated', ago(m.updatedAt, ctx.deps.now())],
  ]);
  ctx.lines(['', m.content.trimEnd()]);
}

/** Read new document content from a file, stdin (`-`), or `$EDITOR`. */
async function editedDoc(ctx: Ctx, current: string, file: string | undefined, name: string): Promise<string> {
  if (file === '-') return ctx.deps.readStdin();
  if (file) {
    if (!ctx.deps.fs.exists(file)) throw new UsageError(`no such file: ${file}`);
    return ctx.deps.fs.readText(file);
  }
  if (!ctx.deps.stdinIsTTY) return ctx.deps.readStdin();
  return ctx.deps.editText(current, name);
}

export function memoryCommands(program: Command, deps: CliDeps): void {
  const memory = program.command('memory').description('what agents have learned: search, review, correct and forget');

  memory
    .command('embedder')
    .description('which embedding model backs semantic memory search, and why')
    .action(action(deps, async (ctx) => {
      const e = await ctx.client().embedderStatus();
      ctx.emit(e, () => {
        ctx.fields([
          ['provider', e.provider], ['model', e.id], ['dimensions', e.dims], ['semantic search', e.semantic ? 'yes' : 'no (lexical hash embedder)'],
          ['mode', e.mode], ['key', e.authRef], ['why', e.reason],
        ]);
        if (!e.semantic) ctx.note(ctx.style.dim('for real embeddings: conductor secret set <ref>, then conductor config set embeddings.provider openai'));
        else if (e.mode !== 'auto') ctx.note(ctx.style.dim('back to automatic selection: conductor config set embeddings.provider'));
      });
    }));

  memory
    .command('utility-model')
    .description('which model does the background work (summaries, memory extraction, skill judging), and why')
    .action(action(deps, async (ctx) => {
      const u = await ctx.client().utilityModelStatus(await ctx.org());
      ctx.emit(u, () => ctx.fields([
        ['backend', u.backend], ['model', u.model], ['billing', u.backend === 'offline' ? null : u.subscription ? 'subscription (CLI login)' : 'metered API'],
        ['local calls today', u.localCalls ? `${u.localCalls.today} of ${u.localCalls.dailyCap}` : null], ['why', u.reason],
      ]));
    }));

  memory
    .command('search <query...>')
    .description('hybrid search over memories (scoped to what an agent can see with --agent)')
    .option('--agent <agent>', 'search as this agent: its own, its department\'s and the org\'s memories')
    .option('--kind <kind,...>', KINDS.join(' | '))
    .option('--limit <n>', 'maximum results', '10')
    .option('--review', 'include memories still waiting for review')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const hits = await ctx.client().searchMemory(o, compact({
        text: arg(args, 0, 'query'),
        agentId: str(opts, 'agent') ? (await resolveAgent(ctx, o, str(opts, 'agent')!)).id : undefined,
        kinds: choices(opts, 'kind', KINDS),
        limit: num(opts, 'limit', { int: true, min: 1, max: 200 }),
        includeReview: flag(opts, 'review') ? true : undefined,
      }));
      ctx.emit(hits, () => ctx.table(
        ['score', 'kind', 'scope', 'content', 'id'],
        hits.map((h) => [h.score.toFixed(2), h.memory.kind, h.memory.scope, clip(h.memory.content, 90), h.memory.id]),
        'no memories match',
      ));
    }));

  memory
    .command('list')
    .description('list memories; --review shows the queue waiting for your approval')
    .option('--review', 'only low-confidence memories waiting for review')
    .option('--scope <scope>', SCOPES.join(' | '))
    .option('--agent <agent>', 'only this agent\'s memories')
    .option('--kind <kind>', KINDS.join(' | '))
    .option('--status <status>', STATUSES.join(' | '))
    .option('--limit <n>', 'maximum rows', '50')
    .action(action(deps, async (ctx, _a, opts) => {
      const o = await ctx.org();
      if (flag(opts, 'review') && str(opts, 'status')) throw new UsageError('pass either --review or --status, not both');
      const agent = str(opts, 'agent') ? await resolveAgent(ctx, o, str(opts, 'agent')!) : undefined;
      const rows = await ctx.client().listMemory(o, compact({
        scope: agent ? ('agent' as const) : choice(opts, 'scope', SCOPES),
        scopeId: agent?.id,
        kind: choice(opts, 'kind', KINDS),
        status: flag(opts, 'review') ? ('review' as const) : choice(opts, 'status', STATUSES),
        limit: num(opts, 'limit', { int: true, min: 1, max: 1000 }),
      }));
      ctx.emit(rows, () => {
        ctx.table(
          ['id', 'kind', 'scope', 'status', 'conf', 'pin', 'content'],
          rows.map((m) => [m.id, m.kind, m.scope, m.status, m.confidence.toFixed(2), m.pinned ? '*' : '', clip(m.content, 80)]),
          flag(opts, 'review') ? 'nothing is waiting for review' : 'no memories yet',
        );
        if (flag(opts, 'review') && rows.length) ctx.note(ctx.style.dim('keep: conductor memory approve <id>   ·   drop: conductor memory forget <id>   ·   fix: conductor memory edit <id>'));
      });
    }));

  memory
    .command('show <id>')
    .description('show one memory')
    .action(action(deps, async (ctx, args) => {
      const m = await ctx.client().getMemory(await ctx.org(), arg(args, 0, 'id'));
      ctx.emit(m, () => showMemory(ctx, m));
    }));

  memory
    .command('edit <id>')
    .description('correct a memory; without flags the content opens in $EDITOR')
    .option('--content <text>', 'new content')
    .option('--importance <0-1>', 'new importance')
    .option('--confidence <0-1>', 'new confidence')
    .option('--kind <kind>', KINDS.join(' | '))
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const id = arg(args, 0, 'id');
      const patch: UpdateMemoryRequest = compact({
        content: str(opts, 'content'),
        importance: num(opts, 'importance', { min: 0, max: 1 }),
        confidence: num(opts, 'confidence', { min: 0, max: 1 }),
        kind: choice(opts, 'kind', KINDS),
      });
      if (isEmpty(patch)) {
        if (!ctx.deps.stdinIsTTY) throw new UsageError('nothing to change: pass --content, --importance, --confidence or --kind');
        const current = await ctx.client().getMemory(o, id);
        const next = (await ctx.deps.editText(current.content, `${id}.md`)).trim();
        if (!next || next === current.content.trim()) return ctx.emit(current, () => ctx.line(ctx.style.dim('no changes')));
        patch.content = next;
      }
      const m = await ctx.client().updateMemory(o, id, patch);
      ctx.emit(m, () => ctx.ok(`updated ${m.id}: ${Object.keys(patch).join(', ')}`));
    }));

  memory
    .command('pin <id>')
    .description('pin a memory so it is never decayed or compressed away')
    .option('--off', 'unpin instead')
    .action(action(deps, async (ctx, args, opts) => {
      const m = await ctx.client().updateMemory(await ctx.org(), arg(args, 0, 'id'), { pinned: !flag(opts, 'off') });
      ctx.emit(m, () => ctx.ok(`${m.pinned ? 'pinned' : 'unpinned'} ${m.id}`));
    }));

  memory
    .command('forget <id>')
    .description('forget a memory (agents stop recalling it)')
    .action(action(deps, async (ctx, args) => {
      const id = arg(args, 0, 'id');
      await ctx.client().forgetMemory(await ctx.org(), id);
      ctx.emit({ ok: true, id }, () => ctx.ok(`forgot ${id}`));
    }));

  memory
    .command('approve <id>')
    .description('approve a memory from the review queue')
    .action(action(deps, async (ctx, args) => {
      const m = await ctx.client().updateMemory(await ctx.org(), arg(args, 0, 'id'), { status: 'active' });
      ctx.emit(m, () => ctx.ok(`approved ${m.id}; agents can recall it now`));
    }));

  memory
    .command('owner-model')
    .description('print what the org has learned about you (USER.md); --edit changes it')
    .option('--edit', 'edit it in $EDITOR (or from --file / stdin)')
    .option('--file <path>', 'with --edit: replace it with this file ("-" for stdin)')
    .action(action(deps, async (ctx, _a, opts) => {
      const o = await ctx.org();
      const current = await ctx.client().getOwnerModel(o);
      if (!flag(opts, 'edit')) {
        if (str(opts, 'file')) throw new UsageError('--file only applies with --edit');
        return ctx.emit(current, () => ctx.line(current.content.trimEnd() || ctx.style.dim('(empty — agents fill this in as they learn how you work)')));
      }
      const next = await editedDoc(ctx, current.content, str(opts, 'file'), 'USER.md');
      if (next === current.content) return ctx.emit(current, () => ctx.line(ctx.style.dim('no changes')));
      const saved = await ctx.client().putOwnerModel(o, next);
      ctx.emit(saved, () => ctx.ok(`owner model updated (${saved.content.length} characters)`));
    }));

  const backend = memory.command('backend').description('optional external memory backend for an org (Honcho, Mem0, Zep, Supermemory); local memory always stays on');

  backend
    .command('show')
    .description('show the org\'s external memory backend')
    .action(action(deps, async (ctx) => {
      const { backend: b } = await ctx.client().getMemoryBackend(await ctx.org());
      ctx.emit({ backend: b }, () => {
        if (!b) return ctx.line(ctx.style.dim('local memory only — add a backend: conductor memory backend set mem0 --secret-ref org/<org>/mem0-api-key'));
        ctx.fields([['backend', b.kind], ['base URL', b.baseUrl ?? '(default)'], ['secret ref', b.authRef], ['key stored', b.ready ? 'yes' : ctx.style.yellow('no — the backend is skipped until it is')], ['options', b.options ? JSON.stringify(b.options) : null]]);
        if (!b.ready) ctx.line(`  store the key (never echoed): conductor secret set ${b.authRef}`);
      });
    }));

  backend
    .command('set <kind>')
    .description(`use an external memory backend (${BACKENDS.join(', ')}) for this org`)
    .requiredOption('--secret-ref <ref>', 'secret holding the backend API key (store it with `conductor secret set <ref>`)')
    .option('--base-url <url>', 'self-hosted endpoint (default: the vendor\'s cloud)')
    .option('--option <key=value...>', 'backend-specific option, e.g. workspace=acme (repeatable)')
    .action(action(deps, async (ctx, args, opts) => {
      const options: Record<string, string> = {};
      for (const pair of list(opts, 'option')) {
        const i = pair.indexOf('=');
        if (i < 1) throw new UsageError('--option expects key=value');
        options[pair.slice(0, i).trim()] = pair.slice(i + 1);
      }
      const { backend: b } = await ctx.client().putMemoryBackend(await ctx.org(), compact({
        kind: oneOf(arg(args, 0, 'kind'), '<kind>', BACKENDS),
        authRef: str(opts, 'secretRef')!,
        baseUrl: str(opts, 'baseUrl'),
        options: isEmpty(options) ? undefined : options,
      }));
      ctx.emit({ backend: b }, () => {
        ctx.ok(`external memory backend set to ${b?.kind ?? arg(args, 0, 'kind')}`);
        if (b && !b.ready) ctx.line(`  the secret ${b.authRef} is not stored yet: conductor secret set ${b.authRef}`);
      });
    }));

  backend
    .command('clear')
    .description('go back to local memory only')
    .action(action(deps, async (ctx) => {
      await ctx.client().clearMemoryBackend(await ctx.org());
      ctx.emit({ backend: null }, () => ctx.ok('external memory backend removed; local memory only'));
    }));
}
