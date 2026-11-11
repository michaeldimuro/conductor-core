import { execFileSync } from 'node:child_process';
import { and, eq } from 'drizzle-orm';
import { vi } from 'vitest';
import { agents, departments, issues, organizations } from '../../src/db/schema/index.js';
import type { UtilityModel } from '../../src/contracts/kernel.js';
import type { ApprovalService, EvalRunner } from '../../src/contracts/services.js';
import type { Approval } from '../../src/contracts/rows.js';
import type { OrgPolicies } from '../../src/contracts/types.js';
import type { ToolCallContext } from '../../src/contracts/tools.js';
import { notFound } from '../../src/shared/errors.js';
import { newId } from '../../src/shared/ids.js';
import { createSkillService, type SkillDeps, type SkillsContext } from '../../src/skills/index.js';
import type { TestKernel } from '../helpers/kernel.js';

/** Org collaborator backed by the seeded rows (always org-scoped, like the real one). */
export function fakeOrg(k: TestKernel): SkillDeps['org'] {
  const getOrg = (orgId: string) => {
    const o = k.db.select().from(organizations).where(eq(organizations.id, orgId)).get();
    if (!o) throw notFound('org', orgId);
    return o;
  };
  const getDept = (orgId: string, deptId: string) => {
    const d = k.db.select().from(departments).where(and(eq(departments.id, deptId), eq(departments.orgId, orgId))).get();
    if (!d) throw notFound('department', deptId);
    return d;
  };
  const getAgent = (orgId: string, agentId: string) => {
    const a = k.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, orgId))).get();
    if (!a) throw notFound('agent', agentId);
    return a;
  };
  return {
    getOrg,
    getDept,
    getAgent,
    leadOf: (orgId, deptId) => {
      const d = getDept(orgId, deptId);
      return d.leadAgentId ? getAgent(orgId, d.leadAgentId) : null;
    },
    resolveCapabilityRefs: (orgId, agentId) => {
      const a = getAgent(orgId, agentId);
      const skillNames = [...new Set([...getOrg(orgId).defaultSkills, ...getDept(orgId, a.deptId).sharedSkills, ...a.skills])];
      return { skillNames, connectorIds: [], denySkills: a.denySkills, denyConnectors: [] };
    },
  };
}

/** In-memory ApprovalService that emits `approval.decided` on the kernel bus like the real one. */
export function fakeApprovals(k: TestKernel): ApprovalService & { all: Approval[] } {
  const all: Approval[] = [];
  const open = (orgId: string, kind: string, matchKey: string, statuses: string[]) =>
    all.find((a) => a.orgId === orgId && a.kind === kind && a.payload.matchKey === matchKey && statuses.includes(a.status) && a.consumedAt === null) ?? null;
  return {
    all,
    requiresApproval: vi.fn(() => true),
    request: (input) => {
      const a: Approval = {
        id: newId('approval'), orgId: input.orgId, requesterAgentId: input.requesterAgentId ?? null, runId: input.runId ?? null, issueId: input.issueId ?? null,
        kind: input.kind, title: input.title, payload: input.payload ?? {}, status: 'pending', decidedBy: null, decisionNote: null, decidedAt: null,
        consumedAt: null, expiresAt: input.expiresAt ?? null, createdAt: k.clock.now(),
      };
      all.push(a);
      k.bus.emit('approval.requested', { orgId: a.orgId, approvalId: a.id, kind: a.kind });
      return a;
    },
    decide: (orgId, approvalId, decision, by) => {
      const a = all.find((x) => x.id === approvalId && x.orgId === orgId);
      if (!a) throw notFound('approval', approvalId);
      a.status = decision;
      a.decidedBy = by.id ?? by.kind;
      a.decidedAt = k.clock.now();
      k.bus.emit('approval.decided', { orgId, approvalId, status: decision, requesterAgentId: a.requesterAgentId });
      return a;
    },
    get: (orgId, approvalId) => {
      const a = all.find((x) => x.id === approvalId && x.orgId === orgId);
      if (!a) throw notFound('approval', approvalId);
      return a;
    },
    list: (orgId) => all.filter((a) => orgId === null || a.orgId === orgId),
    consume: (orgId, kind, matchKey) => {
      const a = open(orgId, kind, matchKey, ['approved']);
      if (a) a.consumedAt = k.clock.now();
      return a;
    },
    findOpen: (orgId, kind, matchKey) => open(orgId, kind, matchKey, ['pending', 'approved']),
    isKnownRecipient: () => false,
    rememberRecipient: () => undefined,
  };
}

