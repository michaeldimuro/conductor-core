import net, { type AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/* ───────────────────────── SMTP ───────────────────────── */

export interface SmtpMessage {
  from: string;
  to: string[];
  /** DATA exactly as it crossed the wire (still dot-stuffed), without the terminating ".". */
  wire: string;
  /** DATA after the server removed the transparency dots. */
  data: string;
}

export interface SmtpMock {
  port: number;
  /** Every command line the client sent, in order (DATA payload excluded). */
  commands: string[];
  messages: SmtpMessage[];
  authenticated: Array<{ mechanism: string; username: string; password: string }>;
  close(): Promise<void>;
}

/** A plain-text SMTP server (node:net) strict enough to catch protocol mistakes. */
export async function startSmtpMock(opts: { auth?: string[]; username?: string; password?: string } = {}): Promise<SmtpMock> {
  const mechanisms = opts.auth ?? ['PLAIN', 'LOGIN'];
  const mock: SmtpMock = { port: 0, commands: [], messages: [], authenticated: [], close: async () => {} };
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let inData = false;
    let greeted = false;
    let loginStep: 'user' | 'pass' | null = null;
    let loginUser = '';
    let current: SmtpMessage = { from: '', to: [], wire: '', data: '' };
    const send = (line: string) => socket.write(`${line}\r\n`);
    const checkAuth = (mechanism: string, username: string, password: string) => {
      if ((opts.username ?? username) === username && (opts.password ?? password) === password) {
        mock.authenticated.push({ mechanism, username, password });
        send('235 2.7.0 Authentication successful');
      } else {
        send('535 5.7.8 Authentication credentials invalid');
      }
    };
    send('220 mock.smtp ESMTP ready');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.startsWith('.\r\n') ? 0 : buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const wire = end === 0 ? '' : buffer.slice(0, end + 2);
          buffer = buffer.slice(end === 0 ? 3 : end + 5);
          current.wire = wire;
          current.data = wire.replace(/^\./gm, '');
          mock.messages.push(current);
          current = { from: '', to: [], wire: '', data: '' };
          inData = false;
          send('250 2.0.0 Queued');
          continue;
        }
        const i = buffer.indexOf('\r\n');
        if (i < 0) return;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);

        if (loginStep === 'user') {
          loginUser = Buffer.from(line, 'base64').toString('utf8');
          loginStep = 'pass';
          send('334 UGFzc3dvcmQ6');
          continue;
        }
        if (loginStep === 'pass') {
          loginStep = null;
          mock.commands.push('<login credentials>');
          checkAuth('LOGIN', loginUser, Buffer.from(line, 'base64').toString('utf8'));
          continue;
        }

        const upper = line.toUpperCase();
        mock.commands.push(upper.startsWith('AUTH PLAIN') ? 'AUTH PLAIN <credentials>' : line);
        if (upper.startsWith('EHLO ')) {
          greeted = true;
          socket.write(`250-mock.smtp greets you\r\n250-8BITMIME\r\n${mechanisms.length ? `250-AUTH ${mechanisms.join(' ')}\r\n` : ''}250 SIZE 10485760\r\n`);
        } else if (!greeted) {
          send('503 5.5.1 EHLO first');
        } else if (upper.startsWith('AUTH PLAIN ')) {
          const [, username = '', password = ''] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000');
          checkAuth('PLAIN', username, password);
        } else if (upper === 'AUTH LOGIN') {
          loginStep = 'user';
          send('334 VXNlcm5hbWU6');
        } else if (upper.startsWith('MAIL FROM:')) {
          const m = /^MAIL FROM:<([^<>\s]+)>$/i.exec(line);
          if (!m) send('501 5.1.7 Bad sender address syntax');
          else {
            current.from = m[1]!;
            send('250 2.1.0 Ok');
          }
        } else if (upper.startsWith('RCPT TO:')) {
          const m = /^RCPT TO:<([^<>\s]+)>$/i.exec(line);
          if (!m || !current.from) send('501 5.1.3 Bad recipient address syntax');
          else {
            current.to.push(m[1]!);
            send('250 2.1.5 Ok');
          }
        } else if (upper === 'DATA') {
          if (current.to.length === 0) send('503 5.5.1 RCPT first');
          else {
            inData = true;
            send('354 End data with <CR><LF>.<CR><LF>');
          }
        } else if (upper === 'QUIT') {
          send('221 2.0.0 Bye');
          socket.end();
        } else {
          send('502 5.5.2 Command not recognized');
        }
      }
    });
    socket.on('error', () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.port = (server.address() as AddressInfo).port;
  mock.close = () => new Promise((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  });
  return mock;
}

/* ───────────────────────── IMAP ───────────────────────── */

