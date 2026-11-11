import type { Logger } from '../shared/util.js';

/**
 * FR-1 timing budgets.
 *
 *  - After reboot + login the UI must be reachable in < 30 s.
 *  - A killed daemon must be back in < 15 s. launchd respawns a crashed job at
 *    once (or after `ThrottleInterval`, 10 s, when it died within 10 s of
 *    starting), so the daemon's own start must stay far below that.
 *  - A requested stop must not eat the restart budget either: graceful
 *    shutdown is bounded, and whatever is still in flight is parked in the
 *    journal and recovered by the next start.
 */
export const UI_REACHABLE_BUDGET_MS = 30_000;
export const RESTART_BUDGET_MS = 15_000;
/** Target for composing services + binding the API; exceeding it is logged as a warning. */
export const STARTUP_TARGET_MS = 5_000;
/** Hard ceiling for a graceful shutdown; after this the process exits regardless. */
export const SHUTDOWN_BUDGET_MS = 8_000;
/** Time gateways and the HTTP server get to close. */
export const SHUTDOWN_NETWORK_MS = 1_500;

const LOOPBACK_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

/** True when `host` only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_NAMES.has(h)) return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
  return h === '::1' || h === '0:0:0:0:0:0:0:1' || /^::ffff:127(\.\d{1,3}){3}$/.test(h);
}

/**
 * The API is designed for loopback + an authenticated tunnel. Binding it to
 * anything else exposes the control plane to the network: say so, loudly.
 * Returns true when a warning was logged.
 */
export function warnIfExposed(log: Pick<Logger, 'warn'>, host: string, port: number): boolean {
  if (isLoopbackHost(host)) return false;
  const everywhere = host === '0.0.0.0' || host === '::' || host === '';
  log.warn(
    { host, port, exposure: everywhere ? 'all-interfaces' : 'non-loopback' },
    `SECURITY WARNING: conductord is listening on ${host || '(all interfaces)'}:${port}, not on loopback. ` +
      'The control plane (agents, secrets by reference, approvals) is reachable from the network. ' +
      'Unset CONDUCTOR_HOST to bind 127.0.0.1 and use a tunnel (Tailscale / Cloudflare Tunnel) for remote access.',
  );
  return true;
}

export type PhaseOutcome = 'done' | 'failed' | 'timeout';

/**
 * Await `work` for at most `ms`. Never rejects: a failure or an overrun is
 * logged and reported, so one stuck component cannot hold up shutdown.
 */
export async function bounded(label: string, work: () => Promise<unknown>, ms: number, log: Pick<Logger, 'warn'>): Promise<PhaseOutcome> {
  if (!Number.isFinite(ms)) {
    try {
      await work();
      return 'done';
    } catch (err) {
      log.warn({ err, phase: label }, 'shutdown phase failed');
      return 'failed';
    }
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<PhaseOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, ms));
  });
  const run = (async (): Promise<PhaseOutcome> => {
    try {
      await work();
      return 'done';
    } catch (err) {
      log.warn({ err, phase: label }, 'shutdown phase failed');
      return 'failed';
    }
  })();
  const outcome = await Promise.race([run, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') log.warn({ phase: label, budgetMs: ms }, 'shutdown phase exceeded its budget; moving on (in-flight work is recovered on restart)');
  return outcome;
}
