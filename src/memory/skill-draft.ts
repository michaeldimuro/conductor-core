import { z } from 'zod';
import type { Kernel, UtilityModel } from '../contracts/kernel.js';
import type { SkillService } from '../contracts/services.js';
import { errorMessage } from '../shared/errors.js';
import { slugify } from '../shared/ids.js';
import { heuristicSkillDraft, type SkillDraft } from './heuristics.js';
import { fitTranscript, renderSteps, tag, type TranscriptStep } from './transcript.js';

export type SkillDeps = Pick<SkillService, 'manage' | 'list'>;

const draftSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().min(1).max(400),
  body: z.string().min(20).max(20_000),
});

export interface DraftRequest {
  orgId: string;
  agentId: string;
  /** Fixed skill name (slug); the model may not rename it. */
  name: string;
  title: string;
  taskType?: string | null;
  trigger: string;
  steps: TranscriptStep[];
  notes?: string[];
  runId?: string;
  issueId?: string | null;
}

export function skillExists(skills: SkillDeps, orgId: string, agentId: string, name: string): boolean {
  return skills.list({ orgId, scope: 'agent', scopeId: agentId }).some((s) => s.name === name);
}

/** Draft a SKILL.md with the utility model (purpose `extract`), falling back to a distilled-steps body. */
export async function draftSkill(kernel: Kernel, utility: UtilityModel, req: DraftRequest): Promise<SkillDraft> {
  const fallback = heuristicSkillDraft({ title: req.title, taskType: req.taskType, trigger: req.trigger, steps: req.steps, notes: req.notes });
  try {
    const res = await utility.complete({
      orgId: req.orgId,
      purpose: 'extract',
      json: true,
      system:
        'You write reusable agent skills (SKILL.md bodies) from a transcript of work that succeeded. Keep only the steps that worked, ' +
        'in order, generalised beyond this one task; list pitfalls that were hit; end with how to verify the result. Never include secrets or credentials.',
      prompt: [
        tag('task', 'skill_draft'),
        tag('meta', JSON.stringify({ title: req.title, taskType: req.taskType ?? null, trigger: req.trigger, notes: req.notes ?? [] })),
        tag('transcript', fitTranscript(renderSteps(req.steps))),
        'Answer as JSON: {"description":"<one line: what the skill does and when to use it>","body":"<markdown instructions>"}',
      ].join('\n\n'),
    });
    const parsed = draftSchema.safeParse(res.json);
    if (parsed.success) return { name: req.name, description: parsed.data.description, body: parsed.data.body };
  } catch (e) {
    kernel.log.warn({ err: errorMessage(e) }, 'skill draft model call failed; using distilled steps');
  }
  return { ...fallback, name: req.name };
}

/** Open a skill DRAFT in the agent's own scope. Returns false when it already exists or the skills context refuses. */
export async function openSkillDraft(kernel: Kernel, utility: UtilityModel, skills: SkillDeps, req: DraftRequest): Promise<boolean> {
  const name = slugify(req.name);
  if (skillExists(skills, req.orgId, req.agentId, name)) return false;
  const draft = await draftSkill(kernel, utility, { ...req, name });
  try {
    await skills.manage(
      { orgId: req.orgId, agentId: req.agentId, runId: req.runId, issueId: req.issueId ?? null },
      { action: 'create', name, description: draft.description, body: draft.body, reason: `learning loop: ${req.trigger}` },
    );
    return true;
  } catch (e) {
    kernel.log.warn({ orgId: req.orgId, agentId: req.agentId, name, err: errorMessage(e) }, 'could not open skill draft');
    return false;
  }
}
