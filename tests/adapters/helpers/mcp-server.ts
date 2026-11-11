import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/** 1x1 transparent PNG. */
export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export interface TestGateway {
  url: string;
  token: string;
  /** Tool calls that reached the server (after the bearer check). */
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** Requests rejected for a missing/incorrect bearer. */
  unauthorized: number;
  close(): Promise<void>;
}

/**
 * A real MCP server (SDK McpServer over Streamable HTTP) standing in for the
 * Conductor connector gateway. It refuses any request without the run token.
 */
export async function startTestGateway(token: string): Promise<TestGateway> {
  const gw: TestGateway = { url: '', token, calls: [], unauthorized: 0, close: async () => {} };

  const build = (): McpServer => {
    const server = new McpServer({ name: 'conductor-test-gateway', version: '0.0.0' });
    server.registerTool(
      'lookup_code',
      { description: 'Look up the secret code for a key.', inputSchema: { key: z.string().describe('The key to look up') } },
      async ({ key }) => {
        gw.calls.push({ tool: 'lookup_code', args: { key } });
        return { content: [{ type: 'text', text: `CODE-${key}-42` }] };
      },
    );
    server.registerTool('screenshot', { description: 'Capture the current page as an image.', inputSchema: {} }, async () => {
      gw.calls.push({ tool: 'screenshot', args: {} });
      return {
        content: [
          { type: 'text', text: 'page captured' },
          { type: 'image', data: TINY_PNG, mimeType: 'image/png' },
        ],
      };
    });
    return server;
  };

  const http: Server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      gw.unauthorized++;
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    // Stateless: one server + transport per request.
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  gw.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  gw.close = () =>
    new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  return gw;
}
