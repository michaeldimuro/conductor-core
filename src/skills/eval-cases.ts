import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, eq, like } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { evalCases, issues } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Skill } from '../contracts/rows.js';
import type { Actor, EvalExpectations, SkillEvalCase } from '../contracts/types.js';
import { errorMessage, invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import type { SkillCtx } from './store.js';

/**
 * Explicit eval cases shipped with a skill: `evals/cases.json` (or `.yaml` / `.yml`) in the skill folder.
 * A list (or `{ cases: [...] }`) of `{ prompt, criteria?, expect?: { contains?, notContains?, regex?, files? } }`.
 */
export const EVAL_CASE_FILES = ['evals/cases.json', 'evals/cases.yaml', 'evals/cases.yml'] as const;
const MAX_FOLDER_CASES = 20;
/** Issue replays kept per skill (each case costs two sandbox runs per evaluation). */
const MAX_ISSUE_CASES = 3;

const strings = z.array(z.string().min(1).max(2000)).max(50);
export const expectSchema = z
  .object({ contains: strings.optional(), notContains: strings.optional(), regex: strings.optional(), files: strings.optional() })
  .strict();
const caseSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  criteria: z.string().max(4000).optional(),
  expect: expectSchema.optional(),
});
const fileSchema = z.union([z.array(caseSchema), z.object({ cases: z.array(caseSchema) }).transform((v) => v.cases)]);
export const addCaseSchema = caseSchema.extend({ issueId: z.string().min(1).nullable().optional() }).strict();

const hasExpectations = (e: EvalExpectations | undefined): e is EvalExpectations => !!e && Object.values(e).some((v) => Array.isArray(v) && v.length > 0);

/**
 * `eval_cases.success_criteria` is one text column: plain natural-language criteria, or — when the case
 * carries deterministic expectations — a JSON envelope `{"criteria": "...", "expect": {...}}`.
 */
export function encodeCriteria(criteria: string, expect?: EvalExpectations): string {
  return hasExpectations(expect) ? JSON.stringify({ criteria, expect }) : criteria;
}

export function decodeCriteria(stored: string): { criteria: string; expect: EvalExpectations } {
  if (stored.startsWith('{')) {
    try {
      const parsed = z.object({ criteria: z.string().catch(''), expect: expectSchema }).safeParse(JSON.parse(stored));
      if (parsed.success) return parsed.data;
    } catch {
      /* plain text that happens to start with a brace */
    }
  }
  return { criteria: stored, expect: {} };
}

const issueCaseId = (skillId: string, issueId: string): string => `${skillId}:issue:${issueId}`;
const folderCaseId = (skillId: string, n: number): string => `${skillId}:folder:${n}`;
const sourceOf = (id: string): SkillEvalCase['source'] => (id.includes(':issue:') ? 'issue' : id.includes(':folder:') ? 'folder' : 'manual');

/** Stored cases of a skill, oldest first (org-scoped like the skill itself). */
export function listEvalCases(kernel: Kernel, skill: Skill): SkillEvalCase[] {
  return kernel.db
    .select()
    .from(evalCases)
    .where(eq(evalCases.skillId, skill.id))
    .orderBy(asc(evalCases.createdAt), asc(evalCases.id))
    .all()
    .filter((c) => c.orgId === skill.orgId)
    .map((c) => ({ id: c.id, skillId: c.skillId, source: sourceOf(c.id), issueId: c.issueId, createdAt: c.createdAt, prompt: c.prompt, ...decodeCriteria(c.successCriteria) }));
}

/** Parse the skill folder's explicit cases. Invalid files are reported, never thrown (a bad case file must not block a write). */
export function readFolderCases(dir: string): { cases: Array<z.infer<typeof caseSchema>>; error?: string } {
  const file = EVAL_CASE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!file) return { cases: [] };
  try {
    const parsed = fileSchema.safeParse(parseYaml(readFileSync(file, 'utf8')));
    if (!parsed.success) return { cases: [], error: parsed.error.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ') };
    return { cases: parsed.data.slice(0, MAX_FOLDER_CASES) };
  } catch (e) {
    return { cases: [], error: errorMessage(e) };
  }
}

/**
 * Keep `eval_cases` in step with a skill after every write: the folder's explicit cases replace the
 * previous folder cases, and the issue the write came from (the originating issue on create, the
 * issue being worked on for a patch) is stored as a replay case.
 */
