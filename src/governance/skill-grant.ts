import { createHash } from 'node:crypto';
import type { Approval } from '../contracts/rows.js';
import type { ApprovalService } from '../contracts/services.js';
import type { Actor } from '../contracts/types.js';
import { invalid } from '../shared/errors.js';

/** Marks approvals filed through this helper, so a context only ever applies its own. */
export const SKILL_GRANT_SOURCE = 'governance.skill_grant';

export interface SkillGrantRequest {
  orgId: string;
  /** The agent that would receive the skill. */
  agentId: string;
  skillId: string;
  /** Shown to the approver. */
  skillName?: string;
  agentName?: string;
  /** Who is asking for the grant. */
  actor: Actor;
  issueId?: string | null;
}

export type SkillGrantDecision =
  /** Grant now. `approval` is the board approval this grant used up (null when none was needed). */
  | { allowed: true; approval: Approval | null }
  /** Do not grant: `approval` is pending with the board. Apply the grant when it is approved. */
  | { allowed: false; approval: Approval };

/** Identity of one "give skill S to agent A" action (the approval's `payload.matchKey`). */
export function skillGrantMatchKey(agentId: string, skillId: string): string {
  return `grant_skill:${createHash('sha256').update(`${agentId}|${skillId}`).digest('hex')}`;
}

/**
 * The `grant_skill` approval gate (PRD default gate, loosened per org with
 * `policies.approvalOverrides.grant_skill = false`). The owner grants
 * directly. Anyone else — an agent, an automation — needs board approval
 * while the org gates skill grants: an already approved request for the same
 * agent + skill is consumed (single use) and the grant goes ahead; otherwise
 * the open request is returned, or a new one is filed.
 *
 * The caller applies the grant when `allowed` is true, and again on
 * `approval.decided` (status approved) by calling this once more — the
 * approved request is then consumed and `allowed` comes back true.
 */
export function gateSkillGrant(approvals: ApprovalService, req: SkillGrantRequest): SkillGrantDecision {
  if (!req || typeof req.orgId !== 'string' || !req.orgId) throw invalid('orgId is required');
  if (typeof req.agentId !== 'string' || !req.agentId) throw invalid('agentId is required');
  if (typeof req.skillId !== 'string' || !req.skillId) throw invalid('skillId is required');
  if (!req.actor) throw invalid('actor is required');

  if (req.actor.kind === 'human') return { allowed: true, approval: null };
  if (!approvals.requiresApproval(req.orgId, 'grant_skill')) return { allowed: true, approval: null };

  const matchKey = skillGrantMatchKey(req.agentId, req.skillId);
  const approved = approvals.consume(req.orgId, 'grant_skill', matchKey);
  if (approved) return { allowed: true, approval: approved };
  const open = approvals.findOpen(req.orgId, 'grant_skill', matchKey);
  if (open) return { allowed: false, approval: open };

  const approval = approvals.request({
    orgId: req.orgId,
    kind: 'grant_skill',
    title: `Grant skill "${req.skillName ?? req.skillId}" to ${req.agentName ?? req.agentId}`.slice(0, 300),
    payload: {
      source: SKILL_GRANT_SOURCE, matchKey, skillId: req.skillId, agentId: req.agentId,
      ...(req.skillName ? { skillName: req.skillName } : {}),
      ...(req.agentName ? { agentName: req.agentName } : {}),
    },
    requesterAgentId: req.actor.kind === 'agent' ? (req.actor.id ?? null) : null,
    runId: req.actor.runId ?? null,
    issueId: req.issueId ?? null,
  });
  return { allowed: false, approval };
}
