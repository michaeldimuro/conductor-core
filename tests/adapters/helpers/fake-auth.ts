import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execCli, type CliExec } from '../../../src/adapters/shared/cli-exec.js';

const FAKE = fileURLToPath(new URL('../fixtures/fake-auth-cli.mjs', import.meta.url));

/**
 * An executable named like the real CLI that plays `claude` or `codex` (tests/adapters/fixtures/fake-auth-cli.mjs).
 * Its state file and mode are baked into the wrapper because the daemon starts CLIs with a minimal environment.
 */
export function fakeCli(dir: string, cli: 'claude' | 'codex', extra: Record<string, string> = {}): string {
  const file = join(dir, cli);
  const env = Object.entries({ FAKE_CLI: cli, FAKE_CLI_STATE: join(dir, 'state.json'), ...extra }).map(([k, v]) => `${k}='${v}'`).join(' ');
  writeFileSync(file, `#!/bin/sh\n${env} exec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A `CliExec` that runs the fakes wherever the real `claude` / `codex` would be called (status checks, model catalogs). */
export function fakeCliExec(commands: { claude: string; codex: string }): CliExec {
  return (command, args, opts) => execCli(command === 'claude' ? commands.claude : command === 'codex' ? commands.codex : command, args, opts);
}
