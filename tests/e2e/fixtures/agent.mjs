/* global process, URL, fetch */
// A minimal real agent for the end-to-end gate: it runs as a child of the run
// worker (process adapter), reaches every tool through the Conductor gateway
// (MCP over Streamable HTTP + the agent-facing HTTP API) using only its
// run-scoped token, then reports its result.
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { CONDUCTOR_API_URL: api, CONDUCTOR_RUN_TOKEN: token, CONDUCTOR_MCP_URL: mcpUrl, E2E_MODE: mode = 'work', E2E_TRACE: trace } = process.env;
const headers = { Authorization: `Bearer ${token}` };

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }));
const text = (r) => (r.content ?? []).map((c) => c.text ?? '').join('');
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: text(r), isError: !!r.isError };
};
const http = async (path, init) => {
  const res = await fetch(`${api}${path}`, { ...init, headers: { ...headers, 'content-type': 'application/json' } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const out = { mode, prompt };
out.tools = (await client.listTools()).tools.map((t) => t.name);
out.me = (await http('/api/v1/agent/me')).body;
out.ownerRoute = (await http('/api/v1/orgs')).status; // must be refused for a run token

if (mode === 'work') {
  out.recalled = await call('conductor-memory__memory_search', { query: 'deploy checklist staging' });
  out.file = await call('conductor-files__write_file', { path: 'report.md', content: '# Report\nAll checks passed.\n' });
  out.escape = await call('conductor-files__write_file', { path: '../../escape.txt', content: 'nope' });
  out.memory = await call('conductor-memory__memory_write', {
    kind: 'procedural', content: 'Deploy checklist: run the smoke suite against staging before promoting a release to production.',
  });
  const viaHttp = await http('/api/v1/agent/tools/conductor-tasks__report_progress', {
    method: 'POST', body: JSON.stringify({ arguments: { status: 'done', summary: 'Wrote report.md; all checks passed.' } }),
  });
  out.report = viaHttp;
} else if (mode === 'ask') {
  // A gated external action: must come back "approval pending", then succeed once approved.
  out.gated = await call('conductor-tasks__request_approval', { kind: 'external_send', title: 'Email the launch announcement', payload: { to: 'press@example.com' } });
}

await client.close();
if (trace) writeFileSync(trace, JSON.stringify(out, null, 2));
process.stdout.write(mode === 'work' ? 'Finished: report written.' : 'Requested approval and stopped.');
