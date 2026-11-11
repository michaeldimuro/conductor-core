import { and, eq, inArray } from 'drizzle-orm';
import { agents, departments, projects } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Organization, Project } from '../contracts/rows.js';
import type { BudgetLine } from '../contracts/services.js';
import { SYSTEM, type Actor } from '../contracts/types.js';
import { isBlocked, isSoft, monthKey, ratioOf, SOFT_RATIO, usd, type SpendReader } from './budget-lines.js';
import type { SettingsStore } from './store.js';

/** A bus emission deferred until the surrounding transaction has committed. */
export type Effect = () => void;

type AlertScope = BudgetLine['scope'] | 'seat';

/** Threshold evaluation after spend is recorded: soft alerts, hard stops, resumes. */
export class BudgetEnforcer {
  constructor(
    private readonly k: Kernel,
    private readonly spend: SpendReader,
    private readonly settings: SettingsStore,
  ) {}

  private markKey(level: 'soft' | 'hard', scope: AlertScope, id: string): string {
    return `budget.alert.${level}.${scope}.${id}.${monthKey(this.k.clock.now())}`;
  }

  /** Forget this month's alert marks for a scope (after its cap changed) so new crossings alert again. */
  clearMarks(scope: AlertScope, id: string): void {
    this.settings.delete(this.markKey('soft', scope, id));
    this.settings.delete(this.markKey('hard', scope, id));
  }

  /** Run inside the recording transaction; pushes bus emissions onto `effects`. */
  evaluate(org: Organization, agent: Agent | null, project: Project | null, effects: Effect[]): void {
    for (const line of this.spend.linesFor(org, agent, project)) {
      if (line.capUsd === null) continue;
      if (isBlocked(line)) this.hardStop(org, line, agent, effects);
      else if (isSoft(line)) this.softAlert(org, line, effects);
    }
    this.evaluateSeat(org, effects);
  }

