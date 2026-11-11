import { readFileSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { z } from 'zod';
import type { SkillManageInput } from '../contracts/services.js';
import { jsonResult, textResult, type BuiltinToolProvider, type ToolCallContext, type ToolDef, type ToolResult } from '../contracts/tools.js';
import { invalid, notFound } from '../shared/errors.js';
import { resolveInside } from '../shared/paths.js';
import { MAX_BODY_CHARS, MAX_DESCRIPTION_LEN, MAX_FILE_BYTES, MAX_NAME_LEN, listSkillFiles, oneLine, readSkillMd } from './format.js';
import { manage, parseInput } from './authoring.js';
import { effectiveByName, effectiveSkills } from './resolve.js';
import type { SkillCtx } from './store.js';

export const SKILLS_PROVIDER_ID = 'conductor-skills';
const MAX_TRACKED_RUNS = 2000;

const NAME_SCHEMA = { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$', maxLength: MAX_NAME_LEN, description: 'Skill name (lowercase letters, digits and hyphens).' };

const TOOLS: ToolDef[] = [
  {
    name: 'list_skills',
    description: 'List the skills available to you (name and one-line description only). Call load_skill to read the instructions of one that applies to your task.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
  },
  {
    name: 'load_skill',
    description: 'Load the full instructions (SKILL.md body) and the file list of one of your skills. Do this only when the skill applies to the task at hand.',
    inputSchema: { type: 'object', properties: { name: NAME_SCHEMA }, required: ['name'], additionalProperties: false },
    risk: 'read',
  },
  {
    name: 'read_skill_file',
    description: 'Read a supporting file (scripts/, references/, assets/) of one of your skills, by the relative path shown in load_skill.',
    inputSchema: {
      type: 'object',
      properties: { name: NAME_SCHEMA, path: { type: 'string', minLength: 1, maxLength: 256, description: 'Path relative to the skill folder, e.g. "references/checklist.md".' } },
      required: ['name', 'path'],
      additionalProperties: false,
    },
    risk: 'read',
  },
  {
    name: 'skill_manage',
    description:
      'Create, patch or deprecate a skill in YOUR OWN scope. New skills start as draft and are evaluated against a baseline before they become active. ' +
      'Use create after solving a reusable procedure; patch (full body, or find → replace) when a skill underperforms; deprecate when it is obsolete. Never put credentials in a skill.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'patch', 'deprecate'] },
        name: NAME_SCHEMA,
        description: { type: 'string', maxLength: MAX_DESCRIPTION_LEN, description: 'One line: what the skill does and when to use it. Required for create.' },
        body: { type: 'string', maxLength: MAX_BODY_CHARS, description: 'SKILL.md instructions. Required for create; for patch it replaces the whole body.' },
        find: { type: 'string', minLength: 1, description: 'patch: exact text in the current body to replace (must occur exactly once).' },
        replace: { type: 'string', description: 'patch: replacement for `find`.' },
        files: {
          type: 'object',
          description: 'Extra files, relative path → content. Paths must be under scripts/, references/, assets/ or evals/. `evals/cases.json` may hold explicit eval cases: [{"prompt": "...", "criteria": "...", "expect": {"contains": [], "notContains": [], "regex": [], "files": []}}].',
          additionalProperties: { type: 'string', maxLength: MAX_FILE_BYTES },
        },
        reason: { type: 'string', maxLength: 1000, description: 'Why this change is being made (recorded in the skill history).' },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    risk: 'write',
  },
];

const nameArgs = z.object({ name: z.string().min(1).max(MAX_NAME_LEN) }).strict();
const fileArgs = z.object({ name: z.string().min(1).max(MAX_NAME_LEN), path: z.string().min(1).max(256) }).strict();

function markLoaded(ctx: SkillCtx, runId: string, skillId: string): void {
  let set = ctx.loaded.get(runId);
  if (!set) {
    if (ctx.loaded.size >= MAX_TRACKED_RUNS) {
      const oldest = ctx.loaded.keys().next();
      if (!oldest.done) ctx.loaded.delete(oldest.value);
    }
    set = new Set();
    ctx.loaded.set(runId, set);
  }
  set.add(skillId);
}

/** The `conductor-skills` builtin tool server. Identity always comes from the run token (ctx), never from args. */
export function createToolProvider(ctx: SkillCtx): BuiltinToolProvider {
  return {
    id: SKILLS_PROVIDER_ID,
    description: 'Your skills: list them, load one when it applies, and author or refine your own.',
    tools: () => TOOLS,
    async call(call: ToolCallContext, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
      switch (tool) {
        case 'list_skills': {
          const list = effectiveSkills(ctx, call.orgId, call.agentId).map((s) => ({ name: s.name, description: oneLine(s.description) }));
          return jsonResult({ skills: list });
        }
        case 'load_skill': {
          const { name } = parseInput(nameArgs, args, 'load_skill arguments');
          const skill = effectiveByName(ctx, call.orgId, call.agentId, name);
          const body = readSkillMd(skill.path).body;
          markLoaded(ctx, call.runId, skill.id);
          return jsonResult({ name: skill.name, description: skill.description, scope: skill.scope, version: skill.version, body, files: listSkillFiles(skill.path).filter((f) => f !== 'SKILL.md') });
        }
        case 'read_skill_file': {
          const { name, path } = parseInput(fileArgs, args, 'read_skill_file arguments');
          const skill = effectiveByName(ctx, call.orgId, call.agentId, name);
          if (path.includes('\0') || path.includes('\\')) throw invalid('unsafe skill file path');
          const abs = resolveInside(skill.path, path);
          const rel = relative(skill.path, abs).split(sep).join('/');
          // Only regular files that are part of the skill (symlinks and .git are never listed).
          if (!listSkillFiles(skill.path).includes(rel)) throw notFound('skill file', path.slice(0, 120));
          if (statSync(abs).size > MAX_FILE_BYTES * 4) throw invalid('skill file is too large to read through this tool');
          const bytes = readFileSync(abs);
          if (bytes.subarray(0, 8000).includes(0)) throw invalid('skill file is binary; reference it by path from a script instead');
          return textResult(bytes.toString('utf8'));
        }
        case 'skill_manage': {
          const skill = await manage(ctx, { orgId: call.orgId, agentId: call.agentId, runId: call.runId, issueId: call.issueId }, args as unknown as SkillManageInput);
          const candidate = ctx.store.pendingCandidate(skill);
          return jsonResult({
            id: skill.id,
            name: skill.name,
            scope: skill.scope,
            status: skill.status,
            version: skill.version,
            ...(candidate ? { candidateVersion: candidate.version } : {}),
            scanFindings: skill.scanFindings.filter((f) => f.severity !== 'info'),
            note:
              candidate
                ? `This skill is live, so your change was saved as candidate v${candidate.version}. v${skill.version} stays in use until the candidate passes its evaluation against it.`
                : skill.status === 'quarantined'
                ? 'The static scan blocked this skill. Remove the flagged content; a human must review it before it can be used.'
                : skill.status === 'draft'
                  ? 'Saved as draft. It becomes active once its evaluation beats the baseline.'
                  : undefined,
          });
        }
        default:
          throw notFound('tool', `${SKILLS_PROVIDER_ID}/${String(tool).slice(0, 60)}`);
      }
    },
  };
}
