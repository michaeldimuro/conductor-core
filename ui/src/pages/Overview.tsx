import { Link } from 'react-router-dom';
import { ActivityList } from '../components/activity.js';
import { TakeoverCallouts, useOpenTakeovers } from '../components/takeover.js';
import { Empty, Load, Meter, PageHead, Panel, Status } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { GoalNode, Issue, Run } from '../lib/api.js';
import { ago, duration, money, monthStart, seatTime, blockedText } from '../lib/format.js';
import { k, useDirectory, useOrg, type Directory } from '../lib/org.js';
import { useQuery } from '../lib/query.js';

function goalProgress(n: GoalNode): { open: number; done: number } {
  return n.children.reduce((acc, c) => {
    const p = goalProgress(c);
    return { open: acc.open + p.open, done: acc.done + p.done };
  }, { ...n.issueCounts });
}

export function RunRow({ run, base, dir }: { run: Run; base: string; dir: Directory }) {
  return (
    <li className="line">
      <Status value={run.status} />
      <Link className="grow truncate" to={`${base}/runs/${run.id}`}>{dir.agentName(run.agentId)}{run.phase ? <span className="muted"> {run.phase}</span> : null}</Link>
      <span className="muted nowrap">{run.startedAt ? duration((run.endedAt ?? Date.now()) - run.startedAt) : ago(run.createdAt)}</span>
    </li>
  );
}

function IssueLine({ issue, base, dir }: { issue: Issue; base: string; dir: Directory }) {
  return (
    <li className="line">
      <Status value={issue.status} />
      <Link className="grow truncate" to={`${base}/issues/${issue.number}`}><span className="muted">#{issue.number}</span> {issue.title}</Link>
      <span className="muted nowrap truncate line-meta">{issue.blockedReason ? blockedText(issue.blockedReason) : dir.agentName(issue.assigneeAgentId)}</span>
    </li>
  );
}

export function Overview() {
  const { org, base } = useOrg();
  const dir = useDirectory(org.id);
  const o = { orgId: org.id };
  const goals = useQuery(k(org.id, 'goal-tree'), () => api.goalTree(org.id), { ...o, events: ['goal.', 'issue.'] });
  const running = useQuery(k(org.id, 'runs', 'live'), async () => {
    const [a, b, c] = await Promise.all([api.listRuns(org.id, { status: 'running', limit: 50 }), api.listRuns(org.id, { status: 'paused', limit: 50 }), api.listRuns(org.id, { status: 'queued', limit: 50 })]);
    return [...a, ...b, ...c];
  }, { ...o, events: ['run.started', 'run.finished', 'run.paused', 'run.resumed'], pollMs: 30_000 });
  const needs = useQuery(k(org.id, 'issues', 'needs-owner'), () => api.listIssues(org.id, { status: ['blocked', 'in_review'], limit: 50 }), { ...o, events: ['issue.'] });
  const approvals = useQuery(k(org.id, 'approvals', 'pending'), () => api.listApprovals(org.id, { status: 'pending', limit: 100 }), { ...o, events: ['approval.'] });
  const takeovers = useOpenTakeovers(org.id);
  const spend = useQuery(k(org.id, 'budget', 'month'), () => api.budgetSummary(org.id, { since: monthStart() }), { ...o, events: ['run.finished', 'budget.'] });
  const activity = useQuery(k(org.id, 'activity', 'recent'), () => api.activity(org.id, { limit: 40 }), { ...o, events: ['issue.', 'run.started', 'run.finished', 'approval.', 'agent.', 'goal.', 'skill.', 'memory.', 'comment.'] });
  const orgLine = spend.data?.lines.find((l) => l.scope === 'org');
  const forOwner = (needs.data?.items ?? []).filter((i) => i.status === 'blocked' || !i.reviewerAgentId);

  return (
    <div className="page">
      <PageHead title={org.name} sub={org.mission || 'No mission set. Add one in Settings so every agent knows what this organization is for.'} />
      <div className="grid-3">
        <Panel title="Needs you" actions={<Link to="/approvals">Approvals inbox</Link>} flush>
          <div aria-live="polite">
            {(approvals.data?.length ?? 0) > 0 ? (
              <Link className="callout callout-warn" to="/approvals">
                <strong>{approvals.data!.length}</strong> {approvals.data!.length === 1 ? 'approval is' : 'approvals are'} waiting for your decision
              </Link>
            ) : null}
            <TakeoverCallouts orgId={org.id} sessions={takeovers.data ?? []} />
            <Load q={needs} lines={2}>
              {() => forOwner.length === 0 && !approvals.data?.length && !takeovers.data?.length
                ? <Empty title="Nothing is waiting on you" />
                : <ul className="lines">{forOwner.map((i) => <IssueLine key={i.id} issue={i} base={base} dir={dir} />)}</ul>}
            </Load>
          </div>
        </Panel>

        <Panel title="Active runs" flush>
          <div aria-live="polite">
            <Load q={running} lines={2} empty={<Empty title="No agent is running right now" />}>
              {(runs) => <ul className="lines">{runs.map((r) => <RunRow key={r.id} run={r} base={base} dir={dir} />)}</ul>}
            </Load>
          </div>
        </Panel>

        <Panel title="Spend this month" actions={<Link to={`${base}/costs`}>Cost dashboard</Link>}>
          <Load q={spend} lines={2}>
            {(s) => (
              <div className="stack">
                <p><span className="tile-value">{money(s.totalUsd)}</span> <span className="muted">of {org.budgetMonthlyUsd == null ? 'no cap' : money(org.budgetMonthlyUsd)}</span></p>
                <Meter value={orgLine?.spentUsd ?? s.totalUsd} cap={org.budgetMonthlyUsd} label="Organization budget used" />
                <p className="muted">Seat time {seatTime(s.seatSeconds)}{org.seatSecondsMonthly ? ` of ${seatTime(org.seatSecondsMonthly)}` : ''}</p>
              </div>
            )}
          </Load>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Goals" actions={<Link to={`${base}/goals`}>Goal tree</Link>} flush>
          <Load q={goals} empty={<Empty title="No goals yet"><Link to={`${base}/goals`}>Set the first goal</Link></Empty>}>
            {(tree) => (
              <ul className="lines">
                {tree.map((n) => {
                  const p = goalProgress(n);
                  const total = p.open + p.done;
                  return (
                    <li key={n.goal.id} className="goal-line">
                      <div className="spread"><span className="truncate">{n.goal.title}</span><span className="muted nowrap">{p.done} of {total} done</span></div>
                      <div className="meter meter-go" role="meter" aria-label={`${n.goal.title} progress`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={p.done}>
                        <span className="meter-fill" style={{ width: `${total ? (p.done / total) * 100 : 0}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Load>
        </Panel>
        <Panel title="Recent activity" actions={<Link to={`${base}/activity`}>Full log</Link>} flush>
          <Load q={activity} empty={<Empty title="Nothing has happened yet" />}>
            {(items) => <ActivityList items={items} base={base} dir={dir} />}
          </Load>
        </Panel>
      </div>
    </div>
  );
}
