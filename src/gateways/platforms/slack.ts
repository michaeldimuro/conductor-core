import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { errorMessage } from '../../shared/errors.js';
import { safeEqual } from '../../shared/util.js';
import type { AdapterContext, GatewayAdapter, OutboundButton, OutboundMessage, WebhookRequest, WebhookResponse, WebhookRoute } from '../types.js';
import { SeenSet, asRecord, asString, httpJson, trimBaseUrl } from '../util.js';
import { startSocketMode } from './slack-socket.js';

const slackConfig = z.looseObject({ apiBaseUrl: z.string().url().optional() });

const SIGNATURE_TOLERANCE_S = 5 * 60;

function header(req: WebhookRequest, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

/** Slack request signing, v0: HMAC-SHA256 over `v0:<timestamp>:<raw body>`, 5-minute replay window, constant-time compare. */
export function verifySlackSignature(signingSecret: string, req: WebhookRequest, nowMs: number): boolean {
  const timestamp = header(req, 'x-slack-request-timestamp');
  const signature = header(req, 'x-slack-signature');
  if (!signingSecret || !/^\d{1,12}$/.test(timestamp) || !signature) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(req.rawBody).digest('hex')}`;
  return safeEqual(expected, signature);
}

function unescapeSlack(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Slack's documented escaping for the `text` field: makes `<!channel>`-style control sequences inert. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buttonStyle(action: string): 'primary' | 'danger' | undefined {
  if (/:(approve|accepted):/.test(action)) return 'primary';
  if (/:(deny|rejected):/.test(action)) return 'danger';
  return undefined;
}

function section(text: string): Record<string, unknown> {
  return { type: 'section', text: { type: 'plain_text', text: text.slice(0, 3000), emoji: true } };
}

function actionsBlock(buttons: OutboundButton[]): Record<string, unknown> {
  return {
    type: 'actions',
    elements: buttons.map((b, i) => {
      const style = buttonStyle(b.action);
      return {
        type: 'button', action_id: `conductor_${i}`, value: b.action,
        text: { type: 'plain_text', text: b.label.slice(0, 75) },
        ...(style ? { style } : {}),
      };
    }),
  };
}

/**
 * Slack: Web API out (chat.postMessage / chat.update with Block Kit buttons);
 * in via the Events API + interactivity webhooks (signature-verified), or
 * Socket Mode when an app-level token is configured.
 */
export function createSlackAdapter(ctx: AdapterContext): GatewayAdapter {
  const abort = new AbortController();
  const seen = new SeenSet();
  let base = 'https://slack.com/api';
  let botUserId: string | null = null;

  async function api(method: string, body: Record<string, unknown>, token = ctx.credentials.token): Promise<Record<string, unknown>> {
    if (!token) throw new Error('slack bot token is not configured (authRef)');
    const { status, json } = await httpJson(`${base}/${method}`, { body, headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
    const res = asRecord(json);
    if (res.ok !== true) throw new Error(`slack ${method} failed: ${asString(res.error) ?? `HTTP ${status}`}`);
    return res;
  }

  const fail = (what: string) => (err: unknown) => ctx.log.warn({ gatewayId: ctx.gatewayId, err: errorMessage(err) }, `slack ${what} handling failed`);

  /** Slack conversation ids: `D…` is a 1:1 direct message; channels (`C…`) and group DMs (`G…`) are shared. */
  const isDirectMessage = (channelId: string): boolean => channelId.startsWith('D');

  function onEvent(payload: unknown): void {
    const envelope = asRecord(payload);
    if (envelope.type !== 'event_callback') return;
    const event = asRecord(envelope.event);
    if (event.type !== 'message' && event.type !== 'app_mention') return;
    // Ignore bots (including ourselves), edits, joins and other subtypes.
    if (event.bot_id || event.subtype) return;
    const chatId = asString(event.channel);
    const userId = asString(event.user);
    const rawText = asString(event.text);
    if (!chatId || !userId || rawText === null || userId === botUserId) return;
    // Slack retries deliveries, and a mention arrives as both `message` and `app_mention`.
    if (!seen.add(`${chatId}:${asString(event.ts) ?? asString(envelope.event_id) ?? ''}`)) return;
    const text = unescapeSlack(rawText.replace(/^(\s*<@[A-Z0-9]+>\s*)+/, ''));
    const isGroup = asString(event.channel_type) !== null ? event.channel_type !== 'im' : !isDirectMessage(chatId);
    void ctx.emit({ chatId, userId, text, isGroup }).catch(fail('event'));
  }

  function onInteractive(payload: unknown): void {
    const p = asRecord(payload);
    if (p.type !== 'block_actions') return;
    const action = asRecord(Array.isArray(p.actions) ? p.actions[0] : null);
    const container = asRecord(p.container);
    const message = asRecord(p.message);
    const chatId = asString(asRecord(p.channel).id) ?? asString(container.channel_id);
    const userId = asString(asRecord(p.user).id);
    const value = asString(action.value);
    const ts = asString(message.ts) ?? asString(container.message_ts);
    // Slack hands the original text back already escaped.
    const original = unescapeSlack(asString(message.text) ?? '');
    if (!chatId || !userId || value === null) return;
    void ctx.emit({
      chatId, userId, text: '', action: value, isGroup: !isDirectMessage(chatId),
      respond: async (outcome) => {
        if (outcome.final && ts) {
          // Replace the buttons with the verdict so the message cannot be pressed again.
          await api('chat.update', {
            channel: chatId, ts,
            text: escapeSlack(`${original}\n\n${outcome.text}`.trim()),
            blocks: [
              ...(original ? [section(original)] : []),
              { type: 'context', elements: [{ type: 'plain_text', text: outcome.text.slice(0, 2000) }] },
            ],
          });
        } else {
          await api('chat.postEphemeral', { channel: chatId, user: userId, text: escapeSlack(outcome.text) });
        }
      },
    }).catch(fail('interaction'));
  }

  function onSlashCommand(payload: unknown): void {
    const p = asRecord(payload);
    const command = asString(p.command);
    const chatId = asString(p.channel_id);
    const userId = asString(p.user_id);
    if (!command || !chatId || !userId || !/^\/[a-z_]{1,32}$/i.test(command)) return;
    void ctx.emit({ chatId, userId, text: `${command} ${asString(p.text) ?? ''}`.trim(), isGroup: !isDirectMessage(chatId) }).catch(fail('slash command'));
  }

  async function handleWebhook(route: WebhookRoute, req: WebhookRequest): Promise<WebhookResponse> {
    const signingSecret = ctx.credentials.signingSecret;
    if (!signingSecret || !verifySlackSignature(signingSecret, req, ctx.now())) return { status: 401, body: { error: 'invalid_signature' } };

    const raw = req.rawBody.toString('utf8');
    if (route === 'events') {
      let body: Record<string, unknown>;
      try {
        body = asRecord(JSON.parse(raw));
      } catch {
        return { status: 400, body: { error: 'invalid_json' } };
      }
      if (body.type === 'url_verification') return { status: 200, body: { challenge: asString(body.challenge) ?? '' } };
      // Acknowledge within Slack's 3-second budget; the work continues in the background.
      onEvent(body);
      return { status: 200, body: { ok: true } };
    }

    const form = new URLSearchParams(raw);
    const payload = form.get('payload');
    if (payload !== null) {
      try {
        onInteractive(JSON.parse(payload));
      } catch {
        return { status: 400, body: { error: 'invalid_payload' } };
      }
      return { status: 200, body: '', contentType: 'text/plain' };
    }
    if (form.get('command')) {
      onSlashCommand(Object.fromEntries(form));
      return { status: 200, body: '', contentType: 'text/plain' };
    }
    return { status: 400, body: { error: 'unsupported_payload' } };
  }

  return {
    kind: 'slack',
    maxLength: 3000,
    buttons: true,
    handleWebhook,

    async start() {
      const cfg = slackConfig.parse(ctx.config());
      base = trimBaseUrl(cfg.apiBaseUrl ?? base);
      const { signingSecret, appToken } = ctx.credentials;
      if (!signingSecret && !appToken) throw new Error('slack needs a signing secret (Events API) or an app-level token (Socket Mode)');
      const auth = await api('auth.test', {});
      botUserId = asString(auth.user_id);
      if (appToken) {
        await startSocketMode({
          open: async () => asString((await api('apps.connections.open', {}, appToken)).url) ?? '',
          onEnvelope: (type, payload) => {
            if (type === 'events_api') onEvent(payload);
            else if (type === 'interactive') onInteractive(payload);
            else if (type === 'slash_commands') onSlashCommand(payload);
          },
          health: ctx.health,
          signal: abort.signal,
        });
      }
    },

    async stop() {
      abort.abort();
    },

    async send(chatId: string, message: OutboundMessage) {
      const body: Record<string, unknown> = { channel: chatId, text: escapeSlack(message.text), unfurl_links: false, unfurl_media: false };
      if (message.buttons?.length) body.blocks = [section(message.text), actionsBlock(message.buttons)];
      await api('chat.postMessage', body);
    },
  };
}
