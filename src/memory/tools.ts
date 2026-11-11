import { z } from 'zod';
import type { MemoryService } from '../contracts/services.js';
import { jsonResult, type BuiltinToolProvider, type ToolCallContext, type ToolDef, type ToolResult } from '../contracts/tools.js';
import { AUTONOMY, type Actor } from '../contracts/types.js';
import { MEMORY_KINDS } from '../db/schema/index.js';
import { forbidden, invalid } from '../shared/errors.js';
import type { MemoryStore } from './store.js';

const WRITABLE_KINDS = ['procedural', 'semantic', 'episodic', 'lesson', 'profile', 'owner_model'] as const;

const searchArgs = z.object({
  query: z.string().trim().min(1).max(4000),
  kinds: z.array(z.enum(MEMORY_KINDS)).max(6).optional(),
  entity: z.string().max(200).optional(),
  task_type: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(25).optional(),
}).strict();

const writeArgs = z.object({
  content: z.string().trim().min(1).max(4000),
  kind: z.enum(WRITABLE_KINDS),
  scope: z.enum(['agent', 'dept', 'org']).optional(),
  entity: z.string().max(200).optional(),
  task_type: z.string().max(120).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

const forgetArgs = z.object({ memory_id: z.string().min(1) }).strict();
const sessionArgs = z.object({ query: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(25).optional() }).strict();

const unitSchema = (description: string) => ({ type: 'number', minimum: 0, maximum: 1, description });

const TOOLS: ToolDef[] = [
  {
    name: 'memory_search',
    description:
      'Search long-term memory visible to you (your own, your department\'s and the organization\'s) with hybrid keyword + semantic ranking. ' +
      'Use before starting work to recall procedures, facts about an entity, past runs and lessons.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 4000, description: 'What you want to recall, in natural language.' },
        kinds: { type: 'array', maxItems: 6, items: { type: 'string', enum: [...MEMORY_KINDS] }, description: 'Restrict to these memory kinds.' },
        entity: { type: 'string', maxLength: 200, description: 'Only facts about this entity (customer, vendor, system, repo).' },
        task_type: { type: 'string', maxLength: 120, description: 'Only memories recorded for this task type.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 8 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_write',
    description:
      'Save something worth remembering for future runs. Kinds: procedural (small how-to), semantic (fact about an entity — set `entity`), ' +
      'lesson (mistake/correction — set `task_type`), episodic (what happened), profile (a standing rule for yourself), owner_model (owner preference; org scope). ' +
      'Writes go to your own scope by default. Department/org scope is stored directly only for autonomous agents; otherwise it lands in the owner\'s review queue. ' +
      'Never store secrets or credentials.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 4000, description: 'The memory, as one self-contained statement.' },
        kind: { type: 'string', enum: [...WRITABLE_KINDS] },
        scope: { type: 'string', enum: ['agent', 'dept', 'org'], default: 'agent', description: 'Who should see it: you, your department, or the whole organization.' },
        entity: { type: 'string', maxLength: 200, description: 'Entity the fact is about (semantic memories).' },
        task_type: { type: 'string', maxLength: 120, description: 'Task type this applies to (procedural / lesson).' },
        importance: unitSchema('How much this matters for doing the job right (default 0.5).'),
        confidence: unitSchema('How sure you are (default 0.7). Below 0.5 goes to the review queue.'),
      },
      required: ['content', 'kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_forget',
    description: 'Forget one of YOUR OWN memories (agent scope) that is wrong or obsolete. Department and organization memories can only be removed by the owner.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { memory_id: { type: 'string', minLength: 1, description: 'Id of the memory (from memory_search).' } },
      required: ['memory_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_search',
    description: 'Full-text search over summaries of your past runs. Use to find how a similar task went before.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000, description: 'Keywords to look for in past run summaries.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args);
  if (!r.success) throw invalid(`invalid arguments: ${r.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
  return r.data;
}

/** The builtin `conductor-memory` tool server. Identity always comes from ctx, never from args. */
export function createMemoryToolProvider(service: Pick<MemoryService, 'search' | 'searchSessions' | 'get' | 'forget'>, store: MemoryStore): BuiltinToolProvider {
  const call = async (ctx: ToolCallContext, tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const actor: Actor = { kind: 'agent', id: ctx.agentId, runId: ctx.runId };
    switch (tool) {
      case 'memory_search': {
        const a = parse(searchArgs, args);
        const hits = await service.search(ctx.orgId, { agentId: ctx.agentId, text: a.query, kinds: a.kinds, entity: a.entity, taskType: a.task_type, limit: a.limit ?? 8 });
        return jsonResult(
          hits.map((h) => ({
            id: h.memory.id, kind: h.memory.kind, scope: h.memory.scope, content: h.memory.content, entity: h.memory.entity, task_type: h.memory.taskType,
            confidence: h.memory.confidence, source_run_id: h.memory.sourceRunId, score: Number(h.score.toFixed(4)),
          })),
        );
      }
      case 'memory_write': {
        const a = parse(writeArgs, args);
        const scope = a.scope ?? (a.kind === 'owner_model' ? 'org' : 'agent');
        if (a.kind === 'owner_model' && scope !== 'org') throw invalid('owner_model memories are organization-scoped');
        if (a.kind === 'profile' && scope !== 'agent') throw invalid('profile memories are agent-scoped');
        const scopeId = scope === 'agent' ? ctx.agentId : scope === 'dept' ? ctx.deptId : ctx.orgId;
        // Wider-than-self writes need autonomy ≥ 2; below that the owner reviews them first.
        const forceReview = scope !== 'agent' && ctx.autonomyLevel < AUTONOMY.AUTONOMOUS;
        const m = await store.write(
          ctx.orgId,
          { scope, scopeId, kind: a.kind, content: a.content, entity: a.entity, taskType: a.task_type, importance: a.importance, confidence: a.confidence, sourceRunId: ctx.runId },
          actor,
          { forceReview },
        );
        return jsonResult({
          id: m.id,
          status: m.status,
          scope: m.scope,
          note: m.status === 'review' ? 'Queued for owner review; it will not be recalled until approved.' : 'Saved.',
        });
      }
      case 'memory_forget': {
        const a = parse(forgetArgs, args);
        const m = service.get(ctx.orgId, a.memory_id);
        if (m.scope !== 'agent' || m.scopeId !== ctx.agentId) throw forbidden('you can only forget memories in your own scope');
        service.forget(ctx.orgId, m.id, actor);
        return jsonResult({ id: m.id, status: 'forgotten' });
      }
      case 'session_search': {
        const a = parse(sessionArgs, args);
        return jsonResult(service.searchSessions(ctx.orgId, ctx.agentId, a.query, a.limit ?? 5));
      }
      default:
        throw invalid(`unknown tool: ${tool}`);
    }
  };

  return {
    id: 'conductor-memory',
    description: 'Long-term memory: search, write and forget typed memories; search past run summaries.',
    tools: () => TOOLS,
    call: (ctx, tool, args) => call(ctx, tool, args ?? {}),
  };
}
