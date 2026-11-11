import { useSyncExternalStore } from 'react';
import { wsUrl } from './api.js';
import type { WsClientMessage, WsEventMessage, WsServerMessage } from './api.js';

export type LiveState = 'idle' | 'connecting' | 'open' | 'reconnecting';
type EventListener = (msg: WsEventMessage) => void;

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 15_000;
const PING_MS = 25_000;

/**
 * One WebSocket to `/api/v1/ws` for the whole app: subscribes to every org
 * (the approvals inbox is cross-org), re-subscribes run streams after a
 * reconnect, and backs off exponentially with jitter while the daemon is away.
 */
class LiveBus {
  private socket: WebSocket | null = null;
  private wanted = false;
  private backoff = MIN_BACKOFF;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private state: LiveState = 'idle';
  private readonly listeners = new Set<EventListener>();
  private readonly stateListeners = new Set<() => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly runs = new Map<string, number>();
  private everOpened = false;

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.connect();
  }

  stop(): void {
    this.wanted = false;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    this.socket?.close(1000);
    this.socket = null;
    this.everOpened = false;
    this.setState('idle');
  }

  getState = (): LiveState => this.state;
  subscribeState = (fn: () => void): (() => void) => {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  };

  on(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called after the socket comes back, so stale views can refetch what they missed. */
  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }

  /** Per-step `run.event`s are only delivered for runs subscribed here. */
  watchRun(runId: string): () => void {
    const n = this.runs.get(runId) ?? 0;
    this.runs.set(runId, n + 1);
    if (n === 0) this.send({ type: 'subscribe', runId });
    return () => {
      const left = (this.runs.get(runId) ?? 1) - 1;
      if (left > 0) return void this.runs.set(runId, left);
      this.runs.delete(runId);
      this.send({ type: 'unsubscribe', runId });
    };
  }

  private setState(s: LiveState): void {
    if (this.state === s) return;
    this.state = s;
    for (const fn of this.stateListeners) fn();
  }

  private send(msg: WsClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private connect(): void {
    if (!this.wanted) return;
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');
    const socket = new WebSocket(wsUrl('/api/v1/ws'));
    this.socket = socket;
    socket.onopen = () => {
      const wasOpenBefore = this.everOpened;
      this.everOpened = true;
      this.backoff = MIN_BACKOFF;
      this.setState('open');
      this.send({ type: 'subscribe' });
      for (const runId of this.runs.keys()) this.send({ type: 'subscribe', runId });
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), PING_MS);
      if (wasOpenBefore) for (const fn of this.reconnectListeners) fn();
    };
    socket.onmessage = (ev) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as WsServerMessage;
      } catch {
        return;
      }
      if (msg.type !== 'event') return;
      for (const fn of this.listeners) fn(msg);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      window.clearInterval(this.pingTimer);
      if (!this.wanted) return;
      this.setState('reconnecting');
      const delay = this.backoff * (0.7 + Math.random() * 0.6);
      this.backoff = Math.min(MAX_BACKOFF, this.backoff * 2);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
    socket.onerror = () => socket.close();
  }
}

export const live = new LiveBus();

export function useLiveState(): LiveState {
  return useSyncExternalStore(live.subscribeState, live.getState);
}
