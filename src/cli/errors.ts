import { ConductorApiError } from '../api/client.js';

/** Exit codes of the `conductor` CLI. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

/** A failure the user can act on. `hints` are printed as next steps. */
export class CliError extends Error {
  constructor(message: string, readonly exitCode: number = EXIT.failure, readonly hints: string[] = [], readonly code = 'cli_error') {
    super(message);
    this.name = 'CliError';
  }
}

/** Bad arguments: exit code 2. */
export class UsageError extends CliError {
  constructor(message: string, hints: string[] = []) {
    super(message, EXIT.usage, hints, 'usage');
    this.name = 'UsageError';
  }
}

/** The command already reported its result; only the exit code is left to set. */
export class SilentExit extends CliError {
  constructor(exitCode: number) {
    super('', exitCode, [], 'exit');
    this.name = 'SilentExit';
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

/** True for transport failures (daemon down, wrong port), false for API error responses. */
export function isUnreachable(err: unknown): boolean {
  if (err instanceof ConductorApiError || err instanceof CliError) return false;
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  const code = (err as { code?: unknown }).code ?? cause?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  return err instanceof TypeError && /fetch failed|network|socket/i.test(err.message);
}

export function unreachableError(baseUrl: string): CliError {
  return new CliError(`Cannot reach the Conductor daemon at ${baseUrl}.`, EXIT.failure, [
    'start it (and keep it running across reboots): conductor install',
    'already installed? restart it: conductor restart',
    'see what is wrong: conductor doctor   ·   conductor logs',
    'daemon on another port? pass --url http://127.0.0.1:<port>',
  ], 'daemon_unreachable');
}

/** Normalize anything thrown by a command into a CliError with actionable text. */
export function toCliError(err: unknown, baseUrl: string): CliError {
  if (err instanceof CliError) return err;
  if (isUnreachable(err)) return unreachableError(baseUrl);
  if (err instanceof ConductorApiError) {
    if (err.status === 401) {
      return new CliError(`The daemon rejected the owner token (${err.message}).`, EXIT.failure, [
        'the token file may belong to another install: check --home / CONDUCTOR_HOME',
        'restart the daemon to re-issue it: conductor restart',
      ], err.code);
    }
    const exit = err.code === 'validation' || err.status === 400 ? EXIT.usage : EXIT.failure;
    return new CliError(err.message, exit, [], err.code);
  }
  return new CliError(err instanceof Error ? err.message : String(err));
}
