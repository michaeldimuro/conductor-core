import type { Command } from 'commander';
import type { BrowserEngineConfig, BrowserProfileDto, BrowserSessionDto, UpdateProfileRequest } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, arg, compact, flag, isEmpty, list, oneOf, optArg, str } from '../command.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { ago, clip, duration } from '../output.js';
import { agentNames, pick, resolveAgent } from '../resolve.js';

const CHANNELS = ['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary', 'msedge'] as const;
const ENGINES = ['chromium', ...CHANNELS, 'cdp'] as const;

const engineText = (e: BrowserEngineConfig): string => (e.kind === 'chromium' ? 'bundled Chromium' : e.kind === 'channel' ? `installed ${e.channel}` : `running Chrome at ${e.endpoint}`);
const windowText = (headed: boolean | null): string => (headed === null ? 'daemon default' : headed ? 'headed (visible window)' : 'headless');

async function resolveProfile(ctx: Ctx, org: string, needle: string): Promise<BrowserProfileDto> {
  const profiles = await ctx.client().listBrowserProfiles(org);
  return pick('browser profile', needle, profiles, (p) => [p.id, p.slug, p.name], (p) => `${p.slug}  ${p.name}  (${p.id})`, 'conductor browser profiles');
}

/** `--engine chromium|chrome|…|cdp` (+ `--cdp-endpoint`) → the engine config the API takes. */
function engineFrom(opts: Record<string, unknown>): BrowserEngineConfig | undefined {
  const endpoint = str(opts, 'cdpEndpoint');
  const raw = str(opts, 'engine') ?? (endpoint ? 'cdp' : undefined);
  if (raw === undefined) return undefined;
  const kind = oneOf(raw, '--engine', ENGINES);
  if (kind === 'cdp') {
    if (!endpoint) throw new UsageError('--engine cdp needs --cdp-endpoint, e.g. http://127.0.0.1:9222', ['start Chrome with --remote-debugging-port=9222 first']);
    return { kind: 'cdp', endpoint };
  }
  if (endpoint) throw new UsageError('--cdp-endpoint only applies with --engine cdp');
  return kind === 'chromium' ? { kind: 'chromium' } : { kind: 'channel', channel: kind };
}

function headedFrom(opts: Record<string, unknown>): boolean | null | undefined {
  const set = [flag(opts, 'headed'), flag(opts, 'headless'), flag(opts, 'defaultWindow')].filter(Boolean).length;
  if (set > 1) throw new UsageError('pass only one of --headed, --headless, --default-window');
  return flag(opts, 'headed') ? true : flag(opts, 'headless') ? false : flag(opts, 'defaultWindow') ? null : undefined;
}

function settingsOptions(cmd: Command): Command {
  return cmd
    .option('--engine <engine>', `which browser: ${ENGINES.join(' | ')}`)
    .option('--cdp-endpoint <url>', 'with --engine cdp: the loopback debugging endpoint of your running Chrome')
    .option('--headed', 'show the browser window on this Mac')
    .option('--headless', 'never show a window')
    .option('--default-window', 'follow the daemon default again')
    .option('--op-vault <name,...>', '1Password vaults the agent may fill from with op:// references ("none" clears the list)');
}

function settingsFrom(opts: Record<string, unknown>): Pick<UpdateProfileRequest, 'engine' | 'headed' | 'onePasswordVaults'> {
  const vaults = list(opts, 'opVault');
  return compact({
    engine: engineFrom(opts),
    headed: headedFrom(opts),
    onePasswordVaults: vaults.length === 0 ? undefined : vaults.length === 1 && vaults[0]!.toLowerCase() === 'none' ? [] : vaults,
  });
}

function showProfile(ctx: Ctx, p: BrowserProfileDto): void {
  ctx.fields([
    ['name', p.name], ['slug', p.slug], ['id', p.id], ['engine', engineText(p.engine)], ['window', windowText(p.headed)],
    ['allowed domains', p.domainAllowlist.length ? p.domainAllowlist.join(', ') : 'any'], ['sensitive domains', p.sensitiveDomains.join(', ') || null],
    ['1Password vaults', p.onePasswordVaults.join(', ') || null], ['in use by', p.leasedRunId],
  ]);
}

