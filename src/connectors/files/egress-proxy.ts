import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';

/**
 * One allowlist entry: `host`, `host:port`, `*.domain` (any subdomain, and the
 * domain itself) or a full URL whose host is used. Matching is exact and
 * case-insensitive — never a substring.
 */
export function hostAllowed(allowlist: readonly string[], host: string, port: number): boolean {
  const target = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!target) return false;
  for (const raw of allowlist) {
    let entry = String(raw).trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes('://')) {
      try {
        entry = new URL(entry).host;
      } catch {
        continue;
      }
    }
    let entryPort: number | null = null;
    const m = /^(.*):(\d{1,5})$/.exec(entry);
    if (m && !m[1]!.includes(':')) {
      entry = m[1]!;
      entryPort = Number(m[2]);
    }
    entry = entry.replace(/^\[|\]$/g, '');
    if (entryPort !== null && entryPort !== port) continue;
    if (entry.startsWith('*.')) {
      const domain = entry.slice(2);
      if (domain && (target === domain || target.endsWith(`.${domain}`))) return true;
    } else if (entry === target) {
      return true;
    }
  }
  return false;
}

function splitAuthority(authority: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(authority.trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  return port > 0 && port < 65536 ? { host: m[1]!, port } : null;
}

export interface EgressProxy {
  port: number;
  /** Hosts refused during this command (for the tool result). */
  denied: string[];
  close(): Promise<void>;
}

/**
 * A forward proxy on loopback that only reaches hosts on the org's network
 * allowlist. The sandboxed command can talk to nothing but this port, so
 * `policies.networkAllowlist` is enforced per host rather than as an on/off
 * switch. Supports `CONNECT` (HTTPS and anything tunnelled) and plain HTTP.
 */
export async function startEgressProxy(allowlist: readonly string[]): Promise<EgressProxy> {
  const denied: string[] = [];
  const sockets = new Set<Socket>();
  const refuse = (host: string): void => {
    if (denied.length < 50 && !denied.includes(host)) denied.push(host);
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('proxy requests need an absolute URL');
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    if (url.protocol !== 'http:' || !hostAllowed(allowlist, url.hostname, port)) {
      refuse(url.hostname);
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`blocked by the organization's network allowlist: ${url.hostname}`);
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = httpRequest({ host: url.hostname, port, method: req.method, path: `${url.pathname}${url.search}`, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = splitAuthority(req.url ?? '', 443);
    if (!target || !hostAllowed(allowlist, target.host, target.port)) {
      refuse(target?.host ?? String(req.url));
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(target.port, target.host.replace(/^\[|\]$/g, ''), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    const done = (): void => {
      upstream.destroy();
      client.destroy();
      sockets.delete(upstream);
    };
    upstream.on('error', () => {
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      done();
    });
    upstream.on('close', done);
    client.on('error', done);
    client.on('close', done);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    denied,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
