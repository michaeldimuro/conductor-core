import type { Kernel } from '../contracts/kernel.js';
import type { BrowserProfile } from '../contracts/rows.js';
import type { ApprovalService } from '../contracts/services.js';
import type { ToolCallContext, ToolResult } from '../contracts/tools.js';
import { sha256 } from '../shared/util.js';
import { hostMatches, hostOf } from './domains.js';
import type { ElementDescriptor } from './page-scripts.js';

const COMMIT_WORDS =
  /\b(buy|purchase|pay|payment|checkout|check out|order|send|submit|confirm|transfer|subscribe|donate|book|delete|remove|place|sign|authorize|authorise|approve|withdraw|post|publish)\b/i;

/** Does activating this element submit a form or look like a purchase / payment / send / confirmation? */
export function looksLikeCommit(d: ElementDescriptor): boolean {
  if (d.submits) return true;
  const buttonLike =
    d.tag === 'button' || d.tag === 'a' || ['button', 'link', 'menuitem'].includes(d.role) ||
    (d.tag === 'input' && ['button', 'submit', 'image'].includes(d.type));
  return buttonLike && COMMIT_WORDS.test(`${d.text} ${d.label} ${d.name} ${d.id}`.replace(/[-_]+/g, ' '));
}

/** Stable identity of an element for approval matching (same button → same key). */
export function descriptorKey(d: ElementDescriptor): string {
  return ['click', d.tag, d.type, d.role, d.text, d.name, d.id].join('|');
}

/** True when the page, the form target or the link target is on one of the profile's sensitive domains. */
export function touchesSensitiveDomain(profile: BrowserProfile, pageUrl: string, d?: ElementDescriptor): boolean {
  if (profile.sensitiveDomains.length === 0) return false;
  const hosts = [hostOf(pageUrl), d?.formAction ? hostOf(d.formAction) : null, d?.href ? hostOf(d.href) : null];
  return hosts.some((h) => h !== null && hostMatches(h, profile.sensitiveDomains));
}

export interface GateRequest {
  ctx: ToolCallContext;
  profile: BrowserProfile;
  pageUrl: string;
  /** Stable description of the exact action (element descriptor, script hash…). */
  descriptor: string;
  title: string;
  detail: Record<string, unknown>;
}

/**
 * Non-blocking approval gate for sensitive browser actions: an approved
 * approval is consumed and the action proceeds exactly once; otherwise an
 * Approval is filed (once) and the agent is told to carry on and retry later.
 */
export class ActionGate {
  constructor(private readonly kernel: Kernel, private readonly approvals: ApprovalService) {}

  /** Returns null when the action may proceed now, else the tool result to hand back instead of acting. */
  check(req: GateRequest): ToolResult | null {
    const { ctx, profile } = req;
    const host = hostOf(req.pageUrl) ?? '';
    const matchKey = sha256(`${ctx.agentId}|${profile.id}|${host}|${req.descriptor}`);
    const actor = { kind: 'agent' as const, id: ctx.agentId, runId: ctx.runId };
    const base = { orgId: ctx.orgId, actor, entityKind: 'approval', runId: ctx.runId, issueId: ctx.issueId ?? undefined };

    const approved = this.approvals.consume(ctx.orgId, 'browser_action', matchKey);
    if (approved) {
      this.kernel.audit.record({ ...base, action: 'browser.approval_consumed', entityId: approved.id, data: { host, profileId: profile.id, ...req.detail } });
      return null;
    }
    const open = this.approvals.findOpen(ctx.orgId, 'browser_action', matchKey);
    if (open) {
      return reply({
        status: 'approval_pending', approvalId: open.id,
        message: `Approval ${open.id} for this action is still pending. Do not retry yet: continue with other work or finish this run; retry the same action once it is approved.`,
      });
    }
    const denied = this.approvals
      .list(ctx.orgId, { status: 'denied', kind: 'browser_action', limit: 100 })
      .find((a) => a.runId === ctx.runId && a.payload.matchKey === matchKey);
    if (denied) {
      return reply({
        status: 'approval_denied', approvalId: denied.id,
        message: `The board denied this action (approval ${denied.id}${denied.decisionNote ? `: ${denied.decisionNote}` : ''}). Do not attempt it again in this run.`,
      }, true);
    }
    const approval = this.approvals.request({
      orgId: ctx.orgId, kind: 'browser_action', title: req.title,
      payload: { matchKey, host, profileId: profile.id, ...req.detail },
      requesterAgentId: ctx.agentId, runId: ctx.runId, issueId: ctx.issueId,
    });
    this.kernel.audit.record({ ...base, action: 'browser.approval_requested', entityId: approval.id, data: { host, profileId: profile.id, ...req.detail } });
    return reply({
      status: 'approval_required', approvalId: approval.id,
      message: `This action on the sensitive domain ${host} needs board approval and was NOT performed. Approval ${approval.id} has been requested. Continue with other work or finish this run, then retry the exact same action once it is approved.`,
    });
  }
}

function reply(value: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}
