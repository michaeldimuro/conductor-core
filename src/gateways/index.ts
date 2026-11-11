import type { FastifyPluginAsync } from 'fastify';
import type { Services } from '../daemon/container.js';
import type { Organization } from '../contracts/rows.js';
import type { GatewayKind } from '../db/schema/reach.js';
import { errorMessage } from '../shared/errors.js';
import { buildDigest } from '../runtime/system-jobs.js';
import { GatewayManager, type GatewayStatus } from './manager.js';
import { Notifier } from './notifier.js';
import { createDiscordAdapter } from './platforms/discord.js';
import { createEmailAdapter } from './platforms/email.js';
import { createIMessageAdapter } from './platforms/imessage.js';
import { createSlackAdapter } from './platforms/slack.js';
import { createTelegramAdapter } from './platforms/telegram.js';
import { GatewayRouter } from './router.js';
import { createGatewayRoutes } from './routes.js';
import { GatewayStore } from './store.js';
import type { AdapterFactory } from './types.js';

export { mintPairingCode } from './store.js';
export type { GatewayStatus } from './manager.js';
export type {
  ActionOutcome, AdapterContext, AdapterFactory, GatewayAdapter, GatewayConfig, InboundMessage, OutboundButton, OutboundMessage,
} from './types.js';

export const DEFAULT_ADAPTERS: Record<GatewayKind, AdapterFactory> = {
  telegram: createTelegramAdapter,
  slack: createSlackAdapter,
  discord: createDiscordAdapter,
  email: createEmailAdapter,
  imessage: createIMessageAdapter,
};

export interface GatewayOptions {
  /** Replace platform adapters (tests, plugins). */
  adapters?: Partial<Record<GatewayKind, AdapterFactory>>;
  /** How often the `gateways` table is re-read for config edits made through the API. 0 disables polling. */
  pollMs?: number;
  /** Override the on-demand digest text (`/digest`). */
  digest?: (org: Organization) => string;
}

export interface Gateways {
  /** Inbound webhook routes (Slack events/interactivity, Discord interactions). */
  routes: FastifyPluginAsync;
  stop(): Promise<void>;
  /** Re-read the `gateways` table and start/stop adapters to match. */
  reload(): Promise<void>;
  status(): GatewayStatus[];
  /** Mint a one-time pairing code for a gateway; the plain code is returned exactly once. */
  mintPairingCode(gatewayId: string, ttlMs?: number): string;
  /** Resolves when in-flight chat turns and notification deliveries have settled (tests). */
  idle(): Promise<void>;
}

/**
 * Messaging gateways (Hermes-style): Telegram, Slack, Discord, iMessage and
 * email in front of one shared router. Chat with any agent, get approvals
 * with one-tap approve/deny, the morning digest, budget alerts and takeover
 * links. A failing adapter is marked `error` and never takes the daemon down.
 */
export async function startGateways(services: Services, options: GatewayOptions = {}): Promise<Gateways> {
  const { kernel } = services;
  const store = new GatewayStore(kernel);
  const digest = options.digest ?? ((org: Organization) => buildDigest(kernel, services, org.id, org.name));
  const router = new GatewayRouter({ services, store, digest });
  const manager = new GatewayManager(services, store, router, { ...DEFAULT_ADAPTERS, ...options.adapters });
  const notifier = new Notifier({ services, store, running: () => manager.adapters() });

  await manager.reload(true);
  notifier.start();

  const pollMs = options.pollMs ?? 30_000;
  const timer = pollMs > 0
    ? setInterval(() => {
      void manager.reload(false).catch((err) => kernel.log.error({ err: errorMessage(err) }, 'gateway table poll failed'));
    }, pollMs)
    : null;
  timer?.unref();

  return {
    routes: createGatewayRoutes((id) => manager.lookup(id)),
    async stop() {
      if (timer) clearInterval(timer);
      notifier.stop();
      await manager.stop();
    },
    reload: () => manager.reload(true),
    status: () => manager.status(),
    mintPairingCode: (gatewayId, ttlMs) => store.mintPairingCode(gatewayId, ttlMs),
    async idle() {
      await notifier.idle();
      await router.idle();
    },
  };
}
