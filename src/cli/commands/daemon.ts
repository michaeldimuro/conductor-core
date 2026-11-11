import { join } from 'node:path';
import type { Command } from 'commander';
import type { HealthResponse, StatusResponse } from '../../api/types.js';
import type { LaunchdStatus } from '../../daemon/launchd.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, flag, num, str } from '../command.js';
import { CliError, EXIT, SilentExit, UsageError, isUnreachable } from '../errors.js';
import { duration } from '../output.js';

const HEADLESS_LABEL = 'ai.conductor.daemon.headless';
const SYSTEM_BIN = '/usr/local/bin/conductord';
/** FR-1: the UI must be reachable within 30 s of the agent loading. */
const READY_TIMEOUT_MS = 30_000;

/** The daemon entry launchd should run: the build when present, else the tsx dev launcher. */
export function daemonEntry(ctx: Ctx): { entry: string; dev: boolean } {
  const root = ctx.deps.projectRoot;
  const built = join(root, 'dist', 'daemon', 'main.js');
  if (ctx.deps.fs.exists(built)) return { entry: built, dev: false };
  const dev = join(root, 'bin', 'conductord.mjs');
  if (ctx.deps.fs.exists(dev) && ctx.deps.fs.exists(join(root, 'src', 'daemon', 'main.ts'))) return { entry: dev, dev: true };
  throw new CliError(`No daemon build found at ${built}.`, EXIT.failure, [`build it first: (cd ${root} && npm run build)`, 'then run: conductor install'], 'no_build');
}

/** Poll `/healthz` until the daemon answers or the timeout passes. */
export async function waitForHealth(ctx: Ctx, timeoutMs = READY_TIMEOUT_MS): Promise<{ health: HealthResponse; waitedMs: number } | null> {
  const started = ctx.deps.now();
  const client = ctx.anonymous();
  for (;;) {
    try {
      const health = await client.health();
      return { health, waitedMs: ctx.deps.now() - started };
    } catch (err) {
      if (!isUnreachable(err)) throw err;
    }
    if (ctx.deps.now() - started >= timeoutMs || ctx.deps.signal.aborted) return null;
    await ctx.deps.sleep(500);
  }
}

function nextSteps(ctx: Ctx): string[] {
  return [
    'Next steps:',
    '  conductor open         open the web UI in your browser (signs you in)',
    '  conductor quickstart   create your first org and run its first issue',
    '  conductor doctor       check provider logins, Keychain and the tunnel',
    `  conductor logs -f      follow the daemon log (${ctx.logDir})`,
  ];
}

