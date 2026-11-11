import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Services } from '../daemon/container.js';
import type { EventName } from '../shared/events.js';
import { errorMessage } from '../shared/errors.js';
import { parse, resolveOrg } from './http.js';
import { wsClientMessage } from './schemas/capabilities.js';
import type { WsServerMessage } from './types.js';

const OPEN = 1;
/** A client this far behind is not reading; cut it loose rather than buffer without bound. */
const MAX_BUFFERED = 8 * 1024 * 1024;

interface Conn {
  socket: WebSocket;
  /** `subscribe` with no org: every org (the cross-org inbox). */
  all: boolean;
  orgs: Set<string>;
  runs: Set<string>;
  alive: boolean;
}

/**
 * `WS /api/v1/ws` — live event fan-out for owner/device principals. One bus
 * subscription serves every socket; each socket only receives events of the
 * orgs it subscribed to, and per-step `run.event`s only for subscribed runs.
 */
export function eventSocket(app: FastifyInstance, s: Services, opts: { heartbeatMs: number }): { close(): void } {
  const conns = new Set<Conn>();
  const send = (c: Conn, msg: WsServerMessage): void => {
    if (c.socket.readyState === OPEN) c.socket.send(JSON.stringify(msg));
  };

  const wants = (c: Conn, name: EventName, p: { orgId?: string | null; runId?: string }): boolean => {
    if (typeof p.runId === 'string' && c.runs.has(p.runId)) return true;
    if (name === 'run.event') return false;
    if (typeof p.orgId !== 'string') return c.all || c.orgs.size > 0; // install-wide events
    return c.all || c.orgs.has(p.orgId);
  };

  const off = s.kernel.bus.onAny((name, payload) => {
    if (conns.size === 0) return;
    let frame: string | null = null;
    for (const c of conns) {
      if (!wants(c, name, payload as { orgId?: string | null; runId?: string })) continue;
      if (c.socket.readyState !== OPEN) continue;
      if (c.socket.bufferedAmount > MAX_BUFFERED) {
        c.socket.terminate();
        continue;
      }
      frame ??= JSON.stringify({ type: 'event', name, payload });
      c.socket.send(frame);
    }
  });

  const heartbeat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      if (c.socket.readyState === OPEN) c.socket.ping();
    }
  }, opts.heartbeatMs);
  heartbeat.unref();

  app.get('/ws', { websocket: true }, (socket) => {
    const c: Conn = { socket, all: false, orgs: new Set(), runs: new Set(), alive: true };
    conns.add(c);
    socket.on('pong', () => {
      c.alive = true;
    });
    socket.on('close', () => conns.delete(c));
    socket.on('error', () => conns.delete(c));
    socket.on('message', (data) => {
      c.alive = true;
      try {
        const msg = parse(wsClientMessage, JSON.parse(String(data)));
        if (msg.type === 'ping') return send(c, { type: 'pong' });
        const orgId = msg.orgId ? resolveOrg(s, msg.orgId).id : null;
        const runId = msg.runId ?? null;
        if (msg.type === 'subscribe') {
          if (orgId) c.orgs.add(orgId);
          if (runId) c.runs.add(runId);
          if (!orgId && !runId) c.all = true;
          return send(c, { type: 'subscribed', orgId, runId });
        }
        if (orgId) c.orgs.delete(orgId);
        if (runId) c.runs.delete(runId);
        if (!orgId && !runId) {
          c.all = false;
          c.orgs.clear();
          c.runs.clear();
        }
        return send(c, { type: 'unsubscribed', orgId, runId });
      } catch (e) {
        return send(c, { type: 'error', message: e instanceof SyntaxError ? 'invalid JSON' : errorMessage(e) });
      }
    });
  });

  return {
    close() {
      off();
      clearInterval(heartbeat);
      for (const c of conns) c.socket.close(1001, 'server shutting down');
      conns.clear();
    },
  };
}
