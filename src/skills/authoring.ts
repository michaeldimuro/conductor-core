import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { SCOPES, SKILL_STATUSES } from '../db/schema/index.js';
import type { SkillManageInput, SkillService } from '../contracts/services.js';
import type { Skill } from '../contracts/rows.js';
import type { Actor } from '../contracts/types.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import {
  MAX_BODY_CHARS, MAX_DESCRIPTION_LEN, SKILL_FILE, assertDescription, assertFiles, assertSkillName, copySkillDir, readSkillMd, renderSkillMd, writeSkillFiles,
} from './format.js';
import { agentWriteStatus, humanWriteStatus } from './writer.js';
import type { SkillCtx } from './store.js';

const manageSchema = z.object({
  action: z.enum(['create', 'patch', 'deprecate']),
  name: z.string(),
  description: z.string().max(MAX_DESCRIPTION_LEN).optional(),
  body: z.string().max(MAX_BODY_CHARS).optional(),
  find: z.string().min(1).max(MAX_BODY_CHARS).optional(),
  replace: z.string().max(MAX_BODY_CHARS).optional(),
  files: z.record(z.string(), z.string()).optional(),
  reason: z.string().max(1000).optional(),
}).strict();

const upsertSchema = z.object({
  scope: z.enum(SCOPES),
  scopeId: z.string().min(1).nullable(),
  name: z.string(),
  description: z.string().max(MAX_DESCRIPTION_LEN),
  body: z.string().max(MAX_BODY_CHARS),
  files: z.record(z.string(), z.string()).optional(),
  status: z.enum(SKILL_STATUSES).optional(),
});

const importSchema = z.object({
  sourceDir: z.string().min(1),
  scope: z.enum(SCOPES),
  scopeId: z.string().min(1).nullable(),
  source: z.string().max(500).optional(),
});

const IMPORT_LIMITS = { maxFiles: 500, maxBytes: 20 * 1024 * 1024 };

