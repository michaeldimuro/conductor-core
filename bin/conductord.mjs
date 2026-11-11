#!/usr/bin/env node
// Launches the built daemon, or the TypeScript source via tsx in a dev checkout.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const built = `${root}dist/daemon/main.js`;
if (existsSync(built)) {
  await import(built);
} else {
  const child = spawn(process.execPath, ['--import', 'tsx', `${root}src/daemon/main.ts`, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => child.kill(s));
}
