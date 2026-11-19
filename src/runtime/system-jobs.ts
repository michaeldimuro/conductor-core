import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { browserSessions, issues, runs, type JobKind } from '../db/schema/index.js';
import { vacuumInto } from '../db/client.js';
import type { Kernel } from '../contracts/kernel.js';
import { blockedOnOwner } from '../work/owner-blocks.js';
import type { ReviewRegrade } from '../contracts/services.js';
import { SYSTEM } from '../contracts/types.js';
import type { Scheduler } from './scheduler.js';
import { nextCron } from './scheduler.js';
import type { RuntimeDeps } from './types.js';

/** Recurring install-level jobs: kind → cron (local time). */
const SYSTEM_CRONS: Partial<Record<JobKind, string>> = {
  dream: '0 3 * * *', // nightly consolidation
  backup: '30 3 * * *', // nightly VACUUM INTO snapshot
  skill_retire: '0 4 * * *',
  digest: '30 7 * * *', // morning digest
  weekly_review: '0 8 * * 1',
};

const BACKUPS_KEPT = 7;

/**
 * Governance sweep (budget auto-resume + approval expiry). There is no dedicated job kind for it,
 * so it rides on the `dream` (maintenance) kind, told apart by `payload.task`.
 */
const GOVERNANCE_TASK = 'governance_sweep';
const GOVERNANCE_CRON = '*/15 * * * *';
const OPEN_ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'] as const;
export const SKILL_ADAPT_TASK_TYPE = 'skill-adapt';

/** Scheduler hooks the governance context exposes beyond the `Governance` contract. */
interface GovernanceMaintenance {
  resumeBudgetPaused?(orgId: string): string[];
  expireApprovals?(now?: number): unknown[];
}

export interface SystemJobs {
  /** Resolves once every review verdict seen so far has been fed to the learning loop. */
  idle(): Promise<void>;
  /** Detach the bus subscriptions. */
  dispose(): void;
}

