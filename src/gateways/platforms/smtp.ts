import type net from 'node:net';
import os from 'node:os';
import { SocketReader, connect, upgradeToTls } from './net-reader.js';
import { isEmailAddress } from './mime.js';

export interface SmtpOptions {
  host: string;
  port: number;
  /** Implicit TLS (port 465). Otherwise STARTTLS is used whenever the server offers it. */
  secure: boolean;
  username?: string;
  password?: string;
  /** Allow AUTH on a connection that could not be encrypted (local test servers only). */
  allowInsecureAuth?: boolean;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
}

interface Reply {
  code: number;
  lines: string[];
}

async function readReply(reader: SocketReader): Promise<Reply> {
  const lines: string[] = [];
  for (;;) {
    const line = await reader.readLine();
    const m = /^(\d{3})([ -])?(.*)$/.exec(line);
    if (!m) throw new Error('SMTP server sent a malformed reply');
    lines.push(m[3] ?? '');
    if (m[2] !== '-') return { code: Number(m[1]), lines };
  }
}

/** Send one command and require one of the expected codes. `label` is what appears in errors (never the payload). */
async function command(reader: SocketReader, line: string, expect: number[], label: string): Promise<Reply> {
  reader.write(`${line}\r\n`);
  const reply = await readReply(reader);
  if (!expect.includes(reply.code)) throw new Error(`SMTP ${label} rejected: ${reply.code} ${(reply.lines.at(-1) ?? '').slice(0, 200)}`);
  return reply;
}

function clientName(): string {
  const host = os.hostname().replace(/[^A-Za-z0-9.-]/g, '');
  return host || 'localhost';
}

async function ehlo(reader: SocketReader): Promise<Map<string, string>> {
  const reply = await command(reader, `EHLO ${clientName()}`, [250], 'EHLO');
  const caps = new Map<string, string>();
  for (const line of reply.lines.slice(1)) {
    const [name = '', ...rest] = line.trim().split(/\s+/);
    if (name) caps.set(name.toUpperCase(), rest.join(' ').toUpperCase());
  }
  return caps;
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** Greeting → EHLO → STARTTLS (when offered) → EHLO → AUTH PLAIN/LOGIN. */
async function openSession(o: SmtpOptions): Promise<SocketReader> {
  const socket = await connect({ host: o.host, port: o.port, secure: o.secure, rejectUnauthorized: o.rejectUnauthorized, timeoutMs: o.timeoutMs });
  let reader = new SocketReader(socket);
  try {
    const greeting = await readReply(reader);
    if (greeting.code !== 220) throw new Error(`SMTP greeting rejected: ${greeting.code}`);
    let caps = await ehlo(reader);
    let encrypted = o.secure;
    if (!encrypted && caps.has('STARTTLS')) {
      await command(reader, 'STARTTLS', [220], 'STARTTLS');
      reader.detach();
      reader = new SocketReader(await upgradeToTls(socket as net.Socket, o.host, o.rejectUnauthorized ?? true));
      encrypted = true;
      // Capabilities must be re-read: the pre-TLS list is untrusted.
      caps = await ehlo(reader);
    }

    if (o.username) {
      if (!encrypted && !o.allowInsecureAuth) throw new Error('SMTP server does not offer TLS; refusing to send credentials in plaintext');
      const mechanisms = (caps.get('AUTH') ?? '').split(/\s+/);
      const password = o.password ?? '';
      if (mechanisms.includes('PLAIN')) {
        await command(reader, `AUTH PLAIN ${b64(`\u0000${o.username}\u0000${password}`)}`, [235], 'AUTH');
      } else if (mechanisms.includes('LOGIN')) {
        await command(reader, 'AUTH LOGIN', [334], 'AUTH');
        await command(reader, b64(o.username), [334], 'AUTH');
        await command(reader, b64(password), [235], 'AUTH');
      } else {
        throw new Error('SMTP server offers no supported AUTH mechanism (PLAIN or LOGIN)');
      }
    }
    return reader;
  } catch (err) {
    reader.socket.destroy();
    throw err;
  }
}

async function quit(reader: SocketReader): Promise<void> {
  try {
    await command(reader, 'QUIT', [221], 'QUIT');
  } catch {
    /* the message is already accepted (or the session is already dead) */
  }
  reader.detach();
  reader.socket.destroy();
}

/** CRLF line endings and transparency: a line starting with "." gets a second dot (RFC 5321 §4.5.2). */
export function dotStuff(data: string): string {
  const normalized = data.replace(/\r\n|\r|\n/g, '\r\n').replace(/^\./gm, '..');
  return normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`;
}

/** Connect and authenticate, then leave — proves the configuration works. */
export async function verifySmtp(o: SmtpOptions): Promise<void> {
  await quit(await openSession(o));
}

/** Deliver one RFC 5322 message (`data`) from `from` to `to`. */
export async function sendMail(o: SmtpOptions, envelope: { from: string; to: string; data: string }): Promise<void> {
  // Envelope addresses are interpolated into commands: they must be plain addresses.
  if (!isEmailAddress(envelope.from)) throw new Error('invalid sender address');
  if (!isEmailAddress(envelope.to)) throw new Error('invalid recipient address');
  const reader = await openSession(o);
  try {
    await command(reader, `MAIL FROM:<${envelope.from}>`, [250], 'MAIL FROM');
    await command(reader, `RCPT TO:<${envelope.to}>`, [250, 251], 'RCPT TO');
    await command(reader, 'DATA', [354], 'DATA');
    reader.write(dotStuff(envelope.data));
    await command(reader, '.', [250], 'message');
  } catch (err) {
    reader.detach();
    reader.socket.destroy();
    throw err;
  }
  await quit(reader);
}
