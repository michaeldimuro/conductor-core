import { join } from 'node:path';
import type { Command } from 'commander';
import type { ConductorClient } from '../../api/client.js';
import type { DoctorResponse } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, flag } from '../command.js';
import { SilentExit, isUnreachable, toCliError } from '../errors.js';
import { clip, duration } from '../output.js';

export type CheckStatus = 'ok' | 'fail' | 'warn' | 'skip';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What the user should run or do when the check is not ok. */
  fix?: string;
  /** `--fix` repaired this during the run. */
  fixed?: boolean;
}

const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const KEY_REFS: Record<string, { name: string; secret: string }> = {
  claude_api: { name: 'Anthropic API key', secret: 'anthropic-api-key' },
  openai_api: { name: 'OpenAI API key', secret: 'openai-api-key' },
};

const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
const errText = (ctx: Ctx, err: unknown) => clip(toCliError(err, ctx.baseUrl).message, 160);

interface Tailnet {
  binary: string;
  running: boolean;
  dnsName: string | null;
  ip: string | null;
  state: string;
}

async function tailscale(ctx: Ctx): Promise<Tailnet | null> {
  for (const binary of ['tailscale', TAILSCALE_APP]) {
    const res = await ctx.deps.exec(binary, ['status', '--json'], { timeoutMs: 8000 });
    if (res.code === 127) continue;
    try {
      const j = JSON.parse(res.stdout) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } };
      const dnsName = j.Self?.DNSName?.replace(/\.$/, '') || null;
      return { binary, running: j.BackendState === 'Running', dnsName, ip: j.Self?.TailscaleIPs?.[0] ?? null, state: j.BackendState ?? 'unknown' };
    } catch {
      return { binary, running: false, dnsName: null, ip: null, state: firstLine(res.stderr || res.stdout) || 'not running' };
    }
  }
  return null;
}

function layoutDirs(ctx: Ctx): string[] {
  const h = ctx.home;
  return [h, join(h, 'adapters'), join(h, 'skills', 'global'), join(h, 'orgs'), join(h, 'backups'), join(h, 'run'), ctx.logDir];
}

async function providerChecks(ctx: Ctx, client: ConductorClient | null, checks: Check[]): Promise<void> {
  const before = checks.length;
  for (const [bin, adapter, hint] of [
    ['claude', 'claude_local', 'install Claude Code (npm i -g @anthropic-ai/claude-code) and run `claude` once to log in'],
    ['codex', 'codex_local', 'install the Codex CLI (npm i -g @openai/codex) and run `codex login`'],
  ] as const) {
    const res = await ctx.deps.exec(bin, ['--version'], { timeoutMs: 10_000 });
    if (res.code === 0) checks.push({ id: `provider.${adapter}`, label: `${bin} CLI`, status: 'ok', detail: `${firstLine(res.stdout) || 'present'} (${adapter}; uses your local login)` });
    else checks.push({ id: `provider.${adapter}`, label: `${bin} CLI`, status: 'warn', detail: res.code === 127 ? 'not installed' : `\`${bin} --version\` failed: ${clip(firstLine(res.stderr), 100)}`, fix: hint });
  }

  const org = ctx.chosenOrg();
  for (const [adapter, k] of Object.entries(KEY_REFS)) {
    const id = `provider.${adapter}`;
    const fix = `store one (never echoed): conductor secret set conductor/${k.secret}`;
    if (!client) {
      checks.push({ id, label: k.name, status: 'skip', detail: 'not checked (daemon unreachable)' });
      continue;
    }
    try {
      let ref: string | null = null;
      for (const candidate of [...(org && !org.startsWith('org_') ? [`org/${org}/${k.secret}`] : []), `conductor/${k.secret}`]) {
        if ((await client.secretExists(candidate)).exists) {
          ref = candidate;
          break;
        }
      }
      if (!ref) {
        checks.push({ id, label: k.name, status: 'warn', detail: `none stored (${adapter} unavailable)`, fix });
        continue;
      }
      const health = await client.testAdapter(adapter, { authRef: ref });
      checks.push(health.ok
        ? { id, label: k.name, status: 'ok', detail: `${ref}: ${clip(health.detail ?? 'key works', 120)}` }
        : { id, label: k.name, status: 'fail', detail: `${ref}: ${clip(health.detail ?? 'connection test failed', 140)}`, fix: `replace the key: conductor secret set ${ref}` });
    } catch (err) {
      checks.push({ id, label: k.name, status: 'fail', detail: errText(ctx, err), fix });
    }
  }

  const added = checks.slice(before);
  if (!added.some((c) => c.status === 'ok')) {
    checks.push({ id: 'provider', label: 'usable provider', status: 'fail', detail: 'no provider is ready, so agents cannot run', fix: 'log in to the claude or codex CLI, or store an API key (see above)' });
  }

  // An org's actual bindings, tested by the daemon with its resolved credentials.
  if (client && org) {
    try {
      const d = await client.doctor({ orgId: org });
      for (const b of d.bindings ?? []) {
        checks.push({
          id: `binding.${b.source}`, label: `${org} · ${b.source}`, status: b.health.ok ? 'ok' : 'fail',
          detail: `${b.adapter}${b.model ? `:${b.model}` : ''} — ${clip(b.health.detail ?? (b.health.ok ? 'ok' : 'failed'), 120)}`,
          ...(b.health.ok ? {} : { fix: `fix the login/key for ${b.adapter}, or rebind: conductor agent update <agent> --provider <adapter[:model]>` }),
        });
      }
    } catch (err) {
      checks.push({ id: 'binding', label: `${org} bindings`, status: 'warn', detail: errText(ctx, err) });
    }
  }
}

