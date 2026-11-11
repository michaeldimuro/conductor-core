import { and, desc, eq, gte, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { agents, costLedger, departments, projects } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { LedgerRow, Organization } from '../contracts/rows.js';
import type { BudgetLine, BudgetService, BudgetStatus } from '../contracts/services.js';
import { invalid } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import type { BudgetEnforcer, Effect } from './budget-enforcer.js';
import { isBlocked, makeLine, tightestOf, usd, type SpendReader } from './budget-lines.js';
import { parse, requireAgent, requireOrg, requireProject } from './store.js';

const recordSchema = z.object({
  orgId: z.string().min(1),
  agentId: z.string().min(1).nullish(),
  projectId: z.string().min(1).nullish(),
  runId: z.string().min(1).nullish(),
  category: z.string().min(1).max(64).optional(),
  provider: z.string().max(128).nullish(),
  model: z.string().max(256).nullish(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
  subscription: z.boolean().optional(),
  seatSeconds: z.number().nonnegative().optional(),
});

const SCOPE_LABEL: Record<BudgetLine['scope'], string> = { org: 'organization', dept: 'department', agent: 'agent', project: 'project' };

export class Budgets implements BudgetService {
  constructor(
    private readonly k: Kernel,
    private readonly spend: SpendReader,
    private readonly enforcer: BudgetEnforcer,
  ) {}

  check(orgId: string, agentId: string, projectId?: string | null): BudgetStatus {
    const org = requireOrg(this.k, orgId);
    const agent = requireAgent(this.k, orgId, agentId);
    const project = projectId ? requireProject(this.k, orgId, projectId) : null;
    return this.status(org, this.spend.linesFor(org, agent, project));
  }

  private status(org: Organization, lines: BudgetLine[]): BudgetStatus {
    const tightest = tightestOf(lines);
    const remainingUsd = tightest && tightest.capUsd !== null ? Math.max(0, tightest.capUsd - tightest.spentUsd) : null;
    const usedSeconds = this.spend.seatUsed(org.id);
    const capSeconds = org.seatSecondsMonthly;
    const seat = { capSeconds, usedSeconds, allowed: capSeconds === null || usedSeconds < capSeconds };

    const blocked = lines.filter(isBlocked);
    const reasons = blocked.map(
      (l) => `${SCOPE_LABEL[l.scope]} budget exhausted: ${usd(l.spentUsd)} of ${usd(l.capUsd ?? 0)} monthly cap (${l.pct ?? 100}%)`,
    );
    if (!seat.allowed) reasons.push(`seat-time quota exhausted: ${usedSeconds}s of ${capSeconds ?? 0}s this month`);

    const status: BudgetStatus = { allowed: reasons.length === 0, remainingUsd, tightest, lines, seat };
    if (reasons.length) status.reason = reasons.join('; ');
    return status;
  }

  record(raw: Parameters<BudgetService['record']>[0]): BudgetStatus | null {
    const e = parse(recordSchema, raw);
    const org = requireOrg(this.k, e.orgId);
    const agent = e.agentId ? requireAgent(this.k, e.orgId, e.agentId) : null;
    const project = e.projectId ? requireProject(this.k, e.orgId, e.projectId) : null;
    const subscription = e.subscription === true;

    const effects: Effect[] = [];
    this.k.sqlite.transaction(() => {
      this.k.db
        .insert(costLedger)
        .values({
          id: newId('ledger'),
          orgId: org.id,
          deptId: agent?.deptId ?? null,
          agentId: agent?.id ?? null,
          projectId: project?.id ?? null,
          runId: e.runId ?? null,
          category: e.category ?? 'run',
          provider: e.provider ?? null,
          model: e.model ?? null,
          tokensIn: e.tokensIn ?? 0,
          tokensOut: e.tokensOut ?? 0,
          // Subscription runs cost nothing in USD; they draw down the seat-time quota instead.
          costUsd: subscription ? 0 : e.costUsd,
          subscription,
          seatSeconds: subscription ? Math.round(e.seatSeconds ?? 0) : 0,
          ts: this.k.clock.now(),
        })
        .run();
      this.enforcer.evaluate(org, agent, project, effects);
    })();
    for (const fx of effects) fx();

    return agent ? this.status(org, this.spend.linesFor(org, agent, project)) : null;
  }

  summary(orgId: string, opts: { since?: number; until?: number } = {}): ReturnType<BudgetService['summary']> {
    const org = requireOrg(this.k, orgId);
    const since = opts.since ?? this.spend.windowStart();
    if (!Number.isFinite(since) || (opts.until !== undefined && !Number.isFinite(opts.until))) throw invalid('since/until must be timestamps');
    const range: SQL[] = [eq(costLedger.orgId, orgId), gte(costLedger.ts, since)];
    if (opts.until !== undefined) range.push(lt(costLedger.ts, opts.until));
    const where = and(...range);

    const totals = this.k.db
      .select({
        totalUsd: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)`,
        seatSeconds: sql<number>`coalesce(sum(${costLedger.seatSeconds}), 0)`,
      })
      .from(costLedger)
      .where(where)
      .get();

    const byAgent = this.k.db
      .select({
        agentId: sql<string>`${costLedger.agentId}`,
        costUsd: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)`,
        tokensIn: sql<number>`coalesce(sum(${costLedger.tokensIn}), 0)`,
        tokensOut: sql<number>`coalesce(sum(${costLedger.tokensOut}), 0)`,
        runs: sql<number>`count(distinct ${costLedger.runId})`,
      })
      .from(costLedger)
      .where(and(where, isNotNull(costLedger.agentId)))
      .groupBy(costLedger.agentId)
      .orderBy(sql`2 desc`, costLedger.agentId)
      .all();

    const day = sql<string>`strftime('%Y-%m-%d', ${costLedger.ts} / 1000, 'unixepoch')`;
    const byDay = this.k.db
      .select({ day, costUsd: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)` })
      .from(costLedger)
      .where(where)
      .groupBy(day)
      .orderBy(day)
      .all();

    return {
      totalUsd: totals?.totalUsd ?? 0,
      seatSeconds: totals?.seatSeconds ?? 0,
      lines: this.allLines(org),
      byAgent,
      byDay,
    };
  }

  /** Every budget line in the org for the current month: org, departments, agents, projects. */
  private allLines(org: Organization): BudgetLine[] {
    const since = this.spend.windowStart();
    const spentBy = (col: typeof costLedger.deptId | typeof costLedger.agentId | typeof costLedger.projectId): Map<string, number> => {
      const rows = this.k.db
        .select({ id: sql<string>`${col}`, v: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)` })
        .from(costLedger)
        .where(and(eq(costLedger.orgId, org.id), gte(costLedger.ts, since), isNotNull(col)))
        .groupBy(col)
        .all();
      return new Map(rows.map((r) => [r.id, r.v]));
    };
    const byDept = spentBy(costLedger.deptId);
    const byAgent = spentBy(costLedger.agentId);
    const byProject = spentBy(costLedger.projectId);

    const lines: BudgetLine[] = [makeLine('org', org.id, org.budgetMonthlyUsd, this.spend.orgSpend(org.id, since))];
    const depts = this.k.db.select().from(departments).where(eq(departments.orgId, org.id)).orderBy(departments.name).all();
    for (const d of depts) lines.push(makeLine('dept', d.id, d.budgetUsd, byDept.get(d.id) ?? 0));
    const ags = this.k.db.select().from(agents).where(eq(agents.orgId, org.id)).orderBy(agents.name).all();
    for (const a of ags) {
      if (a.status === 'terminated' && !byAgent.has(a.id)) continue;
      lines.push(makeLine('agent', a.id, a.budgetUsd, byAgent.get(a.id) ?? 0));
    }
    const projs = this.k.db.select().from(projects).where(eq(projects.orgId, org.id)).orderBy(projects.name).all();
    for (const p of projs) {
      if (p.status === 'archived' && !byProject.has(p.id)) continue;
      lines.push(makeLine('project', p.id, p.budgetUsd, byProject.get(p.id) ?? 0));
    }
    return lines;
  }

  ledger(orgId: string, opts: { agentId?: string; limit?: number } = {}): LedgerRow[] {
    requireOrg(this.k, orgId);
    const where: SQL[] = [eq(costLedger.orgId, orgId)];
    if (opts.agentId !== undefined) where.push(eq(costLedger.agentId, opts.agentId));
    const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? 100) || 100, 1000));
    return this.k.db
      .select()
      .from(costLedger)
      .where(and(...where))
      .orderBy(desc(costLedger.ts), desc(costLedger.id))
      .limit(limit)
      .all();
  }
}
