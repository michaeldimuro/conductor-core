import { and, eq, gte, inArray, lt, ne, notInArray, or, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Kernel, UtilityModel } from '../contracts/kernel.js';
import type { Agent, Department, Scorecard } from '../contracts/rows.js';
import type { AgentScorecard } from '../contracts/services.js';
import type { OrgService, WorkService } from '../contracts/org-work.js';
import { SYSTEM, type RunGrade } from '../contracts/types.js';
import { agents, departments, issues, runs, scorecards } from '../db/schema/index.js';
import { ConductorError, errorMessage } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { heuristicProposals, type ReviewProposal } from './heuristics.js';
import type { MemoryStore } from './store.js';
import { tag } from './transcript.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** 1970-01-05 was a Monday: weekly buckets are Monday-aligned (UTC). */
const MONDAY_OFFSET = 4 * DAY;
export const weekStartOf = (ts: number): number => ts - ((((ts - MONDAY_OFFSET) % WEEK) + WEEK) % WEEK);

/**
 * Triggers of runs that are not heartbeat-loop work: `chat` is a conversational turn and
 * `system` is the sandboxed skill-eval replay (the runtime's EvalRunner).
 */
export const NON_LOOP_TRIGGERS = ['chat', 'system'] as const;

interface RunRow {
  status: string;
  grade: RunGrade | null;
  costUsd: number;
  steps: number;
  createdAt: number;
  issueId: string | null;
  taskType: string | null;
  issueStatus: string | null;
  reworkCount: number | null;
  reviewOutcome: string | null;
}

interface Stats {
  runs: number;
  issuesClosed: number;
  successRate: number;
  reworkRate: number;
  costPerIssue: number;
  avgSteps: number;
}

function stats(rows: RunRow[]): Stats {
  const n = rows.length;
  const issueMap = new Map<string, RunRow>();
  for (const r of rows) if (r.issueId) issueMap.set(r.issueId, r);
  const touched = [...issueMap.values()];
  const closed = touched.filter((r) => r.issueStatus === 'done').length;
  const reworked = touched.filter((r) => (r.reworkCount ?? 0) > 0 || r.reviewOutcome === 'edited' || r.reviewOutcome === 'rejected').length;
  const cost = rows.reduce((s, r) => s + r.costUsd, 0);
  const success = rows.filter((r) => r.grade?.success ?? r.status === 'succeeded').length;
  const denominator = closed > 0 ? closed : touched.length;
  return {
    runs: n,
    issuesClosed: closed,
    successRate: n > 0 ? success / n : 0,
    reworkRate: touched.length > 0 ? reworked / touched.length : 0,
    costPerIssue: denominator > 0 ? cost / denominator : 0,
    avgSteps: n > 0 ? rows.reduce((s, r) => s + r.steps, 0) / n : 0,
  };
}

const proposalsSchema = z.object({
  proposals: z.array(
    z.object({
      kind: z.enum(['prompt', 'skill', 'role']).catch('prompt'),
      agentId: z.string(),
      title: z.string().min(1).max(200),
      rationale: z.string().max(2000).catch(''),
      change: z.string().max(4000).catch(''),
    }),
  ),
});

export interface ReviewDeps {
  work?: Pick<WorkService, 'createIssue' | 'getIssue'>;
  org?: Pick<OrgService, 'listAgents' | 'listDepts' | 'leadOf'>;
}

/** Scorecards (the "self-improving" signal) and the weekly department review. */
export class Scorecards {
  constructor(
    private readonly kernel: Kernel,
    private readonly store: MemoryStore,
    private readonly utility: UtilityModel,
    private readonly deps: () => ReviewDeps,
  ) {}

