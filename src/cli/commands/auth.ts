import type { Command } from 'commander';
import type { CliProvider, LoginMethod, LoginSession, ProviderAuthStatus } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, arg, flag, oneOf, str } from '../command.js';
import { CliError, EXIT, SilentExit, UsageError } from '../errors.js';

const PROVIDERS: readonly CliProvider[] = ['claude', 'codex'];
const METHODS: readonly LoginMethod[] = ['subscription', 'console', 'token', 'device', 'browser', 'api_key'];
const DEFAULT_METHOD: Record<CliProvider, LoginMethod> = { claude: 'subscription', codex: 'device' };
const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

const providerArg = (v: string): CliProvider => oneOf(v.toLowerCase().replace(/[-_]?(code|cli|local)$/, ''), '<provider>', PROVIDERS);

function loginText(p: ProviderAuthStatus): string {
  if (!p.installed) return 'not installed';
  if (p.loggedIn === 'yes') return `logged in${p.method !== 'unknown' ? ` (${p.method.replace('_', ' ')})` : ''}${p.plan ? `, ${p.plan} plan` : ''}`;
  return p.loggedIn === 'no' ? 'not logged in' : 'unknown';
}

/** A credential from a hidden prompt, or stdin when piped (`pbpaste | conductor auth login …`). Never echoed. */
async function readCredential(ctx: Ctx, label: string): Promise<string> {
  const v = ctx.deps.stdinIsTTY ? await ctx.deps.prompt(`${label}: `, { hidden: true }) : await ctx.deps.readStdin();
  const trimmed = v.trim();
  if (!trimmed) throw new UsageError(`no ${label.toLowerCase()} given`);
  return trimmed;
}

/** Follow a login session until it ends: print the link/code, relay the pasted code, cancel on Ctrl-C. */
async function follow(ctx: Ctx, first: LoginSession): Promise<LoginSession> {
  const client = ctx.client();
  let s = first;
  let shown = false;
  let asked = false;
  const onAbort = () => void client.cancelLogin(s.id).catch(() => {});
  ctx.deps.signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (!FINISHED.has(s.state)) {
      if (!shown && s.url) {
        shown = true;
        ctx.line(`Open this link to sign in:\n  ${ctx.style.cyan(s.url)}`);
        if (s.userCode) ctx.line(`and enter the code  ${ctx.style.bold(s.userCode)}`);
      }
      if (s.state === 'waiting' && s.needsCode && !asked) {
        asked = true;
        if (!ctx.deps.stdinIsTTY) throw new CliError('this login needs the code from the sign-in page; run it in a terminal (or finish it in the web UI)');
        const code = (await ctx.deps.prompt('Paste the code shown after signing in: ')).trim();
        s = await client.submitLoginCode(s.id, code);
        continue;
      }
      if (ctx.deps.signal.aborted) break;
      await ctx.deps.sleep(1000);
      s = await client.getLoginSession(s.id);
    }
  } finally {
    ctx.deps.signal.removeEventListener('abort', onAbort);
  }
  return s;
}

/**
 * `conductor auth` — authenticate Conductor with the Claude Code and Codex CLIs:
 * check the CLIs' logins, run their login flows through the daemon (works over
 * the tunnel too), store long-lived tokens/keys for bindings, log out.
 */
