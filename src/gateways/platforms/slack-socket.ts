import { errorMessage } from '../../shared/errors.js';
import { abortableSleep, asRecord, asString } from '../util.js';

export interface SocketModeOptions {
  /** `apps.connections.open` with the app-level token → a fresh single-use wss:// URL. */
  open(): Promise<string>;
  /** events_api | interactive | slash_commands envelopes, already acknowledged. */
  onEnvelope(type: string, payload: unknown): void;
  health(error: string | null): void;
  signal: AbortSignal;
}

/**
 * Slack Socket Mode over Node's global WebSocket: works with no public port.
 * Resolves once the first connection is open; reconnects with backoff afterwards.
 */
export async function startSocketMode(o: SocketModeOptions): Promise<void> {
  let socket: WebSocket | null = null;

  const connect = async (): Promise<void> => {
    const url = await o.open();
    if (!/^wss?:\/\//.test(url)) throw new Error('slack socket mode returned an invalid URL');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      let opened = false;
      ws.addEventListener('open', () => {
        opened = true;
        socket = ws;
        o.health(null);
        resolve();
      });
      ws.addEventListener('message', (event) => {
        let envelope: Record<string, unknown>;
        try {
          envelope = asRecord(JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)));
        } catch {
          return;
        }
        const type = asString(envelope.type) ?? '';
        const envelopeId = asString(envelope.envelope_id);
        // Every envelope must be acknowledged within 3 seconds or Slack redelivers it.
        if (envelopeId && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ envelope_id: envelopeId }));
        if (type === 'hello') return;
        if (type === 'disconnect') {
          ws.close();
          return;
        }
        try {
          o.onEnvelope(type, envelope.payload);
        } catch {
          /* handlers log their own failures */
        }
      });
      ws.addEventListener('error', () => {
        if (!opened) reject(new Error('slack socket mode connection failed'));
      });
      ws.addEventListener('close', () => {
        if (socket === ws) socket = null;
        if (!opened) {
          reject(new Error('slack socket mode connection closed before it opened'));
          return;
        }
        if (!o.signal.aborted) void reconnect();
      });
    });
  };

  const reconnect = async (): Promise<void> => {
    let backoff = 1_000;
    while (!o.signal.aborted) {
      await abortableSleep(backoff, o.signal);
      if (o.signal.aborted) return;
      try {
        await connect();
        return;
      } catch (err) {
        o.health(errorMessage(err));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  };

  o.signal.addEventListener('abort', () => socket?.close(), { once: true });
  await connect();
}