  private rows(orgId: string, agentId: string, from: number, to: number): RunRow[] {
    return this.kernel.db
      .select({
        status: runs.status, grade: runs.grade, costUsd: runs.costUsd, steps: runs.steps, createdAt: runs.createdAt, issueId: runs.issueId,
        outcome: runs.outcome, taskType: issues.taskType, issueStatus: issues.status, reworkCount: issues.reworkCount, reviewOutcome: issues.reviewOutcome,
      })
      .from(runs)
      .leftJoin(issues, and(eq(issues.id, runs.issueId), eq(issues.orgId, runs.orgId)))
      .where(
        and(
          eq(runs.orgId, orgId), eq(runs.agentId, agentId), gte(runs.createdAt, from), lt(runs.createdAt, to),
          inArray(runs.status, ['succeeded', 'failed']), or(isNull(runs.outcome), ne(runs.outcome, 'no_work')),
          // Only real heartbeat-loop runs count: chat turns and sandboxed skill-eval replays are not work.
          notInArray(runs.trigger, [...NON_LOOP_TRIGGERS]),
        ),
      )
      .orderBy(runs.createdAt)
      .all();
  }

  scorecard(orgId: string, agentId: string, opts: { days?: number } = {}): AgentScorecard {
    this.store.agent(orgId, agentId);
    const days = opts.days ?? 30;
    if (!Number.isFinite(days) || days <= 0 || days > 3660) throw new ConductorError('validation', 'days must be between 1 and 3660');
    const now = this.kernel.clock.now();
    const rows = this.rows(orgId, agentId, now - days * DAY, now + 1);
    const overall = stats(rows);

    const weeks = new Map<number, RunRow[]>();
    const types = new Map<string, RunRow[]>();
    for (const r of rows) {
      const w = weekStartOf(r.createdAt);
      weeks.set(w, [...(weeks.get(w) ?? []), r]);
      const t = r.taskType ?? 'untyped';
      types.set(t, [...(types.get(t) ?? []), r]);
    }
    return {
      agentId,
      days,
      runs: overall.runs,
      issuesClosed: overall.issuesClosed,
      successRate: overall.successRate,
      reworkRate: overall.reworkRate,
      costPerIssue: overall.costPerIssue,
      trend: [...weeks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([weekStart, rs]) => {
          const s = stats(rs);
          return { weekStart, runs: s.runs, successRate: s.successRate, costPerIssue: s.costPerIssue };
        }),
      byTaskType: [...types.entries()]
        .map(([taskType, rs]) => {
          const s = stats(rs);
          return { taskType, runs: s.runs, successRate: s.successRate, costPerIssue: s.costPerIssue };
        })
        .sort((a, b) => b.runs - a.runs || a.taskType.localeCompare(b.taskType)),
    };
  }

  /** Persist a rolling 7-day snapshot per agent (overall row + one row per task type). */
  snapshotScorecards(orgId: string): Scorecard[] {
    this.store.org(orgId);
    const now = this.kernel.clock.now();
    const periodStart = now - WEEK;
    const out: Scorecard[] = [];
    const active = this.kernel.db.select().from(agents).where(and(eq(agents.orgId, orgId), ne(agents.status, 'terminated'))).all();
    for (const agent of active) {
      const rows = this.rows(orgId, agent.id, periodStart, now + 1);
      if (rows.length === 0) continue;
      const groups: Array<[string | null, RunRow[]]> = [[null, rows]];
      const types = new Map<string, RunRow[]>();
      for (const r of rows) if (r.taskType) types.set(r.taskType, [...(types.get(r.taskType) ?? []), r]);
      groups.push(...types.entries());
      for (const [taskType, rs] of groups) {
        const s = stats(rs);
        const row = this.kernel.db
          .insert(scorecards)
          .values({
            id: newId('scorecard'), orgId, agentId: agent.id, taskType, periodStart, periodEnd: now, runs: s.runs, issuesClosed: s.issuesClosed,
            successRate: s.successRate, reworkRate: s.reworkRate, costPerIssue: s.costPerIssue, avgSteps: s.avgSteps, createdAt: now,
          })
          .returning()
          .get();
        out.push(row);
      }
    }
    return out;
  }

  private depts(orgId: string): Department[] {
    const d = this.deps().org;
    return d ? d.listDepts(orgId) : this.kernel.db.select().from(departments).where(eq(departments.orgId, orgId)).all();
  }

  private members(orgId: string, deptId: string): Agent[] {
    const d = this.deps().org;
    const list = d ? d.listAgents(orgId, { deptId }) : this.kernel.db.select().from(agents).where(and(eq(agents.orgId, orgId), eq(agents.deptId, deptId))).all();
    return list.filter((a) => a.status !== 'terminated');
  }