export function syncEvalCases(kernel: Kernel, skill: Skill, opts: { issueId?: string | null } = {}): void {
  const { db, clock, log } = kernel;
  const now = clock.now();
  const folder = readFolderCases(skill.path);
  if (folder.error) log.warn({ skillId: skill.id, err: folder.error }, 'skill eval case file is invalid; ignoring it');

  db.transaction((tx) => {
    if (!folder.error) {
      tx.delete(evalCases).where(and(eq(evalCases.skillId, skill.id), like(evalCases.id, `${skill.id}:folder:%`))).run();
      folder.cases.forEach((c, n) => {
        tx.insert(evalCases)
          .values({ id: folderCaseId(skill.id, n), orgId: skill.orgId, skillId: skill.id, issueId: null, prompt: c.prompt, successCriteria: encodeCriteria(c.criteria ?? '', c.expect), createdAt: now + n })
          .run();
      });
    }

    const issueId = opts.issueId ?? (skill.version === 1 ? skill.originIssueId : null);
    if (issueId && skill.orgId) {
      const issue = tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.orgId, skill.orgId))).get();
      if (issue) {
        const prompt = [issue.title, issue.body, issue.expectedOutput ? `Expected output: ${issue.expectedOutput}` : ''].filter((p) => p.trim().length > 0).join('\n\n');
        tx.insert(evalCases)
          .values({ id: issueCaseId(skill.id, issue.id), orgId: skill.orgId, skillId: skill.id, issueId: issue.id, prompt, successCriteria: issue.expectedOutput ?? '', createdAt: now })
          .onConflictDoNothing()
          .run();
        const replay = tx
          .select({ id: evalCases.id })
          .from(evalCases)
          .where(and(eq(evalCases.skillId, skill.id), like(evalCases.id, `${skill.id}:issue:%`)))
          .orderBy(asc(evalCases.createdAt), asc(evalCases.id))
          .all();
        // The originating issue (oldest) is always kept; beyond the cap the oldest later replays go.
        for (const old of replay.slice(1, Math.max(1, replay.length - (MAX_ISSUE_CASES - 1)))) tx.delete(evalCases).where(eq(evalCases.id, old.id)).run();
      }
    }
  });
}

export function evalCasesOf(ctx: SkillCtx, skillId: string): SkillEvalCase[] {
  return listEvalCases(ctx.kernel, ctx.store.get(skillId));
}

export function addEvalCase(ctx: SkillCtx, skillId: string, raw: unknown, actor: Actor): SkillEvalCase {
  const skill = ctx.store.get(skillId);
  ctx.store.assertCanEdit(skill, actor);
  const parsed = addCaseSchema.safeParse(raw);
  if (!parsed.success) throw invalid(`invalid eval case: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
  const input = parsed.data;
  for (const r of input.expect?.regex ?? []) compileRegex(r);
  if (input.issueId) {
    const issue = skill.orgId ? ctx.kernel.db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.orgId, skill.orgId))).get() : undefined;
    if (!issue) throw notFound('issue', input.issueId);
  }
  const id = newId('evalCase');
  ctx.kernel.db
    .insert(evalCases)
    .values({ id, orgId: skill.orgId, skillId, issueId: input.issueId ?? null, prompt: input.prompt, successCriteria: encodeCriteria(input.criteria ?? '', input.expect), createdAt: ctx.kernel.clock.now() })
    .run();
  ctx.kernel.audit.record({ orgId: skill.orgId, actor, action: 'skill.eval_case_added', entityKind: 'skill', entityId: skillId, data: { caseId: id, name: skill.name } });
  const created = listEvalCases(ctx.kernel, skill).find((c) => c.id === id);
  if (!created) throw notFound('eval case', id);
  return created;
}

export function removeEvalCase(ctx: SkillCtx, skillId: string, caseId: string, actor: Actor): void {
  const skill = ctx.store.get(skillId);
  ctx.store.assertCanEdit(skill, actor);
  if (!listEvalCases(ctx.kernel, skill).some((c) => c.id === caseId)) throw notFound('eval case', caseId);
  ctx.kernel.db.delete(evalCases).where(and(eq(evalCases.id, caseId), eq(evalCases.skillId, skillId))).run();
  ctx.kernel.audit.record({ orgId: skill.orgId, actor, action: 'skill.eval_case_removed', entityKind: 'skill', entityId: skillId, data: { caseId, name: skill.name } });
}

/** `/source/flags` or a bare source → RegExp. Throws a validation error on a bad pattern. */
export function compileRegex(pattern: string): RegExp {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  try {
    return m ? new RegExp(m[1] ?? '', m[2]) : new RegExp(pattern, 'i');
  } catch (e) {
    throw invalid(`invalid eval case regex ${pattern.slice(0, 80)}: ${errorMessage(e)}`);
  }
}
