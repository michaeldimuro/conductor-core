import type { HireAgentInput } from '../../contracts/org-work.js';
import { AUTONOMY } from '../../contracts/types.js';
import type { Approval } from '../../contracts/rows.js';
import { ConductorError, forbidden, notFound } from '../../shared/errors.js';
import { redact } from '../../shared/util.js';
import {
  actorOf, agentView, goalView, issueBrief, resolveAgent, resolveIssue,
  type Handlers,
} from './support.js';

type OrgTools =
  | 'list_goals' | 'create_goal' | 'list_team' | 'propose_hire' | 'propose_termination' | 'propose_budget_change' | 'propose_skill_grant'
  | 'request_approval' | 'list_playbooks' | 'run_playbook';

const approvalView = (a: Approval) => ({ id: a.id, kind: a.kind, title: a.title, status: a.status });

export const orgHandlers: Handlers<OrgTools> = {
  list_goals(env, ctx, args) {
    const goals = env.work.listGoals(ctx.orgId, {
      status: args.status,
      ownerAgentId: args.mine ? ctx.agentId : undefined,
    });
    return { goals: goals.map(goalView) };
  },

  create_goal(env, ctx, args) {
    const level = args.level ?? 'agent';
    if (level === 'dept' && ctx.autonomyLevel < AUTONOMY.LEAD) {
      throw forbidden('department goals require autonomy 3 (lead)');
    }
    const goal = env.work.createGoal(
      ctx.orgId,
      {
        title: args.title,
        description: args.description,
        level,
        parentGoalId: args.parentGoalId,
        successMetric: args.successMetric,
        target: args.target,
        weight: args.weight,
        due: args.due,
        deptId: ctx.deptId,
        ownerAgentId: level === 'agent' ? ctx.agentId : null,
      },
      actorOf(ctx),
    );
    return { goal: goalView(goal) };
  },

  list_team(env, ctx) {
    const active = <T extends { status: string }>(xs: T[]): T[] => xs.filter((a) => a.status !== 'terminated');
    const manager = env.org.managerOf(ctx.orgId, ctx.agentId);
    const siblings = manager
      ? env.org.reportsOf(ctx.orgId, manager.id)
      : env.org.listAgents(ctx.orgId).filter((a) => a.reportsTo === null);
    const lead = env.org.leadOf(ctx.orgId, ctx.deptId);
    return {
      manager: manager ? agentView(manager) : null,
      reportsToOwner: manager === null,
      departmentLead: lead ? agentView(lead) : null,
      peers: active(siblings).filter((a) => a.id !== ctx.agentId).map(agentView),
      reports: active(env.org.reportsOf(ctx.orgId, ctx.agentId)).map(agentView),
    };
  },

  propose_hire(env, ctx, args) {
    const input: HireAgentInput = {
      deptId: args.deptId ?? ctx.deptId,
      name: args.name,
      role: args.role,
      goal: args.goal,
      backstory: args.backstory,
      reportsTo: args.reportsTo ? resolveAgent(env, ctx, args.reportsTo).id : ctx.agentId,
      model: args.model,
      skills: args.skills,
      connectors: args.connectors,
      heartbeatCron: args.heartbeatCron,
      budgetUsd: args.budgetUsd,
      autonomyLevel: args.autonomyLevel,
    };
    // As an agent actor the Org context raises a `hire_agent` approval instead of hiring.
    const result = env.org.hireAgent(ctx.orgId, input, actorOf(ctx));
    if (result.approval) {
      return { approval: approvalView(result.approval), note: 'The hire happens only if the owner approves.' };
    }
    return { agent: result.agent ? agentView(result.agent) : null };
  },

  propose_termination(env, ctx, args) {
    const target = resolveAgent(env, ctx, args.agent);
    // As an agent actor the Org context raises a `terminate_agent` approval instead of terminating.
    const result = env.org.terminateAgent(ctx.orgId, target.id, actorOf(ctx), { reason: redact(args.reason) });
    if (result.approval) {
      return { approval: approvalView(result.approval), note: 'The agent is terminated only if the owner approves.' };
    }
    return { agent: result.agent ? agentView(result.agent) : null };
  },

  propose_budget_change(env, ctx, args) {
    if (!env.org.proposeBudgetChange) {
      throw new ConductorError('unavailable', 'budget proposals are not available in this installation');
    }
    const id = args.scope === 'agent' ? (args.target ? resolveAgent(env, ctx, args.target).id : ctx.agentId) : (args.target ?? ctx.deptId);
    const result = env.org.proposeBudgetChange(
      ctx.orgId,
      { scope: args.scope, id, budgetUsd: args.budgetUsd, reason: redact(args.reason) },
      actorOf(ctx),
    );
    if (result.approval) {
      return { approval: approvalView(result.approval), note: 'The budget changes only if the owner approves.' };
    }
    return {
      agent: result.agent ? { ...agentView(result.agent), budgetUsd: result.agent.budgetUsd } : undefined,
      department: result.department ? { id: result.department.id, name: result.department.name, budgetUsd: result.department.budgetUsd } : undefined,
    };
  },

  propose_skill_grant(env, ctx, args) {
    if (!env.org.proposeSkillGrant) {
      throw new ConductorError('unavailable', 'skill grant proposals are not available in this installation');
    }
    const id = args.scope === 'agent' ? (args.target ? resolveAgent(env, ctx, args.target).id : ctx.agentId) : args.scope === 'dept' ? (args.target ?? ctx.deptId) : undefined;
    // As an agent actor the Org context raises a `grant_skill` approval (while that gate is on) instead of granting.
    const result = env.org.proposeSkillGrant(ctx.orgId, { scope: args.scope, id, skill: args.skill, reason: redact(args.reason) }, actorOf(ctx));
    if (result.approval) {
      return { approval: approvalView(result.approval), note: 'The skill is granted only if the owner approves.' };
    }
    return {
      granted: true,
      agent: result.agent ? { ...agentView(result.agent), skills: result.agent.skills } : undefined,
      department: result.department ? { id: result.department.id, name: result.department.name, sharedSkills: result.department.sharedSkills } : undefined,
      organization: result.organization ? { id: result.organization.id, defaultSkills: result.organization.defaultSkills } : undefined,
    };
  },

  request_approval(env, ctx, args) {
    // Defence in depth: scrub anything credential-shaped before it is stored.
    const payload = args.payload
      ? (JSON.parse(redact(JSON.stringify(args.payload))) as Record<string, unknown>)
      : {};
    const approval = env.approvals.request({
      orgId: ctx.orgId,
      kind: args.kind,
      title: args.title,
      payload,
      requesterAgentId: ctx.agentId,
      runId: ctx.runId,
      issueId: ctx.issueId,
    });
    return { approval: approvalView(approval), note: 'Wait for the decision before acting.' };
  },

  list_playbooks(env, ctx) {
    return {
      playbooks: env.work.listPlaybooks(ctx.orgId).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        process: p.process,
        managerAgentId: p.managerAgentId,
        steps: p.steps,
      })),
    };
  },

  run_playbook(env, ctx, args) {
    const wanted = args.playbook.trim().toLowerCase();
    const playbook = env.work
      .listPlaybooks(ctx.orgId)
      .find((p) => p.id === args.playbook || p.name.toLowerCase() === wanted);
    if (!playbook) throw notFound('playbook', args.playbook);
    const issue = resolveIssue(env, ctx, args.issue);
    const children = env.work.runPlaybook(ctx.orgId, playbook.id, issue.id, actorOf(ctx));
    return { playbook: { id: playbook.id, name: playbook.name, process: playbook.process }, children: children.map(issueBrief) };
  },
};