export function registerSystemJobs(k: Kernel, d: RuntimeDeps, scheduler: Scheduler): SystemJobs {
  const unsubs: Array<() => void> = [];
  const maintenance = d.governance as typeof d.governance & GovernanceMaintenance;
  const again = (kind: JobKind) => {
    const cron = SYSTEM_CRONS[kind];
    const runAt = cron ? nextCron(cron, k.clock.now()) : null;
    if (runAt !== null) scheduler.queue.enqueue({ kind, runAt, dedupeKey: `sys:${kind}`, maxAttempts: 1 });
  };
  const recurring = (kind: JobKind, fn: () => Promise<void>) =>
    scheduler.registerHandler(kind, async () => {
      try {
        await fn();
      } finally {
        again(kind);
      }
    });
  const eachAgent = async (fn: (orgId: string, agentId: string) => Promise<unknown>) => {
    for (const org of d.org.listOrgs()) {
      if (d.governance.killSwitch.isEngaged(org.id)) continue;
      for (const agent of d.org.listAgents(org.id, { status: 'active' })) {
        await fn(org.id, agent.id).catch((err) => k.log.warn({ err, agentId: agent.id }, 'system job step failed'));
      }
    }
  };

  /** Agents paused at 100% of a cap go back to work once every cap that applies to them has room again. */
  const resumeBudgetPaused = (orgId?: string): string[] => {
    const resumed: string[] = [];
    if (!maintenance.resumeBudgetPaused) return resumed;
    for (const org of d.org.listOrgs()) {
      if (orgId && org.id !== orgId) continue;
      try {
        resumed.push(...maintenance.resumeBudgetPaused(org.id));
      } catch (err) {
        k.log.warn({ err, orgId: org.id }, 'budget auto-resume failed');
      }
    }
    if (resumed.length) k.log.info({ resumed: resumed.length }, 'resumed budget-paused agents');
    return resumed;
  };
  const governanceSweep = (): void => {
    try {
      maintenance.expireApprovals?.(k.clock.now());
    } catch (err) {
      k.log.warn({ err }, 'approval expiry failed');
    }
    resumeBudgetPaused();
  };
  const scheduleGovernance = (): void => {
    const runAt = nextCron(GOVERNANCE_CRON, k.clock.now());
    if (runAt !== null) scheduler.queue.enqueue({ kind: 'dream', runAt, payload: { task: GOVERNANCE_TASK }, dedupeKey: `sys:${GOVERNANCE_TASK}`, maxAttempts: 1 });
  };

  scheduler.registerHandler('dream', async (job) => {
    if (job.payload.task === GOVERNANCE_TASK) {
      // Month rollover (the budget window is a UTC month) and expired approvals: checked on the clock.
      try {
        governanceSweep();
      } finally {
        scheduleGovernance();
      }
      return;
    }
    try {
      await eachAgent((orgId, agentId) => d.memory.consolidate(orgId, agentId));
      for (const org of d.org.listOrgs()) d.memory.snapshotScorecards(org.id);
      scheduler.queue.prune();
    } finally {
      again('dream');
    }
  });
  // A cap edit (org / dept / agent / project, or an approved budget raise) can make room at once.
  unsubs.push(k.bus.on('org.updated', (e) => void resumeBudgetPaused(e.orgId)));
  unsubs.push(k.bus.on('agent.updated', (e) => void resumeBudgetPaused(e.orgId)));
  unsubs.push(k.bus.on('budget.updated', (e) => void resumeBudgetPaused(e.orgId)));
  unsubs.push(k.bus.on('approval.decided', (e) => void (e.status === 'approved' && resumeBudgetPaused(e.orgId))));

  recurring('backup', async () => {
    const dir = k.paths.ensure(k.paths.backups);
    const stamp = new Date(k.clock.now()).toISOString().slice(0, 10);
    const dest = join(dir, `conductor-${stamp}.db`);
    rmSync(dest, { force: true });
    vacuumInto(k.sqlite, dest);
    const old = readdirSync(dir).filter((f) => /^conductor-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(BACKUPS_KEPT);
    for (const f of old) rmSync(join(dir, f), { force: true });
    k.audit.record({ orgId: null, actor: SYSTEM, action: 'backup.created', data: { file: dest } });
  });

  recurring('skill_retire', async () => {
    const retired = await d.skills.retireStale(k.clock.now());
    if (retired.length) k.log.info({ retired: retired.length }, 'retired stale skills');
  });

  recurring('weekly_review', async () => {
    for (const org of d.org.listOrgs()) {
      await d.memory.weeklyReview(org.id).catch((err) => k.log.warn({ err, orgId: org.id }, 'weekly review failed'));
    }
  });

  recurring('digest', async () => {
    for (const org of d.org.listOrgs()) {
      const text = buildDigest(k, d, org.id, org.name);
      k.bus.emit('notification', { orgId: org.id, kind: 'digest', title: `Morning digest — ${org.name}`, body: text });
    }
  });

  // Post-run reflection (step 8) runs off the run slot so the agent frees up immediately.
  scheduler.registerHandler('reflect', async (job) => {
    const runId = job.payload.runId as string;
    const orgId = job.orgId!;
    const reflection = await d.memory.reflect(orgId, runId);
    const run = k.db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.orgId, orgId))).get();
    const skillIds = (job.payload.skillIds as string[] | undefined) ?? [];
    if (run && skillIds.length) {
      await d.skills.recordUsage({
        orgId, runId, agentId: run.agentId, skillIds, success: reflection.grade.success,
        humanEdited: reflection.grade.reviewOutcome === 'edited', costUsd: run.costUsd, steps: run.steps,
      });
    }
  });

  // ── Review verdicts → learning ─────────────────────────────────────────
  // Reflection runs right after the run, before anyone reviewed the work. When the verdict lands the
  // run is re-graded (scorecards read the grade), the usages of the skills it loaded are corrected
  // (which can auto-revert a regressed version) and the agent is asked to patch a skill a human had to correct.
  const reviews = new Map<string, Promise<void>>();
  const onReview = (orgId: string, issueId: string): void => {
    if (!d.memory.applyReview) return;
    const key = `${orgId}:${issueId}`;
    const next: Promise<void> = (reviews.get(key) ?? Promise.resolve())
      .then(() => applyReview(orgId, issueId))
      .catch((err) => k.log.warn({ err, orgId, issueId }, 'could not feed the review verdict to the learning loop'))
      .finally(() => {
        if (reviews.get(key) === next) reviews.delete(key);
      });
    reviews.set(key, next);
  };
  const applyReview = async (orgId: string, issueId: string): Promise<void> => {
    const regrade = await d.memory.applyReview?.(orgId, issueId);
    if (!regrade) return;
    const outcome = regrade.grade.reviewOutcome;
    const res = (await d.skills.recordReview?.({ orgId, runId: regrade.runId, success: regrade.grade.success, humanEdited: outcome === 'edited' })) ?? { updated: [], reverted: [] };
    if (outcome !== 'edited' && outcome !== 'rejected') return;
    for (const skillId of res.updated) {
      if (!res.reverted.includes(skillId)) requestSkillPatch(k, d, regrade, skillId, outcome);
    }
  };
  unsubs.push(k.bus.on('issue.reviewed', (e) => onReview(e.orgId, e.issueId)));
  // The work context reports a verdict as a status change (accepted/edited → done, rejected → todo);
  // `applyReview` is idempotent and ignores issues without a verdict.
  unsubs.push(k.bus.on('issue.updated', (e) => void ((e.status === 'done' || e.status === 'todo') && onReview(e.orgId, e.issueId))));

  // The eval gate: a new draft skill, and a patch to a live skill (a pending candidate version),
  // are evaluated; winners are activated, everything undecided goes to the owner.
  /** Version of the patch waiting behind a live skill, if any (the newest version is ahead of the live one). */
  const pendingCandidate = (skill: { id: string; status: string; version: number }): number | null => {
    if (skill.status !== 'active' || typeof d.skills.history !== 'function') return null;
    const newest = d.skills.history(skill.id)[0];
    return newest && newest.version > skill.version && !newest.eval ? newest.version : null;
  };
  scheduler.registerHandler('skill_eval', async (job) => {
    const skillId = job.payload.skillId as string;
    const skill = d.skills.get(skillId);
    const candidate = pendingCandidate(skill);
    if (skill.status !== 'draft' && candidate === null) return;
    const what = candidate === null ? `Skill "${skill.name}"` : `The patch (v${candidate}) to skill "${skill.name}"`;
    const stays = candidate === null ? 'it stays a draft' : `v${skill.version} stays live`;
    let result: Awaited<ReturnType<typeof d.skills.evaluate>>;
    try {
      result = await d.skills.evaluate(skillId);
    } catch (err) {
      // A patch that cannot be evaluated (no eval case, no runner) must not wait unseen behind the live version.
      if (candidate !== null) {
        k.bus.emit('notification', {
          orgId: skill.orgId, kind: 'skill_review', title: `${what} needs your review`,
          body: `It could not be evaluated (${err instanceof Error ? err.message : String(err)}), so ${stays} until you review it.`,
          data: { skillId, candidateVersion: candidate },
        });
      }
      throw err;
    }
    if (result.passed) await d.skills.activate(skillId, SYSTEM);
    else if (result.needsReview) {
      k.bus.emit('notification', {
        orgId: skill.orgId, kind: 'skill_review', title: `${what} needs your review`,
        body: `Its evaluation could not be decided automatically, so ${stays} until you review it.\n${result.notes ?? ''}`.trim(),
        data: { skillId, score: result.score, ...(candidate !== null ? { candidateVersion: candidate } : {}) },
      });
    }
  });
  unsubs.push(k.bus.on('skill.changed', (e) => {
    if (e.status !== 'draft' && e.status !== 'active') return;
    try {
      const skill = d.skills.get(e.skillId);
      const candidate = pendingCandidate(skill);
      // Agent-authored drafts with something to replay are auto-evaluated; so is every pending patch of a live skill.
      if (candidate !== null || (skill.status === 'draft' && skill.author.startsWith('agent:'))) {
        const dedupeKey = candidate === null ? `skilleval:${e.skillId}` : `skilleval:${e.skillId}:v${candidate}`;
        scheduler.queue.enqueue({ kind: 'skill_eval', orgId: e.orgId, payload: { skillId: e.skillId }, dedupeKey, runAt: k.clock.now() + 5_000, maxAttempts: 1 });
      }
    } catch {
      /* skill vanished */
    }
  }));

  if (d.options?.systemJobs !== false) {
    for (const kind of Object.keys(SYSTEM_CRONS) as JobKind[]) again(kind);
    scheduleGovernance();
  }

  return {
    async idle() {
      while (reviews.size > 0) await Promise.allSettled([...reviews.values()]);
    },
    dispose() {
      for (const off of unsubs.splice(0)) off();
    },
  };
}

