#!/usr/bin/env node
/**
 * conductor — the command-line client of the Conductor daemon.
 *
 * Every command goes through the REST API with the owner token from
 * `<home>/owner.token`; the CLI never opens the database itself.
 */
import { defaultDeps } from './deps.js';
import { runCli } from './program.js';

// Piping into `head` closes stdout early; that is not an error worth a stack trace.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

runCli(process.argv.slice(2), defaultDeps()).then(
  (code) => {
    process.exitCode = code;
    // Follow loops and prompts may leave handles open (stdin, timers); the command is done.
    if (process.stdin.isTTY) process.stdin.pause();
  },
  (err) => {
    process.stderr.write(`conductor: unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