async function installHeadless(ctx: Ctx, out: string | undefined): Promise<void> {
  const { entry } = daemonEntry(ctx);
  const vaultKeyFile = join(ctx.home, 'vault.key');
  const plist = ctx.deps.launchd.renderHeadlessDaemonPlist({ program: SYSTEM_BIN, home: ctx.home, logDir: ctx.logDir, userName: ctx.deps.username, vaultKeyFile });
  const wrapper = ctx.deps.launchd.renderWrapper(ctx.deps.nodePath, entry);
  const plistFile = out ?? `${HEADLESS_LABEL}.plist`;
  const target = `/Library/LaunchDaemons/${HEADLESS_LABEL}.plist`;
  const steps = [
    `printf '%s' ${shellQuote(wrapper)} | sudo tee ${SYSTEM_BIN} >/dev/null && sudo chmod 755 ${SYSTEM_BIN}`,
    `mkdir -p ${shellQuote(ctx.home)} ${shellQuote(ctx.logDir)}`,
    `(umask 077 && openssl rand -base64 32 > ${shellQuote(vaultKeyFile)})   # vault passphrase; back it up somewhere safe`,
    `sudo install -m 644 -o root -g wheel ${shellQuote(plistFile)} ${target}`,
    `sudo launchctl bootstrap system ${target}`,
    `curl -fsS ${ctx.baseUrl}/healthz   # should answer within 30 s`,
  ];
  if (out) ctx.deps.fs.writeText(out, plist, 0o644);
  if (ctx.json) return ctx.printJson({ label: HEADLESS_LABEL, plist, plistFile: out ?? null, target, steps });
  if (out) ctx.ok(`wrote ${out}`);
  else ctx.line(plist.trimEnd());
  ctx.note('');
  ctx.note('Headless LaunchDaemon (boots without login; no Keychain, no GUI browser — secrets live in the encrypted file vault).');
  ctx.note('Conductor never installs this itself. Run these steps as an administrator:');
  if (!out) ctx.note(`  0. save the plist above:  conductor install --headless --out ${plistFile}`);
  steps.forEach((s, i) => ctx.note(`  ${i + 1}. ${s}`));
  ctx.note(`To remove it: sudo launchctl bootout system/${HEADLESS_LABEL} && sudo rm ${target}`);
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function install(ctx: Ctx, opts: { port?: number; load: boolean; headless: boolean; out?: string }): Promise<void> {
  if (opts.port !== undefined) ctx.globals.url = `http://127.0.0.1:${opts.port}`;
  if (opts.headless) return installHeadless(ctx, opts.out);

  const { entry, dev } = daemonEntry(ctx);
  ctx.deps.fs.mkdirp(ctx.home);
  const result = await ctx.deps.launchd.installLaunchAgent({ home: ctx.home, entry, nodePath: ctx.deps.nodePath, logDir: ctx.logDir, port: opts.port, load: opts.load });
  // Remember a non-default port so later commands find the daemon without --url.
  if (opts.port !== undefined) ctx.saveConfig({ url: ctx.baseUrl });

  const ready = result.loaded ? await waitForHealth(ctx) : null;
  const data = { ...result, entry, devEntry: dev, url: ctx.baseUrl, ready: ready !== null, readyMs: ready?.waitedMs ?? null, version: ready?.health.version ?? null };
  if (ctx.json) {
    ctx.printJson(data);
  } else {
    if (dev) ctx.warn(`no build found; launchd will run the TypeScript source through tsx. For a production install run \`npm run build\` in ${ctx.deps.projectRoot} and re-run \`conductor install\`.`);
    ctx.ok(`LaunchAgent written to ${result.plistPath}`);
    ctx.fields([['program', result.program], ['home', ctx.home], ['logs', result.logDir]]);
    if (!result.loaded) {
      ctx.line('Not loaded (--no-load). Load it with:');
      ctx.line(`  launchctl bootstrap gui/$(id -u) ${result.plistPath}`);
    } else if (ready) {
      ctx.ok(`daemon ${ready.health.version} is up after ${duration(ready.waitedMs)} — UI: ${ctx.baseUrl}`);
      ctx.lines(nextSteps(ctx));
    }
  }
  if (result.loaded && !ready) {
    throw new CliError(`The LaunchAgent is loaded but the daemon did not answer at ${ctx.baseUrl} within ${READY_TIMEOUT_MS / 1000} s.`, EXIT.failure, [
      `read the startup error: conductor logs   (${join(result.logDir, 'conductord.err.log')})`,
      'check the environment: conductor doctor',
    ], 'not_ready');
  }
}

interface StatusData {
  url: string;
  launchd: LaunchdStatus;
  reachable: boolean;
  health: HealthResponse | null;
  status: StatusResponse | null;
  note?: string;
}

async function status(ctx: Ctx): Promise<void> {
  const data: StatusData = { url: ctx.baseUrl, launchd: await ctx.deps.launchd.launchdStatus(), reachable: false, health: null, status: null };
  try {
    data.health = await ctx.anonymous().health();
    data.reachable = true;
  } catch (err) {
    if (!isUnreachable(err)) throw err;
  }
  if (data.reachable) {
    if (ctx.readToken()) data.status = await ctx.client().status();
    else data.note = `no owner token at ${ctx.tokenFile}; details unavailable`;
  }
  ctx.emit(data, () => {
    const l = data.launchd;
    const s = ctx.style;
    const st = data.status;
    ctx.fields([
      ['launchd', !l.installed ? s.red('not installed') : !l.loaded ? s.yellow('installed, not loaded') : l.pid ? s.green(`running (pid ${l.pid})`) : s.yellow(`loaded, not running (last exit ${l.lastExitCode ?? '?'})`)],
      ['daemon', data.health ? s.green(`up ${duration(data.health.uptimeMs)}, v${data.health.version}`) : s.red(`unreachable at ${data.url}`)],
      ['url', data.url],
      ...(st
        ? ([
            ['public url', st.publicUrl],
            ['runs', `${st.runtime.running} running, ${st.runtime.queued} queued`],
            ['orgs', st.counts.orgs],
            ['agents', st.counts.agents],
            ['approvals', `${st.counts.pendingApprovals} pending`],
            ['kill switch', st.killSwitch.global ? s.red('ENGAGED (global)') : st.killSwitch.orgs.length ? s.yellow(`engaged for ${st.killSwitch.orgs.length} org(s)`) : 'off'],
          ] as Array<[string, string | number]>)
        : []),
    ]);
    if (data.note) ctx.note(data.note);
    if (!data.reachable) ctx.note(l.installed ? 'start it: conductor restart   ·   why: conductor logs' : 'install it: conductor install');
  });
  if (!data.reachable) throw new SilentExit(EXIT.failure);
}

export function daemonCommands(program: Command, deps: CliDeps): void {
  program
    .command('install')
    .description('install the launchd agent so the daemon starts at login and restarts on crash')
    .option('--port <n>', 'port for the API and web UI (default 7420)')
    .option('--no-load', 'write the plist but do not load it')
    .option('--headless', 'print the LaunchDaemon plist and sudo steps for boot-without-login instead of installing')
    .option('--out <file>', 'with --headless: write the plist to this file')
    .action(action(deps, (ctx, _args, opts) => {
      if (str(opts, 'out') && !flag(opts, 'headless')) throw new UsageError('--out only applies to --headless');
      return install(ctx, { port: num(opts, 'port', { int: true, min: 1, max: 65_535 }), load: opts.load !== false, headless: flag(opts, 'headless'), out: str(opts, 'out') });
    }));

  program
    .command('uninstall')
    .description('stop the daemon and remove the launchd agent (data in the home directory is kept)')
    .action(action(deps, async (ctx) => {
      await ctx.deps.launchd.uninstallLaunchAgent();
      ctx.emit({ uninstalled: true, home: ctx.home }, () => ctx.ok(`LaunchAgent removed. Your data is still in ${ctx.home}.`));
    }));

  program
    .command('restart')
    .description('restart the daemon through launchd and wait until it is healthy')
    .action(action(deps, async (ctx) => {
      try {
        await ctx.deps.launchd.restartLaunchAgent();
      } catch (err) {
        throw new CliError(`launchd could not restart the daemon: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`, EXIT.failure, ['is it installed? run: conductor install'], 'launchd');
      }
      const ready = await waitForHealth(ctx);
      if (!ready) throw new CliError(`The daemon did not come back at ${ctx.baseUrl} within ${READY_TIMEOUT_MS / 1000} s.`, EXIT.failure, ['read the startup error: conductor logs'], 'not_ready');
      ctx.emit({ restarted: true, url: ctx.baseUrl, version: ready.health.version, readyMs: ready.waitedMs }, () => ctx.ok(`daemon ${ready.health.version} is back after ${duration(ready.waitedMs)} — ${ctx.baseUrl}`));
    }));

  program.command('status').description('launchd state and a summary of what the daemon is doing').action(action(deps, status));

  program
    .command('open')
    .description('sign in and open the web UI in your browser')
    .option('--print', 'print the one-time login URL instead of opening it')
    .action(action(deps, async (ctx, _args, opts) => {
      const login = await ctx.client().createLoginCode({ label: 'browser' });
      if (flag(opts, 'print')) return ctx.emit({ url: login.url, expiresAt: login.expiresAt }, () => ctx.line(login.url));
      const res = await ctx.deps.exec('open', [login.url]);
      if (res.code !== 0) {
        throw new CliError('Could not launch a browser.', EXIT.failure, ['print the link instead and open it yourself (valid 2 minutes, single use): conductor open --print']);
      }
      ctx.emit({ opened: true, expiresAt: login.expiresAt }, () => ctx.ok(`opened ${ctx.baseUrl} in your browser`));
    }));

  program
    .command('pair')
    .description('print a one-time login link for a phone or another device over the tunnel')
    .option('--label <name>', 'name shown for the device session', 'phone')
    .option('--days <n>', 'how long the device stays signed in', '30')
    .action(action(deps, async (ctx, _args, opts) => {
      const days = num(opts, 'days', { min: 1, max: 90 }) ?? 30;
      const login = await ctx.client().createLoginCode({ label: str(opts, 'label') ?? 'phone', ttlMs: Math.round(days * 86_400_000) });
      const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/)/.test(login.remoteUrl);
      ctx.emit({ url: login.remoteUrl, code: login.code, expiresAt: login.expiresAt, remoteReachable: !local }, () => {
        ctx.line(login.remoteUrl);
        ctx.fields([['code', login.code], ['valid for', `${duration(login.expiresAt - ctx.deps.now())}, single use`], ['session', `${days} days`]]);
      });
      if (local) {
        ctx.warn('no public URL is configured, so this link only works on this Mac.');
        ctx.note('  set one up: conductor doctor --fix   (Tailscale)   or   conductor config set daemon.public_url https://<your-tunnel-host>');
      }
    }));
}
