import { hasLineBreak } from '../util.js';
import { SocketReader, connect } from './net-reader.js';

export interface ImapOptions {
  host: string;
  port: number;
  /** Implicit TLS (993). Plain connections are refused unless `allowInsecureAuth` (local test servers). */
  secure: boolean;
  username: string;
  password: string;
  mailbox?: string;
  allowInsecureAuth?: boolean;
  rejectUnauthorized?: boolean;
  /** Messages per poll. */
  max?: number;
  timeoutMs?: number;
}

interface Untagged {
  line: string;
  literals: Buffer[];
}

const MAX_LITERAL_BYTES = 25 * 1024 * 1024;

function quote(value: string): string {
  if (hasLineBreak(value)) throw new Error('IMAP argument contains a line break');
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/** Minimal IMAP4rev1 client: LOGIN, SELECT, UID SEARCH UNSEEN, UID FETCH BODY.PEEK[], UID STORE +FLAGS (\Seen). */
class ImapSession {
  private seq = 0;

  constructor(private readonly reader: SocketReader) {}

  /** One logical response line; `{n}` literals are read as bytes and replaced by a placeholder. */
  private async readLogicalLine(): Promise<Untagged> {
    let line = await this.reader.readLine();
    const literals: Buffer[] = [];
    for (;;) {
      const m = /\{(\d+)\}$/.exec(line);
      if (!m) break;
      const size = Number(m[1]);
      if (size > MAX_LITERAL_BYTES) throw new Error('IMAP literal too large');
      literals.push(await this.reader.readBytes(size));
      line = `${line.slice(0, m.index)}<literal>${await this.reader.readLine()}`;
    }
    return { line, literals };
  }

  async greeting(): Promise<void> {
    const { line } = await this.readLogicalLine();
    if (!/^\* (OK|PREAUTH)\b/i.test(line)) throw new Error('IMAP server refused the connection');
  }

  /** Run a command; `label` is what appears in errors (never the arguments). */
  async run(commandLine: string, label: string): Promise<Untagged[]> {
    const tag = `C${++this.seq}`;
    this.reader.write(`${tag} ${commandLine}\r\n`);
    const untagged: Untagged[] = [];
    for (;;) {
      const response = await this.readLogicalLine();
      if (response.line.startsWith(`${tag} `)) {
        const rest = response.line.slice(tag.length + 1);
        if (!/^OK\b/i.test(rest)) throw new Error(`IMAP ${label} failed: ${rest.slice(0, 200)}`);
        return untagged;
      }
      untagged.push(response);
    }
  }
}

/**
 * Fetch every unseen message in the mailbox (oldest first, up to `max`) and
 * mark each one \Seen as soon as it has been read, so a message is handed
 * out at most once.
 */
export async function fetchUnseen(o: ImapOptions): Promise<Buffer[]> {
  if (!o.secure && !o.allowInsecureAuth) throw new Error('IMAP without TLS is refused; set imap.secure or (tests only) imap.allowInsecureAuth');
  const socket = await connect({ host: o.host, port: o.port, secure: o.secure, rejectUnauthorized: o.rejectUnauthorized, timeoutMs: o.timeoutMs });
  const reader = new SocketReader(socket);
  const session = new ImapSession(reader);
  const messages: Buffer[] = [];
  try {
    await session.greeting();
    await session.run(`LOGIN ${quote(o.username)} ${quote(o.password)}`, 'LOGIN');
    await session.run(`SELECT ${quote(o.mailbox ?? 'INBOX')}`, 'SELECT');
    const search = await session.run('UID SEARCH UNSEEN', 'SEARCH');
    const uids = search
      .filter((u) => /^\* SEARCH\b/i.test(u.line))
      .flatMap((u) => u.line.split(/\s+/).slice(2))
      .filter((s) => /^\d+$/.test(s))
      .map(Number)
      .sort((a, b) => a - b)
      .slice(0, o.max ?? 20);
    for (const uid of uids) {
      const fetched = await session.run(`UID FETCH ${uid} (BODY.PEEK[])`, 'FETCH');
      const body = fetched.find((u) => /^\* \d+ FETCH\b/i.test(u.line) && u.literals.length > 0)?.literals[0];
      await session.run(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`, 'STORE');
      if (body) messages.push(body);
    }
    await session.run('LOGOUT', 'LOGOUT').catch(() => {});
  } finally {
    reader.detach();
    socket.destroy();
  }
  return messages;
}
