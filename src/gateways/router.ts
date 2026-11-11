import type { Services } from '../daemon/container.js';
import type { Organization } from '../contracts/rows.js';
import { OWNER, SYSTEM } from '../contracts/types.js';
import { errorMessage, isConductorError } from '../shared/errors.js';
import { redact } from '../shared/util.js';
import { Decisions } from './actions.js';
import { Commands, parseCommand, type ChatContext } from './commands.js';
import type { GatewayStore } from './store.js';
import { parseGatewayConfig, type ActionOutcome, type GatewayAdapter, type GatewayConfig, type InboundMessage } from './types.js';
import { KeyedQueue, deliver } from './util.js';

const MAX_INBOUND_CHARS = 8_000;
const MAX_ID_CHARS = 256;
const REFUSAL_THROTTLE_MS = 60_000;
export const REFUSAL_TEXT = 'This chat is not authorized to talk to Conductor.';

export function isAllowed(config: GatewayConfig, chatId: string, userId: string): boolean {
  const chats = config.allowedChatIds.map((c) => c.toLowerCase());
  const users = config.allowedUserIds.map((u) => u.toLowerCase());
  // No allow-list at all → nobody (pairing is the only way in).
  if (chats.length === 0 && users.length === 0) return false;
  if (chats.length > 0 && !chats.includes(chatId.toLowerCase())) return false;
  if (users.length > 0 && !users.includes(userId.toLowerCase())) return false;
  return true;
}

export interface RouterDeps {
  services: Services;
  store: GatewayStore;
  digest(org: Organization): string;
}

/**
 * The one router every platform feeds. Authorization first, then strictly
 * parsed commands; free text only ever goes to `runtime.chat`.
 */
export class GatewayRouter {
  readonly decisions: Decisions;
  readonly commands: Commands;
  private readonly chatQueue = new KeyedQueue();
  private readonly lastRefusal = new Map<string, number>();

  constructor(private readonly d: RouterDeps) {
    this.decisions = new Decisions(d.services);
    this.commands = new Commands({ services: d.services, store: d.store, decisions: this.decisions, digest: d.digest });
  }

  /** Resolves once every queued chat turn has finished (shutdown, tests). */
  idle(): Promise<void> {
    return this.chatQueue.idle();
  }

  async handle(gatewayId: string, adapter: GatewayAdapter, message: InboundMessage): Promise<void> {
    const gateway = this.d.store.get(gatewayId);
    if (!gateway || gateway.status === 'disabled') return;
    const chatId = String(message.chatId ?? '').trim();
    const userId = String(message.userId ?? '').trim();
    if (!chatId || chatId.length > MAX_ID_CHARS || userId.length > MAX_ID_CHARS) return;
    const text = String(message.text ?? '').replaceAll('\u0000', '').slice(0, MAX_INBOUND_CHARS).trim();
    const log = this.d.services.kernel.log;

    const ctx: ChatContext = {
      gateway,
      config: parseGatewayConfig(gateway.config),
      adapter,
      chatId,
      userId,
      // Fail closed: an adapter that does not say is only a 1:1 chat when the chat IS the user.
      isGroup: message.isGroup ?? chatId.toLowerCase() !== userId.toLowerCase(),
      reply: async (replyText, buttons) => {
        try {
          await deliver(adapter, chatId, { text: replyText, buttons });
        } catch (err) {
          log.warn({ gatewayId, err: errorMessage(err) }, 'gateway reply failed');
        }
      },
    };

    if (!isAllowed(ctx.config, chatId, userId)) return this.unauthorized(ctx, message, text);

    if (message.action !== undefined) {
      const outcome = this.decisions.run(gateway, message.action, ctx);
      return this.acknowledge(ctx, message, outcome);
    }
    const command = parseCommand(text);
    if (command) return this.commands.run(ctx, command);
    if (text.startsWith('/')) return ctx.reply('Unknown command. Send /help for the list.');
    if (!text) return;
    return this.chatQueue.run(`${gatewayId}:${chatId}`, () => this.chatTurn(ctx, text));
  }

  private async acknowledge(ctx: ChatContext, message: InboundMessage, outcome: ActionOutcome): Promise<void> {
    if (!message.respond) return ctx.reply(outcome.text);
    try {
      await message.respond(outcome);
    } catch (err) {
      this.d.services.kernel.log.warn({ gatewayId: ctx.gateway.id, err: errorMessage(err) }, 'gateway action acknowledgement failed');
    }
  }

