/* global process, console */
// Stand-in for `codex exec --json`: emits the JSONL thread/turn/item events of codex-cli 0.16x.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { callTool, readStdin, sleep } from './mcp-call.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('codex-cli 0.999.0');
  process.exit(0);
}
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (argv[0] !== 'exec' || !argv.includes('--json') || argv.at(-1) !== '-') {
  console.error('fake codex: expected `exec --json ... -`');
  process.exit(2);
}
const overrides = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-c') {
    const [key, ...rest] = argv[i + 1].split('=');
    overrides[key] = rest.join('=');
  }
}
const resumed = argv[1] === 'resume' ? argv.at(-2) : null;
const prompt = await readStdin();
const mode = process.env.FAKE_MODE ?? 'normal';
if (process.env.FAKE_RECORD) {
  writeFileSync(
    process.env.FAKE_RECORD,
    JSON.stringify({
      argv,
      overrides,
      prompt,
      resumed,
      cwd: process.cwd(),
      envKeys: Object.keys(process.env),
      codexApiKey: process.env.CODEX_API_KEY ?? null,
      agentsMd: existsSync('AGENTS.md') ? readFileSync('AGENTS.md', 'utf8') : null,
    }),
  );
}

const thread = resumed ?? '019a0000-fake-7000-8000-codexthread01';
out({ type: 'thread.started', thread_id: thread });
out({ type: 'turn.started' });

if (mode === 'auth') {
  out({ type: 'error', message: 'unexpected status 401 Unauthorized: Incorrect API key provided' });
  out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Incorrect API key provided' } });
  process.exit(1);
}
if (mode === 'hang') {
  out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Considering the task' } });
  await sleep(600_000);
}
if (mode === 'many_tools') {
  for (let i = 0; i < 50; i++) {
    out({ type: 'item.started', item: { id: `item_${i}`, type: 'command_execution', command: `bash -lc 'echo ${i}'`, aggregated_output: '', exit_code: null, status: 'in_progress' } });
    out({ type: 'item.completed', item: { id: `item_${i}`, type: 'command_execution', command: `bash -lc 'echo ${i}'`, aggregated_output: `${i}\n`, exit_code: 0, status: 'completed' } });
    await sleep(20);
  }
  await sleep(600_000);
}

const serverKey = Object.keys(overrides).find((k) => /^mcp_servers\.[^.]+\.url$/.test(k));
const server = serverKey.split('.')[1];
const url = JSON.parse(overrides[serverKey]);
const bearerVar = JSON.parse(overrides[`mcp_servers.${server}.bearer_token_env_var`]);
const item = { id: 'item_0', type: 'mcp_tool_call', server, tool: 'lookup_code', arguments: { key: 'alpha' } };
out({ type: 'item.started', item: { ...item, result: null, error: null, status: 'in_progress' } });
let text;
try {
  text = await callTool(url, { Authorization: `Bearer ${process.env[bearerVar]}` }, 'lookup_code', { key: 'alpha' });
  out({ type: 'item.completed', item: { ...item, result: { content: [{ type: 'text', text }], structured_content: null }, error: null, status: 'completed' } });
} catch (e) {
  text = `MCP error: ${e.message}`;
  out({ type: 'item.completed', item: { ...item, result: null, error: { message: text }, status: 'failed' } });
}
out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `The code is ${text}` } });
out({ type: 'turn.completed', usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 150, reasoning_output_tokens: 20 } });
