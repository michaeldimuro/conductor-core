import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { SANDBOX_EXEC, type SandboxSpec } from './sandbox.js';

const PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SHELL', 'TERM', 'TZ'];

/** Usual install locations for agent CLIs; launchd gives the daemon a very short PATH. */
function extraPathDirs(): string[] {
  const home = process.env.HOME ?? homedir();
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

/**
 * The environment handed to child agents: a short allowlist from the daemon's
 * env plus what the caller adds. Nothing else the daemon holds (API keys,
 * tokens, CONDUCTOR_* internals) is inherited.
 */
export function minimalEnv(extra: Record<string, string | undefined> = {}, passthrough: string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...PASSTHROUGH, ...passthrough]) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  const dirs = (env.PATH ?? '/usr/bin:/bin').split(delimiter).filter(Boolean);
  for (const d of extraPathDirs()) if (!dirs.includes(d)) dirs.push(d);
  env.PATH = dirs.join(delimiter);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** Absolute path of `command` if it is an executable file (searching `pathEnv` for bare names). */
export function findExecutable(command: string, pathEnv: string = minimalEnv().PATH ?? ''): string | null {
  const candidates = command.includes('/') || isAbsolute(command) ? [command] : pathEnv.split(delimiter).filter(Boolean).map((d) => join(d, command));
  for (const c of candidates) {
    try {
      if (!statSync(c).isFile()) continue;
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      // keep looking
    }
  }
  return null;
}

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Negative pid = the whole process group (the child is its own group leader).
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Detached children would outlive a dying worker; take their groups down with it.
  process.on('exit', () => {
    for (const child of live) killGroup(child, 'SIGKILL');
  });
}

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  /** The complete child environment (use `minimalEnv`). */
  env: Record<string, string>;
  /** Written to stdin, which is then closed. */
  stdin?: string;
  /** Aborting kills the child's whole process group (SIGTERM, then SIGKILL after `killGraceMs`). */
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  killGraceMs?: number;
  /** Bytes of stderr kept for error reporting. */
  stderrLimit?: number;
  /** Start the command under this macOS sandbox profile (see `agentSandbox`). Omit to run unsandboxed. */
  sandbox?: SandboxSpec;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Tail of stderr. */
  stderr: string;
  /** Set when the command could not be started at all (e.g. ENOENT). */
  spawnError?: NodeJS.ErrnoException;
}

/**
 * Run a command in its own process group, streaming stdout line by line.
 * Never rejects: start failures come back as `spawnError`.
 */
export function runProcess(opts: ProcessOptions): Promise<ProcessExit> {
  installExitHook();
  const limit = opts.stderrLimit ?? 8192;
  return new Promise<ProcessExit>((resolve) => {
    let child: ChildProcess;
    let command = opts.command;
    let args = opts.args;
    if (opts.sandbox) {
      // sandbox-exec would hide a missing command behind its own exit code; keep the ENOENT contract.
      const target = opts.command.includes('/') && !isAbsolute(opts.command) ? resolvePath(opts.cwd, opts.command) : opts.command;
      const resolved = findExecutable(target, opts.env.PATH ?? '');
      if (!resolved) {
        const err: NodeJS.ErrnoException = Object.assign(new Error(`spawn ${opts.command} ENOENT`), { code: 'ENOENT' });
        resolve({ code: null, signal: null, stderr: '', spawnError: err });
        return;
      }
      command = opts.sandbox.exec ?? SANDBOX_EXEC;
      args = ['-p', opts.sandbox.profile, resolved, ...opts.args];
    }
    try {
      child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, signal: null, stderr: '', spawnError: e as NodeJS.ErrnoException });
      return;
    }
    live.add(child);

    let stderr = '';
    let buffer = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let spawnError: NodeJS.ErrnoException | undefined;

    const onAbort = (): void => {
      killGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), opts.killGraceMs ?? 2000);
    };
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      live.delete(child);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (buffer.length > 0) {
        const rest = buffer;
        buffer = '';
        opts.onStdoutLine?.(rest);
      }
      resolve({ code, signal, stderr, ...(spawnError ? { spawnError } : {}) });
    };

    child.on('error', (e: NodeJS.ErrnoException) => {
      spawnError = e;
      if (child.pid === undefined) settle(null, null);
    });
    child.on('close', (code, signal) => settle(code, signal));

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) opts.onStdoutLine?.(line);
        nl = buffer.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-limit);
    });
    child.stdin?.on('error', () => {
      // The child may exit without reading stdin (EPIPE); that is its call.
    });
    child.stdin?.end(opts.stdin ?? '');

    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Line-delimited JSON process helper: runs the command and hands every stdout
 * line that parses as a JSON object to `onJson`; other lines go to `onText`.
 */
export function runJsonLines(
  opts: Omit<ProcessOptions, 'onStdoutLine'> & { onJson: (value: Record<string, unknown>) => void; onText?: (line: string) => void },
): Promise<ProcessExit> {
  const { onJson, onText, ...rest } = opts;
  return runProcess({
    ...rest,
    onStdoutLine: (line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            onJson(parsed as Record<string, unknown>);
            return;
          }
        } catch {
          // fall through: not JSON after all
        }
      }
      onText?.(line);
    },
  });
}

/** Run `<command> --version`-style probes with a hard timeout. */
export async function probeCommand(command: string, args: string[], timeoutMs = 10_000): Promise<{ ok: boolean; output: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let out = '';
  try {
    const exit = await runProcess({
      command,
      args,
      cwd: homedir(),
      env: minimalEnv(),
      signal: controller.signal,
      killGraceMs: 500,
      onStdoutLine: (l) => {
        out += `${l}\n`;
      },
    });
    if (exit.spawnError) return { ok: false, output: '', error: exit.spawnError.code === 'ENOENT' ? `${command} not found on PATH` : exit.spawnError.message };
    if (controller.signal.aborted) return { ok: false, output: out.trim(), error: `${command} did not answer within ${timeoutMs}ms` };
    if (exit.code !== 0) return { ok: false, output: out.trim(), error: (exit.stderr || out).trim().slice(0, 300) || `exit code ${exit.code}` };
    return { ok: true, output: out.trim() };
  } finally {
    clearTimeout(timer);
  }
}
