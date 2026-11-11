import type { Kernel } from '../contracts/kernel.js';
import type { OrgService } from '../contracts/org-work.js';
import type { ApprovalService } from '../contracts/services.js';
import * as agentOps from './agents.js';
import * as chart from './chart.js';
import { createCtx, type OrgImportDeps } from './context.js';
import * as deptOps from './departments.js';
import { exportOrg } from './export.js';
import { hireAgent, onApprovalDecided, proposeBudgetChange, terminateAgent } from './gated.js';
import { importOrg } from './import.js';
import * as orgOps from './orgs.js';
import { listAgentRows, listDeptRows, requireAgent, requireDept, requireOrg } from './repo.js';
import { listRevisions, rollback } from './revisions.js';
import { proposeSkillGrant } from './skill-grants.js';
import { createFromTemplate, listTemplates } from './templates.js';

export type { OrgImportDeps } from './context.js';

export interface OrgContextHooks {
  /** Late-bind the skills / memory / connector services used only by `importOrg`. */
  setImportDeps(deps: OrgImportDeps): void;
  /** Resolves once every in-flight import has finished re-creating skills, connectors and memories. */
  whenIdle(): Promise<void>;
  /** Unsubscribe from the bus. */
  dispose(): void;
}

/**
 * The Org context: the `OrgService` contract (every optional method
 * implemented) plus wiring hooks for the composition root.
 */
export type OrgContext = OrgService &
  Required<Pick<OrgService, 'unarchiveOrg' | 'archiveDept' | 'unarchiveDept' | 'proposeBudgetChange' | 'proposeSkillGrant'>> &
  OrgContextHooks;

export function createOrgService(
  kernel: Kernel,
  deps: { approvals: ApprovalService } & OrgImportDeps,
): OrgContext {
  const ctx = createCtx(kernel, { ...deps });
  const background = new Set<Promise<void>>();

  // Approved hires/terminations/budget changes/skill grants filed by this context execute here, exactly once.
  const unsubscribe = kernel.bus.on('approval.decided', (event) => onApprovalDecided(ctx, event));

  return {
    createOrg: (input, actor) => orgOps.createOrg(ctx, input, actor),
    updateOrg: (orgId, patch, actor) => orgOps.updateOrg(ctx, orgId, patch, actor),
    archiveOrg: (orgId, actor) => orgOps.archiveOrg(ctx, orgId, actor),
    unarchiveOrg: (orgId, actor) => orgOps.unarchiveOrg(ctx, orgId, actor),
    getOrg: (orgId) => requireOrg(kernel, orgId),
    getOrgBySlug: (slug) => orgOps.getOrgBySlug(ctx, slug),
    listOrgs: (opts) => orgOps.listOrgs(ctx, opts),

    createDept: (orgId, input, actor) => deptOps.createDept(ctx, orgId, input, actor),
    updateDept: (orgId, deptId, patch, actor) => deptOps.updateDept(ctx, orgId, deptId, patch, actor),
    archiveDept: (orgId, deptId, actor) => deptOps.archiveDept(ctx, orgId, deptId, actor),
    unarchiveDept: (orgId, deptId, actor) => deptOps.unarchiveDept(ctx, orgId, deptId, actor),
    getDept: (orgId, deptId) => requireDept(kernel, orgId, deptId),
    listDepts: (orgId) => {
      requireOrg(kernel, orgId);
      return listDeptRows(kernel, orgId);
    },

    hireAgent: (orgId, input, actor) => hireAgent(ctx, orgId, input, actor),
    updateAgent: (orgId, agentId, patch, actor) => agentOps.updateAgent(ctx, orgId, agentId, patch, actor),
    pauseAgent: (orgId, agentId, reason, actor) => agentOps.pauseAgent(ctx, orgId, agentId, reason, actor),
    resumeAgent: (orgId, agentId, actor) => agentOps.resumeAgent(ctx, orgId, agentId, actor),
    terminateAgent: (orgId, agentId, actor, opts) => terminateAgent(ctx, orgId, agentId, actor, opts),
    proposeBudgetChange: (orgId, input, actor) => proposeBudgetChange(ctx, orgId, input, actor),
    proposeSkillGrant: (orgId, input, actor) => proposeSkillGrant(ctx, orgId, input, actor),
    getAgent: (orgId, agentId) => requireAgent(kernel, orgId, agentId),
    findAgent: (orgId, idOrSlug) => agentOps.findAgent(ctx, orgId, idOrSlug),
    listAgents: (orgId, filter) => {
      requireOrg(kernel, orgId);
      return listAgentRows(kernel, orgId, filter);
    },

    orgChart: (orgId) => chart.orgChart(kernel, orgId),
    managerOf: (orgId, agentId) => chart.managerOf(kernel, orgId, agentId),
    reportsOf: (orgId, agentId, opts) => chart.reportsOf(kernel, orgId, agentId, opts),
    leadOf: (orgId, deptId) => chart.leadOf(kernel, orgId, deptId),
    canAssign: (orgId, from, to) => chart.canAssign(kernel, orgId, from, to),
    resolveCapabilityRefs: (orgId, agentId) => chart.resolveCapabilityRefs(kernel, orgId, agentId),

    listTemplates,
    createFromTemplate: (templateId, input, actor) => createFromTemplate(ctx, templateId, input, actor),
    exportOrg: (orgId) => exportOrg(ctx, orgId),
    importOrg: (bundle, input, actor) => {
      const result = importOrg(ctx, bundle, input, actor);
      if (result.background) {
        const task = result.background
          .catch((err: unknown) => kernel.log.error({ err, orgId: result.org.id }, 'org import background step failed'))
          .finally(() => background.delete(task));
        background.add(task);
      }
      return result.org;
    },

    listRevisions: (orgId, entityKind, entityId) => listRevisions(ctx, orgId, entityKind, entityId),
    rollback: (orgId, entityKind, entityId, revision, actor) => rollback(ctx, orgId, entityKind, entityId, revision, actor),

    setImportDeps: (next) => {
      if (next.skills) ctx.deps.skills = next.skills;
      if (next.memory) ctx.deps.memory = next.memory;
      if (next.connectors) ctx.deps.connectors = next.connectors;
    },
    whenIdle: async () => {
      while (background.size > 0) await Promise.all([...background]);
    },
    dispose: unsubscribe,
  };
}
