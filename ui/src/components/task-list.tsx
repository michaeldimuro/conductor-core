import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { Issue, ListIssuesQuery } from '../lib/api.js';
import { ago, blockedText } from '../lib/format.js';
import { k, useOrg, type Directory } from '../lib/org.js';
import { useQuery } from '../lib/query.js';
import { chainSize, useOpenIssues } from '../lib/work.js';
import { Icon, PriorityIcon, StatusIcon } from './icons.js';
import { Loading } from './ui.js';

type Tab = 'needs' | 'active' | 'next' | 'backlog' | 'done';
const TABS: ReadonlyArray<{ id: Tab; label: string; match: (i: Issue) => boolean }> = [
  { id: 'needs', label: 'Needs you', match: (i) => i.status === 'blocked' || (i.status === 'in_review' && !i.reviewerAgentId) },
  { id: 'active', label: 'In progress', match: (i) => i.status === 'in_progress' || (i.status === 'in_review' && !!i.reviewerAgentId) },
  { id: 'next', label: 'Up next', match: (i) => i.status === 'todo' },
  { id: 'backlog', label: 'Backlog', match: (i) => i.status === 'backlog' },
  { id: 'done', label: 'Done', match: (i) => i.status === 'done' },
];

export interface TaskFilter { assigneeAgentId?: string; goalId?: string; label?: string; search?: string }
const matches = (i: Issue, f: TaskFilter): boolean =>
  (!f.assigneeAgentId || i.assigneeAgentId === f.assigneeAgentId) && (!f.goalId || i.goalId === f.goalId) && (!f.label || i.labels.includes(f.label))
  && (!f.search || `${i.title} ${i.body}`.toLowerCase().includes(f.search.toLowerCase()) || String(i.number) === f.search.replace('#', ''));

function TaskRow({ issue, dir, base, chain }: { issue: Issue; dir: Directory; base: string; chain: number }) {
  const sub = issue.status === 'blocked' && issue.blockedReason ? blockedText(issue.blockedReason) : issue.status === 'in_review' && !issue.reviewerAgentId ? 'Ready for your review' : null;
  return (
    <li>
      <Link className={`task-row task-${issue.status}`} to={`${base}/issues/${issue.number}`}>
        <StatusIcon status={issue.status} size={18} />
        <span className="task-text">
          <span className="task-title">{issue.title}</span>
          {sub ? <span className="task-sub">{sub}</span> : null}
          <span className="task-meta">
            <span>#{issue.number}</span>
            <span>{dir.agentName(issue.assigneeAgentId)}</span>
            <span>{ago(issue.status === 'done' ? (issue.closedAt ?? issue.updatedAt) : issue.updatedAt)}</span>
          </span>
        </span>
        <span className="task-side">
          {issue.priority <= 1 && issue.status !== 'done' ? <PriorityIcon priority={issue.priority} /> : null}
          {chain > 0 ? <span className="task-chain" title={`${chain} open tasks wait on this`}><Icon name="link" size={11} />{chain}</span> : null}
        </span>
      </Link>
    </li>
  );
}

/** Tasks as a list grouped by what they need: the phone's way through the board, one tap per task. */
export function TaskList({ filter, dir }: { filter: TaskFilter; dir: Directory }) {
  const { org, base } = useOrg();
  const open = useOpenIssues(org.id);
  const all = open.data ?? [];
  const list = all.filter((i) => matches(i, filter));
  const counts = Object.fromEntries(TABS.map((t) => [t.id, list.filter(t.match).length])) as Record<Tab, number>;
  // Until the owner picks a tab, open on what needs them (decided once the data is in).
  const [picked, setTab] = useState<Tab | null>(null);
  const tab: Tab = picked ?? (counts.needs ? 'needs' : counts.active ? 'active' : 'next');
  const doneQ = useQuery(tab === 'done' ? k(org.id, 'issues', 'list-done', JSON.stringify(filter)) : null,
    async () => (await api.listIssues(org.id, { status: ['done'], limit: 100, ...filter } as ListIssuesQuery)).items, { orgId: org.id, events: ['issue.'] });
  const [limit, setLimit] = useState(40);
  const rows = tab === 'done' ? (doneQ.data ?? []) : list.filter(TABS.find((t) => t.id === tab)!.match).sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt);

  return (
    <div className="task-list">
      <div className="task-tabs" role="tablist" aria-label="Task status">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`${tab === t.id ? 'on' : ''}${t.id === 'needs' && counts.needs ? ' has-needs' : ''}`} onClick={() => { setTab(t.id); setLimit(40); }}>
            {t.label}{t.id !== 'done' && counts[t.id] ? <span className="task-tab-count">{counts[t.id]}</span> : null}
          </button>
        ))}
      </div>
      {open.loading || (tab === 'done' && doneQ.loading) ? <Loading lines={4} /> : rows.length ? (
        <>
          <ul className="task-rows" role="tabpanel">{rows.slice(0, limit).map((i) => <TaskRow key={i.id} issue={i} dir={dir} base={base} chain={i.status === 'done' ? 0 : chainSize(i.id, i.parentIssueId, all)} />)}</ul>
          {rows.length > limit ? <button type="button" className="task-more" onClick={() => setLimit(limit + 40)}>Show {Math.min(40, rows.length - limit)} more</button> : null}
        </>
      ) : (
        <p className="task-empty">{tab === 'needs' ? 'Nothing needs you. Agents will bring blocked work and finished results here.' : tab === 'done' ? 'Nothing finished yet.' : 'No tasks here.'}</p>
      )}
    </div>
  );
}
