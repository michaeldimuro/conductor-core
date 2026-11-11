import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Department, Issue, Organization, Run } from '../contracts/rows.js';
import type { RunContext, RunEvent } from '../contracts/adapter.js';
import type { ToolCallContext } from '../contracts/tools.js';
import type { WorkerJob, RecallBundle } from '../contracts/services.js';
import type { CapabilitySnapshot } from '../contracts/types.js';
import { errorMessage } from '../shared/errors.js';
import { RunJournal } from './journal.js';
import { buildSystemPrompt, buildTaskPrompt, type TaskPromptInput } from './prompt.js';
import { effectiveBinding, resolveChain, NATIVE_SKILL_ADAPTERS } from './binding.js';
import { settleIssue } from './settle.js';
import type { RunHandle, SupervisedResult, Supervisor } from './supervisor.js';
import type { RunRequest, RunSummary, RuntimeDeps } from './types.js';

const RUN_TOKEN_GRACE_MS = 10 * 60_000;

export interface ActiveRun {
  run: Run;
  org: Organization;
  agent: Agent;
  dept: Department;
  issueId: string | null;
  checkedOut: boolean;
  workspacePath: string;
  provider: string;
  handle: RunHandle | null;
  secrets: string[];
  cancelReason: string | null;
  paused: boolean;
  mode: NonNullable<RunRequest['mode']>;
}

const EMPTY_RECALL: RecallBundle = { profile: '', ownerModel: '', memories: [] };

/**
 * Executes ONE run of the heartbeat loop (PRD "The heartbeat loop"):
 * wake+resolve → recall → inbox → checkout → plan/execute → report → (reflect is queued).
 */
export class RunExecutor {
  readonly active = new Map<string, ActiveRun>();
  /** Hook the scheduler sets to queue the post-run reflection. */
  onFinished: (run: Run, mode: ActiveRun['mode']) => void = () => {};

  constructor(
    private readonly k: Kernel,
    private readonly d: RuntimeDeps,
    readonly journal: RunJournal,
    private readonly supervisor: Supervisor,
  ) {}

  /** Agents currently mid-run (per-agent concurrency is 1). */
  busyAgents(): Set<string> {
    return new Set([...this.active.values()].filter((a) => a.mode !== 'eval').map((a) => a.agent.id));
  }

  toolContext(runId: string): ToolCallContext | null {
    const a = this.active.get(runId);
    if (!a) return null;
    return {
      orgId: a.org.id, agentId: a.agent.id, deptId: a.dept.id, runId, issueId: a.issueId,
      workspacePath: a.workspacePath, autonomyLevel: a.agent.autonomyLevel,
    };
  }

