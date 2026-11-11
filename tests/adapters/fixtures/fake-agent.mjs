/* global process, console */
// A generic CLI agent for the `process` adapter: prompt on stdin, CONDUCTOR_* env, RunEvents (or plain text) on stdout.
import { writeFileSync } from 'node:fs';
import { callTool, readStdin, sleep } from './mcp-call.mjs';

const prompt = await readStdin();
const mode = process.env.FAKE_MODE ?? 'jsonl';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (process.env.FAKE_RECORD) {
  writeFileSync(
    process.env.FAKE_RECORD,
    JSON.stringify({
      argv: process.argv.slice(2),
      prompt,
      envKeys: Object.keys(process.env),
      conductor: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CONDUCTOR_'))),
    }),
  );
}
if (mode === 'fail') {
  console.error('boom: the agent crashed');
  process.exit(3);
}
if (mode === 'hang') {
  out({ type: 'status', status: 'started' });
  await sleep(600_000);
}
if (mode === 'leak') {
  out({ type: 'text', text: `my token is ${process.env.CONDUCTOR_RUN_TOKEN}` });
  process.exit(0);
}
if (mode === 'many_tools') {
  for (let i = 0; i < 50; i++) {
    out({ type: 'tool_call', id: `t${i}`, name: 'noop', input: {} });
    await sleep(20);
  }
  await sleep(600_000);
}
if (mode === 'spend') {
  for (let i = 0; i < 50; i++) {
    out({ type: 'usage', tokensIn: 1000, tokensOut: 10, costUsd: 1 });
    await sleep(20);
  }
  await sleep(600_000);
}

const code = await callTool(process.env.CONDUCTOR_MCP_URL, { Authorization: `Bearer ${process.env.CONDUCTOR_RUN_TOKEN}` }, 'lookup_code', { key: 'alpha' });
if (mode === 'text') {
  console.log(`The code is ${code}`);
} else {
  out({ type: 'tool_call', id: 't1', name: 'lookup_code', input: { key: 'alpha' } });
  out({ type: 'tool_result', id: 't1', name: 'lookup_code', output: code, isError: false });
  out({ type: 'usage', tokensIn: 321, tokensOut: 45, costUsd: 0.0007 });
  console.log('this line is not a RunEvent');
  out({ type: 'text', text: `The code is ${code}` });
}
