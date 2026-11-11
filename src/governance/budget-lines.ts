import { and, eq, gte, isNotNull, sql, type SQL } from 'drizzle-orm';
import { costLedger, projects } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Organization, Project } from '../contracts/rows.js';
import type { BudgetLine } from '../contracts/services.js';
import { monthStart } from '../shared/util.js';

export const SOFT_RATIO = 0.8;
const EPS = 1e-9;

/** spent / cap. A zero cap means "no spend allowed", i.e. already at 100%. */
export function ratioOf(spent: number, cap: number): number {
  return cap > 0 ? spent / cap : 1;
}

export function makeLine(scope: BudgetLine['scope'], id: string, capUsd: number | null, spentUsd: number): BudgetLine {
  const pct = capUsd === null ? null : Math.round(ratioOf(spentUsd, capUsd) * 10_000) / 100;
  return { scope, id, capUsd, spentUsd, pct };
}

/** At or over 100% of a cap. */
export function isBlocked(line: BudgetLine): boolean {
  return line.capUsd !== null && ratioOf(line.spentUsd, line.capUsd) >= 1 - EPS;
}

/** At or over the 80% soft threshold. */
export function isSoft(line: BudgetLine): boolean {
  return line.capUsd !== null && ratioOf(line.spentUsd, line.capUsd) >= SOFT_RATIO - EPS;
}

export const usd = (n: number): string => `$${n.toFixed(2)}`;

/** `YYYY-MM` (UTC) of the budget window containing `now`. */
export function monthKey(now: number): string {
  return new Date(monthStart(now)).toISOString().slice(0, 7);
}

const sumCost = sql<number>`coalesce(sum(${costLedger.costUsd}), 0)`;
const sumSeat = sql<number>`coalesce(sum(${costLedger.seatSeconds}), 0)`;

/** Read side of the cost ledger: month-to-date spend per scope. */
export class SpendReader {
  constructor(private readonly k: Kernel) {}

  windowStart(): number {
    return monthStart(this.k.clock.now());
  }

  private total(orgId: string, extra: SQL | undefined, since: number): number {
    const row = this.k.db
      .select({ v: sumCost })
      .from(costLedger)
      .where(and(eq(costLedger.orgId, orgId), gte(costLedger.ts, since), extra))
      .get();
    return row?.v ?? 0;
  }

  orgSpend(orgId: string, since = this.windowStart()): number {
    return this.total(orgId, undefined, since);
  }
  deptSpend(orgId: string, deptId: string, since = this.windowStart()): number {
    return this.total(orgId, eq(costLedger.deptId, deptId), since);
  }
  agentSpend(orgId: string, agentId: string, since = this.windowStart()): number {
    return this.total(orgId, eq(costLedger.agentId, agentId), since);
  }
  projectSpend(orgId: string, projectId: string, since = this.windowStart()): number {
    return this.total(orgId, eq(costLedger.projectId, projectId), since);
  }

  seatUsed(orgId: string, since = this.windowStart()): number {
    const row = this.k.db
      .select({ v: sumSeat })
      .from(costLedger)
      .where(and(eq(costLedger.orgId, orgId), gte(costLedger.ts, since)))
      .get();
    return row?.v ?? 0;
  }

  /** The cap lines that apply to one unit of work: org, then dept + agent, then project. */
  linesFor(org: Organization, agent: Agent | null, project: Project | null): BudgetLine[] {
    const since = this.windowStart();
    const lines: BudgetLine[] = [makeLine('org', org.id, org.budgetMonthlyUsd, this.orgSpend(org.id, since))];
    if (agent) {
      const dept = this.k.db.query.departments
        .findFirst({ where: (d, { and: a, eq: e }) => a(e(d.orgId, org.id), e(d.id, agent.deptId)) })
        .sync();
      lines.push(makeLine('dept', agent.deptId, dept?.budgetUsd ?? null, this.deptSpend(org.id, agent.deptId, since)));
      lines.push(makeLine('agent', agent.id, agent.budgetUsd, this.agentSpend(org.id, agent.id, since)));
    }
    if (project) {
      lines.push(makeLine('project', project.id, project.budgetUsd, this.projectSpend(org.id, project.id, since)));
    }
    return lines;
  }

  /** Capped projects this agent has spent on in the current window (for resume checks). */
  projectLinesTouchedBy(orgId: string, agentId: string): BudgetLine[] {
    const since = this.windowStart();
    const touched = this.k.db
      .selectDistinct({ projectId: costLedger.projectId })
      .from(costLedger)
      .where(
        and(eq(costLedger.orgId, orgId), eq(costLedger.agentId, agentId), gte(costLedger.ts, since), isNotNull(costLedger.projectId)),
      )
      .all();
    const lines: BudgetLine[] = [];
    for (const t of touched) {
      if (!t.projectId) continue;
      const p = this.k.db.select().from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, t.projectId))).get();
      if (p && p.budgetUsd !== null) lines.push(makeLine('project', p.id, p.budgetUsd, this.projectSpend(orgId, p.id, since)));
    }
    return lines;
  }
}

/** Line with the least headroom among capped lines; null when nothing is capped. */
export function tightestOf(lines: BudgetLine[]): BudgetLine | null {
  let best: BudgetLine | null = null;
  for (const l of lines) {
    if (l.capUsd === null) continue;
    if (best === null || best.capUsd === null || l.capUsd - l.spentUsd < best.capUsd - best.spentUsd) best = l;
  }
  return best;
}
