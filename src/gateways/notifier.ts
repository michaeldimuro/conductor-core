import type { Services } from '../daemon/container.js';
import type { Gateway } from '../contracts/rows.js';
import type { DomainEvents } from '../shared/events.js';
import { errorMessage } from '../shared/errors.js';
import { redact } from '../shared/util.js';
import { parseAction } from './actions.js';
import type { GatewayStore } from './store.js';
import { parseGatewayConfig, type GatewayAdapter, type OutboundButton, type OutboundMessage } from './types.js';
import { deliver } from './util.js';

type Notification = DomainEvents['notification'];

function safeLink(link: string | undefined): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Reply-command fallback for platforms without buttons (email, iMessage). */
function commandHints(buttons: OutboundButton[]): string[] {
  const hints = new Set<string>();
  for (const b of buttons) {
    const action = parseAction(b.action);
    if (action?.type === 'approval') hints.add(`Reply "/approve ${action.id}" to approve, or "/deny ${action.id} [note]" to deny.`);
    if (action?.type === 'review') hints.add(`Reply "/accept ${action.id}" to accept, or "/reject ${action.id} [note]" to send it back.`);
  }
  return [...hints];
}

/** Render a `notification` bus event for one platform. */
export function composeNotification(n: Notification, opts: { buttons: boolean; orgLabel: string | null }): OutboundMessage {
  const title = redact(n.title).trim();
  const heading = opts.orgLabel && !title.includes(opts.orgLabel) ? `[${opts.orgLabel}] ${title}` : title;
  const parts = [heading];
  const body = redact(n.body ?? '').trim();
  if (body) parts.push(body);
  // The takeover share link is the payload itself; it is delivered verbatim and never logged.
  const link = safeLink(n.link);
  if (link) parts.push(link);

  // Only actions the router can execute become buttons.
  const buttons = (n.actions ?? [])
    .filter((a) => parseAction(a.action) !== null)
    .slice(0, 5)
    .map((a) => ({ label: String(a.label).slice(0, 40), action: a.action }));
  if (buttons.length > 0 && !opts.buttons) parts.push(commandHints(buttons).join('\n'));

  return { text: parts.join('\n\n'), subject: heading, buttons: buttons.length > 0 && opts.buttons ? buttons : undefined };
}

export interface NotifierDeps {
  services: Services;
  store: GatewayStore;
  running(): Array<{ gatewayId: string; adapter: GatewayAdapter }>;
}

/** Fans `notification` events out to every running gateway that serves the org. */
export class Notifier {
  private off: (() => void) | null = null;
  private pending = new Set<Promise<void>>();

  constructor(private readonly d: NotifierDeps) {}

  start(): void {
    this.off = this.d.services.kernel.bus.on('notification', (n) => {
      const p = this.dispatch(n).catch((err) => {
        this.d.services.kernel.log.warn({ err: errorMessage(err) }, 'gateway notification dispatch failed');
      });
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    });
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  /** Resolves when every in-flight delivery has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private serves(gateway: Gateway, n: Notification): boolean {
    if (gateway.status === 'disabled') return false;
    if (gateway.orgId === null) return true;
    return n.orgId !== null && gateway.orgId === n.orgId;
  }

  async dispatch(n: Notification): Promise<void> {
    const { kernel, org } = this.d.services;
    const orgs = org.listOrgs();
    await Promise.all(this.d.running().map(async ({ gatewayId, adapter }) => {
      const gateway = this.d.store.get(gatewayId);
      if (!gateway || !this.serves(gateway, n)) return;
      const config = parseGatewayConfig(gateway.config);
      if (config.notify && !config.notify.includes(n.kind)) return;
      const targets = [...new Set(config.notifyChatIds ?? config.allowedChatIds)];
      if (targets.length === 0) return;

      // An owner-level gateway mixes orgs in one chat: say which one is speaking.
      const orgLabel = gateway.orgId === null && n.orgId !== null && orgs.length > 1
        ? orgs.find((o) => o.id === n.orgId)?.name ?? null
        : null;
      const message = composeNotification(n, { buttons: adapter.buttons, orgLabel });
      for (const chatId of targets) {
        try {
          await deliver(adapter, chatId, message);
        } catch (err) {
          kernel.log.warn({ gatewayId, kind: n.kind, err: errorMessage(err) }, 'gateway notification delivery failed');
        }
      }
    }));
  }
}
