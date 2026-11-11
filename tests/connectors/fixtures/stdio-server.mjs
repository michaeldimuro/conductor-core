// Tiny real MCP server over stdio (SDK McpServer) used by the connector gateway tests.
import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture-stdio', version: '1.0.0' });
const text = (t) => ({ content: [{ type: 'text', text: t }] });

server.registerTool('get_note', { description: 'Read a note by id', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } }, async ({ id }) =>
  text(`note ${id}: remember the milk`),
);
// Reports which credential the gateway injected into this subprocess.
server.registerTool('whoami', { description: 'Report the connected account', inputSchema: {} }, async () =>
  text(`account=${process.env.FIXTURE_TOKEN ?? 'none'} inheritedSecret=${process.env.CONDUCTOR_TEST_PARENT_SECRET ?? 'none'}`),
);
server.registerTool('send_message', { description: 'Send a message to a recipient', inputSchema: { to: z.string(), body: z.string() } }, async ({ to }) =>
  text(`sent to ${to}`),
);
server.registerTool('delete_note', { description: 'Delete a note', inputSchema: { id: z.string() } }, async ({ id }) => text(`deleted ${id}`));
// Simulates an upstream that dies mid-session.
server.registerTool('crash', { description: 'Exit the server process', inputSchema: {} }, async () => process.exit(1));

await server.connect(new StdioServerTransport());
