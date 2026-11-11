/* global process, URL, setTimeout */
// Minimal MCP client used by the fake agents: one tool call over Streamable HTTP.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function callTool(url, headers, name, args) {
  const client = new Client({ name: 'fake-agent', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  try {
    const res = await client.callTool({ name, arguments: args });
    return (res.content ?? []).map((c) => c.text ?? '').join('');
  } finally {
    await client.close();
  }
}

export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
