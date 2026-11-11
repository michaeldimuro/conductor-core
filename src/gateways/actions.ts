import { and, eq } from 'drizzle-orm';
import type { Services } from '../daemon/container.js';
import type { Gateway } from '../contracts/rows.js';
import { OWNER } from '../contracts/types.js';
import { approvals, issues } from '../db/schema/index.js';
import { errorMessage, isConductorError } from '../shared/errors.js';
import { redact } from '../shared/util.js';
import type { ActionOutcome } from './types.js';
import { APPROVAL_ID_RE, ISSUE_ID_RE } from './util.js';

export type ParsedAction =
  | { type: 'approval'; decision: 'approved' | 'denied'; id: string }
  | { type: 'review'; outcome: 'accepted' | 'rejected'; id: string };

/** Strict parse of a button's action string. Anything else is rejected (it is untrusted platform input). */
export function parseAction(raw: string): ParsedAction | null {
  if (typeof raw !== 'string' || raw.length > 100) return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [type, verb, id] = parts as [string, string, string];
  if (type === 'approval' && (verb === 'approve' || verb === 'deny') && APPROVAL_ID_RE.test(id)) {
    return { type, decision: verb === 'approve' ? 'approved' : 'denied', id };
  }
  if (type === 'review' && (verb === 'accepted' || verb === 'rejected') && ISSUE_ID_RE.test(id)) {
    return { type, outcome: verb, id };
  }
  return null;
}

export interface Via {
  chatId: string;
  userId: string;
}

const NOT_FOUND: ActionOutcome = { text: 'Not found (it may belong to another organization).', final: false, changed: false };

/**
 * One-tap decisions shared by buttons and reply-commands on every platform.
 * The human on the allow-listed chat acts as the Owner.
 */
export class Decisions {
  constructor(private readonly services: Services) {}

  run(gateway: Gateway, rawAction: string, via: Via): ActionOutcome {
    const action = parseAction(rawAction);
    if (!action) return { text: 'That button is not something I can act on.', final: false, changed: false };
    return action.type === 'approval'
      ? this.approval(gateway, action.id, action.decision, undefined, via)
      : this.review(gateway, action.id, action.outcome, undefined, via);
  }

  approval(gateway: Gateway, approvalId: string, decision: 'approved' | 'denied', note: string | undefined, via: Via): ActionOutcome {
    const { kernel, governance } = this.services;
    // An owner-level gateway (orgId null) serves every org; an org's gateway only ever sees its own rows.
    const row = kernel.db
      .select({ orgId: approvals.orgId, title: approvals.title })
      .from(approvals)
      .where(gateway.orgId ? and(eq(approvals.id, approvalId), eq(approvals.orgId, gateway.orgId)) : eq(approvals.id, approvalId))
      .get();
    if (!row) return NOT_FOUND;

    const verb = decision === 'approved' ? 'Approved' : 'Denied';
    try {
      governance.approvals.decide(row.orgId, approvalId, decision, { kind: 'human', id: 'owner' }, note);
    } catch (err) {
      if (isConductorError(err) && err.code === 'conflict') {
        const status = typeof err.details?.status === 'string' ? err.details.status : null;
        return { text: status ? `Already decided — this approval is ${status}.` : 'Already decided.', final: true, changed: false };
      }
      if (isConductorError(err) && err.code === 'not_found') return NOT_FOUND;
      return { text: `Could not record the decision: ${redact(errorMessage(err))}`, final: false, changed: false };
    }
    this.audit(gateway, row.orgId, via, { action: 'approval', approvalId, decision });
    return { text: `${verb}: ${row.title}`, final: true, changed: true };
  }

  review(gateway: Gateway, issueId: string, outcome: 'accepted' | 'rejected', note: string | undefined, via: Via): ActionOutcome {
    const { kernel, work } = this.services;
    const row = kernel.db
      .select({ orgId: issues.orgId, title: issues.title, number: issues.number })
      .from(issues)
      .where(gateway.orgId ? and(eq(issues.id, issueId), eq(issues.orgId, gateway.orgId)) : eq(issues.id, issueId))
      .get();
    if (!row) return NOT_FOUND;

    try {
      work.review(row.orgId, issueId, outcome, note, OWNER);
    } catch (err) {
      if (isConductorError(err) && (err.code === 'conflict' || err.code === 'validation')) {
        return { text: `Already reviewed — #${row.number} is no longer waiting for review.`, final: true, changed: false };
      }
      if (isConductorError(err) && err.code === 'not_found') return NOT_FOUND;
      return { text: `Could not record the review: ${redact(errorMessage(err))}`, final: false, changed: false };
    }
    this.audit(gateway, row.orgId, via, { action: 'review', issueId, outcome });
    return { text: `${outcome === 'accepted' ? 'Accepted' : 'Sent back for rework'}: #${row.number} ${row.title}`, final: true, changed: true };
  }

  private audit(gateway: Gateway, orgId: string, via: Via, data: Record<string, unknown>): void {
    this.services.kernel.audit.record({
      orgId, actor: OWNER, action: 'gateway.action', entityKind: 'gateway', entityId: gateway.id,
      issueId: typeof data.issueId === 'string' ? data.issueId : undefined,
      data: { ...data, gatewayKind: gateway.kind, chatId: via.chatId, userId: via.userId },
    });
  }
}
