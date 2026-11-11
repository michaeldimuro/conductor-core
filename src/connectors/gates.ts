import type { ApprovalKind } from '../db/schema/governance.js';
import type { ApprovalService } from '../contracts/services.js';
import type { ToolCallContext } from '../contracts/tools.js';
import { credentialUseKey, extractAmountUsd, extractRecipients, originOf, type ActionCategory } from './actions.js';
import { isGuardedRisk } from './risk.js';
import type { ToolEntry } from './types.js';

/** Why a call needs the board, beyond its configured tool policy. */
export interface Gate {
  kind: ApprovalKind;
  reason: 'payment' | 'spend_threshold' | 'new_recipient' | 'unknown_recipient' | 'publish' | 'credential_new_origin' | 'org_policy';
  /** Shown to the approver (already free of secrets: recipients, amount, origin). */
  detail: Record<string, unknown>;
  /** Known-recipient keys to remember once the approved call has succeeded. */
  remember: string[];
}

const MAX_TRACKED_RUNS = 5_000;

/**
 * The PRD's default approval gates as they apply to tool calls: any payment
 * or purchase, spend above the org threshold, the first send to a new external
 * recipient, publishing public content, and whatever else the org gated with
 * `policies.extraGated` (a tool name, a `server__tool` name or an action
 * category). All of them are decided by governance's `requiresApproval`, so an
 * org loosens or tightens them with its policy toggles.
 */
export class ActionGates {
  /** Origin each run's browser last navigated to (for "credential on a new origin"). */
  private readonly origins = new Map<string, string>();

  constructor(private readonly approvals: ApprovalService) {}

  endRun(runId: string): void {
    this.origins.delete(runId);
  }

  /** Remember where a builtin navigation took the run. */
  observe(ctx: ToolCallContext, entry: ToolEntry, args: Record<string, unknown>): void {
    if (!entry.builtin || entry.def.risk !== 'external_read') return;
    const origin = originOf(args.url);
    if (!origin) return;
    if (this.origins.size >= MAX_TRACKED_RUNS && !this.origins.has(ctx.runId)) this.origins.clear();
    this.origins.set(ctx.runId, origin);
  }

  evaluate(ctx: ToolCallContext, entry: ToolEntry, args: Record<string, unknown>, category: ActionCategory, ingestedUntrusted: boolean): Gate | null {
    // A payment recognised only at call time (from the arguments) is gated even when the tool's listed risk was a read.
    if (!isGuardedRisk(entry.def.risk) && !(category === 'payment' && !entry.builtin)) return null;
    const a = this.approvals;
    const orgId = ctx.orgId;

    if (category === 'payment') {
      const amountUsd = extractAmountUsd(args);
      if (a.requiresApproval(orgId, 'payment', amountUsd === null ? undefined : { amountUsd })) {
        // Still gated with the amount left out → the default gate; otherwise only the spend threshold caught it.
        const reason = a.requiresApproval(orgId, 'payment') ? 'payment' : 'spend_threshold';
        return { kind: 'payment', reason, detail: { amountUsd }, remember: [] };
      }
    }
    if (category === 'send') {
      const recipients = extractRecipients(args, entry.serverName);
      const fresh = recipients.filter((r) => !a.isKnownRecipient(orgId, r));
      // No recipient the gateway can read (nested oddly, unusually named, or implied by the upstream):
      // that is an unknown recipient, never a known one. Nothing can be remembered, so it asks each time.
      const unknown = recipients.length === 0;
      if ((fresh.length > 0 || unknown) && a.requiresApproval(orgId, 'external_send')) {
        return unknown
          ? { kind: 'external_send', reason: 'unknown_recipient', detail: { newRecipients: [], recipientUnknown: true }, remember: [] }
          : { kind: 'external_send', reason: 'new_recipient', detail: { newRecipients: fresh }, remember: fresh };
      }
    }
    if (category === 'publish' && a.requiresApproval(orgId, 'publish')) {
      return { kind: 'publish', reason: 'publish', detail: {}, remember: [] };
    }
    if (category === 'credential' && ingestedUntrusted) {
      const ref = typeof args.secret_ref === 'string' ? args.secret_ref : typeof args.secretRef === 'string' ? args.secretRef : null;
      const origin = originOf(args.url) ?? this.origins.get(ctx.runId) ?? null;
      const key = ref && origin ? credentialUseKey(ref, origin) : null;
      // Unknown origin fails closed: ask, and remember nothing.
      if (ref && (!key || !a.isKnownRecipient(orgId, key))) {
        return { kind: 'tool_call', reason: 'credential_new_origin', detail: { origin, secretRef: ref }, remember: key ? [key] : [] };
      }
    }
    for (const gated of [entry.qualified, entry.def.name, category]) {
      if (a.requiresApproval(orgId, gated)) return { kind: 'tool_call', reason: 'org_policy', detail: { gatedBy: gated }, remember: [] };
    }
    return null;
  }

  /** After an approved call succeeded: its recipients (or credential origin) are known from now on. */
  remember(orgId: string, keys: string[]): void {
    for (const key of keys) this.approvals.rememberRecipient(orgId, key);
  }
}