export function authCommands(program: Command, deps: CliDeps): void {
  const auth = program.command('auth').description('provider accounts: log Conductor in to Claude Code and Codex, store long-lived tokens');

  auth
    .command('status')
    .description('login state of each agent CLI and the credentials Conductor stored for bindings')
    .option('--refresh', 'ask the CLIs again instead of using the last answer')
    .action(action(deps, async (ctx, _a, opts) => {
      const org = ctx.chosenOrg();
      const list = await ctx.client().listProviders({ ...(org ? { orgId: org } : {}), refresh: flag(opts, 'refresh') });
      ctx.emit(list, () => {
        ctx.table(['provider', 'cli', 'login', 'expires', 'stored for bindings'], list.map((p) => [
          p.label, p.installed ? p.version ?? 'installed' : 'missing', loginText(p),
          p.expiresAt ? (p.expiresAt > ctx.deps.now() ? new Date(p.expiresAt).toISOString().slice(0, 10) : 'expired') : '',
          p.storedCredentials.filter((c) => c.present).map((c) => `${c.auth}: ${c.ref}`).join(', ') || 'none',
        ]));
        if (list.some((p) => p.loggedIn !== 'yes')) ctx.note(ctx.style.dim('log in: conductor auth login claude | conductor auth login codex'));
      });
    }));

  auth
    .command('login <provider>')
    .description('log in: claude (subscription | console | token) or codex (device | browser | api_key)')
    .option('--method <method>', `login method (default: claude subscription, codex device): ${METHODS.join(' | ')}`)
    .option('--key-ref <ref>', 'token/api_key: use a credential already in the secret store instead of pasting one')
    .option('--save-as <ref>', 'token/api_key: where to keep the pasted credential (default conductor/…, or org/<org>/… with --org)')
    .option('--open', 'let the CLI open a browser window on the Mac running the daemon')
    .action(action(deps, async (ctx, args, opts) => {
      const provider = providerArg(arg(args, 0, 'provider'));
      const method = str(opts, 'method') ? oneOf(str(opts, 'method')!, '--method', METHODS) : DEFAULT_METHOD[provider];
      const org = ctx.chosenOrg();
      const body: Parameters<ReturnType<Ctx['client']>['startLogin']>[1] = { method, ...(org ? { orgId: org } : {}), ...(flag(opts, 'open') ? { openBrowser: true } : {}) };
      if (str(opts, 'saveAs')) body.saveAs = str(opts, 'saveAs');
      if (method === 'token' || method === 'api_key') {
        if (str(opts, 'keyRef')) body.secretRef = str(opts, 'keyRef');
        else {
          if (method === 'token' && ctx.deps.stdinIsTTY) ctx.note('Make a long-lived token by running `claude setup-token` in a terminal, then paste it here.');
          body.secret = await readCredential(ctx, method === 'token' ? 'Claude Code token' : 'API key');
        }
      }
      const done = await follow(ctx, await ctx.client().startLogin(provider, body));
      ctx.emit(done, () => {
        if (done.state === 'succeeded') ctx.ok(`${provider}: ${done.message}${done.storedRef ? ` (stored as ${done.storedRef})` : ''}`);
        else ctx.line(`${ctx.style.red('✗')} ${provider} login ${done.state}: ${done.message}`);
      });
      if (done.state !== 'succeeded') throw new SilentExit(EXIT.failure);
    }));

  auth
    .command('logout <provider>')
    .description("log the CLI itself out on this Mac (affects every use of that CLI, not only Conductor's)")
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action(deps, async (ctx, args, opts) => {
      const provider = providerArg(arg(args, 0, 'provider'));
      if (!flag(opts, 'yes')) {
        if (!ctx.deps.stdinIsTTY) throw new UsageError('pass --yes to log out without a prompt');
        const a = (await ctx.deps.prompt(`Log the ${provider} CLI out on this Mac? [y/N] `)).trim().toLowerCase();
        if (a !== 'y' && a !== 'yes') throw new SilentExit(EXIT.failure);
      }
      const p = await ctx.client().logoutProvider(provider);
      ctx.emit(p, () => ctx.ok(`${p.label}: ${loginText(p)}`));
    }));

  auth
    .command('forget <provider> <kind>')
    .description('remove a long-lived credential Conductor stored for bindings (kind: token | api_key)')
    .option('--ref <ref>', 'the secret ref to remove (default: the conventional one)')
    .action(action(deps, async (ctx, args, opts) => {
      const provider = providerArg(arg(args, 0, 'provider'));
      const kind = oneOf(arg(args, 1, 'kind'), '<kind>', ['token', 'api_key'] as const);
      const org = ctx.chosenOrg();
      const p = await ctx.client().forgetProviderCredential(provider, { auth: kind, ...(str(opts, 'ref') ? { ref: str(opts, 'ref') } : {}), ...(org ? { orgId: org } : {}) });
      ctx.emit(p, () => ctx.ok(`${p.label}: stored ${kind} removed`));
    }));
}