export function browserCommands(program: Command, deps: CliDeps): void {
  const browser = program.command('browser').description('agent browsers: profiles, engine and headed mode, and human takeovers');

  browser
    .command('profiles')
    .description('list browser profiles with their engine and window mode')
    .action(action(deps, async (ctx) => {
      const o = await ctx.org();
      const [profiles, name] = await Promise.all([ctx.client().listBrowserProfiles(o), agentNames(ctx, o)]);
      ctx.emit(profiles, () => ctx.table(
        ['slug', 'name', 'agent', 'engine', 'window', 'in use', 'id'],
        profiles.map((p) => [p.slug, p.name, p.agentId ? name(p.agentId) : 'shared', engineText(p.engine), windowText(p.headed), p.leasedRunId ? 'yes' : '', p.id]),
        'no browser profiles yet — one is created the first time an agent browses, or: conductor browser profile-create "Ada browser" --agent ada',
      ));
    }));

  settingsOptions(browser
    .command('profile-create <name>')
    .description('create a browser profile for an agent')
    .option('--agent <agent>', 'the agent that owns the profile'))
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const agentId = str(opts, 'agent') ? (await resolveAgent(ctx, o, str(opts, 'agent')!)).id : undefined;
      const p = await ctx.client().createBrowserProfile(o, compact({ name: arg(args, 0, 'name'), agentId, ...settingsFrom(opts) }));
      ctx.emit(p, () => {
        ctx.ok(`created browser profile ${p.name}`);
        showProfile(ctx, p);
      });
    }));

  settingsOptions(browser
    .command('profile-set <profile>')
    .description('change a profile\'s engine (bundled Chromium, your Chrome, or a running Chrome over CDP), window mode or 1Password vaults'))
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const patch = settingsFrom(opts);
      if (isEmpty(patch)) throw new UsageError('nothing to change: pass --engine, --headed, --headless, --default-window or --op-vault');
      const current = await resolveProfile(ctx, o, arg(args, 0, 'profile'));
      const p = await ctx.client().updateBrowserProfile(o, current.id, patch);
      ctx.emit(p, () => {
        ctx.ok(`updated ${p.name}; takes effect on the agent's next run`);
        showProfile(ctx, p);
      });
    }));

  browser
    .command('takeovers')
    .description('browser sessions where an agent is waiting for you (login, MFA, CAPTCHA)')
    .option('--all', 'include finished takeovers')
    .action(action(deps, async (ctx, _a, opts) => {
      const o = await ctx.org();
      const [sessions, name] = await Promise.all([ctx.client().listBrowserSessions(o), agentNames(ctx, o)]);
      const rows = flag(opts, 'all') ? sessions : sessions.filter((s) => s.status === 'pending' || s.status === 'active');
      ctx.emit(rows, () => {
        ctx.table(
          ['id', 'agent', 'status', 'reason', 'asked', 'expires in'],
          rows.map((s) => [s.id, name(s.agentId), s.status, clip(s.reason, 60), ago(s.createdAt, ctx.deps.now()), s.status === 'pending' || s.status === 'active' ? duration(Math.max(0, s.expiresAt - ctx.deps.now())) : '-']),
          'no agent is waiting for you in a browser',
        );
        if (rows.some((s) => s.status === 'pending')) ctx.note(ctx.style.dim('take over: conductor browser takeover <id>'));
      });
    }));

  browser
    .command('takeover [session]')
    .description('get a fresh one-time link to an agent\'s waiting browser (the previous link stops working)')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const waiting = (await ctx.client().listBrowserSessions(o)).filter((s) => s.status === 'pending' || s.status === 'active');
      const needle = optArg(args, 0);
      let session: BrowserSessionDto;
      if (needle) session = pick('takeover', needle, waiting, (s) => [s.id], (s) => `${s.id}  ${clip(s.reason, 60)}`, 'conductor browser takeovers');
      else if (waiting.length === 1) session = waiting[0]!;
      else if (waiting.length === 0) throw new CliError('No agent is waiting for you in a browser.', EXIT.failure, ['list past takeovers: conductor browser takeovers --all'], 'not_found');
      else throw new UsageError(`${waiting.length} takeovers are waiting; name one.`, waiting.map((s) => `  ${s.id}  ${clip(s.reason, 60)}`));
      const link = await ctx.client().takeoverLink(o, session.id);
      ctx.emit(link, () => {
        ctx.line(`Takeover link for "${clip(session.reason, 80)}" (works once, expires in ${duration(Math.max(0, link.expiresAt - ctx.deps.now()))}):`);
        ctx.line(`  ${link.url}`);
        ctx.line(ctx.style.dim('  open it on the device you want to use; when you are done, press "Hand back" and the agent continues'));
      });
    }));
}
