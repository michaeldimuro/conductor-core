import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorBody } from './http.js';

/** `ui/dist` at the project root (same relative position from `src/api` and `dist/api`). */
export const DEFAULT_UI_DIR = fileURLToPath(new URL('../../ui/dist', import.meta.url));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const NOT_BUILT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conductor</title>
<style>
body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec}
main{max-width:34rem;padding:2rem}
h1{font-size:1.4rem;margin:0 0 .5rem}
code{background:#1c2029;padding:.15rem .4rem;border-radius:4px}
p{color:#a8afbd}
</style>
</head>
<body>
<main>
<h1>Conductor is running</h1>
<p>The web UI has not been built yet. Run <code>npm run build:ui</code> in the project directory and reload this page.</p>
<p>The API is available at <code>/api/v1</code>; the CLI works without the UI.</p>
</main>
</body>
</html>
`;

/** Paths that are never the SPA: unknown ones answer with a JSON 404. */
const NON_UI_PREFIXES = ['/api/', '/mcp', '/hooks/', '/auth/', '/healthz', '/assets/'];

export function securityHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    // Takeover and login links carry credentials in the URL; never leak them through Referer.
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });
}

/**
 * Serve the built web UI with SPA fallback for non-API GETs. When the UI has
 * not been built, a small built-in page says so (the API and CLI still work).
 */
export async function registerUi(app: FastifyInstance, uiDir: string | undefined): Promise<void> {
  const root = resolve(uiDir ?? DEFAULT_UI_DIR);
  const index = join(root, 'index.html');
  const built = existsSync(index) && statSync(index).isFile();

  if (built) {
    await app.register(fastifyStatic, { root, prefix: '/', index: 'index.html', dotfiles: 'deny', wildcard: true });
  }

  const spa = (reply: FastifyReply): FastifyReply => {
    reply.header('cache-control', 'no-cache');
    return built ? reply.sendFile('index.html', root) : reply.code(200).type('text/html; charset=utf-8').send(NOT_BUILT_HTML);
  };

  // The takeover viewer is a client-side route; the token stays in the URL for the SPA to claim.
  app.get('/takeover/:token', async (_req, reply) => spa(reply));
  if (!built) app.get('/', async (_req, reply) => spa(reply));

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0] ?? '/';
    const isUiRoute = (req.method === 'GET' || req.method === 'HEAD')
      && !NON_UI_PREFIXES.some((p) => path === p || path.startsWith(p))
      && extname(path) === '';
    if (isUiRoute) return spa(reply);
    return reply.code(404).send(errorBody('not_found', `no route for ${req.method} ${path}`));
  });
}
