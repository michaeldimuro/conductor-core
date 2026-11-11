/* global process, console, setTimeout */
// Stand-in for the two local agent CLIs as the utility backend drives them:
//   claude -p --output-format json …      (FAKE_KIND=claude)   and   claude auth status --json
//   codex exec --json … -                 (FAKE_KIND=codex)    and   codex login status
// Behaviour is selected by FAKE_MODE; every invocation is appended to FAKE_RECORD as one JSON line.
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const kind = process.env.FAKE_KIND ?? 'claude';
const mode = process.env.FAKE_MODE ?? 'normal';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const record = (entry) => {
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ kind, pid: process.pid, ...entry })}\n`);
};
const readStdin = () =>
  new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });

// ── login probes (read-only) ──
if (kind === 'claude' && argv[0] === 'auth' && argv[1] === 'status') {
  record({ probe: true, argv });
  console.log(JSON.stringify({ loggedIn: mode !== 'logged_out', authMethod: 'claude.ai', subscriptionType: 'max' }));
  process.exit(mode === 'logged_out' ? 1 : 0);
}
if (kind === 'codex' && argv[0] === 'login' && argv[1] === 'status') {
  record({ probe: true, argv });
  console.error(mode === 'logged_out' ? 'Not logged in' : 'Logged in using ChatGPT');
  process.exit(mode === 'logged_out' ? 1 : 0);
}

// ── argument contract ──
const fail = (msg) => {
  console.error(`fake ${kind}: ${msg}`);
  process.exit(2);
};
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (kind === 'claude') {
  for (const required of ['-p', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence', '--system-prompt']) {
    if (!argv.includes(required)) fail(`missing ${required}`);
  }
  if (flag('--output-format') !== 'json') fail('expected --output-format json');
  if (flag('--tools') !== '') fail('expected --tools "" (no tools)');
  if (argv.includes('--mcp-config')) fail('no MCP config may be passed');
} else {
  if (argv[0] !== 'exec' || !argv.includes('--json') || argv.at(-1) !== '-') fail('expected `exec --json … -`');
  for (const required of ['--ephemeral', '--ignore-user-config', '--skip-git-repo-check']) if (!argv.includes(required)) fail(`missing ${required}`);
  if (flag('-s') !== 'read-only') fail('expected -s read-only');
}

const startedAt = Date.now();
const prompt = await readStdin();
let homeReadable = null;
if (process.env.FAKE_PROBE_READ) {
  try {
    readFileSync(process.env.FAKE_PROBE_READ);
    homeReadable = true;
  } catch {
    homeReadable = false;
  }
}
const base = {
  argv,
  prompt,
  cwd: process.cwd(),
  cwdEntries: readdirSync(process.cwd()),
  envKeys: Object.keys(process.env),
  apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY ?? null,
  homeReadable,
  startedAt,
};

if (mode === 'hang') {
  record(base);
  process.on('SIGTERM', () => {});
  await sleep(600_000);
}
if (mode === 'flood') {
  record(base);
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 4096; i++) process.stdout.write(chunk);
  await sleep(600_000);
}
if (mode === 'slow') await sleep(150);
record({ ...base, endedAt: Date.now() });

const answer = process.env.FAKE_ANSWER ?? '{"summary":"The export finished.","facts":[],"lessons":[],"preferences":[],"taskType":"stripe-balance-export"}';
if (kind === 'claude') {
  if (mode === 'error') {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error: 429 rate limited', usage: {} }));
    process.exit(1);
  }
  if (mode === 'auth_error') {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', usage: {} }));
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: answer, session_id: 'sess-utility-1', total_cost_usd: 0.0031,
      usage: { input_tokens: 900, cache_creation_input_tokens: 50, cache_read_input_tokens: 50, output_tokens: 120 },
      modelUsage: { 'claude-haiku-fake': { inputTokens: 900, outputTokens: 120 } },
    }),
  );
} else {
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  out({ type: 'thread.started', thread_id: '019a0000-fake-utility' });
  out({ type: 'turn.started' });
  if (mode === 'error') {
    out({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
    process.exit(1);
  }
  out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: answer } });
  out({ type: 'turn.completed', usage: { input_tokens: 700, cached_input_tokens: 100, output_tokens: 90 } });
}
