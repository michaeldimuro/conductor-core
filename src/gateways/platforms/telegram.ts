import { z } from 'zod';
import { errorMessage } from '../../shared/errors.js';
import type { AdapterContext, GatewayAdapter, OutboundMessage } from '../types.js';
import { abortableSleep, asRecord, asString, httpJson, trimBaseUrl } from '../util.js';

const telegramConfig = z.looseObject({
  apiBaseUrl: z.string().url().optional(),
  /** Long-poll hold time in seconds (0 = short polling, used by tests). */
  pollTimeoutSec: z.number().int().min(0).max(50).default(25),
  /** Pause between empty short polls. */
  pollIdleMs: z.number().int().min(10).max(60_000).default(1_000),
});

/**
 * Telegram Bot API over long polling — no public URL needed.
 * getUpdates (offset persisted in the gateway row) → router; sendMessage with
 * inline keyboards for one-tap approve/deny; answerCallbackQuery +
 * editMessageReplyMarkup after a decision.
 */
export function createTelegramAdapter(ctx: AdapterContext): GatewayAdapter {
  const abort = new AbortController();
  let loop: Promise<void> | null = null;
  let base = 'https://api.telegram.org';
  let pollTimeoutSec = 25;
  let pollIdleMs = 1_000;

  async function call(method: string, body: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const token = ctx.credentials.token;
    if (!token) throw new Error('telegram bot token is not configured (authRef)');
    const { status, json } = await httpJson(`${base}/bot${token}/${method}`, { body, signal: opts.signal, timeoutMs: opts.timeoutMs });
    const res = asRecord(json);
    if (res.ok !== true) throw new Error(`telegram ${method} failed: ${asString(res.description) ?? `HTTP ${status}`}`);
    return res.result;
  }

  function dispatch(update: Record<string, unknown>): void {
    const message = asRecord(update.message);
    const callback = asRecord(update.callback_query);
    if (update.message) {
      const chatId = asString(asRecord(message.chat).id);
      const userId = asString(asRecord(message.from).id);
      const text = asString(message.text) ?? asString(message.caption);
      if (!chatId || !userId || !text) return;
      void ctx.emit({ chatId, userId, text }).catch((err) => ctx.log.warn({ gatewayId: ctx.gatewayId, err: errorMessage(err) }, 'telegram message handling failed'));
      return;
    }
    if (update.callback_query) {
      const callbackId = asString(callback.id);
      const original = asRecord(callback.message);
      const chatId = asString(asRecord(original.chat).id);
      const messageId = original.message_id;
      const userId = asString(asRecord(callback.from).id);
      const data = asString(callback.data);
      if (!callbackId || !chatId || !userId || data === null) return;
      void ctx.emit({
        chatId, userId, text: '', action: data,
        respond: async (outcome) => {
          await call('answerCallbackQuery', { callback_query_id: callbackId, text: outcome.text.slice(0, 200) });
          if (!outcome.final || typeof messageId !== 'number') return;
          // Decided: drop the buttons so the message cannot be pressed again…
          await call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
          // …and leave the verdict on the record under the original message.
          if (outcome.changed) {
            await call('sendMessage', { chat_id: chatId, text: outcome.text, reply_parameters: { message_id: messageId, allow_sending_without_reply: true } });
          }
        },
      }).catch((err) => ctx.log.warn({ gatewayId: ctx.gatewayId, err: errorMessage(err) }, 'telegram callback handling failed'));
    }
  }

  async function poll(): Promise<void> {
    const stored = ctx.getState('telegramOffset');
    let offset = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
    let backoff = 1_000;
    while (!abort.signal.aborted) {
      try {
        const result = await call(
          'getUpdates',
          { offset, timeout: pollTimeoutSec, allowed_updates: ['message', 'callback_query'] },
          { signal: abort.signal, timeoutMs: (pollTimeoutSec + 15) * 1_000 },
        );
        backoff = 1_000;
        ctx.health(null);
        const updates = Array.isArray(result) ? result : [];
        for (const raw of updates) {
          const update = asRecord(raw);
          if (typeof update.update_id === 'number') offset = Math.max(offset, update.update_id + 1);
          dispatch(update);
        }
        // Persist before the next poll: an update is handled at most once across restarts.
        if (updates.length > 0) ctx.setState('telegramOffset', offset);
        else if (pollTimeoutSec === 0) await abortableSleep(pollIdleMs, abort.signal);
      } catch (err) {
        if (abort.signal.aborted) return;
        ctx.health(errorMessage(err));
        await abortableSleep(backoff, abort.signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  return {
    kind: 'telegram',
    maxLength: 4096,
    buttons: true,

    async start() {
      const cfg = telegramConfig.parse(ctx.config());
      base = trimBaseUrl(cfg.apiBaseUrl ?? base);
      pollTimeoutSec = cfg.pollTimeoutSec;
      pollIdleMs = cfg.pollIdleMs;
      // Validates the token before we claim to be active.
      await call('getMe', {}, { timeoutMs: 15_000 });
      loop = poll();
    },

    async stop() {
      abort.abort();
      await loop?.catch(() => {});
    },

    async send(chatId: string, message: OutboundMessage) {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: message.text,
        link_preview_options: { is_disabled: true },
      };
      if (message.buttons?.length) {
        // callback_data is limited to 64 bytes; action strings are ≤ 47.
        body.reply_markup = { inline_keyboard: [message.buttons.map((b) => ({ text: b.label, callback_data: b.action }))] };
      }
      await call('sendMessage', body);
    },
  };
}
