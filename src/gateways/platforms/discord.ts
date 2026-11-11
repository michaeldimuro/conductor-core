import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { errorMessage } from '../../shared/errors.js';
import { COMMAND_NAMES } from '../commands.js';
import type { ActionOutcome, AdapterContext, GatewayAdapter, OutboundMessage, WebhookRequest, WebhookResponse, WebhookRoute } from '../types.js';
import { asRecord, asString, httpJson, trimBaseUrl } from '../util.js';

const discordConfig = z.looseObject({
  apiBaseUrl: z.string().url().optional(),
  /** The application's Ed25519 public key (hex) from the developer portal. Not a secret. */
  publicKey: z.string().regex(/^[0-9a-fA-F]{64}$/, 'publicKey must be 64 hex characters'),
  /** When set, the slash commands are registered on start. */
  applicationId: z.string().regex(/^\d{5,25}$/).optional(),
  /** How long a button press may hold the HTTP response before deferring (Discord allows 3 s). */
  interactionWaitMs: z.number().int().min(10).max(2_800).default(2_000),
});

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function header(req: WebhookRequest, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

/** Discord interaction signing: Ed25519 over `<timestamp><raw body>` with the application's public key. */
export function verifyDiscordSignature(publicKeyHex: string, req: WebhookRequest): boolean {
  const signature = header(req, 'x-signature-ed25519');
  const timestamp = header(req, 'x-signature-timestamp');
  if (!/^[0-9a-fA-F]{128}$/.test(signature) || !timestamp || timestamp.length > 64 || !/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(timestamp, 'utf8'), req.rawBody]), key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

const STRING_OPTION = 3;
const EPHEMERAL = 64;

/** Slash commands registered for the application: one per router command plus `/chat <text>`. */
function commandDefinitions(): Array<Record<string, unknown>> {
  const withArg: Record<string, [string, string, boolean]> = {
    org: ['slug', 'Organization slug', true],
    agent: ['slug', 'Agent slug', true],
    approve: ['id', 'Approval id', true],
    deny: ['id', 'Approval id, optionally followed by a note', true],
    accept: ['issue', 'Issue id or #number', true],
    reject: ['issue', 'Issue id or #number, optionally followed by a note', true],
    issue: ['title', 'Issue title', true],
    pair: ['code', 'Pairing code', true],
    stop: ['confirm', 'Type "confirm" to engage the kill switch', false],
  };
  const defs: Array<Record<string, unknown>> = COMMAND_NAMES.filter((n) => n !== 'start').map((name) => {
    const arg = withArg[name];
    return {
      name, type: 1, description: `Conductor: ${name}`,
      options: arg ? [{ type: STRING_OPTION, name: arg[0], description: arg[1], required: arg[2] }] : [],
    };
  });
  defs.push({
    name: 'chat', type: 1, description: 'Talk to the selected Conductor agent',
    options: [{ type: STRING_OPTION, name: 'text', description: 'Your message', required: true }],
  });
  return defs;
}

/** Text the router should see for an application-command interaction. */
function commandText(data: Record<string, unknown>): string | null {
  const name = asString(data.name)?.toLowerCase();
  if (!name || !/^[a-z_]{1,32}$/.test(name)) return null;
  const values = (Array.isArray(data.options) ? data.options : [])
    .map((o) => asString(asRecord(o).value))
    .filter((v): v is string => v !== null);
  // `/chat` (or any catch-all command) carries the message itself, which may be a `/command`.
  if (!(COMMAND_NAMES as readonly string[]).includes(name)) return values.join(' ').trim() || null;
  return `/${name} ${values.join(' ')}`.trim();
}

/**
 * Discord: REST out (messages with button components), interactions endpoint
 * in (Ed25519-verified; PING, slash commands and button presses).
 */
export function createDiscordAdapter(ctx: AdapterContext): GatewayAdapter {
  const abort = new AbortController();
  let base = 'https://discord.com/api/v10';
  let publicKey = '';
  let waitMs = 2_000;

  async function rest(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = ctx.credentials.token;
    if (!token) throw new Error('discord bot token is not configured (authRef)');
    const { status, json } = await httpJson(`${base}${path}`, { method, body, headers: { authorization: `Bot ${token}` }, signal: abort.signal });
    if (status < 200 || status >= 300) throw new Error(`discord ${method} ${path.split('/').slice(0, 2).join('/')} failed: ${asString(asRecord(json).message) ?? `HTTP ${status}`}`);
    return json;
  }

  function buttonRow(message: OutboundMessage): Array<Record<string, unknown>> | undefined {
    if (!message.buttons?.length) return undefined;
    return [{
      type: 1,
      components: message.buttons.map((b) => ({
        type: 2, label: b.label.slice(0, 80), custom_id: b.action.slice(0, 100),
        style: /:(approve|accepted):/.test(b.action) ? 3 : /:(deny|rejected):/.test(b.action) ? 4 : 2,
      })),
    }];
  }

  async function handleWebhook(route: WebhookRoute, req: WebhookRequest): Promise<WebhookResponse> {
    if (route !== 'interactions') return { status: 404, body: { error: 'not_found' } };
    if (!verifyDiscordSignature(publicKey, req)) return { status: 401, body: { error: 'invalid request signature' } };
    let body: Record<string, unknown>;
    try {
      body = asRecord(JSON.parse(req.rawBody.toString('utf8')));
    } catch {
      return { status: 400, body: { error: 'invalid_json' } };
    }

    if (body.type === 1) return { status: 200, body: { type: 1 } }; // PING → PONG

    const chatId = asString(body.channel_id) ?? asString(asRecord(body.channel).id);
    const userId = asString(asRecord(asRecord(body.member).user).id) ?? asString(asRecord(body.user).id);
    const data = asRecord(body.data);
    if (!chatId || !userId) return { status: 400, body: { error: 'missing channel or user' } };
    // Interactions from a server carry `guild_id`; a DM with the bot does not.
    const isGroup = body.guild_id !== undefined && body.guild_id !== null;

    if (body.type === 2) {
      const text = commandText(data);
      if (!text) return { status: 200, body: { type: 4, data: { content: 'Nothing to do.', flags: EPHEMERAL } } };
      // Acknowledge now; the router answers in the channel (an agent reply can take minutes).
      void ctx.emit({ chatId, userId, text, isGroup }).catch((err) => ctx.log.warn({ gatewayId: ctx.gatewayId, err: errorMessage(err) }, 'discord command handling failed'));
      return { status: 200, body: { type: 4, data: { content: 'On it.', flags: EPHEMERAL } } };
    }

    if (body.type === 3) {
      const action = asString(data.custom_id);
      const original = asRecord(body.message);
      const originalId = asString(original.id);
      const originalText = asString(original.content) ?? '';
      if (action === null) return { status: 400, body: { error: 'missing custom_id' } };
      const annotated = (o: ActionOutcome) => ({ content: `${originalText}\n\n${o.text}`.trim().slice(0, 2000), components: [], allowed_mentions: { parse: [] } });

      let deferred = false;
      const outcome = await new Promise<ActionOutcome | null>((resolve) => {
        const timer = setTimeout(() => {
          deferred = true;
          resolve(null);
        }, waitMs);
        void ctx.emit({
          chatId, userId, text: '', action, isGroup,
          respond: async (o) => {
            clearTimeout(timer);
            if (!deferred) return resolve(o);
            // Too slow for the HTTP response: annotate the message over REST instead.
            if (o.final && originalId) await rest('PATCH', `/channels/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(originalId)}`, annotated(o));
            else await rest('POST', `/channels/${encodeURIComponent(chatId)}/messages`, { content: o.text.slice(0, 2000), allowed_mentions: { parse: [] } });
          },
        }).catch(() => {}).finally(() => {
          clearTimeout(timer);
          resolve(null);
        });
      });
      if (!outcome) return { status: 200, body: { type: 6 } }; // deferred update
      // Decided → rewrite the message without its buttons; otherwise tell only the presser.
      if (outcome.final) return { status: 200, body: { type: 7, data: annotated(outcome) } };
      return { status: 200, body: { type: 4, data: { content: outcome.text.slice(0, 2000), flags: EPHEMERAL } } };
    }

    return { status: 400, body: { error: 'unsupported interaction type' } };
  }

  return {
    kind: 'discord',
    maxLength: 2000,
    buttons: true,
    handleWebhook,

    async start() {
      const cfg = discordConfig.parse(ctx.config());
      base = trimBaseUrl(cfg.apiBaseUrl ?? base);
      publicKey = cfg.publicKey;
      waitMs = cfg.interactionWaitMs;
      await rest('GET', '/users/@me');
      if (cfg.applicationId) await rest('PUT', `/applications/${cfg.applicationId}/commands`, commandDefinitions());
    },

    async stop() {
      abort.abort();
    },

    async send(chatId: string, message: OutboundMessage) {
      await rest('POST', `/channels/${encodeURIComponent(chatId)}/messages`, {
        content: message.text,
        components: buttonRow(message),
        // Agent-authored text must never ping @everyone or roles.
        allowed_mentions: { parse: [] },
      });
    },
  };
}
