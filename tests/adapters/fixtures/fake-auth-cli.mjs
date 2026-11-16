#!/usr/bin/env node
/* global process, setTimeout */
// Fake `claude` / `codex` for provider-auth tests. Which CLI it plays comes from FAKE_CLI
// (claude | codex); login state lives in the JSON file at FAKE_CLI_STATE.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const cli = process.env.FAKE_CLI ?? 'claude';
const stateFile = process.env.FAKE_CLI_STATE;
const read = () => (stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {});
const write = (s) => stateFile && writeFileSync(stateFile, JSON.stringify(s));
const args = process.argv.slice(2);
const has = (...xs) => xs.every((x) => args.includes(x));
const out = (s) => process.stdout.write(s);

if (has('--version')) {
  out(cli === 'claude' ? '9.9.9 (Claude Code)\n' : 'codex-cli 9.9.9\n');
  process.exit(0);
}

if (cli === 'claude') {
  if (has('--help')) {
    out(`Usage: claude [options]\n  --effort <level>   Effort level for the current session\n                     (low, medium, high)\n  --model <model>    Model for the current session. Provide\n                     an alias for the latest model (e.g.\n                     'alpha', or 'beta') or a\n                     model's full name.\n  -n, --name <name>  Set a display name\n`);
    process.exit(0);
  }
  if (has('auth', 'status')) {
    const s = read();
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      const ok = process.env.CLAUDE_CODE_OAUTH_TOKEN.startsWith('sk-ant-oat');
      out(JSON.stringify({ loggedIn: ok, authMethod: ok ? 'oauth_token' : 'none', email: 'person@example.com' }));
      process.exit(0);
    }
    out(JSON.stringify(s.claude
      ? { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'person@example.com', orgName: 'Secret Org', loginExpiresAt: '2030-01-01T00:00:00Z' }
      : { loggedIn: false, authMethod: 'none' }));
    process.exit(0);
  }
  if (has('auth', 'logout')) {
    write({ ...read(), claude: false });
    out('Successfully logged out\n');
    process.exit(0);
  }
  if (has('auth', 'login')) {
    out('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.example/oauth/authorize?code=true&state=abc123\nPaste code here if prompted > ');
    process.stdin.setEncoding('utf8');
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      const code = buf.trim();
      if (code === 'good-code') {
        write({ ...read(), claude: true });
        out('\nLogin successful for person@example.com\n');
        process.exit(0);
      }
      // Like Claude Code 2.1: complain on stderr and keep waiting for another paste.
      process.stderr.write('Invalid code. Please make sure the full code was copied.\n');
      buf = '';
    });
    setTimeout(() => process.exit(3), 60_000);
  }
} else {
  if (has('debug', 'models')) {
    out(JSON.stringify({ models: [
      { slug: 'gpt-fake-2', display_name: 'GPT Fake 2', priority: 2, visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], base_instructions: 'x'.repeat(5000) },
      { slug: 'gpt-fake-1', display_name: 'GPT Fake 1', priority: 1, visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'gpt-internal', display_name: 'Internal', priority: 3, visibility: 'hide' },
    ] }));
    process.exit(0);
  }
  if (has('login', 'status')) {
    const s = read();
    out(s.codex === 'chatgpt' ? 'Logged in using ChatGPT\n' : s.codex === 'api_key' ? 'Logged in using an API key - sk-abc***xyz\n' : 'Not logged in\n');
    process.exit(0);
  }
  if (has('logout')) {
    write({ ...read(), codex: null });
    out('Successfully logged out\n');
    process.exit(0);
  }
  if (has('login', '--with-api-key')) {
    let key = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (key += d));
    process.stdin.on('end', () => {
      if (!key.trim().startsWith('sk-')) {
        process.stderr.write('Error: invalid API key\n');
        process.exit(1);
      }
      write({ ...read(), codex: 'api_key', codexKeyArgv: process.argv.join(' ').includes(key.trim()) });
      out('Successfully logged in\n');
      process.exit(0);
    });
  } else if (has('login', '--device-auth')) {
    const link = '\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.example/codex/device\u001b[0m\n\n';
    const code = '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mABCD-12345\u001b[0m\n';
    // FAKE_DEVICE_SPLIT_MS: the link and the code arrive as separate writes, as on a loaded machine.
    const split = Number(process.env.FAKE_DEVICE_SPLIT_MS ?? 0);
    if (split) {
      out(link);
      await new Promise((r) => setTimeout(r, split));
      out(code);
    } else out(link + code);
    const ms = Number(process.env.FAKE_DEVICE_MS ?? 300);
    setTimeout(() => {
      if (process.env.FAKE_DEVICE_FAIL) {
        process.stderr.write('Error: device code expired\n');
        process.exit(1);
      }
      write({ ...read(), codex: 'chatgpt' });
      out('Successfully logged in\n');
      process.exit(0);
    }, ms);
  }
}
