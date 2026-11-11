import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Memory } from '../contracts/rows.js';
import type { RecallBundle, ScoredMemory } from '../contracts/services.js';
import type { Actor } from '../contracts/types.js';
import { memories } from '../db/schema/index.js';
import { invalid } from '../shared/errors.js';
import { estimateTokens } from '../shared/util.js';
import { byScore, PROFILE_TOKEN_BUDGET } from './ranking.js';
import type { MemoryStore } from './store.js';
import { ftsQuery, mentionsEntity } from './text.js';

const MAX_DOC_CHARS = 200_000;
const RECALL_LIMIT = 12;

/** Cut text to a token budget on a line boundary, saying so when it was cut. */
export function fitTokens(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;
  const marker = '\n[…truncated to fit the standing-memory budget]';
  const maxChars = Math.max(0, budget * 4 - marker.length);
  let cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf('\n');
  if (nl > maxChars * 0.6) cut = cut.slice(0, nl);
  return `${cut.trimEnd()}${marker}`.slice(0, budget * 4);
}

export function roleCard(agent: Pick<Agent, 'name' | 'role' | 'goal' | 'backstory'>): string {
  return [`# ${agent.name}`, `Role: ${agent.role}`, agent.goal ? `Goal: ${agent.goal}` : '', agent.backstory ? `Backstory: ${agent.backstory}` : '']
    .filter(Boolean)
    .join('\n');
}

/** Always-on memory (profile + owner model), typed recall and session search. */
export class Recall {
  constructor(
    private readonly kernel: Kernel,
    private readonly store: MemoryStore,
  ) {}

  /* ───────────── MEMORY.md / USER.md ───────────── */

  private readDoc(file: string): string {
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  private writeDoc(file: string, content: string): void {
    if (typeof content !== 'string') throw invalid('document content must be a string');
    if (content.length > MAX_DOC_CHARS) throw invalid(`document too large (${content.length} chars, max ${MAX_DOC_CHARS})`);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, file);
  }

  private agentFile(orgId: string, agentId: string): { file: string; agent: Agent } {
    const org = this.store.org(orgId);
    const agent = this.store.agent(orgId, agentId);
    return { file: this.kernel.paths.agentMemoryFile(org.slug, agent.slug), agent };
  }

  getProfileDoc(orgId: string, agentId: string): string {
    return this.readDoc(this.agentFile(orgId, agentId).file);
  }

  setProfileDoc(orgId: string, agentId: string, content: string, actor: Actor): void {
    const { file } = this.agentFile(orgId, agentId);
    this.writeDoc(file, content);
    this.kernel.audit.record({ orgId, actor, action: 'memory.updated', entityKind: 'profile_doc', entityId: agentId, data: { tokens: estimateTokens(content) } });
  }

  getOwnerModel(orgId: string): string {
    return this.readDoc(this.kernel.paths.ownerModelFile(this.store.org(orgId).slug));
  }

  setOwnerModel(orgId: string, content: string, actor: Actor): void {
    this.writeDoc(this.kernel.paths.ownerModelFile(this.store.org(orgId).slug), content);
    this.kernel.audit.record({ orgId, actor, action: 'memory.updated', entityKind: 'owner_model', entityId: orgId, data: { tokens: estimateTokens(content) } });
  }

