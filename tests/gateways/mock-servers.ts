import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
  auth: string | null;
}

interface MockHttp {
  url: string;
  calls: RecordedCall[];
  close(): Promise<void>;
}

type Responder = (call: RecordedCall) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;

async function startHttp(respond: Responder): Promise<MockHttp> {
  const calls: RecordedCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      } catch {
        body = {};
      }
      const call: RecordedCall = { method: req.method ?? 'GET', path: req.url ?? '/', body, auth: req.headers.authorization ?? null };
      calls.push(call);
      void Promise.resolve(respond(call)).then((r) => {
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/* ───────────────────────── Telegram ───────────────────────── */

export interface TelegramMock extends MockHttp {
  token: string;
  /** Bot API calls by method name (getUpdates excluded). */
  of(method: string): Array<Record<string, unknown>>;
  offsets: number[];
  pushMessage(chatId: number, userId: number, text: string): void;
  pushCallback(chatId: number, userId: number, data: string, messageId: number): string;
}

export async function startTelegramMock(token = '123456789:AAFakeTelegramTokenForTestsOnly_abcdefgh'): Promise<TelegramMock> {
  const updates: Array<Record<string, unknown>> = [];
  const offsets: number[] = [];
  let nextUpdate = 100;
  let nextMessage = 1;
  const mock = await startHttp(async (call) => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(call.path);
    if (!m || m[1] !== token) return { status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } };
    const method = m[2]!;
    if (method === 'getMe') return { json: { ok: true, result: { id: 1, is_bot: true, username: 'conductor_bot' } } };
    if (method === 'getUpdates') {
      const offset = Number(call.body.offset ?? 0);
      offsets.push(offset);
      const pending = () => updates.filter((u) => (u.update_id as number) >= offset);
      if (pending().length === 0) await new Promise((r) => setTimeout(r, 15));
      return { json: { ok: true, result: pending() } };
    }
    if (method === 'sendMessage') return { json: { ok: true, result: { message_id: nextMessage++ } } };
    return { json: { ok: true, result: true } };
  });
  return Object.assign(mock, {
    token,
    offsets,
    of: (method: string) => mock.calls.filter((c) => c.path.endsWith(`/${method}`)).map((c) => c.body),
    pushMessage: (chatId: number, userId: number, text: string) => {
      updates.push({ update_id: nextUpdate++, message: { message_id: nextMessage++, chat: { id: chatId }, from: { id: userId }, text } });
    },
    pushCallback: (chatId: number, userId: number, data: string, messageId: number) => {
      const id = `cb${nextUpdate}`;
      updates.push({ update_id: nextUpdate++, callback_query: { id, from: { id: userId }, data, message: { message_id: messageId, chat: { id: chatId } } } });
      return id;
    },
  });
}

/* ───────────────────────── Slack ───────────────────────── */

export interface SlackMock extends MockHttp {
  of(method: string): Array<Record<string, unknown>>;
  /** Set the URL `apps.connections.open` hands out (Socket Mode). */
  setSocketUrl(url: string | null): void;
}

export async function startSlackMock(botToken: string): Promise<SlackMock> {
  let ts = 1000;
  const state = { socketUrl: null as string | null };
  const mock = await startHttp((call) => {
    const method = call.path.replace(/^\//, '');
    if (method === 'apps.connections.open') {
      return call.auth?.startsWith('Bearer xapp-') && state.socketUrl
        ? { json: { ok: true, url: state.socketUrl } }
        : { json: { ok: false, error: 'invalid_auth' } };
    }
    if (call.auth !== `Bearer ${botToken}`) return { json: { ok: false, error: 'invalid_auth' } };
    if (method === 'auth.test') return { json: { ok: true, user_id: 'UBOT', team: 'T1' } };
    if (method === 'chat.postMessage') return { json: { ok: true, channel: call.body.channel, ts: `${ts++}.0001` } };
    return { json: { ok: true } };
  });
  return Object.assign(mock, {
    of: (method: string) => mock.calls.filter((c) => c.path === `/${method}`).map((c) => c.body),
    setSocketUrl: (url: string | null) => {
      state.socketUrl = url;
    },
  });
}

export function slackSignature(signingSecret: string, timestampSec: number, rawBody: string): Record<string, string> {
  return {
    'x-slack-request-timestamp': String(timestampSec),
    'x-slack-signature': `v0=${createHmac('sha256', signingSecret).update(`v0:${timestampSec}:${rawBody}`).digest('hex')}`,
  };
}

/* ───────────────────────── Discord ───────────────────────── */

export interface DiscordMock extends MockHttp {
  of(method: string, pathPattern: RegExp): Array<Record<string, unknown>>;
}

export async function startDiscordMock(botToken: string): Promise<DiscordMock> {
  let id = 5000;
  const mock = await startHttp((call) => {
    if (call.auth !== `Bot ${botToken}`) return { status: 401, json: { message: '401: Unauthorized', code: 0 } };
    if (call.method === 'GET' && call.path === '/users/@me') return { json: { id: '42', username: 'conductor', bot: true } };
    if (call.method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(call.path)) return { json: { id: String(id++) } };
    if (call.method === 'PUT') return { json: [] };
    return { json: {} };
  });
  return Object.assign(mock, {
    of: (method: string, pathPattern: RegExp) => mock.calls.filter((c) => c.method === method && pathPattern.test(c.path)).map((c) => c.body),
  });
}

export interface DiscordKeys {
  publicKeyHex: string;
  privateKey: KeyObject;
}

export function discordKeys(): DiscordKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { publicKeyHex: der.subarray(der.length - 32).toString('hex'), privateKey };
}

export function discordSignature(privateKey: KeyObject, timestamp: string, rawBody: string): Record<string, string> {
  return {
    'x-signature-timestamp': timestamp,
    'x-signature-ed25519': sign(null, Buffer.from(timestamp + rawBody, 'utf8'), privateKey).toString('hex'),
  };
}
