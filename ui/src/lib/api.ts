import { ConductorApiError, ConductorClient } from '../../../src/api/client.js';

export type * from '../../../src/api/types.js';
export { ConductorApiError };

/**
 * Same-origin client. No token: the HttpOnly session cookie (or, on the
 * takeover page, the viewer cookie) authenticates every call.
 */
export const api = new ConductorClient({
  baseUrl: window.location.origin,
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
});

export function wsUrl(path: string): string {
  const u = new URL(path, window.location.origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

export function errorText(e: unknown): string {
  if (e instanceof ConductorApiError) return e.message;
  if (e instanceof TypeError) return 'Cannot reach the Conductor daemon. Check that it is running and this device is still connected.';
  return e instanceof Error ? e.message : String(e);
}

export const isUnauthorized = (e: unknown): boolean => e instanceof ConductorApiError && e.status === 401;
