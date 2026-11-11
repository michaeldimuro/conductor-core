import { and, desc, eq, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { approvals, knownRecipients, organizations } from '../db/schema/index.js';
import { APPROVAL_KINDS, type ApprovalKind } from '../db/schema/governance.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Approval } from '../contracts/rows.js';
import type { ApprovalService } from '../contracts/services.js';
import { SYSTEM, type Actor } from '../contracts/types.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { approvalTtlMs, approvalUseTtlMs, evaluateGate, scrubSecrets, summarizePayload } from './policy.js';
import { parse, requireAgent, requireOrg } from './store.js';

const requestSchema = z.object({
  orgId: z.string().min(1),
  kind: z.enum(APPROVAL_KINDS),
  title: z.string().trim().min(1).max(300),
  payload: z.record(z.string(), z.unknown()).optional(),
  requesterAgentId: z.string().min(1).nullish(),
  runId: z.string().min(1).nullish(),
  issueId: z.string().min(1).nullish(),
  expiresAt: z.number().int().positive().nullish(),
});

const matchSchema = z.object({
  orgId: z.string().min(1),
  kind: z.enum(APPROVAL_KINDS),
  matchKey: z.string().min(1),
});

const STATUSES = ['pending', 'approved', 'denied', 'expired', 'cancelled'] as const;

const matchKeyIs = (matchKey: string): SQL => sql`json_extract(${approvals.payload}, '$.matchKey') = ${matchKey}`;

type ExpiryPhase = 'pending' | 'unused';

/**
 * Flip one approval to `expired` (no-op if it changed meanwhile): a pending one
 * nobody decided in time, or an approved grant that was never used. Audited,
 * and announced on the bus so the agent waiting on it is woken.
 */
function markExpired(k: Kernel, a: Approval, phase: ExpiryPhase = 'pending'): boolean {
  const from = phase === 'pending' ? 'pending' : 'approved';
  const res = k.db
    .update(approvals)
    .set({ status: 'expired' })
    .where(and(eq(approvals.id, a.id), eq(approvals.orgId, a.orgId), eq(approvals.status, from), isNull(approvals.consumedAt)))
    .run();
  if (res.changes !== 1) return false;
  k.audit.record({
    orgId: a.orgId,
    actor: SYSTEM,
    action: 'approval.expired',
    entityKind: 'approval',
    entityId: a.id,
    runId: a.runId ?? undefined,
    issueId: a.issueId ?? undefined,
    data: { kind: a.kind, expiresAt: a.expiresAt, phase, ...(phase === 'unused' ? { decidedAt: a.decidedAt } : {}) },
  });
  k.bus.emit('approval.expired', { orgId: a.orgId, approvalId: a.id, requesterAgentId: a.requesterAgentId, phase });
  return true;
}

/** Earliest `decidedAt` an approved grant of this org may have and still be usable; null = no use-by window. */
function useCutoff(k: Kernel, orgId: string, now: number): number | null {
  const org = k.db.select({ policies: organizations.policies }).from(organizations).where(eq(organizations.id, orgId)).get();
  const ttl = approvalUseTtlMs(org?.policies);
  return ttl === null ? null : now - ttl;
}

/** SQL: the approved grant is still inside its use-by window. */
const usable = (cutoff: number | null): SQL => (cutoff === null ? sql`1 = 1` : sql`(${approvals.decidedAt} is null or ${approvals.decidedAt} > ${cutoff})`);

/**
 * Scheduler hook (all orgs): expire every pending approval past its
 * `expiresAt`, and every approved single-use grant (one carrying a
 * `matchKey`) that was not consumed within the org's use-by window. Each is
 * audited and announced with `approval.expired`. Returns the expired approvals.
 */
export function expireApprovals(k: Kernel, now: number = k.clock.now()): Approval[] {
  const expired: Approval[] = [];
  const due = k.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.status, 'pending'), isNotNull(approvals.expiresAt), lte(approvals.expiresAt, now)))
    .all();
  for (const a of due) {
    if (markExpired(k, a, 'pending')) expired.push({ ...a, status: 'expired' });
  }

  const unused = k.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.status, 'approved'), isNull(approvals.consumedAt), isNotNull(approvals.decidedAt), sql`json_extract(${approvals.payload}, '$.matchKey') is not null`))
    .all();
  const cutoffs = new Map<string, number | null>();
  for (const a of unused) {
    if (!cutoffs.has(a.orgId)) cutoffs.set(a.orgId, useCutoff(k, a.orgId, now));
    const cutoff = cutoffs.get(a.orgId) ?? null;
    if (cutoff === null || a.decidedAt === null || a.decidedAt > cutoff) continue;
    if (markExpired(k, a, 'unused')) expired.push({ ...a, status: 'expired' });
  }
  return expired;
}

