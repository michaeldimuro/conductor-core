import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, StatusIcon } from '../components/icons.js';
import { NeedCard } from '../components/needs.js';
import { SetupCard } from '../components/setup-card.js';
import { Loading, Meter } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { GoalNode, Issue } from '../lib/api.js';
import { ago, money, monthStart } from '../lib/format.js';
import { k, useDirectory, useOrg } from '../lib/org.js';
import { useQuery } from '../lib/query.js';
import { lastSeen, markSeen, useLiveRuns, useNeeds, useRecentlyDone } from '../lib/work.js';
import { initials } from './setup/TeamStep.js';

const countGoals = (tree: GoalNode[]): number => tree.reduce((n, g) => n + 1 + countGoals(g.children), 0);
function goalProgress(n: GoalNode): { open: number; done: number } {
  return n.children.reduce((acc, c) => {
    const p = goalProgress(c);
    return { open: acc.open + p.open, done: acc.done + p.done };
  }, { ...n.issueCounts });
}
function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Section({ title, count, action, children, id }: { title: string; count?: number; action?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section className="today-section" aria-labelledby={id}>
      <header className="today-section-head">
        <h2 id={id}>{title}{count ? <span className="today-count">{count}</span> : null}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/** Finished work grouped by who did it: the "what did the team get done" answer in one glance. */
function DoneDigest({ issues, seen, base }: { issues: Issue[]; seen: number; base: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const groups = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const i of issues) m.set(i.assigneeAgentId ?? '', [...(m.get(i.assigneeAgentId ?? '') ?? []), i]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [issues]);
  return (
    <ul className="digest">
      {groups.map(([agentId, list]) => {
        const name = dir.agentName(agentId || null, 'Unassigned');
        const fresh = list.filter((i) => (i.closedAt ?? i.updatedAt) > seen).length;
        return (
          <li key={agentId || 'none'} className="digest-agent">
            <div className="digest-head">
              <span className="avatar avatar-sm" aria-hidden="true">{initials(name)}</span>
              <span className="grow"><strong>{name}</strong> <span className="muted">finished {plural(list.length, 'task')}</span></span>
              {fresh ? <span className="new-pill">{fresh} new</span> : null}
            </div>
            <ul className="digest-items">
              {list.slice(0, 3).map((i) => (
                <li key={i.id}>
                  <Link to={`${base}/issues/${i.number}`} className={(i.closedAt ?? i.updatedAt) > seen ? 'is-new' : undefined}>
                    <StatusIcon status="done" size={14} /><span className="truncate">{i.title}</span><span className="muted nowrap">{ago(i.closedAt ?? i.updatedAt)}</span>
                  </Link>
                </li>
              ))}
              {list.length > 3 ? <li className="muted digest-more">and {list.length - 3} more</li> : null}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Today: the owner's home. Answers, in order, "does anything need me?", "who is
 * working on what?" and "what got done since I last looked?". Phone first: one
 * column of short sections, each ending in the screen that goes deeper.
 */
export function Overview() {
  const { org, base } = useOrg();
  const dir = useDirectory(org.id);
  const seenRef = useRef(lastSeen(org.id));
  useEffect(() => {
    seenRef.current = lastSeen(org.id);
    return () => markSeen(org.id);
  }, [org.id]);
  const { needs, loading: needsLoading, open } = useNeeds(org.id);
  const live = useLiveRuns(org.id);
  const done = useRecentlyDone(org.id, 7);
  const goals = useQuery(k(org.id, 'goal-tree'), () => api.goalTree(org.id), { orgId: org.id, events: ['goal.', 'issue.'] });
  const spend = useQuery(k(org.id, 'budget', 'month'), () => api.budgetSummary(org.id, { since: monthStart() }), { orgId: org.id, events: ['run.finished', 'budget.'] });
  const running = (live.data ?? []).filter((r) => r.status === 'running');
  const queued = (live.data ?? []).filter((r) => r.status !== 'running');
  const issueById = new Map(open.map((i) => [i.id, i]));
  const fresh = (done.data ?? []).filter((i) => (i.closedAt ?? i.updatedAt) > seenRef.current).length;

  const summary = [
    needsLoading ? null : needs.length ? plural(needs.length, 'thing needs', 'things need') + ' you' : 'Nothing needs you',
    live.data ? (running.length ? `${plural(running.length, 'agent')} working` : 'no one is working right now') : null,
    done.data && fresh && seenRef.current ? `${fresh} finished since you last looked` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="page today">
      <header className="screen-head today-head">
        <span className="eyebrow">{greeting()} · {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span>
        <h1>{org.name}</h1>
        <p className="today-summary">{summary || ' '}</p>
      </header>
      <SetupCard org={org} base={base} goals={goals.data ? countGoals(goals.data) : undefined} />

      <div className="today-grid">
        <div className="today-main">
          <Section id="t-needs" title="Needs you" count={needs.length} action={needs.length ? <Link to={`${base}/inbox`}>Open inbox</Link> : null}>
            {needsLoading ? <Loading lines={2} /> : needs.length ? (
              <ul className="needs">
                {needs.slice(0, 2).map((n) => <NeedCard key={n.key} need={n} org={org} base={base} />)}
                {needs.length > 2 ? <li className="needs-more"><Link to={`${base}/inbox`}>{plural(needs.length - 2, 'more decision')}<Icon name="right" size={14} /></Link></li> : null}
              </ul>
            ) : <p className="today-empty"><Icon name="check" size={15} />You&apos;re all caught up.</p>}
          </Section>

          <Section id="t-done" title="Recently done" count={fresh || undefined} action={<Link to={`${base}/activity`}>Activity log</Link>}>
            {done.data === undefined ? <Loading lines={2} /> : done.data.length ? <DoneDigest issues={done.data} seen={seenRef.current} base={base} /> : <p className="today-empty muted">Nothing finished this week yet. Finished tasks show up here, grouped by agent.</p>}
          </Section>
        </div>

        <div className="today-side">
          <Section id="t-now" title="Working now" count={running.length} action={<Link to={`${base}/team`}>Team</Link>}>
            {live.data === undefined ? <Loading lines={2} /> : running.length || queued.length ? (
              <ul className="now-list">
                {[...running, ...queued].slice(0, 5).map((r) => {
                  const issue = r.issueId ? issueById.get(r.issueId) : undefined;
                  const name = dir.agentName(r.agentId);
                  return (
                    <li key={r.id}>
                      <Link to={`${base}/runs/${r.id}`} className="now-item">
                        <span className={`avatar avatar-sm${r.status === 'running' ? ' avatar-live' : ''}`} aria-hidden="true">{initials(name)}</span>
                        <span className="grow now-text">
                          <strong>{name}</strong>
                          <span className="muted truncate">{r.status === 'running' ? (issue ? issue.title : r.phase ?? 'Working') : r.status === 'queued' ? 'Up next' : 'Paused'}</span>
                        </span>
                        <span className="muted nowrap now-time">{r.startedAt ? ago(r.startedAt) : r.status}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="today-empty muted">No one is working right now. Agents wake on their schedule or when you assign something.</p>}
          </Section>

          <Section id="t-goals" title="Goals" action={<Link to={`${base}/goals`}>All goals</Link>}>
            {goals.data === undefined ? <Loading lines={2} /> : goals.data.length ? (
              <ul className="goal-mini">
                {goals.data.slice(0, 4).map((n) => {
                  const p = goalProgress(n);
                  const total = p.open + p.done;
                  return (
                    <li key={n.goal.id}>
                      <Link to={`${base}/issues?goal=${n.goal.id}`}>
                        <span className="spread"><span className="truncate">{n.goal.title}</span><span className="muted nowrap">{total ? `${Math.round((p.done / total) * 100)}%` : 'Not started'}</span></span>
                        <span className="meter meter-go" aria-hidden="true"><span className="meter-fill" style={{ width: `${total ? (p.done / total) * 100 : 0}%` }} /></span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="today-empty muted">No goals yet. <Link to={`${base}/goals`}>Set one</Link> so the team knows what to work toward.</p>}
          </Section>

          <Section id="t-spend" title="Spend this month" action={<Link to={`${base}/costs`}>Costs</Link>}>
            {spend.data ? (
              <div className="spend-mini">
                <p><strong>{money(spend.data.totalUsd)}</strong> <span className="muted">{org.budgetMonthlyUsd == null ? 'no cap set' : `of ${money(org.budgetMonthlyUsd)}`}</span></p>
                <Meter value={spend.data.totalUsd} cap={org.budgetMonthlyUsd} label="Monthly budget used" />
              </div>
            ) : <Loading lines={1} />}
          </Section>
        </div>
      </div>
    </div>
  );
}
