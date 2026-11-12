import { and, desc, eq, lt } from 'drizzle-orm';
import type { Kernel } from '../contracts/kernel.js';
import type { ChatMessage } from '../contracts/rows.js';
import { chatMessages } from '../db/schema/index.js';
import { newId } from '../shared/ids.js';
import { truncate } from '../shared/util.js';

/** How many earlier messages are replayed into the next chat turn, and how much of each. */
const CONTEXT_MESSAGES = 16;
const CONTEXT_CHARS_PER_MESSAGE = 2_000;

/** The durable operator ↔ agent conversation shown on the agent page. */
export class ChatHistory {
  constructor(private readonly k: Kernel) {}

  append(orgId: string, agentId: string, m: { role: 'user' | 'agent'; body: string; runId?: string | null; error?: string | null }): ChatMessage {
    const row: ChatMessage = {
      id: newId('chatMessage'), orgId, agentId, role: m.role, body: m.body, runId: m.runId ?? null, error: m.error ?? null, createdAt: this.k.clock.now(),
    };
    this.k.db.insert(chatMessages).values(row).run();
    return row;
  }

  /** Newest `limit` messages (optionally before a timestamp), returned oldest first. */
  list(orgId: string, agentId: string, opts: { limit?: number; before?: number } = {}): ChatMessage[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const where = [eq(chatMessages.orgId, orgId), eq(chatMessages.agentId, agentId)];
    if (opts.before != null) where.push(lt(chatMessages.createdAt, opts.before));
    return this.k.db.select().from(chatMessages).where(and(...where)).orderBy(desc(chatMessages.createdAt), desc(chatMessages.id)).limit(limit).all().reverse();
  }

  clear(orgId: string, agentId: string): void {
    this.k.db.delete(chatMessages).where(and(eq(chatMessages.orgId, orgId), eq(chatMessages.agentId, agentId))).run();
  }

  /**
   * The new message framed with the recent conversation, so the agent picks up
   * where it left off instead of starting from nothing every turn.
   */
  prompt(prior: ChatMessage[], message: string, agentName: string): string {
    const turns = prior.filter((m) => m.body.trim()).slice(-CONTEXT_MESSAGES);
    if (!turns.length) return message;
    const lines = turns.map((m) => `${m.role === 'user' ? 'Operator' : agentName}: ${truncate(m.body.trim(), CONTEXT_CHARS_PER_MESSAGE)}`);
    return [
      'You are continuing a direct chat with the operator. The conversation so far (oldest first):',
      '',
      ...lines,
      '',
      'Reply to the operator\'s new message below. Use the earlier turns as context; do not repeat them.',
      '',
      `Operator: ${message}`,
    ].join('\n');
  }
}