async function tunnelChecks(ctx: Ctx, client: ConductorClient | null, doc: DoctorResponse | null, fix: boolean, checks: Check[]): Promise<void> {
  const ts = await tailscale(ctx);
  const cf = await ctx.deps.exec('cloudflared', ['--version'], { timeoutMs: 8000 });
  const hasCloudflared = cf.code === 0;

  if (!ts) {
    checks.push({ id: 'tunnel.tailscale', label: 'Tailscale', status: hasCloudflared ? 'skip' : 'warn', detail: 'not installed', ...(hasCloudflared ? {} : { fix: 'for remote access (phone approvals, browser takeover) install Tailscale: brew install --cask tailscale' }) });
  } else if (!ts.running || !ts.dnsName) {
    checks.push({ id: 'tunnel.tailscale', label: 'Tailscale', status: 'warn', detail: `installed but not connected (${ts.state})`, fix: 'connect it: tailscale up' });
  } else {
    checks.push({ id: 'tunnel.tailscale', label: 'Tailscale', status: 'ok', detail: `${ts.dnsName}${ts.ip ? ` (${ts.ip})` : ''}` });
    const serve = await ctx.deps.exec(ts.binary, ['serve', 'status', '--json'], { timeoutMs: 8000 });
    const serving = serve.code === 0 && new RegExp(`(127\\.0\\.0\\.1|localhost):${ctx.port}\\b`).test(serve.stdout);
    checks.push(serving
      ? { id: 'tunnel.serve', label: 'Tailscale serve', status: 'ok', detail: `https://${ts.dnsName} → 127.0.0.1:${ctx.port}` }
      : { id: 'tunnel.serve', label: 'Tailscale serve', status: 'warn', detail: `the tailnet cannot reach port ${ctx.port} yet (the daemon only listens on 127.0.0.1)`, fix: `publish it inside your tailnet: tailscale serve --bg ${ctx.port}` });
  }
  checks.push(hasCloudflared
    ? { id: 'tunnel.cloudflared', label: 'Cloudflare Tunnel', status: 'ok', detail: `${firstLine(cf.stdout || cf.stderr) || 'cloudflared present'}` }
    : { id: 'tunnel.cloudflared', label: 'Cloudflare Tunnel', status: 'skip', detail: 'cloudflared not installed (optional alternative to Tailscale)' });

  if (!client || !doc) {
    checks.push({ id: 'tunnel.public_url', label: 'public URL', status: 'skip', detail: 'not checked (daemon unreachable)' });
    return;
  }
  let stored: unknown;
  try {
    stored = (await client.getSetting('daemon.public_url')).value;
  } catch {
    stored = null;
  }
  if (doc.publicUrlConfigured) {
    checks.push({ id: 'tunnel.public_url', label: 'public URL', status: 'ok', detail: doc.publicUrl });
  } else if (typeof stored === 'string' && stored) {
    checks.push({ id: 'tunnel.public_url', label: 'public URL', status: 'warn', detail: `${stored} is saved but the running daemon has not picked it up`, fix: 'apply it: conductor restart' });
  } else if (fix && ts?.running && ts.dnsName) {
    const url = `https://${ts.dnsName}`;
    try {
      await client.putSetting('daemon.public_url', url);
      checks.push({ id: 'tunnel.public_url', label: 'public URL', status: 'ok', fixed: true, detail: `set daemon.public_url = ${url}`, fix: 'apply it: conductor restart' });
    } catch (err) {
      checks.push({ id: 'tunnel.public_url', label: 'public URL', status: 'warn', detail: `could not set it: ${errText(ctx, err)}`, fix: `conductor config set daemon.public_url ${url}` });
    }
  } else {
    const suggestion = ts?.running && ts.dnsName ? 'conductor doctor --fix   (uses your Tailscale name)' : 'conductor config set daemon.public_url https://<your-tunnel-host>';
    checks.push({ id: 'tunnel.public_url', label: 'public URL', status: 'warn', detail: 'daemon.public_url is not set; links sent to your phone point at 127.0.0.1', fix: suggestion });
  }
}

