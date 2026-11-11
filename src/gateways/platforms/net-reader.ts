import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';

/**
 * Pull-style reader over a socket for line protocols (SMTP, IMAP): read one
 * CRLF-terminated line, or an exact number of bytes (IMAP literals).
 */
export class SocketReader {
  private buffer: Buffer = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer) => {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBuffer) this.fail(new Error('server response too large'));
    this.wake();
  };
  private readonly onError = (err: Error) => this.fail(new Error(`connection error: ${err.message}`));
  private readonly onClose = () => this.fail(new Error('connection closed by server'));
  private readonly onTimeout = () => {
    this.fail(new Error('connection timed out'));
    this.socket.destroy();
  };

  constructor(readonly socket: Duplex & { setTimeout?: (ms: number) => unknown }, private readonly maxBuffer = 32 * 1024 * 1024) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.on('timeout', this.onTimeout);
  }

  /** Stop listening (before upgrading the socket to TLS). */
  detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    this.socket.off('timeout', this.onTimeout);
  }

  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Next line without its CRLF. */
  async readLine(): Promise<string> {
    for (;;) {
      const i = this.buffer.indexOf('\r\n');
      if (i >= 0) {
        const line = this.buffer.subarray(0, i).toString('utf8');
        this.buffer = this.buffer.subarray(i + 2);
        return line;
      }
      if (this.failure) throw this.failure;
      await this.wait();
    }
  }

  async readBytes(n: number): Promise<Buffer> {
    for (;;) {
      if (this.buffer.length >= n) {
        const out = Buffer.from(this.buffer.subarray(0, n));
        this.buffer = this.buffer.subarray(n);
        return out;
      }
      if (this.failure) throw this.failure;
      await this.wait();
    }
  }

  write(data: string | Buffer): void {
    if (this.failure) throw this.failure;
    this.socket.write(data);
  }
}

export interface ConnectOptions {
  host: string;
  port: number;
  /** Implicit TLS from the first byte. */
  secure: boolean;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
}

/** Open a TCP or implicit-TLS connection with an idle timeout. */
export function connect(o: ConnectOptions): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(new Error(`could not connect to ${o.host}:${o.port}: ${err.message}`));
    const ready = () => {
      socket.off('error', onError);
      resolve(socket);
    };
    const socket: net.Socket | tls.TLSSocket = o.secure
      ? tls.connect({ host: o.host, port: o.port, servername: net.isIP(o.host) ? undefined : o.host, rejectUnauthorized: o.rejectUnauthorized ?? true }, ready)
      : net.connect({ host: o.host, port: o.port }, ready);
    socket.setTimeout(o.timeoutMs ?? 30_000);
    socket.once('error', onError);
    socket.once('timeout', () => {
      socket.destroy(new Error('timed out'));
    });
  });
}

/** STARTTLS: wrap an established plain socket in TLS. */
export function upgradeToTls(socket: net.Socket, host: string, rejectUnauthorized = true): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(new Error(`TLS upgrade failed: ${err.message}`));
    const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized }, () => {
      secure.off('error', onError);
      resolve(secure);
    });
    secure.once('error', onError);
  });
}