/**
 * Adapt (skills step 5): a human had to correct work that used one of the agent's own skills, so
 * the agent gets an issue to patch it. One open request per skill; requests never breed requests.
 */
function requestSkillPatch(k: Kernel, d: RuntimeDeps, regrade: ReviewRegrade, skillId: string, outcome: 'edited' | 'rejected'): void {
  try {
    const skill = d.skills.get(skillId);
    // `skill_manage` only reaches the agent's own scope; wider skills are the owner's / lead's to change.
    if (skill.status !== 'active' || !skill.orgId) return;
    if (skill.scope !== 'agent' || skill.scopeId !== regrade.agentId) return;
    const agent = d.org.findAgent(skill.orgId, regrade.agentId);
    if (!agent || agent.status === 'terminated') return;
    const orgId = agent.orgId;
    const source = d.work.findIssue(orgId, regrade.issueId);
    if (!source || source.taskType === SKILL_ADAPT_TASK_TYPE) return;
    const label = `skill:${skill.id}`;
    if (d.work.listIssues(orgId, { label, status: [...OPEN_ISSUE_STATUSES], limit: 1 }).length > 0) return;
    const created = d.work.createIssue(
      orgId,
      {
        title: `Patch skill "${skill.name}": the reviewer ${outcome} the result of #${source.number}`.slice(0, 200),
        body: [
          `Your work on #${source.number} ("${source.title}") used the skill **${skill.name}** (v${skill.version}) and the reviewer ${outcome === 'edited' ? 'had to edit the result' : 'rejected it'}.`,
          'Read the review comment on that issue, work out what the skill got wrong or left out, and patch it with `skill_manage` (action `patch`).',
          'If the skill was not the cause, say so in a comment and close this issue.',
        ].join('\n\n'),
        expectedOutput: `The skill "${skill.name}" is patched so the correction is not needed next time, or a comment explains why no change is needed.`,
        taskType: SKILL_ADAPT_TASK_TYPE,
        labels: [SKILL_ADAPT_TASK_TYPE, label],
        assigneeAgentId: agent.id,
      },
      SYSTEM,
    );
    k.audit.record({
      orgId, actor: SYSTEM, action: 'skill.patch_requested', entityKind: 'skill', entityId: skill.id, runId: regrade.runId, issueId: created.id,
      data: { name: skill.name, version: skill.version, reviewOutcome: outcome, sourceIssueId: source.id },
    });
  } catch (err) {
    k.log.warn({ err, skillId }, 'could not request a skill patch');
  }
}


