import { vi } from 'vitest';
import type { ApprovalService } from '../../src/contracts/services.js';
import type { Approval } from '../../src/contracts/rows.js';
import type { Actor } from '../../src/contracts/types.js';
import { OWNER } from '../../src/contracts/types.js';
import { newId } from '../../src/shared/ids.js';
import { notFound } from '../../src/shared/errors.js';
import { createOrgService, type OrgContext } from '../../src/org/index.js';
import type { TestKernel } from '../helpers/kernel.js';

export interface FakeApprovals {
  svc: ApprovalService;
  rows: Map<string, Approval>;
  /** Toggle what `requiresApproval` answers (default: gated). */
  gated: boolean;
  /** Decide and publish `approval.decided` on the kernel bus, like the real service. */
  decide(approvalId: string, decision: 'approved' | 'denied'): Approval;
}

/** In-memory stand-in for the governance context's ApprovalService. */
export function fakeApprovals(k: TestKernel): FakeApprovals {
  const rows = new Map<string, Approval>();
  const state = { gated: true };
  const matches = (a: Approval, orgId: string, kind: string, matchKey: string) =>
    a.orgId === orgId && a.kind === kind && a.payload.matchKey === matchKey;

  const svc: ApprovalService = {
    requiresApproval: vi.fn(() => state.gated),
    request: vi.fn((input) => {
      const row: Approval = {
        id: newId('approval'),
        orgId: input.orgId,
        requesterAgentId: input.requesterAgentId ?? null,
        runId: input.runId ?? null,
        issueId: input.issueId ?? null,
        kind: input.kind,
        title: input.title,
        payload: input.payload ?? {},
        status: 'pending',
        decidedBy: null,
        decisionNote: null,
        decidedAt: null,
        consumedAt: null,
        expiresAt: input.expiresAt ?? null,
        createdAt: k.clock.now(),
      };
      rows.set(row.id, row);
      return row;
    }),
    decide: vi.fn((orgId: string, approvalId: string, decision: 'approved' | 'denied', by: Actor) => {
      const row = rows.get(approvalId);
      if (!row || row.orgId !== orgId) throw notFound('approval', approvalId);
      row.status = decision;
      row.decidedBy = by.id ?? by.kind;
      row.decidedAt = k.clock.now();
      k.bus.emit('approval.decided', { orgId, approvalId, status: decision, requesterAgentId: row.requesterAgentId });
      return row;
    }),
    get: vi.fn((orgId: string, approvalId: string) => {
      const row = rows.get(approvalId);
      if (!row || row.orgId !== orgId) throw notFound('approval', approvalId);
      return row;
    }),
    list: vi.fn(() => [...rows.values()]),
    consume: vi.fn((orgId: string, kind: string, matchKey: string) => {
      const row = [...rows.values()].find((a) => matches(a, orgId, kind, matchKey) && a.status === 'approved' && a.consumedAt === null);
      if (!row) return null;
      row.consumedAt = k.clock.now();
      return row;
    }),
    findOpen: vi.fn((orgId: string, kind: string, matchKey: string) =>
      [...rows.values()].find(
        (a) => matches(a, orgId, kind, matchKey) && (a.status === 'pending' || (a.status === 'approved' && a.consumedAt === null)),
      ) ?? null),
    isKnownRecipient: vi.fn(() => false),
    rememberRecipient: vi.fn(),
  };

  return {
    svc,
    rows,
    get gated() {
      return state.gated;
    },
    set gated(v: boolean) {
      state.gated = v;
    },
    decide: (approvalId, decision) => svc.decide(rows.get(approvalId)!.orgId, approvalId, decision, OWNER),
  };
}

export function setup(k: TestKernel): { org: OrgContext; approvals: FakeApprovals } {
  const approvals = fakeApprovals(k);
  return { org: createOrgService(k, { approvals: approvals.svc }), approvals };
}

/** Capture every event published on the bus as `[name, payload]`. */
export function recordEvents(k: TestKernel): Array<[string, Record<string, unknown>]> {
  const seen: Array<[string, Record<string, unknown>]> = [];
  k.bus.onAny((name, payload) => void seen.push([name, payload as Record<string, unknown>]));
  return seen;
}

export function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}
