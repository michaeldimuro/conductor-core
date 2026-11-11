import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { errorText } from './api.js';
import { live } from './live.js';
import { toast } from './toast.js';

/**
 * A small keyed cache with stale-while-revalidate reads. Queries name the bus
 * event prefixes that make them stale (`events`), so the WebSocket keeps every
 * mounted view current without polling.
 */
export interface QueryState<T> {
  data: T | undefined;
  error: unknown;
  /** A fetch is in flight (first load or refresh). */
  fetching: boolean;
}

interface Entry {
  state: QueryState<unknown>;
  fn: (() => Promise<unknown>) | null;
  listeners: Set<() => void>;
  events: readonly string[];
  orgId: string | null;
  seq: number;
  /** When data last arrived; mounts within FRESH_MS reuse it without refetching. */
  at: number;
  timer: number | undefined;
}

const FRESH_MS = 4000;
const EMPTY: QueryState<unknown> = { data: undefined, error: undefined, fetching: false };
const cache = new Map<string, Entry>();

function entryOf(key: string): Entry {
  let e = cache.get(key);
  if (!e) {
    e = { state: EMPTY, fn: null, listeners: new Set(), events: [], orgId: null, seq: 0, at: 0, timer: undefined };
    cache.set(key, e);
  }
  return e;
}

function publish(e: Entry, patch: Partial<QueryState<unknown>>): void {
  e.state = { ...e.state, ...patch };
  for (const fn of e.listeners) fn();
}

function run(e: Entry): void {
  if (!e.fn) return;
  const seq = ++e.seq;
  publish(e, { fetching: true });
  e.fn().then(
    (data) => {
      if (seq !== e.seq) return;
      e.at = Date.now();
      publish(e, { data, error: undefined, fetching: false });
    },
    (error: unknown) => {
      if (seq === e.seq) publish(e, { error, fetching: false });
    },
  );
}

/** Refetch every mounted query whose key starts with one of the prefixes; drop unmounted ones. */
export function invalidate(...prefixes: string[]): void {
  for (const [key, e] of cache) {
    if (!prefixes.some((p) => key.startsWith(p))) continue;
    if (e.listeners.size > 0) run(e);
    else cache.delete(key);
  }
}

/** Optimistic write into the cache. Returns a function that restores the previous value. */
export function setQueryData<T>(key: string, update: (prev: T | undefined) => T | undefined): () => void {
  const e = entryOf(key);
  const prev = e.state.data;
  e.seq++; // an in-flight response must not overwrite the optimistic value
  publish(e, { data: update(prev as T | undefined), fetching: false });
  return () => publish(e, { data: prev });
}

live.on((msg) => {
  const orgId = (msg.payload as { orgId?: string | null }).orgId;
  for (const e of cache.values()) {
    if (e.listeners.size === 0 || !e.events.some((p) => msg.name.startsWith(p))) continue;
    if (typeof orgId === 'string' && e.orgId && e.orgId !== orgId) continue;
    window.clearTimeout(e.timer);
    e.timer = window.setTimeout(() => run(e), 180);
  }
});
live.onReconnect(() => invalidate(''));

export interface QueryOptions {
  /** Bus event name prefixes that invalidate this query, e.g. `['issue.', 'comment.']`. */
  events?: readonly string[];
  /** Only react to events of this org id. */
  orgId?: string | null;
  /** Additionally refetch on this interval (ms), for values the bus does not announce. */
  pollMs?: number;
}

export interface QueryResult<T> extends QueryState<T> {
  /** True until the first result (data or error) arrives. */
  loading: boolean;
  reload: () => void;
}

export function useQuery<T>(key: string | null, fn: () => Promise<T>, opts: QueryOptions = {}): QueryResult<T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const subscribe = useCallback((notify: () => void) => {
    if (key === null) return () => {};
    const e = entryOf(key);
    e.listeners.add(notify);
    return () => {
      e.listeners.delete(notify);
    };
  }, [key]);
  const state = useSyncExternalStore(subscribe, () => (key === null ? EMPTY : entryOf(key).state)) as QueryState<T>;

  const eventsKey = (opts.events ?? []).join(',');
  useEffect(() => {
    if (key === null) return;
    const e = entryOf(key);
    e.fn = () => fnRef.current();
    e.events = eventsKey ? eventsKey.split(',') : [];
    e.orgId = opts.orgId ?? null;
    if (!e.state.fetching && Date.now() - e.at > FRESH_MS) run(e);
    if (!opts.pollMs) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') run(e);
    }, opts.pollMs);
    return () => window.clearInterval(t);
  }, [key, eventsKey, opts.orgId, opts.pollMs]);

  const reload = useCallback(() => {
    if (key !== null) run(entryOf(key));
  }, [key]);
  return { ...state, loading: key !== null && state.data === undefined && state.error === undefined, reload };
}

export interface Action<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>;
  busy: boolean;
  error: unknown;
  clear: () => void;
}

/**
 * A mutation with busy/error state. On success it refetches the named cache
 * prefixes and optionally announces the result; failures are announced and
 * kept in `error` for inline display.
 */
export function useAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: { invalidate?: string[]; success?: string | ((r: R) => string); quiet?: boolean } = {},
): Action<A, R> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const ref = useRef({ fn, opts });
  ref.current = { fn, opts };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const runAction = useCallback(async (...args: A): Promise<R | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await ref.current.fn(...args);
      const o = ref.current.opts;
      if (o.invalidate?.length) invalidate(...o.invalidate);
      if (o.success) toast(typeof o.success === 'function' ? o.success(result) : o.success, 'ok');
      return result;
    } catch (e) {
      if (mounted.current) setError(e);
      if (!ref.current.opts.quiet) toast(errorText(e), 'error');
      return undefined;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  const clear = useCallback(() => setError(undefined), []);
  return { run: runAction, busy, error, clear };
}
