import { Link } from 'react-router-dom';
import { Icon } from '../components/icons.js';
import { Loading } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { Agent, Issue, Run } from '../lib/api.js';
import { ago } from '../lib/format.js';
import { k, useDirectory, useOrg } from '../lib/org.js';
import { useQuery } from '../lib/query.js';
import { useLiveRuns, useOpenIssues, useRecentlyDone } from '../lib/work.js';
import { initials } from './setup/TeamStep.js';

export type State = 'working' | 'waiting' | 'queued' | 'idle' | 'paused';
const ORDER: Record<State, number> = { waiting: 0, working: 1, queued: 2, idle: 3, paused: 4 };

interface Row { agent: Agent; state: State; line: string; to?: string; open: number; done: number }

export function describe(agent: Agent, live: Run[], open: Issue[], last: Run | undefined, base: string): Pick<Row, 'state' | 'line' | 'to'> {
  if (agent.status === 'paused') return { state: 'paused', line: agent.pausedReason ? `Paused: ${agent.pausedReason}` : 'Paused' };
  const blocked = open.find((i) => i.assigneeAgentId === agent.id && (i.status === 'blocked' || (i.status === 'in_review' && !i.reviewerAgentId)));
  const run = live.find((r) => r.agentId === agent.id && r.status === 'running');
  if (run) {
    const issue = run.issueId ? open.find((i) => i.id === run.issueId) : undefined;
    return { state: 'working', line: issue ? `Working on #${issue.number} ${issue.title}` : run.phase ? `Working: ${run.phase}` : 'Working', to: `${base}/runs/${run.id}` };
  }
  if (blocked) return { state: 'waiting', line: `${blocked.status === 'blocked' ? 'Waiting on you' : 'Ready for your review'}: #${blocked.number} ${blocked.title}`, to: `${base}/issues/${blocked.number}` };
  if (live.some((r) => r.agentId === agent.id)) return { state: 'queued', line: 'Up next in the queue' };
  return { state: 'idle', line: last ? `Idle · last worked ${ago(last.endedAt ?? last.createdAt)}` : 'Has not worked yet' };
}

/** The team at a glance: who is working, who is waiting on you, and what each one got done this week. */
export function Team() {
  const { org, base } = useOrg();
  const dir = useDirectory(org.id);
  const live = useLiveRuns(org.id);
  const open = useOpenIssues(org.id);
  const done = useRecentlyDone(org.id, 7);
  const recent = useQuery(k(org.id, 'runs', 'recent'), () => api.listRuns(org.id, { limit: 100 }), { orgId: org.id, events: ['run.finished'] });
  if (dir.loading || !live.data || !open.data) return <div className="page page-narrow"><Loading lines={5} /></div>;
  const rows: Row[] = dir.staff.map((agent) => ({
    agent,
    ...describe(agent, live.data!, open.data!, recent.data?.find((r) => r.agentId === agent.id && r.status !== 'running'), base),
    open: open.data!.filter((i) => i.assigneeAgentId === agent.id).length,
    done: (done.data ?? []).filter((i) => i.assigneeAgentId === agent.id).length,
  })).sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.done - a.done);
  const working = rows.filter((r) => r.state === 'working').length;
  const waiting = rows.filter((r) => r.state === 'waiting').length;
  const paused = rows.filter((r) => r.state === 'paused').length;

  return (
    <div className="page page-narrow team-page">
      <header className="screen-head">
        <span className="eyebrow">{org.name}</span>
        <h1>Team</h1>
        <p className="dim">{rows.length === 0 ? 'No agents yet.' : [`${working} working`, waiting ? `${waiting} waiting on you` : null, paused ? `${paused} paused` : null, rows.length - working - waiting - paused ? `${rows.length - working - waiting - paused} idle` : null].filter(Boolean).join(' · ')}</p>
      </header>
      {rows.length === 0 ? (
        <div className="all-clear">
          <h2>Build your team</h2>
          <p className="dim">Hire agents into departments, or let guided setup start you from a template.</p>
          <div className="row"><Link className="btn btn-primary" to={`${base}/setup/team`}>Guided setup</Link><Link className="btn" to={`${base}/chart?hire=1`}>Hire an agent</Link></div>
        </div>
      ) : (
        <ul className="team-list">
          {rows.map((r) => (
            <li key={r.agent.id} className={`team-card is-${r.state}`}>
              <Link to={`${base}/agents/${r.agent.slug}`} className="team-card-main">
                <span className={`avatar${r.state === 'working' ? ' avatar-live' : ''}`} aria-hidden="true">{initials(r.agent.name)}</span>
                <span className="grow team-card-text">
                  <span className="row row-tight"><strong>{r.agent.name}</strong><span className="muted truncate">{r.agent.role}</span></span>
                  <span className={`team-line team-line-${r.state}`}>{r.line}</span>
                  <span className="muted team-stats">{r.done} done this week · {r.open} open · {dir.dept(r.agent.deptId)?.name ?? ''}</span>
                </span>
                <Icon name="right" size={16} className="team-caret" />
              </Link>
              {r.to ? <Link className="team-jump" to={r.to}>{r.state === 'working' ? 'Watch' : 'Open'}</Link> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="muted team-foot"><Link to={`${base}/chart`}>Org chart</Link> · <Link to={`${base}/chart?hire=1`}>Hire an agent</Link></p>
    </div>
  );
}