export function parseInput<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid(`invalid ${what}: ${r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
  return r.data;
}

function requireBody(body: string | undefined): string {
  if (!body || body.trim().length === 0) throw invalid('skill body (instructions) is required');
  return body;
}

/** Apply a `find` → `replace` patch; the anchor must match exactly once. */
function replaceOnce(body: string, find: string, replace: string): string {
  const first = body.indexOf(find);
  if (first === -1) throw invalid('patch `find` text was not found in the skill body');
  if (body.indexOf(find, first + find.length) !== -1) throw invalid('patch `find` text is ambiguous: it occurs more than once');
  return body.slice(0, first) + replace + body.slice(first + find.length);
}

/** The built-in `skill_manage` tool: always the calling agent's OWN scope. */
export async function manage(ctx: SkillCtx, caller: Parameters<SkillService['manage']>[0], raw: SkillManageInput): Promise<Skill> {
  const input = parseInput(manageSchema, raw, 'skill_manage input');
  const name = assertSkillName(input.name);
  const files = assertFiles(input.files);
  const agent = ctx.deps.org.getAgent(caller.orgId, caller.agentId);
  const actor: Actor = { kind: 'agent', id: agent.id, runId: caller.runId };
  const target = ctx.store.target(caller.orgId, 'agent', agent.id, name);

  return ctx.git.exclusive(async () => {
    const existing = ctx.store.findInScope('agent', agent.id, name);

    if (input.action === 'create') {
      if (existing) throw conflict(`skill "${name}" already exists in your scope (use patch)`);
      const description = assertDescription(input.description);
      const md = renderSkillMd({ name, description, body: requireBody(input.body) });
      return ctx.writer.commit({
        existing: null,
        target,
        mutate: (dir) => writeSkillFiles(dir, md, files),
        actor,
        runId: caller.runId,
        issueId: caller.issueId,
        change: 'create',
        message: input.reason ?? `create skill ${name}`,
        decideStatus: agentWriteStatus,
        create: { createdRunId: caller.runId ?? null, originIssueId: caller.issueId ?? null },
      });
    }

    if (!existing || existing.orgId !== caller.orgId) throw notFound('skill', name);

    if (input.action === 'deprecate') {
      if (existing.status === 'quarantined') throw forbidden('a quarantined skill can only be changed by a human');
      return ctx.writer.changeStatus(existing, 'deprecated', actor, input.reason ?? 'deprecated by its author');
    }

    const hasPatch = input.body !== undefined || input.find !== undefined || input.description !== undefined || Object.keys(files).length > 0;
    if (!hasPatch) throw invalid('patch needs a body, a find/replace pair, a description or files');
    if (input.body !== undefined && input.find !== undefined) throw invalid('patch takes either a full body or find/replace, not both');
    if (input.find !== undefined && input.replace === undefined) throw invalid('patch `find` requires `replace`');
    const current = readSkillMd(existing.path);
    let body = current.body;
    if (input.body !== undefined) body = requireBody(input.body);
    else if (input.find !== undefined) body = requireBody(replaceOnce(current.body, input.find, input.replace ?? ''));
    const description = input.description !== undefined ? assertDescription(input.description) : assertDescription(current.description ?? existing.description);
    const md = renderSkillMd({ name, description, body, frontMatter: current.frontMatter });
    return ctx.writer.commit({
      existing,
      target,
      mutate: (dir) => writeSkillFiles(dir, md, files),
      actor,
      runId: caller.runId,
      issueId: caller.issueId,
      change: 'patch',
      message: input.reason ?? `patch skill ${name}`,
      decideStatus: agentWriteStatus,
      // A patch to a skill that is live goes through the eval gate first.
      holdLive: true,
      extraAudit: { patch: input.body !== undefined ? 'body' : input.find !== undefined ? 'find_replace' : 'meta' },
    });
  });
}

/** Human/owner authoring into any scope (agents only where the PRD lets them edit, and never straight to active). */
export async function upsert(ctx: SkillCtx, orgId: string | null, raw: Parameters<SkillService['upsert']>[1], actor: Actor): Promise<Skill> {
  const input = parseInput(upsertSchema, raw, 'skill');
  const files = assertFiles(input.files);
  const description = assertDescription(input.description);
  const body = requireBody(input.body);
  const target = ctx.store.target(orgId, input.scope, input.scopeId, input.name);
  ctx.store.assertCanEdit(target, actor);
  const byAgent = actor.kind === 'agent';

  return ctx.git.exclusive(async () => {
    const existing = ctx.store.findInScope(target.scope, target.scopeId, target.name);
    const frontMatter = existing && existsSync(existing.path) ? safeFrontMatter(existing.path) : undefined;
    const md = renderSkillMd({ name: target.name, description, body, frontMatter });
    return ctx.writer.commit({
      existing,
      target,
      mutate: (dir) => writeSkillFiles(dir, md, files),
      actor,
      change: existing ? 'edit' : 'create',
      message: `${existing ? 'edit' : 'create'} skill ${target.name}`,
      decideStatus: byAgent ? agentWriteStatus : humanWriteStatus(input.status),
      holdLive: byAgent,
    });
  });
}

function safeFrontMatter(dir: string): Record<string, unknown> | undefined {
  try {
    return readSkillMd(dir).frontMatter;
  } catch {
    return undefined;
  }
}

/** Import a third-party skill folder: copied as-is, pinned by hash, starts as draft (quarantined when the scan blocks). */
export async function importSkill(ctx: SkillCtx, orgId: string | null, raw: Parameters<SkillService['importSkill']>[1], actor: Actor): Promise<Skill> {
  const input = parseInput(importSchema, raw, 'skill import');
  if (!isAbsolute(input.sourceDir)) throw invalid('sourceDir must be an absolute path');
  const sourceDir = resolve(input.sourceDir);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) throw invalid('sourceDir is not a directory');
  if (!existsSync(resolve(sourceDir, SKILL_FILE))) throw invalid(`sourceDir has no ${SKILL_FILE}`);
  const parsed = readSkillMd(sourceDir);
  const name = assertSkillName(parsed.name);
  assertDescription(parsed.description);
  const target = ctx.store.target(orgId, input.scope, input.scopeId, name);
  ctx.store.assertCanEdit(target, actor);

  return ctx.git.exclusive(async () => {
    if (ctx.store.findInScope(target.scope, target.scopeId, target.name)) throw conflict(`skill "${name}" already exists in that scope`);
    return ctx.writer.commit({
      existing: null,
      target,
      mutate: (dir) => copySkillDir(sourceDir, dir, IMPORT_LIMITS),
      actor,
      change: 'import',
      message: `import skill ${name} from ${input.source ?? sourceDir}`,
      decideStatus: agentWriteStatus,
      create: { source: input.source ?? sourceDir, pin: true },
      extraAudit: { source: input.source ?? sourceDir },
    });
  });
}