export class Approvals implements ApprovalService {
  constructor(private readonly k: Kernel) {}

  requiresApproval(orgId: string, kind: ApprovalKind | string, ctx?: { amountUsd?: number }): boolean {
    const org = requireOrg(this.k, orgId);
    return evaluateGate(org.policies, String(kind), ctx);
  }

  request(raw: Parameters<ApprovalService['request']>[0]): Approval {
    const input = parse(requestSchema, raw);
    const org = requireOrg(this.k, input.orgId);
    const requester = input.requesterAgentId ? requireAgent(this.k, input.orgId, input.requesterAgentId) : null;
    const now = this.k.clock.now();
    if (input.expiresAt != null && input.expiresAt <= now) throw invalid('expiresAt must be in the future');
    // No expiry given → the org's default lifetime (policy `approvalExpiryHours`, 72h). An explicit null means "never".
    const ttl = approvalTtlMs(org.policies);
    const expiresAt = input.expiresAt === undefined ? (ttl === null ? null : now + ttl) : input.expiresAt;

    const id = newId('approval');
    const payload = scrubSecrets(input.payload ?? {});
    this.k.db
      .insert(approvals)
      .values({
        id,
        orgId: input.orgId,
        requesterAgentId: requester?.id ?? null,
        runId: input.runId ?? null,
        issueId: input.issueId ?? null,
        kind: input.kind,
        title: input.title,
        payload,
        status: 'pending',
        expiresAt,
        createdAt: now,
      })
      .run();
    const approval = this.get(input.orgId, id);

    this.k.audit.record({
      orgId: input.orgId,
      actor: requester ? { kind: 'agent', id: requester.id, runId: input.runId ?? undefined } : SYSTEM,
      action: 'approval.requested',
      entityKind: 'approval',
      entityId: id,
      runId: input.runId ?? undefined,
      issueId: input.issueId ?? undefined,
      data: { kind: input.kind, title: input.title, payloadKeys: Object.keys(payload), expiresAt },
    });

    this.k.bus.emit('approval.requested', { orgId: input.orgId, approvalId: id, kind: input.kind });
    const summary = summarizePayload(payload);
    const header = requester ? `${requester.name} (${requester.role}) requests: ${input.kind}` : `Requested: ${input.kind}`;
    this.k.bus.emit('notification', {
      orgId: input.orgId,
      kind: 'approval',
      title: `Approval needed: ${input.title}`,
      body: summary ? `${header}\n${summary}` : header,
      actions: [
        { label: 'Approve', action: `approval:approve:${id}` },
        { label: 'Deny', action: `approval:deny:${id}` },
      ],
      data: { approvalId: id },
    });
    return approval;
  }