  async execute(req: RunRequest): Promise<RunSummary> {
    const mode = req.mode ?? 'loop';
    const started = this.k.clock.now();
    const skip = (reason: string): RunSummary => ({
      runId: null, outcome: 'skipped', finalText: '', provider: null, costUsd: 0, steps: 0, tokens: 0, wallMs: 0, skipped: reason,
    });

    // ── 1. Wake and resolve ────────────────────────────────────────────────
    const org = this.d.org.getOrg(req.orgId);
    const agent = this.d.org.getAgent(req.orgId, req.agentId);
    const dept = this.d.org.getDept(req.orgId, agent.deptId);
    if (org.status !== 'active') return skip('organization archived');
    if (this.d.governance.killSwitch.isEngaged(org.id)) return skip('kill switch engaged');
    if (agent.status !== 'active') return skip(`agent ${agent.status}${agent.pausedReason ? ` (${agent.pausedReason})` : ''}`);

    const pinned = req.issueId ? this.d.work.findIssue(org.id, req.issueId) : null;
    const budget = this.d.governance.budgets.check(org.id, agent.id, pinned?.projectId ?? null);
    // Dollar caps stop everyone; the seat-time quota only applies to subscription (local CLI) runs.
    const overCap = budget.lines.some((l) => l.capUsd !== null && l.spentUsd >= l.capUsd);
    const seatBlocked = !budget.seat.allowed && NATIVE_SKILL_ADAPTERS.has(effectiveBinding(agent, org).adapter);
    if (overCap || seatBlocked) return skip(`over budget: ${budget.reason ?? (overCap ? 'cap reached' : 'seat-time quota exhausted')}`);

    if (mode === 'loop') {
      const lastHour = this.journal.countSince(agent.id, this.k.clock.now() - 3_600_000);
      if (lastHour >= agent.maxRunsPerHour) {
        this.k.audit.record({ orgId: org.id, actor: { kind: 'system', id: 'runtime' }, action: 'run.rate_limited', entityKind: 'agent', entityId: agent.id, data: { lastHour } });
        return skip(`max runs per hour reached (${agent.maxRunsPerHour})`);
      }
    }

    // ── 3–4. Inbox and atomic checkout ─────────────────────────────────────
    // (Done before the run row exists so an idle heartbeat costs nothing.)
    const inbox = mode === 'loop' ? this.d.work.inbox(org.id, agent.id) : null;
    const candidates: Issue[] = [];
    if (mode === 'loop') {
      if (pinned && pinned.assigneeAgentId === agent.id) candidates.push(pinned);
      for (const i of inbox?.issues ?? []) if (i.id !== pinned?.id) candidates.push(i);
    }
    const goals = mode === 'loop' ? this.d.work.listGoals(org.id, { ownerAgentId: agent.id, status: 'active' }) : [];
    const hasReplies = !!inbox && (inbox.mentions.length > 0 || inbox.newComments.length > 0);
    const proactive = agent.autonomyLevel >= 2 && goals.length > 0 && req.trigger === 'heartbeat';
    if (mode === 'loop' && candidates.length === 0 && !hasReplies && !proactive && !req.prompt) {
      return skip('no work');
    }

    // Checkout first (it only needs a run id) so losing every race leaves no trace.
    const runId = this.journal.newRunId();
    let issue: Issue | null = null;
    let checkedOut = false;
    if (mode === 'loop') {
      for (const c of candidates) {
        if (this.d.work.checkout(org.id, c.id, runId)) {
          issue = this.d.work.getIssue(org.id, c.id);
          checkedOut = true;
          break;
        }
      }
      if (!issue && !hasReplies && !proactive && !req.prompt) return skip('no work (nothing could be checked out)');
    } else if (pinned) {
      issue = pinned;
    }

    const run = this.journal.create({ id: runId, orgId: org.id, orgSlug: org.slug, agentId: agent.id, issueId: issue?.id ?? null, trigger: req.trigger });
    const entry: ActiveRun = {
      run, org, agent, dept, issueId: issue?.id ?? null, checkedOut, workspacePath: '', provider: '',
      handle: null, secrets: [], cancelReason: null, paused: false, mode,
    };
    this.active.set(run.id, entry);

    let result: SupervisedResult;
    let evalDir: string | null = null;
    try {
      // Playbook issues expand into their steps instead of being worked directly.
      if (issue && entry.checkedOut && issue.playbookId && this.d.work.listIssues(org.id, { parentIssueId: issue.id, limit: 1 }).length === 0) {
        const children = this.d.work.runPlaybook(org.id, issue.playbookId, issue.id, { kind: 'system', id: 'runtime' });
        this.d.work.addComment(org.id, issue.id, { body: `Playbook started: ${children.length} step issue(s) created.`, runId: run.id }, { kind: 'system', id: 'runtime' });
        this.d.work.release(org.id, issue.id, run.id, { status: 'blocked', blockedReason: 'waiting_on_children' });
        entry.checkedOut = false;
        this.finishRun(entry, null, 'completed', started);
        return { runId: run.id, outcome: 'completed', finalText: 'playbook expanded', provider: null, costUsd: 0, steps: 0, tokens: 0, wallMs: 0 };
      }

      // ── Capability snapshot (skills, connectors, budget) ─────────────────
      const binding = effectiveBinding(agent, org);
      const { chain, skipped } = await resolveChain(this.k, this.d.registry, binding, org.slug);
      if (chain.length === 0) throw new Error(`no usable provider for ${agent.name}: ${skipped.join('; ') || 'empty binding'}`);
      const primary = chain[0]!;
      entry.provider = primary.adapterId;
      entry.secrets = chain.flatMap((c) => Object.values(c.secrets));

      const skills = mode === 'eval' ? (req.evalSkills ?? []) : this.d.skills.resolveForAgent(org.id, agent.id);
      const connectors = mode === 'eval' ? [] : await this.d.connectors.snapshot(org.id, agent.id);
      const snapshot: CapabilitySnapshot = {
        resolvedAt: this.k.clock.now(),
        skills: skills.map((s) => ({ id: s.id, name: s.name, scope: s.scope, version: s.version, contentHash: '' })),
        connectors,
        budget: { remainingUsd: budget.remainingUsd, capUsd: budget.tightest?.capUsd ?? null, tightestScope: budget.tightest?.scope ?? null },
        autonomyLevel: agent.autonomyLevel,
        provider: { adapter: primary.adapterId, model: primary.model },
      };
      this.journal.snapshot(run.id, snapshot);
      this.journal.update(run.id, { provider: primary.adapterId, model: primary.model });

      // ── 2. Recall ────────────────────────────────────────────────────────
      this.journal.setPhase(run.id, 'recall');
      const recall =
        mode === 'eval'
          ? EMPTY_RECALL
          : await this.d.memory
              .recall(org.id, agent.id, { title: issue?.title ?? req.prompt ?? agent.goal, body: issue?.body ?? '', taskType: issue?.taskType ?? null })
              .catch((err) => {
                this.k.log.warn({ err, runId: run.id }, 'memory recall failed; continuing without it');
                return EMPTY_RECALL;
              });

      // ── Workspace ────────────────────────────────────────────────────────
      if (mode === 'eval') {
        const root = this.k.paths.ensure(join(this.k.paths.runDir, 'evals'));
        evalDir = mkdtempSync(join(root, 'eval-'));
        entry.workspacePath = evalDir;
      } else {
        const project = issue?.projectId ? this.d.work.getProject(org.id, issue.projectId) : null;
        entry.workspacePath = project?.workspacePath ?? this.k.paths.agentWorkspace(org.slug, agent.slug);
        mkdirSync(entry.workspacePath, { recursive: true });
      }

      // ── 5–6. Plan + execute ──────────────────────────────────────────────
      const task: TaskPromptInput = { mode: 'proactive', orgSlug: org.slug, triggerNote: req.triggerNote, goals };
      if (mode !== 'loop' || (req.prompt && !issue)) {
        task.mode = mode === 'chat' ? 'chat' : 'custom';
        task.customPrompt = req.prompt ?? '';
        task.issue = issue;
      } else if (issue) {
        task.mode = 'issue';
        task.issue = issue;
        task.goal = issue.goalId ? this.d.work.getGoal(org.id, issue.goalId) : null;
        task.parent = issue.parentIssueId ? this.d.work.findIssue(org.id, issue.parentIssueId) : null;
        task.children = this.d.work.listIssues(org.id, { parentIssueId: issue.id });
        task.comments = this.d.work.listComments(org.id, issue.id);
        if (req.prompt) task.triggerNote = [req.triggerNote, req.prompt].filter(Boolean).join(' — ');
      } else if (hasReplies && inbox) {
        task.mode = 'inbox';
        task.inbox = inbox;
      }

      const ttl = agent.maxWallMs + RUN_TOKEN_GRACE_MS;
      const runToken = this.d.governance.tokens.issueRunToken(org.id, agent.id, run.id, ttl);
      entry.secrets.push(runToken);
      const baseUrl = this.d.baseUrl();

      const ctx: RunContext = {
        runId: run.id, orgId: org.id, agentId: agent.id, issueId: issue?.id ?? null,
        systemPrompt: buildSystemPrompt({
          org, dept, agent, recall, skills,
          manager: this.d.org.managerOf(org.id, agent.id),
          reports: this.d.org.reportsOf(org.id, agent.id),
          budgetRemainingUsd: budget.remainingUsd,
          nativeSkills: NATIVE_SKILL_ADAPTERS.has(primary.adapterId),
        }),
        prompt: buildTaskPrompt(task),
        model: primary.model, config: primary.config, secrets: primary.secrets,
        skills,
        mcpEndpoints: mode === 'eval' ? [] : [{ name: 'conductor', url: `${baseUrl}/mcp`, headers: { Authorization: `Bearer ${runToken}` } }],
        workspacePath: entry.workspacePath,
        budgetCapUsd: budget.remainingUsd,
        maxSteps: agent.maxSteps, maxWallMs: agent.maxWallMs,
        runToken, apiBaseUrl: baseUrl,
        resumeSessionId: req.resumeSessionId,
      };
      const job: WorkerJob = { adapterId: primary.adapterId, ctx, chain };

      this.journal.setPhase(run.id, 'execute');
      this.k.bus.emit('run.started', { orgId: org.id, runId: run.id, agentId: agent.id, issueId: entry.issueId });
      this.k.audit.record({
        orgId: org.id, actor: { kind: 'agent', id: agent.id, runId: run.id }, action: 'run.started', entityKind: 'run', entityId: run.id,
        runId: run.id, issueId: entry.issueId ?? undefined, data: { trigger: req.trigger, provider: primary.adapterId, model: primary.model, mode, skippedProviders: skipped },
      });
      for (const s of skipped) this.journal.append(run, { type: 'status', status: `provider skipped — ${s}` });

      if (entry.cancelReason) {
        result = cancelledBeforeStart(job);
      } else {
        const handle = this.supervisor.start(job, (e) => this.onEvent(entry, e));
        entry.handle = handle;
        // A cancel can land between the decision to start and the handle existing.
        if (entry.cancelReason) void handle.cancel(entry.cancelReason);
        if (handle.pid) this.journal.update(run.id, { pid: handle.pid });
        result = await handle.done;
        if (entry.cancelReason && result.outcome === 'completed') result = { ...result, outcome: 'cancelled' };
      }
    } catch (err) {
      this.k.log.error({ err, runId: run.id }, 'run failed before/while executing');
      result = {
        outcome: 'failed', finalText: '', steps: 0, adapterId: entry.provider, model: null,
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 },
        error: { kind: 'other', message: errorMessage(err) },
      };
    }