/** Run every check. Never throws for a failing check: each becomes a row. */
export async function runDoctor(ctx: Ctx, opts: { fix: boolean }): Promise<Check[]> {
  const checks: Check[] = [];
  const { deps } = ctx;

  const major = Number(deps.nodeVersion.split('.')[0]);
  checks.push(major >= 22
    ? { id: 'node', label: 'Node.js', status: 'ok', detail: `v${deps.nodeVersion}` }
    : { id: 'node', label: 'Node.js', status: 'fail', detail: `v${deps.nodeVersion} is too old`, fix: 'install Node 22 LTS or newer (brew install node@22)' });

  const l = await deps.launchd.launchdStatus();
  checks.push(l.installed
    ? { id: 'launchd.installed', label: 'launchd agent', status: 'ok', detail: l.plistPath }
    : { id: 'launchd.installed', label: 'launchd agent', status: 'fail', detail: 'not installed, so the daemon will not start at login', fix: 'conductor install' });
  if (l.loaded && l.pid) checks.push({ id: 'launchd.loaded', label: 'launchd state', status: 'ok', detail: `loaded, pid ${l.pid}` });
  else if (l.loaded) checks.push({ id: 'launchd.loaded', label: 'launchd state', status: 'fail', detail: `loaded but not running (last exit code ${l.lastExitCode ?? 'unknown'})`, fix: 'see why: conductor logs   then: conductor restart' });
  else checks.push({ id: 'launchd.loaded', label: 'launchd state', status: 'fail', detail: 'not loaded', fix: 'conductor install' });

  let reachable = false;
  try {
    const h = await ctx.anonymous().health();
    reachable = true;
    checks.push({ id: 'daemon', label: 'daemon', status: 'ok', detail: `v${h.version} at ${ctx.baseUrl}, up ${duration(h.uptimeMs)}` });
  } catch (err) {
    checks.push({ id: 'daemon', label: 'daemon', status: 'fail', detail: isUnreachable(err) ? `not reachable at ${ctx.baseUrl}` : errText(ctx, err), fix: l.installed ? 'conductor restart   (startup errors: conductor logs)' : 'conductor install' });
  }

  let client: ConductorClient | null = null;
  let doc: DoctorResponse | null = null;
  if (!reachable) {
    checks.push({ id: 'auth', label: 'owner token', status: 'skip', detail: 'not checked (daemon unreachable)' });
  } else if (!ctx.readToken()) {
    checks.push({ id: 'auth', label: 'owner token', status: 'fail', detail: `missing: ${ctx.tokenFile}`, fix: 'conductor restart   (the daemon writes it on start); non-default home? pass --home' });
  } else {
    try {
      doc = await ctx.client().doctor();
      client = ctx.client();
      checks.push({ id: 'auth', label: 'owner token', status: 'ok', detail: ctx.tokenFile });
    } catch (err) {
      checks.push({ id: 'auth', label: 'owner token', status: 'fail', detail: errText(ctx, err), fix: 'conductor restart   (re-issues the token)' });
    }
  }

  if (!doc) checks.push({ id: 'secrets', label: 'secret store', status: 'skip', detail: 'not checked (daemon unreachable)' });
  else if (doc.secretStore.reachable) checks.push({ id: 'secrets', label: 'secret store', status: 'ok', detail: 'reachable (Keychain, or the file vault on a headless install)' });
  else checks.push({ id: 'secrets', label: 'secret store', status: 'fail', detail: clip(doc.secretStore.detail ?? 'not reachable', 140), fix: 'unlock the login keychain: security unlock-keychain ~/Library/Keychains/login.keychain-db' });

  await providerChecks(ctx, client, checks);

  const chromium = await deps.chromiumPath();
  checks.push(chromium && deps.fs.exists(chromium)
    ? { id: 'browser', label: 'Playwright Chromium', status: 'ok', detail: chromium }
    : { id: 'browser', label: 'Playwright Chromium', status: 'warn', detail: 'not installed; agents cannot use the browser', fix: `(cd ${deps.projectRoot} && npx playwright install chromium)` });

  const git = await deps.exec('git', ['--version'], { timeoutMs: 8000 });
  checks.push(git.code === 0
    ? { id: 'git', label: 'git', status: 'ok', detail: firstLine(git.stdout) }
    : { id: 'git', label: 'git', status: 'fail', detail: 'not found; skills are versioned with git', fix: 'xcode-select --install' });

  await tunnelChecks(ctx, client, doc, opts.fix, checks);

  let missing = layoutDirs(ctx).filter((d) => !deps.fs.isWritableDir(d));
  const created: string[] = [];
  if (missing.length && opts.fix) {
    for (const d of missing) {
      try {
        deps.fs.mkdirp(d);
        created.push(d);
      } catch {
        /* reported below */
      }
    }
    missing = layoutDirs(ctx).filter((d) => !deps.fs.isWritableDir(d));
  }
  checks.push(missing.length
    ? { id: 'layout', label: 'disk layout', status: 'fail', detail: `missing or not writable: ${missing.join(', ')}`, fix: opts.fix ? `fix ownership: sudo chown -R "$USER" ${ctx.home}` : 'conductor doctor --fix' }
    : { id: 'layout', label: 'disk layout', status: 'ok', detail: created.length ? `created ${created.join(', ')}` : `${ctx.home} is writable`, ...(created.length ? { fixed: true } : {}) });

  return checks;
}

