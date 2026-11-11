#!/usr/bin/env node
/* global process */
// A stand-in for /usr/bin/security: records every invocation (argv + stdin)
// and keeps generic passwords in a JSON file. FAKE_SECURITY_DIR is the state dir.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_SECURITY_DIR;
const storeFile = join(dir, 'store.json');
const store = existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')) : {};
const save = () => writeFileSync(storeFile, JSON.stringify(store));
const argv = process.argv.slice(2);

/** Tokenize like `security -i`: whitespace separated, double quotes group. */
function tokens(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2]);
  return out;
}
const opt = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

function run(args) {
  const key = `${opt(args, '-s')}\u0000${opt(args, '-a')}`;
  switch (args[0]) {
    case 'add-generic-password':
      store[key] = opt(args, '-w');
      save();
      return 0;
    case 'find-generic-password':
      if (!(key in store)) return 44;
      process.stdout.write(`${store[key]}\n`);
      return 0;
    case 'delete-generic-password':
      if (!(key in store)) return 44;
      delete store[key];
      save();
      return 0;
    default:
      return 1;
  }
}

let stdin = '';
if (argv[0] === '-i') {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdin += chunk;
}
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ argv, stdin })}\n`);

if (argv[0] === '-i') {
  let code = 0;
  for (const line of stdin.split('\n')) {
    if (!line.trim()) continue;
    // The real tool reads 4096-byte lines; refuse longer ones so a regression is loud.
    if (line.length + 1 > 4096) process.exit(1);
    code = run(tokens(line));
  }
  process.exit(code);
}
process.exit(run(argv));
