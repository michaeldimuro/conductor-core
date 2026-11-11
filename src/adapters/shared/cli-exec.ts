import { homedir } from 'node:os';
import { minimalEnv, runProcess } from './proc.js';

/** Result of a short, non-interactive CLI call (status checks, catalogs). */
export interface CliExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the command could not be started (e.g. not installed). */
  spawnError?: NodeJS.ErrnoException;
}

export interface CliExecOptions {
  /** Written to stdin, then closed (credentials go here, never into argv). */
  stdin?: string;
  timeoutMs?: number;
  /** Extra environment on top of the minimal one. */
  env?: Record<string, string>;
  /** Bytes of stdout kept (default 2 MiB: the Codex catalog is several hundred KB). */
  maxStdoutBytes?: number;
}

export type CliExec = (command: string, args: string[], opts?: CliExecOptions) => Promise<CliExecResult>;

/**
 * Where each CLI keeps its login and state. Passed through so the daemon sees the same
 * login the user set up in their terminal (or an isolated one when these are set).
 */
export const CLI_STATE_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME'];

/** Default `CliExec`: own process group, minimal environment, hard timeout. Never rejects. */
export const execCli: CliExec = async (command, args, opts = {}) => {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const max = opts.maxStdoutBytes ?? 2 * 1024 * 1024;
  let stdout = '';
  try {
    const exit = await runProcess({
      command, args, cwd: homedir(),
      env: minimalEnv(opts.env ?? {}, CLI_STATE_ENV),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      signal: controller.signal,
      killGraceMs: 500,
      onStdoutLine: (l) => {
        if (stdout.length < max) stdout += `${l}\n`;
      },
    });
    return {
      code: exit.code, stdout, stderr: exit.stderr, timedOut: controller.signal.aborted,
      ...(exit.spawnError ? { spawnError: exit.spawnError } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
};

/** Strip terminal colour/cursor sequences from CLI output. */
// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
export const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
