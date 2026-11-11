import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConductorError } from '../../shared/errors.js';
import { startEgressProxy } from './egress-proxy.js';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Shell commands only ever run under the macOS sandbox; anywhere else they are refused. */
export function sandboxAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
}

const quote = (p: string): string => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Seatbelt profile for one command: deny by default; read system paths;
 * read/write only the workspace and a private temp dir; no network at all
 * unless `proxyPort` is given — then exactly one destination, the loopback
 * egress proxy that enforces the org's network allowlist host by host.
 */
export function buildSandboxProfile(opts: { workspace: string; tmp: string; proxyPort?: number | null }): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow file-read-metadata)',
    '(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library")',
    '  (subpath "/opt") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/private/var/select") (subpath "/dev")',
    '  (subpath "/Applications/Xcode.app") (subpath "/nix"))',
    `(allow file-read* file-write* (subpath ${quote(opts.workspace)}) (subpath ${quote(opts.tmp)}))`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.logger")',
    '  (global-name "com.apple.system.notification_center") (global-name "com.apple.CoreServices.coreservicesd")',
    '  (global-name "com.apple.SecurityServer") (global-name "com.apple.trustd.agent"))',
    '(allow ipc-posix-shm-read*)',
  ];
  if (opts.proxyPort) {
    lines.push(
      `(allow network-outbound (remote ip "localhost:${Math.trunc(opts.proxyPort)}"))`,
      '(allow system-socket)',
      '(allow mach-lookup (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.networkd") (global-name "com.apple.trustd"))',
      '(allow file-read* (subpath "/private/var/run"))',
    );
  }
  return lines.join('\n');
}

export interface SandboxRun {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** Hosts the command tried to reach that are not on the org's network allowlist. */
  blockedHosts: string[];
}

/**
 * Run `command` with `/bin/sh -c` inside the sandbox. The command string is one
 * argv element (no interpolation by us); the shell it reaches is already
 * confined. Minimal env, own process group, hard timeout, capped output.
 */
export async function runSandboxed(opts: {
  command: string;
  /** Real (symlink-resolved) workspace path. */
  workspace: string;
  /** Real directory inside the workspace to start in. */
  cwd: string;
  /** Hosts the command may reach (org policy `networkAllowlist`). Empty = no network at all. */
  networkAllowlist: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<SandboxRun> {
  if (!sandboxAvailable()) {
    throw new ConductorError('unavailable', 'run_command is refused: the macOS sandbox (sandbox-exec) is not available, and commands never run unsandboxed');
  }
  const tmp = await mkdtemp(join(realpathSync(tmpdir()), 'conductor-sbx-'));
  const proxy = opts.networkAllowlist.length > 0 ? await startEgressProxy(opts.networkAllowlist) : null;
  // Standard proxy variables (both cases: curl only honours lowercase http_proxy). Tools that ignore them get no network.
  const proxyUrl = proxy ? `http://127.0.0.1:${proxy.port}` : null;
  const proxyEnv: Record<string, string> = proxyUrl
    ? { http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, no_proxy: '', NO_PROXY: '' }
    : {};
  try {
    const profile = buildSandboxProfile({ workspace: opts.workspace, tmp, proxyPort: proxy?.port });
    return await new Promise<SandboxRun>((resolve, reject) => {
      const child = spawn(SANDBOX_EXEC, ['-p', profile, '/bin/sh', '-c', opts.command], {
        cwd: opts.cwd,
        // Nothing from the daemon's environment (tokens, CONDUCTOR_*) reaches the command.
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
          HOME: opts.workspace,
          TMPDIR: tmp,
          LANG: 'en_US.UTF-8',
          SHELL: '/bin/sh',
          ...proxyEnv,
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let timedOut = false;
      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const collect = (sink: Buffer[]) => (chunk: Buffer) => {
        const room = opts.maxOutputBytes - size;
        if (room <= 0) {
          truncated = true;
          return;
        }
        if (chunk.length > room) truncated = true;
        sink.push(chunk.subarray(0, room));
        size += Math.min(chunk.length, room);
      };
      child.stdout.on('data', collect(out));
      child.stderr.on('data', collect(err));
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, opts.timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new ConductorError('unavailable', `could not start sandbox: ${e.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        killGroup(); // reap anything the command left in its process group
        resolve({
          exitCode: code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, truncated,
          blockedHosts: [...(proxy?.denied ?? [])],
        });
      });
    });
  } finally {
    await proxy?.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
