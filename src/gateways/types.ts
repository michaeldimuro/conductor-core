import { z } from 'zod';
import type { Logger } from '../shared/util.js';
import type { GatewayKind } from '../db/schema/reach.js';

/** A one-tap action rendered as a platform button (or as a reply-command hint where buttons do not exist). */
export interface OutboundButton {
  label: string;
  /** `approval:approve:<id>` | `approval:deny:<id>` | `review:accepted:<issueId>` | `review:rejected:<issueId>` */
  action: string;
}

export interface OutboundMessage {
  text: string;
  buttons?: OutboundButton[];
  /** Email subject; ignored elsewhere. */
  subject?: string;
}

/** Result of a button press / decision command, handed back to the adapter for the platform-specific acknowledgement. */
export interface ActionOutcome {
  text: string;
  /** The item can no longer be acted on: remove / annotate the buttons. */
  final: boolean;
  /** This press actually changed state (false for "already decided", "not found", refusals). */
  changed: boolean;
}

/** What every platform emits into the shared router. All fields are untrusted input. */
export interface InboundMessage {
  chatId: string;
  userId: string;
  text: string;
  /**
   * True when the chat has (or may have) more members than the sender: a
   * group, channel or server. Decisions (approve / deny / review) from a group
   * need the acting user to be individually authorised. Absent → the router
   * assumes a group unless `chatId === userId`.
   */
  isGroup?: boolean;
  /** Present for button presses: the action string carried by the button. */
  action?: string;
  /** Platform acknowledgement for a button press (toast, message edit). Absent → the router replies with a message. */
  respond?: (outcome: ActionOutcome) => Promise<void>;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export interface WebhookResponse {
  status: number;
  body?: unknown;
  contentType?: string;
}

export type WebhookRoute = 'events' | 'interactions';

/** One messaging platform. Adapters only translate; authorization and commands live in the router. */
export interface GatewayAdapter {
  readonly kind: GatewayKind;
  /** Platform message length limit; the shared delivery helper chunks to it. */
  readonly maxLength: number;
  /** Whether `OutboundMessage.buttons` render as real one-tap buttons. */
  readonly buttons: boolean;
  /** Never answer strangers (email backscatter, texting unknown phone numbers). */
  readonly quietRefusals?: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, message: OutboundMessage): Promise<void>;
  /** Signature-verified inbound webhook (Slack Events/interactivity, Discord interactions). */
  handleWebhook?(route: WebhookRoute, req: WebhookRequest): Promise<WebhookResponse>;
}

/** What the manager hands an adapter. Credentials live only in memory, never in config/state/logs. */
export interface AdapterContext {
  gatewayId: string;
  name: string;
  /** Fresh, validated config from the gateway row. */
  config(): GatewayConfig;
  /** Resolved secrets by name (`token`, `signingSecret`, `appToken`, `smtpPassword`, `imapPassword`). */
  credentials: Readonly<Record<string, string>>;
  /** Hand an inbound message to the router. Resolves when it has been fully handled. */
  emit(message: InboundMessage): Promise<void>;
  /** Small persisted adapter state (poll offsets) under `config.state`. */
  getState(key: string): unknown;
  setState(key: string, value: unknown): void;
  /** Report a runtime failure (sets status=error + lastError) or recovery (null). */
  health(error: string | null): void;
  now(): number;
  log: Logger;
}

export type AdapterFactory = (ctx: AdapterContext) => GatewayAdapter;

const idList = z.array(z.union([z.string(), z.number()]).transform((v) => String(v).trim())).max(500);

/** Non-secret gateway config. Unknown keys are preserved (platform-specific sections are validated by each adapter). */
export const gatewayConfigSchema = z.looseObject({
  allowedChatIds: idList.default([]),
  allowedUserIds: idList.default([]),
  /**
   * Users who may approve / deny / review from a GROUP chat in addition to
   * `allowedUserIds`. Filled when the owner redeems a pairing code from a
   * group; being a member of a paired group is not enough to decide.
   */
  approverUserIds: idList.default([]),
  /** Notification kinds to deliver (approval, review, digest, budget, takeover, …). Absent = all. */
  notify: z.array(z.string().max(64)).max(50).optional(),
  /** Where notifications go. Absent = every allow-listed chat. */
  notifyChatIds: idList.optional(),
  apiBaseUrl: z.string().url().optional(),
  pairingCodeHash: z.string().optional(),
  pairingExpiresAt: z.number().optional(),
  pairingAttempts: z.number().optional(),
  /** Extra secret-store refs by credential name, e.g. { signingSecret: 'slack-signing', appToken: 'slack-app' }. */
  secretRefs: z.record(z.string(), z.string()).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
});
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

/** Keys the gateway context itself rewrites at runtime; changing them never restarts an adapter. */
export const VOLATILE_CONFIG_KEYS = [
  'state', 'pairingCodeHash', 'pairingExpiresAt', 'pairingAttempts', 'allowedChatIds', 'allowedUserIds', 'approverUserIds', 'notify', 'notifyChatIds',
] as const;

export function parseGatewayConfig(raw: unknown): GatewayConfig {
  const parsed = gatewayConfigSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // A malformed allow-list must fail closed: nobody is allowed.
  const loose = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { ...loose, allowedChatIds: [], allowedUserIds: [], approverUserIds: [], notify: undefined, notifyChatIds: undefined, apiBaseUrl: undefined, pairingCodeHash: undefined, pairingExpiresAt: undefined, pairingAttempts: undefined, secretRefs: undefined, state: undefined };
}