export function doctorCommand(program: Command, deps: CliDeps): void {
  program
    .command('doctor')
    .description('check launchd, the daemon, Keychain, provider logins, the browser and the tunnel')
    .option('--fix', 'apply safe fixes (create directories, set the public URL from Tailscale)')
    .action(action(deps, async (ctx, _args, opts) => {
      const checks = await runDoctor(ctx, { fix: flag(opts, 'fix') });
      const failed = checks.filter((c) => c.status === 'fail').length;
      const warned = checks.filter((c) => c.status === 'warn').length;
      ctx.emit({ ok: failed === 0, failed, warnings: warned, checks }, () => {
        const s = ctx.style;
        const mark: Record<CheckStatus, string> = { ok: s.green('✓'), fail: s.red('✗'), warn: s.yellow('!'), skip: s.dim('-') };
        const width = Math.max(...checks.map((c) => c.label.length));
        for (const c of checks) {
          ctx.line(`${mark[c.status]} ${c.label.padEnd(width)}  ${c.detail}${c.fixed ? s.green('  (fixed)') : ''}`);
          if (c.fix && (c.status !== 'ok' || c.fixed)) ctx.line(`  ${' '.repeat(width)}  ${s.dim('→')} ${c.fix}`);
        }
        ctx.line();
        ctx.line(failed ? s.red(`${failed} problem${failed === 1 ? '' : 's'}`) + (warned ? `, ${warned} warning${warned === 1 ? '' : 's'}` : '') : warned ? `ready, with ${warned} warning${warned === 1 ? '' : 's'}` : s.green('everything looks good'));
      });
      if (failed) throw new SilentExit(1);
    }));
}
