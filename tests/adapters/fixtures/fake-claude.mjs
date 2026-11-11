/* global process, console */
// Stand-in for `claude -p --output-format stream-json --verbose`: emits the same line shapes as Claude Code 2.1.x.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { callTool, readStdin, sleep } from './mcp-call.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('2.1.999 (Claude Code)');
  process.exit(0);
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
for (const required of ['-p', '--verbose', '--mcp-config', '--max-turns']) {
  if (!argv.includes(required)) {
    console.error(`fake claude: missing ${required}`);
    process.exit(2);
  }
}
if (flag('--output-format') !== 'stream-json') {
  console.error('fake claude: expected --output-format stream-json');
  process.exit(2);
}

const mode = process.env.FAKE_MODE ?? 'normal';
const prompt = await readStdin();
const mcpPath = flag('--mcp-config');
const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
const skillsDir = '.claude/skills';
if (process.env.FAKE_RECORD) {
  writeFileSync(
    process.env.FAKE_RECORD,
    JSON.stringify({
      argv,
      prompt,
      cwd: process.cwd(),
      envKeys: Object.keys(process.env),
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
      mcpConfigPath: mcpPath,
      mcpConfigMode: statSync(mcpPath).mode & 0o777,
      mcp,
      skills: existsSync(skillsDir) ? readdirSync(skillsDir).filter((n) => existsSync(`${skillsDir}/${n}/SKILL.md`)) : [],
      pid: process.pid,
    }),
  );
}

const session = flag('--resume') ?? 'sess-claude-fake-1';
const model = flag('--model') ?? 'claude-opus-5-5';
const zero = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
out({ type: 'system', subtype: 'init', session_id: session, model, cwd: process.cwd(), tools: ['Read'], mcp_servers: Object.keys(mcp.mcpServers).map((name) => ({ name, status: 'connected' })) });
const assistant = (id, content, usage) =>
  out({ type: 'assistant', session_id: session, message: { id, type: 'message', role: 'assistant', model, content, usage: usage ?? { ...zero, input_tokens: 600, output_tokens: 40 } } });

if (mode === 'rate_limit') {
  out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}', session_id: session, num_turns: 1, total_cost_usd: 0, usage: zero });
  process.exit(1);
}
if (mode === 'max_turns') {
  assistant('msg_1', [{ type: 'text', text: 'Working on it' }]);
  out({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: session, num_turns: Number(flag('--max-turns')), total_cost_usd: 0.01, usage: { ...zero, input_tokens: 600, output_tokens: 40 } });
  process.exit(1);
}
if (mode === 'hang') {
  assistant('msg_1', [{ type: 'text', text: 'Thinking for a long time' }]);
  // A grandchild in the same process group: cancel/timeout must take it down too.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, JSON.stringify({ pid: process.pid, child: child.pid }));
  process.on('SIGTERM', () => {}); // ignore the polite signal: the adapter must escalate
  await sleep(600_000);
}
if (mode === 'spend') {
  for (let i = 0; i < 200; i++) {
    assistant(`msg_${i}`, [{ type: 'text', text: `step ${i}` }], { ...zero, input_tokens: 1_000_000, output_tokens: 1000 });
    await sleep(40);
  }
  process.exit(0);
}

const [serverName, server] = Object.entries(mcp.mcpServers)[0];
// Two content blocks of one message share an id and repeat the usage, as the real CLI does.
assistant('msg_1', [{ type: 'text', text: 'Looking up the code.' }]);
assistant('msg_1', [{ type: 'tool_use', id: 'toolu_1', name: `mcp__${serverName}__lookup_code`, input: { key: 'alpha' } }]);
let text;
let isError = false;
try {
  text = await callTool(server.url, server.headers, 'lookup_code', { key: 'alpha' });
} catch (e) {
  text = `MCP error: ${e.message}`;
  isError = true;
}
out({ type: 'user', session_id: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text }], is_error: isError }] } });
assistant('msg_2', [{ type: 'text', text: `The code is ${text}` }]);
out({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1234,
  num_turns: 2,
  result: `The code is ${text}`,
  session_id: session,
  total_cost_usd: 0.0421,
  usage: { input_tokens: 1200, cache_creation_input_tokens: 100, cache_read_input_tokens: 300, output_tokens: 80 },
});