/** The morning digest: what happened overnight, what it cost, what needs the owner. */
export function buildDigest(k: Kernel, d: RuntimeDeps, orgId: string, orgName: string): string {
  const since = k.clock.now() - 24 * 3_600_000;
  const closed = k.db.select({ title: issues.title, number: issues.number }).from(issues)
    .where(and(eq(issues.orgId, orgId), eq(issues.status, 'done'), gte(issues.closedAt, since))).all();
  const open = k.db.select({ id: issues.id, parentIssueId: issues.parentIssueId, title: issues.title, status: issues.status, blockedReason: issues.blockedReason, blockedBy: issues.blockedBy, reviewerAgentId: issues.reviewerAgentId })
    .from(issues).where(and(eq(issues.orgId, orgId), inArray(issues.status, ['backlog', 'todo', 'in_progress', 'in_review', 'blocked']))).all();
  const runStats = k.db.select({ n: sql<number>`count(*)`, failed: sql<number>`sum(case when ${runs.status} = 'failed' then 1 else 0 end)` })
    .from(runs).where(and(eq(runs.orgId, orgId), gte(runs.createdAt, since), sql`${runs.outcome} is not 'no_work'`)).get();
  const spend = d.governance.budgets.summary(orgId, { since });
  const pending = d.governance.approvals.list(orgId, { status: 'pending' });

  const lines = [
    `${orgName} — last 24 hours`,
    `Runs: ${runStats?.n ?? 0} (${runStats?.failed ?? 0} failed) · Spend: $${spend.totalUsd.toFixed(2)}${spend.seatSeconds ? ` + ${Math.round(spend.seatSeconds / 60)} min seat time` : ''}`,
    `Issues closed: ${closed.length}`,
    ...closed.slice(0, 10).map((c) => `  ✓ #${c.number} ${c.title}`),
  ];
  if (pending.length) lines.push(`Approvals waiting on you: ${pending.length}`, ...pending.slice(0, 5).map((a) => `  • ${a.title}`));
  // Blocked work and reviews are listed only when the next step is the owner's, the same rule as the Needs-you inbox.
  const signIns = k.db.select({ issueId: browserSessions.issueId, expiresAt: browserSessions.expiresAt }).from(browserSessions)
    .where(and(eq(browserSessions.orgId, orgId), inArray(browserSessions.status, ['pending', 'active']))).all();
  const decided = {
    approvalIssues: new Set(pending.flatMap((a) => (a.issueId ? [a.issueId] : []))),
    takeoverIssues: new Set(signIns.flatMap((t) => (t.issueId && t.expiresAt > k.clock.now() ? [t.issueId] : []))),
  };
  // Reviews an agent reviewer owns are not the owner's to do; only the ones waiting on the owner are listed.
  const review = open.filter((w) => w.status === 'in_review' && !w.reviewerAgentId);
  const blocked = open.filter((w) => w.status === 'blocked' && blockedOnOwner(w, open, decided)).map((w) => ({ title: w.title, reason: w.blockedReason }));
  const waiting = [...review, ...blocked];
  if (review.length) lines.push(`Ready for your review: ${review.length}`, ...review.slice(0, 5).map((w) => `  • ${w.title}`));
  if (blocked.length) lines.push(`Blocked: ${blocked.length}`, ...blocked.slice(0, 5).map((w) => `  • ${w.title}${w.reason ? ` (${w.reason})` : ''}`));
  if (!closed.length && !pending.length && !waiting.length && !(runStats?.n ?? 0)) lines.push('Quiet night — nothing to report.');
  return lines.join('\n');
}

/** `caffeinate`-style power assertion held only while runs are active (macOS). */
export class PowerAssertion {
  private child: ChildProcess | null = null;

  constructor(private readonly enabled: boolean) {}

  set(active: boolean): void {
    if (!this.enabled || process.platform !== 'darwin') return;
    if (active && !this.child) {
      try {
        // -i: prevent idle sleep; -w: release automatically if the daemon dies.
        this.child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
        this.child.on('exit', () => (this.child = null));
        this.child.on('error', () => (this.child = null));
        this.child.unref();
      } catch {
        this.child = null;
      }
    } else if (!active && this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }
}