  decide(orgId: string, approvalId: string, decision: 'approved' | 'denied', by: Actor, note?: string): Approval {
    if (decision !== 'approved' && decision !== 'denied') throw invalid('decision must be "approved" or "denied"');
    if (note !== undefined && typeof note !== 'string') throw invalid('note must be a string');
    // The owner is the board: an agent must never be able to approve its own (or any) request.
    if (!by || by.kind === 'agent') throw forbidden('agents cannot decide approvals');

    const current = this.get(orgId, approvalId);
    const now = this.k.clock.now();
    if (current.status === 'pending' && current.expiresAt !== null && current.expiresAt <= now) {
      markExpired(this.k, current, 'pending');
      throw conflict('approval has expired', { status: 'expired' });
    }
    if (current.status !== 'pending') {
      throw conflict(`approval is already ${current.status}`, { status: current.status });
    }

    const decidedBy = by.id ?? by.kind;
    const res = this.k.db
      .update(approvals)
      .set({ status: decision, decidedBy, decisionNote: note ? scrubSecrets(note).slice(0, 2000) : null, decidedAt: now })
      .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, orgId), eq(approvals.status, 'pending')))
      .run();
    if (res.changes !== 1) throw conflict('approval was decided concurrently');

    const decided = this.get(orgId, approvalId);
    this.k.audit.record({
      orgId,
      actor: by,
      action: 'approval.decided',
      entityKind: 'approval',
      entityId: approvalId,
      runId: decided.runId ?? undefined,
      issueId: decided.issueId ?? undefined,
      data: { kind: decided.kind, status: decision, decidedBy, note: decided.decisionNote },
    });
    this.k.bus.emit('approval.decided', {
      orgId,
      approvalId,
      status: decision,
      requesterAgentId: decided.requesterAgentId,
    });
    return decided;
  }

  get(orgId: string, approvalId: string): Approval {
    const row =
      typeof orgId === 'string' && typeof approvalId === 'string'
        ? this.k.db.select().from(approvals).where(and(eq(approvals.orgId, orgId), eq(approvals.id, approvalId))).get()
        : undefined;
    if (!row) throw notFound('approval', String(approvalId));
    return row;
  }

  list(orgId: string | null, filter: { status?: Approval['status']; kind?: string; limit?: number } = {}): Approval[] {
    const where: SQL[] = [];
    if (orgId !== null) where.push(eq(approvals.orgId, orgId));
    if (filter.status !== undefined) {
      if (!STATUSES.includes(filter.status)) throw invalid(`unknown approval status: ${String(filter.status)}`);
      where.push(eq(approvals.status, filter.status));
    }
    if (filter.kind !== undefined) where.push(sql`${approvals.kind} = ${filter.kind}`);
    const limit = Math.max(1, Math.min(Math.trunc(filter.limit ?? 100) || 100, 1000));
    return this.k.db
      .select()
      .from(approvals)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .limit(limit)
      .all();
  }

  consume(orgId: string, kind: ApprovalKind, matchKey: string): Approval | null {
    const m = parse(matchSchema, { orgId, kind, matchKey });
    const now = this.k.clock.now();
    // One UPDATE statement picks and claims the approval, so concurrent
    // consumers (even on separate connections) can never both win.
    const candidate = this.k.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.orgId, m.orgId),
          eq(approvals.kind, m.kind),
          eq(approvals.status, 'approved'),
          isNull(approvals.consumedAt),
          matchKeyIs(m.matchKey),
          // An approved grant is only good inside its use-by window; the sweep marks older ones expired.
          usable(useCutoff(this.k, m.orgId, now)),
        ),
      )
      .orderBy(approvals.decidedAt, approvals.id)
      .limit(1);
    const claimed = this.k.db
      .update(approvals)
      .set({ consumedAt: now })
      .where(and(eq(approvals.orgId, m.orgId), isNull(approvals.consumedAt), sql`${approvals.id} = (${candidate})`))
      .returning()
      .all();
    const approval = claimed[0];
    if (!approval) return null;
    this.k.audit.record({
      orgId: m.orgId,
      actor: approval.requesterAgentId ? { kind: 'agent', id: approval.requesterAgentId } : SYSTEM,
      action: 'approval.consumed',
      entityKind: 'approval',
      entityId: approval.id,
      runId: approval.runId ?? undefined,
      issueId: approval.issueId ?? undefined,
      data: { kind: approval.kind },
    });
    return approval;
  }

  findOpen(orgId: string, kind: ApprovalKind, matchKey: string): Approval | null {
    const m = parse(matchSchema, { orgId, kind, matchKey });
    const now = this.k.clock.now();
    const row = this.k.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.orgId, m.orgId),
          eq(approvals.kind, m.kind),
          matchKeyIs(m.matchKey),
          or(
            and(eq(approvals.status, 'pending'), or(isNull(approvals.expiresAt), sql`${approvals.expiresAt} > ${now}`)),
            and(eq(approvals.status, 'approved'), isNull(approvals.consumedAt), usable(useCutoff(this.k, m.orgId, now))),
          ),
        ),
      )
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .limit(1)
      .get();
    return row ?? null;
  }

  isKnownRecipient(orgId: string, address: string): boolean {
    const addr = normalizeAddress(address);
    const row = this.k.db
      .select({ id: knownRecipients.id })
      .from(knownRecipients)
      .where(and(eq(knownRecipients.orgId, orgId), eq(knownRecipients.address, addr)))
      .get();
    return row !== undefined;
  }

  rememberRecipient(orgId: string, address: string): void {
    const addr = normalizeAddress(address);
    requireOrg(this.k, orgId);
    const res = this.k.db
      .insert(knownRecipients)
      .values({ orgId, address: addr, firstApprovedAt: this.k.clock.now() })
      .onConflictDoNothing()
      .run();
    if (res.changes === 1) {
      this.k.audit.record({ orgId, actor: SYSTEM, action: 'recipient.remembered', entityKind: 'recipient', entityId: addr });
    }
  }
}

function normalizeAddress(address: string): string {
  const addr = typeof address === 'string' ? address.trim().toLowerCase() : '';
  if (!addr) throw invalid('recipient address is required');
  if (addr.length > 512) throw invalid('recipient address is too long');
  return addr;
}