  private lead(orgId: string, dept: Department, members: Agent[]): Agent | null {
    const d = this.deps().org;
    if (d) return d.leadOf(orgId, dept.id);
    return members.find((a) => a.id === dept.leadAgentId) ?? null;
  }

  /**
   * For each department: its agents' scorecards → the utility model proposes
   * prompt / skill / role changes → filed as unassigned backlog issues
   * (label `weekly-review`) so nothing changes until the owner approves.
   */
  async weeklyReview(orgId: string): Promise<string[]> {
    this.store.org(orgId);
    const work = this.deps().work;
    if (!work) throw new ConductorError('unavailable', 'weekly review needs the work service (not bound)');
    const created: string[] = [];
    for (const dept of this.depts(orgId).filter((d) => d.status === 'active')) {
      const members = this.members(orgId, dept.id);
      const cards = members.map((a) => ({ ...this.scorecard(orgId, a.id, { days: 30 }), agentName: a.name, role: a.role })).filter((c) => c.runs > 0);
      if (cards.length === 0) continue;
      const lead = this.lead(orgId, dept, members);
      const proposals = await this.propose(orgId, dept, lead, cards);
      const names = new Map(members.map((a) => [a.id, a.name]));
      for (const p of proposals.filter((x) => names.has(x.agentId)).slice(0, 5)) {
        try {
          const issue = work.createIssue(
            orgId,
            {
              title: `[Weekly review] ${p.title}`.slice(0, 200),
              body: [
                `**Department:** ${dept.name}`,
                `**Agent:** ${names.get(p.agentId)} (${p.agentId})`,
                `**Proposed change (${p.kind}):** ${p.change}`,
                `**Why:** ${p.rationale}`,
                lead ? `Proposed by department lead ${lead.name}.` : 'Proposed by the weekly review (no department lead set).',
                'Nothing changes until the owner approves this issue.',
              ].join('\n\n'),
              expectedOutput: 'Owner decision: approve (apply the change) or close.',
              taskType: 'weekly-review',
              labels: ['weekly-review', `proposal:${p.kind}`],
              status: 'backlog',
              assigneeAgentId: null,
            },
            lead ? { kind: 'agent', id: lead.id } : SYSTEM,
          );
          created.push(issue.id);
        } catch (e) {
          this.kernel.log.warn({ orgId, deptId: dept.id, err: errorMessage(e) }, 'could not file weekly review proposal');
        }
      }
    }
    this.kernel.audit.record({ orgId, actor: SYSTEM, action: 'review.weekly', entityKind: 'organization', entityId: orgId, data: { issues: created } });
    return created;
  }

  private async propose(orgId: string, dept: Department, lead: Agent | null, cards: Array<AgentScorecard & { agentName: string; role: string }>): Promise<ReviewProposal[]> {
    const fallback = () => heuristicProposals(cards);
    try {
      const res = await this.utility.complete({
        orgId,
        purpose: 'review',
        json: true,
        system:
          `You are ${lead ? `${lead.name}, lead of` : 'reviewing'} the ${dept.name} department. Review each agent's scorecard ` +
          '(success rate, rework rate, cost per issue, weekly trend, by task type) and propose only changes the numbers justify: ' +
          'a prompt change (role/goal/backstory or standing rules), a skill to draft or patch, or a role change. Healthy agents need no proposal.',
        prompt: [
          dept.charter ? `Department charter: ${dept.charter}` : '',
          tag('scorecards', JSON.stringify(cards)),
          'Answer as JSON: {"proposals":[{"kind":"prompt"|"skill"|"role","agentId":"<id from the scorecards>","title":"<short>","rationale":"<numbers that justify it>","change":"<the concrete change>"}]}',
        ]
          .filter(Boolean)
          .join('\n\n'),
      });
      const parsed = proposalsSchema.safeParse(res.json);
      return parsed.success ? parsed.data.proposals : fallback();
    } catch (e) {
      this.kernel.log.warn({ orgId, err: errorMessage(e) }, 'weekly review model call failed; using rule-based proposals');
      return fallback();
    }
  }
}
