import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { agents, approvals, departments, organizations, projects } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import { SYSTEM } from '../contracts/types.js';
import type { BudgetEnforcer } from './budget-enforcer.js';

const raiseSchema = z.object({
  scope: z.enum(['org', 'dept', 'agent', 'project']),
  id: z.string().min(1),
  newCapUsd: z.number().nonnegative(),
});

/**
 * Governance executes its own gated action: when a `budget_raise` approval is
 * approved, apply the new cap, consume the approval and resume agents that
 * were paused on budget and are now under every cap.
 */
export class BudgetRaiseHandler {
  constructor(
    private readonly k: Kernel,
    private readonly enforcer: BudgetEnforcer,
  ) {}

  /** Subscribe to `approval.decided`. Returns the unsubscribe function. */
  attach(): () => void {
    return this.k.bus.on('approval.decided', (e) => {
      if (e.status === 'approved') this.apply(e.orgId, e.approvalId);
    });
  }

  /** Returns true when a cap was changed. */
  apply(orgId: string, approvalId: string): boolean {
    const approval = this.k.db.select().from(approvals).where(and(eq(approvals.orgId, orgId), eq(approvals.id, approvalId))).get();
    if (!approval || approval.kind !== 'budget_raise' || approval.status !== 'approved' || approval.consumedAt !== null) return false;

    const fail = (reason: string): false => {
      this.k.audit.record({
        orgId,
        actor: SYSTEM,
        action: 'budget.raise_failed',
        entityKind: 'approval',
        entityId: approvalId,
        data: { reason },
      });
      this.k.bus.emit('notification', {
        orgId,
        kind: 'budget',
        title: 'Budget raise could not be applied',
        body: `Approval "${approval.title}" was approved but not applied: ${reason}.`,
        data: { approvalId },
      });
      return false;
    };

    const parsed = raiseSchema.safeParse(approval.payload);
    if (!parsed.success) return fail('payload must be { scope, id, newCapUsd }');
    const { scope, id, newCapUsd } = parsed.data;
    if (scope === 'org' && id !== orgId) return fail('target organization does not match the approval');

    const now = this.k.clock.now();
    const db = this.k.db;
    const outcome = this.k.sqlite.transaction((): { oldCapUsd: number | null } | 'missing' | 'raced' => {
      // Claim the approval first so the raise is applied at most once.
      const claim = db
        .update(approvals)
        .set({ consumedAt: now })
        .where(and(eq(approvals.orgId, orgId), eq(approvals.id, approvalId), isNull(approvals.consumedAt)))
        .run();
      if (claim.changes !== 1) return 'raced';

      let old: { cap: number | null } | undefined;
      if (scope === 'org') {
        old = db.select({ cap: organizations.budgetMonthlyUsd }).from(organizations).where(eq(organizations.id, orgId)).get();
        if (old) db.update(organizations).set({ budgetMonthlyUsd: newCapUsd, updatedAt: now }).where(eq(organizations.id, orgId)).run();
      } else if (scope === 'dept') {
        const where = and(eq(departments.orgId, orgId), eq(departments.id, id));
        old = db.select({ cap: departments.budgetUsd }).from(departments).where(where).get();
        if (old) db.update(departments).set({ budgetUsd: newCapUsd, updatedAt: now }).where(where).run();
      } else if (scope === 'agent') {
        const where = and(eq(agents.orgId, orgId), eq(agents.id, id));
        old = db.select({ cap: agents.budgetUsd }).from(agents).where(where).get();
        if (old) db.update(agents).set({ budgetUsd: newCapUsd, updatedAt: now }).where(where).run();
      } else {
        const where = and(eq(projects.orgId, orgId), eq(projects.id, id));
        old = db.select({ cap: projects.budgetUsd }).from(projects).where(where).get();
        if (old) db.update(projects).set({ budgetUsd: newCapUsd, updatedAt: now }).where(where).run();
      }
      if (!old) {
        // Nothing was applied, so release the claim.
        db.update(approvals).set({ consumedAt: null }).where(and(eq(approvals.orgId, orgId), eq(approvals.id, approvalId))).run();
        return 'missing';
      }

      this.enforcer.clearMarks(scope, id);
      this.k.audit.record({
        orgId,
        actor: SYSTEM,
        action: 'budget.raised',
        entityKind: scope,
        entityId: id,
        data: { approvalId, approvedBy: approval.decidedBy, oldCapUsd: old.cap, newCapUsd },
      });
      return { oldCapUsd: old.cap };
    })();

    if (outcome === 'raced') return false;
    if (outcome === 'missing') return fail(`${scope} ${id} not found in this organization`);

    if (scope === 'org') this.k.bus.emit('org.updated', { orgId });
    if (scope === 'agent') this.k.bus.emit('agent.updated', { orgId, agentId: id });

    const org = db.select().from(organizations).where(eq(organizations.id, orgId)).get();
    if (org) this.enforcer.resumeUnderCap(org, SYSTEM);
    return true;
  }
}