  private standing(orgId: string, kind: 'profile' | 'owner_model', scope: Memory['scope'], scopeId: string): Memory[] {
    return this.kernel.db
      .select()
      .from(memories)
      .where(and(eq(memories.orgId, orgId), eq(memories.kind, kind), eq(memories.scope, scope), eq(memories.scopeId, scopeId), eq(memories.status, 'active')))
      .all()
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || b.createdAt - a.createdAt);
  }

  /** Role card + MEMORY.md + `profile` memories, within the 2k-token budget. The card is never cut. */
  profile(orgId: string, agentId: string): string {
    const { file, agent } = this.agentFile(orgId, agentId);
    const card = fitTokens(roleCard(agent), PROFILE_TOKEN_BUDGET);
    const rules = this.standing(orgId, 'profile', 'agent', agentId).map((m) => `- ${m.content}`);
    const doc = [this.readDoc(file).trim(), rules.length > 0 ? rules.join('\n') : ''].filter(Boolean).join('\n');
    if (!doc) return card;
    const header = '\n\n## Standing rules (MEMORY.md)\n';
    const remaining = PROFILE_TOKEN_BUDGET - estimateTokens(card) - estimateTokens(header);
    const body = fitTokens(doc, remaining);
    return body ? `${card}${header}${body}` : card;
  }

  /** USER.md + `owner_model` memories at org scope, capped at the same budget. */
  ownerModel(orgId: string): string {
    const facts = this.standing(orgId, 'owner_model', 'org', orgId).map((m) => `- ${m.content}`);
    return fitTokens([this.getOwnerModel(orgId).trim(), facts.join('\n')].filter(Boolean).join('\n'), PROFILE_TOKEN_BUDGET);
  }

  /* ───────────── recall ───────────── */

  async recall(orgId: string, agentId: string, task: { title: string; body: string; taskType?: string | null }): Promise<RecallBundle> {
    const text = `${task.title}\n${task.body}`.trim() || task.taskType || 'task';
    const { where } = this.store.visibility(orgId, agentId);

    // Lessons for this task type: high priority, always ranked first.
    const lessons = task.taskType
      ? await this.store.search(orgId, { agentId, text, kinds: ['lesson'], taskType: task.taskType, limit: 5 }, { noFloor: true, noBump: true })
      : [];

    // Semantic memory by entity mention in the task text.
    const entities = this.kernel.db
      .selectDistinct({ entity: memories.entity })
      .from(memories)
      .where(and(eq(memories.orgId, orgId), eq(memories.kind, 'semantic'), eq(memories.status, 'active'), isNotNull(memories.entity), where))
      .all()
      .map((r) => r.entity)
      .filter((e): e is string => e !== null && mentionsEntity(text, e));
    const byEntity: ScoredMemory[] = [];
    for (const entity of entities.slice(0, 8)) {
      byEntity.push(...(await this.store.search(orgId, { agentId, text, kinds: ['semantic'], entity, limit: 3 }, { noFloor: true, noBump: true })));
    }

    // Procedural by task similarity, episodic by similarity + recency, plus related lessons/facts.
    const general = await this.store.search(orgId, { agentId, text, kinds: ['procedural', 'semantic', 'episodic', 'lesson'], limit: RECALL_LIMIT }, { noBump: true });

    const seen = new Set<string>();
    const take = (list: ScoredMemory[]): ScoredMemory[] =>
      list.filter((s) => {
        if (seen.has(s.memory.id)) return false;
        seen.add(s.memory.id);
        return true;
      });
    const first = take([...lessons].sort(byScore));
    const rest = take([...byEntity, ...general].sort(byScore));
    const picked = [...first, ...rest].slice(0, RECALL_LIMIT);
    this.store.bump(picked.map((s) => s.memory));

    return { profile: this.profile(orgId, agentId), ownerModel: this.ownerModel(orgId), memories: picked };
  }

  /* ───────────── session search ───────────── */

  searchSessions(orgId: string, agentId: string | null, text: string, limit = 10): Array<{ runId: string; issueId: string | null; summary: string; createdAt: number }> {
    this.store.org(orgId);
    if (agentId !== null) this.store.agent(orgId, agentId);
    const match = ftsQuery(typeof text === 'string' ? text : '');
    if (!match) return [];
    const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 10;
    return this.store.index.sessionHits(orgId, agentId, match, n);
  }

  /** Active memories of the given kinds in one scope (consolidation input). */
  inScope(orgId: string, scope: Memory['scope'], scopeId: string, kinds: Memory['kind'][]): Memory[] {
    return this.kernel.db
      .select()
      .from(memories)
      .where(and(eq(memories.orgId, orgId), eq(memories.scope, scope), eq(memories.scopeId, scopeId), eq(memories.status, 'active'), inArray(memories.kind, kinds)))
      .all();
  }
}
