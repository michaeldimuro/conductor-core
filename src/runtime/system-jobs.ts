import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { issues, runs, type JobKind } from '../db/schema/index.js';
import { vacuumInto } from '../db/client.js';
import type { Kernel } from '../contracts/kernel.js';
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

export function registerSystemJobs(k: Kernel, d: RuntimeDeps, scheduler: Scheduler): void {
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

  recurring('dream', async () => {
    await eachAgent((orgId, agentId) => d.memory.consolidate(orgId, agentId));
    for (const org of d.org.listOrgs()) d.memory.snapshotScorecards(org.id);
    scheduler.queue.prune();
  });

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

  // A new draft skill goes through the eval gate; winners are activated.
  scheduler.registerHandler('skill_eval', async (job) => {
    const skillId = job.payload.skillId as string;
    const skill = d.skills.get(skillId);
    if (skill.status !== 'draft') return;
    const result = await d.skills.evaluate(skillId);
    if (result.passed) await d.skills.activate(skillId, SYSTEM);
  });
  k.bus.on('skill.changed', (e) => {
    if (e.status !== 'draft') return;
    try {
      const skill = d.skills.get(e.skillId);
      // Only agent-authored drafts with something to replay are auto-evaluated.
      if (skill.author.startsWith('agent:')) {
        scheduler.queue.enqueue({ kind: 'skill_eval', orgId: e.orgId, payload: { skillId: e.skillId }, dedupeKey: `skilleval:${e.skillId}`, runAt: k.clock.now() + 5_000, maxAttempts: 1 });
      }
    } catch {
      /* skill vanished */
    }
  });

  if (d.options?.systemJobs !== false) for (const kind of Object.keys(SYSTEM_CRONS) as JobKind[]) again(kind);
}


/** The morning digest: what happened overnight, what it cost, what needs the owner. */
export function buildDigest(k: Kernel, d: RuntimeDeps, orgId: string, orgName: string): string {
  const since = k.clock.now() - 24 * 3_600_000;
  const closed = k.db.select({ title: issues.title, number: issues.number }).from(issues)
    .where(and(eq(issues.orgId, orgId), eq(issues.status, 'done'), gte(issues.closedAt, since))).all();
  const waiting = k.db.select({ title: issues.title, status: issues.status, reason: issues.blockedReason }).from(issues)
    .where(and(eq(issues.orgId, orgId), inArray(issues.status, ['blocked', 'in_review']))).all();
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
  const review = waiting.filter((w) => w.status === 'in_review');
  const blocked = waiting.filter((w) => w.status === 'blocked');
  if (review.length) lines.push(`In review: ${review.length}`, ...review.slice(0, 5).map((w) => `  • ${w.title}`));
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
