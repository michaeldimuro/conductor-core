import type { Kernel } from '../contracts/kernel.js';
import type { EvalRunner, SkillService } from '../contracts/services.js';
import { SkillGit } from './git.js';
import { SkillStore, type SkillCtx, type SkillDeps } from './store.js';
import { SkillWriter } from './writer.js';
import { importSkill, manage, upsert } from './authoring.js';
import { activateLocked, diffVersions, readSkill, rollback, setStatus } from './lifecycle.js';
import { evaluate } from './evaluate.js';
import { loadBody, resolveForAgent } from './resolve.js';
import { autoPromoteToDept, onApprovalDecided, promote } from './promote.js';
import { recordUsage, retireStale } from './adapt.js';
import { createToolProvider } from './tools.js';

export type { SkillDeps } from './store.js';
export { scanFiles, scanSkillDir, hasBlockingFinding, type ScanFinding } from './scan.js';
export { parseSkillMd, renderSkillMd, hashSkillDir } from './format.js';
export { SKILLS_GITIGNORE } from './git.js';
export { SKILLS_PROVIDER_ID } from './tools.js';

export type SkillsContext = SkillService & {
  /** The runtime provides the sandboxed eval runner once it exists. */
  setEvalRunner(runner: EvalRunner): void;
  /** Skill ids the run loaded through `load_skill` (pass to `recordUsage`). */
  loadedSkills(runId: string): string[];
  /** Drop the loaded-skills entry of a run that will never report usage. */
  forgetRun(runId: string): void;
  /** Unsubscribe from the bus. */
  dispose(): void;
};

export function createSkillService(kernel: Kernel, deps: SkillDeps): SkillsContext {
  const git = new SkillGit(kernel.paths.skillsRepoRoot);
  const ctx: SkillCtx = {
    kernel,
    deps: { ...deps },
    store: new SkillStore(kernel, deps),
    git,
    writer: new SkillWriter(kernel, git),
    loaded: new Map(),
  };
  const tools = createToolProvider(ctx);
  const off = kernel.bus.on('approval.decided', (event) => onApprovalDecided(ctx, event));

  return {
    resolveForAgent: (orgId, agentId) => resolveForAgent(ctx, orgId, agentId),
    loadBody: (orgId, agentId, name) => loadBody(ctx, orgId, agentId, name),
    manage: (caller, input) => manage(ctx, caller, input),
    upsert: (orgId, input, actor) => upsert(ctx, orgId, input, actor),
    importSkill: (orgId, input, actor) => importSkill(ctx, orgId, input, actor),
    get: (skillId) => ctx.store.get(skillId),
    list: (filter) => ctx.store.list(filter ?? {}),
    read: (skillId) => readSkill(ctx, skillId),
    history: (skillId) => {
      ctx.store.get(skillId);
      return ctx.store.versions(skillId);
    },
    diff: (skillId, fromVersion, toVersion) => diffVersions(ctx, skillId, fromVersion, toVersion),
    rollback: (skillId, toVersion, actor) => rollback(ctx, skillId, toVersion, actor),
    evaluate: (skillId) => evaluate(ctx, skillId),
    async activate(skillId, actor, opts) {
      const before = ctx.store.get(skillId).status;
      const skill = await git.exclusive(() => activateLocked(ctx, skillId, actor, opts));
      if (before !== 'active' && skill.status === 'active') await autoPromoteToDept(ctx, skill);
      return skill;
    },
    promote: (skillId, toScope, actor) => promote(ctx, skillId, toScope, actor),
    setStatus: (skillId, status, actor) => setStatus(ctx, skillId, status, actor),
    recordUsage: (input) => recordUsage(ctx, input),
    retireStale: (now) => retireStale(ctx, now),
    toolProvider: () => tools,
    setEvalRunner(runner) {
      ctx.deps.evalRunner = runner;
    },
    loadedSkills: (runId) => [...(ctx.loaded.get(runId) ?? [])],
    forgetRun: (runId) => void ctx.loaded.delete(runId),
    dispose: () => void off(),
  };
}