export interface ImapMock {
  port: number;
  /** Add an unseen message to the mailbox. */
  deliver(raw: string): number;
  seen: Set<number>;
  logins: Array<{ username: string; password: string }>;
  close(): Promise<void>;
}

/** A plain-text IMAP server (node:net) covering exactly the subset the gateway speaks. */
export async function startImapMock(credentials: { username: string; password: string }): Promise<ImapMock> {
  const mailbox = new Map<number, Buffer>();
  let nextUid = 1;
  const sockets = new Set<net.Socket>();
  const mock: ImapMock = {
    port: 0, seen: new Set(), logins: [],
    deliver: (raw) => {
      const uid = nextUid++;
      mailbox.set(uid, Buffer.from(raw.replace(/\r?\n/g, '\r\n'), 'utf8'));
      return uid;
    },
    close: async () => {},
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    let authed = false;
    socket.write('* OK IMAP4rev1 mock ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const i = buffer.indexOf('\r\n');
        if (i < 0) return;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const [tag = '', ...rest] = line.split(' ');
        const command = rest.join(' ');
        const login = /^LOGIN "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(command);
        const fetch = /^UID FETCH (\d+) \(BODY\.PEEK\[\]\)$/.exec(command);
        const store = /^UID STORE (\d+) \+FLAGS\.SILENT \(\\Seen\)$/.exec(command);
        if (login) {
          const username = login[1]!.replace(/\\(.)/g, '$1');
          const password = login[2]!.replace(/\\(.)/g, '$1');
          mock.logins.push({ username, password });
          authed = username === credentials.username && password === credentials.password;
          socket.write(authed ? `${tag} OK LOGIN completed\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        } else if (command === 'LOGOUT') {
          socket.write(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
          socket.end();
        } else if (!authed) {
          socket.write(`${tag} NO not authenticated\r\n`);
        } else if (command === 'SELECT "INBOX"') {
          socket.write(`* ${mailbox.size} EXISTS\r\n* FLAGS (\\Seen)\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
        } else if (command === 'UID SEARCH UNSEEN') {
          const unseen = [...mailbox.keys()].filter((uid) => !mock.seen.has(uid));
          socket.write(`* SEARCH${unseen.map((u) => ` ${u}`).join('')}\r\n${tag} OK SEARCH completed\r\n`);
        } else if (fetch) {
          const uid = Number(fetch[1]);
          const body = mailbox.get(uid);
          if (body) {
            socket.write(`* ${uid} FETCH (UID ${uid} BODY[] {${body.length}}\r\n`);
            socket.write(body);
            socket.write(')\r\n');
          }
          socket.write(`${tag} OK FETCH completed\r\n`);
        } else if (store) {
          mock.seen.add(Number(store[1]));
          socket.write(`${tag} OK STORE completed\r\n`);
        } else {
          socket.write(`${tag} BAD unknown command\r\n`);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.port = (server.address() as AddressInfo).port;
  mock.close = () => new Promise((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  });
  return mock;
}

/* ───────────────────────── iMessage ───────────────────────── */

export interface ChatDbMock {
  path: string;
  /** Insert a message row like Messages.app does; returns its ROWID. */
  addMessage(handle: string, text: string | null, opts?: { fromMe?: boolean; attributedBody?: Buffer }): number;
}

/** A temp SQLite file with the slice of chat.db's schema the bridge reads. */
export function createChatDb(dir = mkdtempSync(join(tmpdir(), 'conductor-chatdb-'))): ChatDbMock {
  const path = join(dir, 'chat.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT DEFAULT 'iMessage');
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, attributedBody BLOB, handle_id INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, date INTEGER DEFAULT 0);
  `);
  db.close();
  return {
    path,
    addMessage(handle, text, opts = {}) {
      const conn = new Database(path);
      try {
        const existing = conn.prepare('SELECT ROWID AS rowid FROM handle WHERE id = ?').get(handle) as { rowid: number } | undefined;
        const handleId = existing?.rowid ?? Number(conn.prepare('INSERT INTO handle (id) VALUES (?)').run(handle).lastInsertRowid);
        const res = conn.prepare('INSERT INTO message (text, attributedBody, handle_id, is_from_me) VALUES (?, ?, ?, ?)')
          .run(text, opts.attributedBody ?? null, handleId, opts.fromMe ? 1 : 0);
        return Number(res.lastInsertRowid);
      } finally {
        conn.close();
      }
    },
  };
}

export interface OsascriptMock {
  path: string;
  /** argv of every invocation so far. */
  calls(): string[][];
}

/** A stand-in `osascript` binary that records its argv (one JSON array per line). */
export function createOsascriptMock(dir = mkdtempSync(join(tmpdir(), 'conductor-osascript-'))): OsascriptMock {
  const path = join(dir, 'osascript');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(path, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  chmodSync(path, 0o755);
  return {
    path,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []),
  };
}