  private scopeName(orgId: string, org: Organization | null, line: BudgetLine): string {
    const db = this.k.db;
    let name: string | undefined;
    if (line.scope === 'org') name = org?.name;
    else if (line.scope === 'dept') name = db.select({ n: departments.name }).from(departments).where(and(eq(departments.orgId, orgId), eq(departments.id, line.id))).get()?.n;
    else if (line.scope === 'agent') name = db.select({ n: agents.name }).from(agents).where(and(eq(agents.orgId, orgId), eq(agents.id, line.id))).get()?.n;
    else name = db.select({ n: projects.name }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, line.id))).get()?.n;
    const label = line.scope === 'org' ? 'organization' : line.scope === 'dept' ? 'department' : line.scope;
    return name ? `${label} ${name}` : `${label} ${line.id}`;
  }

  private softAlert(org: Organization, line: BudgetLine, effects: Effect[]): void {
    const now = this.k.clock.now();
    const pct = line.pct ?? 0;
    if (!this.settings.putIfAbsent(this.markKey('soft', line.scope, line.id), { ts: now, pct })) return;
    const who = this.scopeName(org.id, org, line);
    this.k.audit.record({
      orgId: org.id,
      actor: SYSTEM,
      action: 'budget.alert',
      entityKind: line.scope,
      entityId: line.id,
      data: { level: 'soft', pct, capUsd: line.capUsd, spentUsd: line.spentUsd },
    });
    effects.push(() => {
      this.k.bus.emit('budget.alert', { orgId: org.id, level: 'soft', scope: line.scope, scopeId: line.id, pct });
      this.k.bus.emit('notification', {
        orgId: org.id,
        kind: 'budget',
        title: `Budget alert: ${who} at ${Math.floor(pct)}%`,
        body: `${who} has spent ${usd(line.spentUsd)} of its ${usd(line.capUsd ?? 0)} monthly cap. Agents are paused at 100%.`,
        data: { level: 'soft', scope: line.scope, scopeId: line.id, pct },
      });
    });
  }

  private hardStop(org: Organization, line: BudgetLine, recordingAgent: Agent | null, effects: Effect[]): void {
    const now = this.k.clock.now();
    const pct = line.pct ?? 100;
    const paused = this.pauseAffected(org.id, line, recordingAgent, now);
    const first = this.settings.putIfAbsent(this.markKey('hard', line.scope, line.id), { ts: now, pct });
    // Later spend against an already-stopped cap (an in-flight run ending) stays quiet
    // unless it had to pause someone again.
    if (!first && paused.length === 0) return;

    const who = this.scopeName(org.id, org, line);
    this.k.audit.record({
      orgId: org.id,
      actor: SYSTEM,
      action: 'budget.hard_stop',
      entityKind: line.scope,
      entityId: line.id,
      data: { level: 'hard', pct, capUsd: line.capUsd, spentUsd: line.spentUsd, pausedAgentIds: paused.map((a) => a.id) },
    });
    for (const a of paused) {
      this.k.audit.record({
        orgId: org.id,
        actor: SYSTEM,
        action: 'agent.paused',
        entityKind: 'agent',
        entityId: a.id,
        data: { reason: 'budget', scope: line.scope, scopeId: line.id, pct },
      });
    }
    effects.push(() => {
      this.k.bus.emit('budget.alert', { orgId: org.id, level: 'hard', scope: line.scope, scopeId: line.id, pct });
      for (const a of paused) this.k.bus.emit('agent.paused', { orgId: org.id, agentId: a.id, reason: 'budget' });
      const names = paused.map((a) => a.name).join(', ');
      this.k.bus.emit('notification', {
        orgId: org.id,
        kind: 'budget',
        title: `Budget hard stop: ${who} at ${Math.floor(pct)}%`,
        body:
          `${who} has spent ${usd(line.spentUsd)} of its ${usd(line.capUsd ?? 0)} monthly cap.` +
          (paused.length ? ` Paused: ${names}.` : '') +
          ' Raise the budget to resume.',
        data: { level: 'hard', scope: line.scope, scopeId: line.id, pct, pausedAgentIds: paused.map((a) => a.id) },
      });
    });
  }

  /** agent cap → that agent; dept cap → dept's active agents; org cap → all active agents; project cap → the recording agent. */
  private pauseAffected(orgId: string, line: BudgetLine, recordingAgent: Agent | null, now: number): Array<{ id: string; name: string }> {
    const active = and(eq(agents.orgId, orgId), eq(agents.status, 'active'));
    let where;
    if (line.scope === 'org') where = active;
    else if (line.scope === 'dept') where = and(active, eq(agents.deptId, line.id));
    else if (line.scope === 'agent') where = and(active, eq(agents.id, line.id));
    else if (recordingAgent) where = and(active, eq(agents.id, recordingAgent.id));
    else return [];
    return this.k.db
      .update(agents)
      .set({ status: 'paused', pausedReason: 'budget', updatedAt: now })
      .where(where)
      .returning({ id: agents.id, name: agents.name })
      .all();
  }

  private evaluateSeat(org: Organization, effects: Effect[]): void {
    const cap = org.seatSecondsMonthly;
    if (cap === null) return;
    const used = this.spend.seatUsed(org.id);
    const ratio = ratioOf(used, cap);
    if (ratio < SOFT_RATIO) return;
    const level = ratio >= 1 ? 'hard' : 'soft';
    const pct = Math.round(ratio * 10_000) / 100;
    if (!this.settings.putIfAbsent(this.markKey(level, 'seat', org.id), { ts: this.k.clock.now(), pct })) return;
    this.k.audit.record({
      orgId: org.id,
      actor: SYSTEM,
      action: 'budget.alert',
      entityKind: 'org',
      entityId: org.id,
      data: { level, scope: 'seat', pct, capSeconds: cap, usedSeconds: used },
    });
    effects.push(() => {
      this.k.bus.emit('budget.alert', { orgId: org.id, level, scope: 'seat', scopeId: org.id, pct });
      this.k.bus.emit('notification', {
        orgId: org.id,
        kind: 'budget',
        title: level === 'hard' ? `Seat-time quota exhausted for ${org.name}` : `Seat-time quota at ${Math.floor(pct)}% for ${org.name}`,
        body: `Local-subscription runs have used ${used}s of the ${cap}s monthly seat-time quota.`,
        data: { level, scope: 'seat', scopeId: org.id, pct },
      });
    });
  }

  /**
   * Resume agents paused with reason `budget` whose every applicable cap
   * (org, dept, agent, and capped projects they spent on) is now under 100%.
   * Returns the resumed agent ids.
   */
  resumeUnderCap(org: Organization, actor: Actor = SYSTEM): string[] {
    const candidates = this.k.db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, org.id), eq(agents.status, 'paused'), eq(agents.pausedReason, 'budget')))
      .all();
    const eligible = candidates.filter((a) => {
      const lines = [...this.spend.linesFor(org, a, null), ...this.spend.projectLinesTouchedBy(org.id, a.id)];
      return !lines.some(isBlocked);
    });
    if (eligible.length === 0) return [];
    const resumed = this.k.db
      .update(agents)
      .set({ status: 'active', pausedReason: null, updatedAt: this.k.clock.now() })
      .where(
        and(
          eq(agents.orgId, org.id),
          eq(agents.status, 'paused'),
          eq(agents.pausedReason, 'budget'),
          inArray(agents.id, eligible.map((a) => a.id)),
        ),
      )
      .returning({ id: agents.id })
      .all()
      .map((r) => r.id);
    for (const id of resumed) {
      this.k.audit.record({ orgId: org.id, actor, action: 'agent.resumed', entityKind: 'agent', entityId: id, data: { reason: 'budget' } });
    }
    for (const id of resumed) this.k.bus.emit('agent.resumed', { orgId: org.id, agentId: id });
    return resumed;
  }
}