    // ── 7. Report ──────────────────────────────────────────────────────────
    const summary = await this.report(entry, result, started);
    if (evalDir) rmSync(evalDir, { recursive: true, force: true });
    return summary;
  }

  private onEvent(entry: ActiveRun, e: RunEvent): void {
    this.journal.append(entry.run, e, entry.secrets);
    if (e.type === 'session') this.journal.update(entry.run.id, { sessionId: e.sessionId });
  }

  private async report(entry: ActiveRun, result: SupervisedResult, started: number): Promise<RunSummary> {
    const { run, org, agent } = entry;
    this.journal.setPhase(run.id, 'report');
    const outcome = entry.cancelReason && result.outcome !== 'completed' ? 'cancelled' : result.outcome;
    const u = result.usage;

    try {
      if (u.costUsd > 0 || u.tokensIn > 0 || u.tokensOut > 0 || u.seatSeconds > 0) {
        const issue = entry.issueId ? this.d.work.findIssue(org.id, entry.issueId) : null;
        this.d.governance.budgets.record({
          orgId: org.id, agentId: agent.id, projectId: issue?.projectId ?? null, runId: run.id,
          category: entry.mode === 'eval' ? 'eval' : 'run', provider: result.adapterId, model: result.model,
          tokensIn: u.tokensIn, tokensOut: u.tokensOut, costUsd: u.costUsd, subscription: u.subscription, seatSeconds: u.seatSeconds,
        });
      }
    } catch (err) {
      this.k.log.error({ err, runId: run.id }, 'cost recording failed');
    }

    if (entry.issueId && entry.checkedOut) {
      try {
        settleIssue(this.k, this.d, this.journal, {
          orgId: org.id, issueId: entry.issueId, runId: run.id, agent, outcome, finalText: result.finalText,
          errorMessage: entry.cancelReason ?? result.error?.message ?? null,
        });
      } catch (err) {
        this.k.log.error({ err, runId: run.id }, 'issue settlement failed; releasing lock');
        this.d.work.releaseAllForRun(org.id, run.id, 'todo');
      }
    }
    if (entry.mode === 'loop') this.d.work.markInboxSeen(org.id, agent.id);

    this.finishRun(entry, result, outcome, started);
    return {
      runId: run.id, outcome, finalText: result.finalText, provider: result.adapterId || null,
      costUsd: u.costUsd, steps: result.steps, tokens: u.tokensIn + u.tokensOut, wallMs: this.k.clock.now() - started,
    };
  }

  private finishRun(entry: ActiveRun, result: SupervisedResult | null, outcome: string, _started: number): void {
    const { run, org, agent } = entry;
    const ok = outcome === 'completed' || outcome === 'no_work';
    this.journal.finish(run.id, {
      status: outcome === 'cancelled' ? 'cancelled' : ok ? 'succeeded' : 'failed',
      outcome, phase: 'done',
      provider: result?.adapterId || entry.provider || null,
      model: result?.model ?? null,
      tokensIn: result?.usage.tokensIn ?? 0, tokensOut: result?.usage.tokensOut ?? 0,
      costUsd: result?.usage.costUsd ?? 0, subscription: result?.usage.subscription ?? false, seatSeconds: result?.usage.seatSeconds ?? 0,
      steps: result?.steps ?? 0,
      error: entry.cancelReason ?? result?.error?.message ?? null,
      ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
    });
    this.active.delete(run.id);
    this.d.governance.tokens.revokeRunTokens(run.id);
    void this.d.connectors.endRun(run.id).catch((err) => this.k.log.warn({ err }, 'connector endRun failed'));
    void this.d.browser?.endRun(run.id).catch((err) => this.k.log.warn({ err }, 'browser endRun failed'));

    if (outcome !== 'no_work') {
      this.k.audit.record({
        orgId: org.id, actor: { kind: 'agent', id: agent.id, runId: run.id }, action: 'run.finished', entityKind: 'run', entityId: run.id,
        runId: run.id, issueId: entry.issueId ?? undefined,
        data: { outcome, costUsd: result?.usage.costUsd ?? 0, steps: result?.steps ?? 0, provider: result?.adapterId ?? null },
      });
    }
    this.k.bus.emit('run.finished', { orgId: org.id, runId: run.id, agentId: agent.id, issueId: entry.issueId, outcome });
    const finished = this.journal.find(run.id);
    if (finished) this.onFinished(finished, entry.mode);
  }

  async cancel(runId: string, reason: string): Promise<boolean> {
    const a = this.active.get(runId);
    if (!a) return false;
    a.cancelReason = reason;
    await a.handle?.cancel(reason);
    return true;
  }

  async cancelWhere(pred: (a: ActiveRun) => boolean, reason: string): Promise<number> {
    const targets = [...this.active.values()].filter(pred);
    await Promise.all(targets.map((a) => this.cancel(a.run.id, reason)));
    return targets.length;
  }
}

function cancelledBeforeStart(job: WorkerJob): SupervisedResult {
  return {
    outcome: 'cancelled', finalText: '', steps: 0, adapterId: job.adapterId, model: job.ctx.model,
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 },
  };
}
