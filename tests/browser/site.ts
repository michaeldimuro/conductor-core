import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

export const SITE_USER = 'alice';
export const SITE_PASSWORD = 'Tr0ub4dor&3-horse';
export const SITE_MFA_CODE = '482913';

/** Fixed geometry so a remote viewer can drive the forms by coordinates alone. */
const box = (top: number) => `position:absolute;left:20px;top:${top}px;width:200px;height:30px;box-sizing:border-box`;
export const POS = { first: { x: 120, y: 35 }, second: { x: 120, y: 85 }, third: { x: 120, y: 135 } } as const;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0">${body}</body></html>`;

export interface TestSite {
  port: number;
  /** URL on 127.0.0.1 (the "work" host). */
  url(path: string): string;
  /** URL on localhost — a different host (and cookie jar) served by the same process. */
  altUrl(path: string): string;
  state: { paid: number; mfaPassed: number; logins: number; lastEcho: string | null; uploads: string[] };
  close(): Promise<void>;
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export async function startSite(): Promise<TestSite> {
  const sessions = new Set<string>();
  const halfway = new Set<string>();
  const state: TestSite['state'] = { paid: 0, mfaPassed: 0, logins: 0, lastEcho: null, uploads: [] };
  let port = 0;

  const html = (res: ServerResponse, body: string, status = 200, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  };
  const redirect = (res: ServerResponse, to: string, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(302, { location: to, ...headers });
    res.end();
  };
  const newSession = (persistent: boolean): string => {
    const sid = randomBytes(12).toString('hex');
    sessions.add(sid);
    state.logins++;
    return `sid=${sid}; Path=/; HttpOnly${persistent ? '; Max-Age=86400' : ''}`;
  };
  const loginForm = (action: string) => page('Sign in', `
    <h1 style="position:absolute;left:300px;top:20px">Sign in</h1>
    <form method="post" action="${action}">
      <input id="u" name="user" aria-label="Username" style="${box(20)}">
      <input id="p" name="pass" type="password" aria-label="Password" style="${box(70)}">
      <button id="go" style="${box(120)}">Sign in</button>
    </form>`);

  const server: Server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const jar = cookies(req);
      const authed = jar.sid !== undefined && sessions.has(jar.sid);
      const route = `${req.method} ${u.pathname}`;
      switch (route) {
        // Two-step login (password, then MFA) — the FR-13 wall.
        case 'GET /login': return html(res, loginForm('/login'));
        case 'POST /login': {
          const f = await form(req);
          if (f.get('user') !== SITE_USER || f.get('pass') !== SITE_PASSWORD) return html(res, page('Sign in', '<p>Wrong credentials</p>'), 401);
          const half = randomBytes(8).toString('hex');
          halfway.add(half);
          return redirect(res, '/mfa', { 'set-cookie': `half=${half}; Path=/; HttpOnly` });
        }
        case 'GET /mfa':
          if (!jar.half || !halfway.has(jar.half)) return redirect(res, '/login');
          return html(res, page('Verify', `
            <form method="post" action="/mfa">
              <input id="code" name="code" aria-label="Code" inputmode="numeric" style="${box(20)}">
              <button id="verify" style="${box(70)}">Verify</button>
            </form>`));
        case 'POST /mfa': {
          const f = await form(req);
          if (!jar.half || !halfway.has(jar.half) || f.get('code') !== SITE_MFA_CODE) return html(res, page('Verify', '<p>Wrong code</p>'), 401);
          state.mfaPassed++;
          return redirect(res, '/account', { 'set-cookie': newSession(true) });
        }
        // One-step login used for the persistence tests. ?session=1 issues a session cookie (no expiry).
        case 'GET /simple-login': return html(res, loginForm(`/simple-login${u.search}`));
        case 'POST /simple-login': {
          const f = await form(req);
          if (f.get('user') !== SITE_USER || f.get('pass') !== SITE_PASSWORD) return html(res, page('Sign in', '<p>Wrong credentials</p>'), 401);
          return redirect(res, '/account', { 'set-cookie': newSession(u.searchParams.get('session') !== '1') });
        }
        case 'GET /account':
          if (!authed) return redirect(res, '/login');
          return html(res, page('Account', `<h1>Welcome ${SITE_USER}</h1><p id="balance">Balance: 42 credits</p>`));
        case 'GET /pay':
          return html(res, page('Checkout', `
            <a id="help" href="/help">Help</a>
            <form method="post" action="/pay"><button id="pay">Pay now</button></form>
            <p id="count">Payments so far: ${state.paid}</p>`));
        case 'POST /pay':
          state.paid++;
          return html(res, page('Paid', `<h1>Payment #${state.paid} complete</h1><a href="/pay">Back</a>`));
        case 'GET /help': return html(res, page('Help', '<h1>Help center</h1>'));
        case 'GET /echo-form':
          return html(res, page('Echo', `
            <form method="post" action="/echo">
              <input id="u" name="user" aria-label="Username">
              <input id="p" name="pass" type="password" aria-label="Password">
              <input id="t" name="token" aria-label="API token">
              <button id="go">Send</button>
            </form>
            <div id="mirror"></div>
            <script>
              for (const id of ['p', 't']) document.getElementById(id).addEventListener('input', (e) => {
                document.getElementById('mirror').textContent = 'mirror: ' + e.target.value;
              });
            </script>`));
        case 'POST /echo': {
          const f = await form(req);
          state.lastEcho = f.get('pass');
          const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
          return html(res, page('Echoed', `<p id="echo">You sent ${esc(f.get('pass') ?? '')} and ${esc(f.get('token') ?? '')}</p>`));
        }
        case 'GET /links':
          return html(res, page('Links', `
            <a id="in" href="/help">Internal help</a>
            <a id="out" href="http://localhost:${port}/help">External site</a>
            <table id="prices"><tr><th>Plan</th><th>Price</th></tr><tr><td>Basic</td><td>$5</td></tr><tr><td>Pro</td><td>$20</td></tr></table>
            <select id="plan" aria-label="Plan"><option value="basic">Basic</option><option value="pro">Pro</option></select>
            <a id="dl" href="/file.txt">Download report</a>
            <a id="blank" href="/help" target="_blank">Open help in new tab</a>`));
        case 'GET /redirect-out': return redirect(res, `http://localhost:${port}/help`);
        case 'GET /file.txt':
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.txt"' });
          return res.end('quarterly report contents');
        case 'GET /upload':
          return html(res, page('Upload', `
            <input type="file" id="f" aria-label="Attachment">
            <p id="picked"></p>
            <script>
              document.getElementById('f').addEventListener('change', async (e) => {
                const file = e.target.files[0];
                document.getElementById('picked').textContent = file.name + ': ' + (await file.text());
              });
            </script>`));
        default:
          return html(res, page('Not found', '<h1>404</h1>'), 404);
      }
    })().catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    altUrl: (path) => `http://localhost:${port}${path}`,
    state,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