/** Judge that answers with a fixed verdict (or one computed from the prompt). */
export function fakeUtility(verdict: boolean | ((prompt: string) => boolean) = true): UtilityModel & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (req: Parameters<UtilityModel['complete']>[0]) => {
    const success = typeof verdict === 'function' ? verdict(req.prompt) : verdict;
    return { text: JSON.stringify({ success }), json: { success, reason: 'fake judge' }, tokensIn: 10, tokensOut: 5, costUsd: 0, offline: true };
  });
  return { complete } as UtilityModel & { complete: ReturnType<typeof vi.fn> };
}

export interface ArmScript {
  outcome?: 'completed' | 'failed';
  steps: number;
  costUsd: number;
  tokens?: number;
  finalText?: string;
}

/** EvalRunner whose result depends only on whether the skill under test is in the run's skill list. */
export function fakeRunner(skillName: string, arms: { baseline: ArmScript; withSkill: ArmScript }): EvalRunner & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (input: Parameters<EvalRunner['run']>[0]) => {
    const arm = input.skills.some((s) => s.name === skillName) ? arms.withSkill : arms.baseline;
    const finalText = arm.finalText ?? (arm === arms.withSkill ? 'done WITH-SKILL' : 'done BASELINE');
    return {
      wallMs: arm.steps * 1000,
      finalText,
      result: {
        outcome: arm.outcome ?? 'completed',
        finalText,
        steps: arm.steps,
        usage: { tokensIn: arm.tokens ?? arm.steps * 100, tokensOut: 0, costUsd: arm.costUsd, subscription: false, seatSeconds: 0 },
      },
    };
  });
  return { run } as EvalRunner & { run: ReturnType<typeof vi.fn> };
}

export const WIN = { baseline: { steps: 12, costUsd: 0.06 }, withSkill: { steps: 4, costUsd: 0.02 } };

export interface Harness {
  svc: SkillsContext;
  approvals: ReturnType<typeof fakeApprovals>;
  utility: ReturnType<typeof fakeUtility>;
}

export function createHarness(k: TestKernel, opts: { evalRunner?: EvalRunner; verdict?: boolean | ((prompt: string) => boolean) } = {}): Harness {
  const approvals = fakeApprovals(k);
  const utility = fakeUtility(opts.verdict ?? true);
  const svc = createSkillService(k, { org: fakeOrg(k), approvals, utility, evalRunner: opts.evalRunner });
  return { svc, approvals, utility };
}

export function seedIssue(k: TestKernel, orgId: string, title = 'Export the monthly Stripe report'): string {
  const id = newId('issue');
  const now = k.clock.now();
  k.db.insert(issues).values({ id, orgId, number: 1, title, body: 'Download the balance report and attach it.', expectedOutput: 'A CSV attached to the issue', createdAt: now, updatedAt: now }).run();
  return id;
}

export function setPolicies(k: TestKernel, orgId: string, policies: OrgPolicies): void {
  k.db.update(organizations).set({ policies }).where(eq(organizations.id, orgId)).run();
}

export function setLead(k: TestKernel, deptId: string, agentId: string): void {
  k.db.update(departments).set({ leadAgentId: agentId }).where(eq(departments.id, deptId)).run();
}

export function toolCtx(orgId: string, agent: { id: string; deptId: string }, runId = 'run_1', issueId: string | null = null): ToolCallContext {
  return { orgId, agentId: agent.id, deptId: agent.deptId, runId, issueId, workspacePath: '/tmp/ws', autonomyLevel: 1 };
}

export function git(k: TestKernel, ...args: string[]): string {
  return execFileSync('git', ['-C', k.paths.home, ...args], { encoding: 'utf8' });
}

export const BODY = '# Stripe export\n\n1. Open Reports → Balance.\n2. Click Export.\n';