  /** Not on the allow-list: the only thing that works is redeeming an owner-minted pairing code. */
  private async unauthorized(ctx: ChatContext, message: InboundMessage, text: string): Promise<void> {
    const { kernel } = this.d.services;
    const command = message.action === undefined ? parseCommand(text) : null;
    if (command?.name === 'pair') {
      const result = this.d.store.redeemPairingCode(ctx.gateway.id, ctx.chatId, ctx.userId, command.args, ctx.isGroup);
      kernel.audit.record({
        orgId: ctx.gateway.orgId, actor: result === 'paired' ? OWNER : SYSTEM,
        action: result === 'paired' ? 'gateway.paired' : 'gateway.pairing_failed',
        entityKind: 'gateway', entityId: ctx.gateway.id,
        data: { gatewayKind: ctx.gateway.kind, chatId: ctx.chatId, userId: ctx.userId, isGroup: ctx.isGroup, result },
      });
      if (result === 'paired') return ctx.reply('Paired. This chat can now talk to Conductor — send /help to see what it can do.');
      if (!ctx.adapter.quietRefusals) await ctx.reply('That pairing code is not valid.');
      return;
    }

    kernel.audit.record({
      orgId: ctx.gateway.orgId, actor: SYSTEM, action: 'gateway.message_refused', entityKind: 'gateway', entityId: ctx.gateway.id,
      data: { gatewayKind: ctx.gateway.kind, chatId: ctx.chatId, userId: ctx.userId, wasAction: message.action !== undefined },
    });
    if (message.respond) {
      await this.acknowledge(ctx, message, { text: REFUSAL_TEXT, final: false, changed: false });
      return;
    }
    if (ctx.adapter.quietRefusals) return;
    // One refusal a minute per chat: never let strangers use the gateway as an amplifier.
    const key = `${ctx.gateway.id}:${ctx.chatId}`;
    const now = kernel.clock.now();
    const last = this.lastRefusal.get(key);
    if (last !== undefined && now - last < REFUSAL_THROTTLE_MS) return;
    if (this.lastRefusal.size > 5_000) this.lastRefusal.clear();
    this.lastRefusal.set(key, now);
    await ctx.reply(REFUSAL_TEXT);
  }

  /** Plain text → one chat turn with the selected agent, recorded on the per-chat conversation issue. */
  private async chatTurn(ctx: ChatContext, text: string): Promise<void> {
    const { services, store } = this.d;
    const { work, runtime, kernel } = services;
    try {
      const chat = store.getChat(ctx.gateway.id, ctx.chatId);
      const org = this.commands.currentOrg(ctx.gateway, chat);
      if (!org) return await ctx.reply('Choose an organization first: /orgs, then /org <slug>.');
      const agent = this.commands.currentAgent(org, chat);
      if (!agent) return await ctx.reply('Choose who you are talking to first: /agents, then /agent <slug>.');

      // The conversation thread: an unassigned backlog issue, so the heartbeat loop never picks it up.
      let issueId: string | null = null;
      if (chat?.issueId && chat.orgId === org.id && chat.agentId === agent.id) {
        const existing = work.findIssue(org.id, chat.issueId);
        if (existing && existing.status !== 'done' && existing.status !== 'cancelled') issueId = existing.id;
      }
      if (!issueId) {
        const issue = work.createIssue(org.id, {
          title: `Chat with ${agent.name} (${ctx.gateway.name})`,
          body: `Conversation with ${agent.name} over the ${ctx.gateway.kind} gateway "${ctx.gateway.name}".`,
          labels: ['chat'],
          status: 'backlog',
          assigneeAgentId: null,
        }, OWNER);
        issueId = issue.id;
      }
      store.saveChat(ctx.gateway.id, ctx.chatId, { orgId: org.id, agentId: agent.id, issueId });

      work.addComment(org.id, issueId, { body: text }, OWNER);
      let reply: string;
      let runId: string;
      try {
        ({ reply, runId } = await runtime.chat(org.id, agent.id, text, { issueId }));
      } catch (err) {
        const why = isConductorError(err) ? redact(err.message) : 'an internal error';
        if (!isConductorError(err)) kernel.log.error({ err: errorMessage(err), gatewayId: ctx.gateway.id }, 'gateway chat failed');
        return await ctx.reply(`${agent.name} could not reply: ${why}`);
      }
      const body = redact(reply.trim()) || '(no reply)';
      work.addComment(org.id, issueId, { body, runId }, { kind: 'agent', id: agent.id });
      await ctx.reply(body);
    } catch (err) {
      kernel.log.error({ err: errorMessage(err), gatewayId: ctx.gateway.id }, 'gateway chat turn failed');
      await ctx.reply(isConductorError(err) ? `Could not do that: ${redact(err.message)}` : 'Something went wrong handling that message.');
    }
  }
}
