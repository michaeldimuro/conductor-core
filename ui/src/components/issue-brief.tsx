import { Link } from 'react-router-dom';
import type { Issue, Organization, Run, TimelineEntry } from '../lib/api.js';
import { ago, blockedText } from '../lib/format.js';
import { PRIORITIES, STATUS_LABEL, type Directory } from '../lib/org.js';
import { chainSize, holdingUp, plain, type Need } from '../lib/work.js';
import { Icon, PriorityIcon, StatusIcon } from './icons.js';
import { NeedCard } from './needs.js';

/**
 * The top of a task: where it stands in one sentence, what (if anything) the
 * owner must do, and what else is waiting on it. Everything else on the page is
 * detail you open only when this is not enough.
 */
export function IssueBrief({ issue, org, base, dir, timeline, runs, children, open }: {
  issue: Issue; org: Organization; base: string; dir: Directory;
  timeline: TimelineEntry[] | undefined; runs: Run[] | undefined; children: Issue[] | undefined; open: Issue[];
}) {
  const live = runs?.find((r) => r.status === 'running');
  const latest = [...(timeline ?? [])].reverse().find((e) => e.kind === 'comment' && e.comment.authorKind === 'agent');
  const note = latest?.kind === 'comment' ? latest.comment : null;
  const assignee = dir.agentName(issue.assigneeAgentId, 'No one');
  const waiting = holdingUp(issue, open);
  const chain = chainSize(issue.id, issue.parentIssueId, open);
  const kids = children ?? [];
  const kidsDone = kids.filter((c) => c.status === 'done').length;
  const needKind = issue.status === 'blocked' ? 'blocked' : issue.status === 'in_review' && !issue.reviewerAgentId ? 'review' : null;
  const need: Need | null = needKind ? { key: issue.id, kind: needKind, title: issue.title, at: issue.updatedAt, chain, issue, agentId: issue.assigneeAgentId } : null;

  let now: { icon: 'live' | 'chat' | 'time' | 'check'; text: string; who?: string; when?: number; to?: string };
  if (live) now = { icon: 'live', text: live.phase ? `Working on it now: ${live.phase}` : 'Working on it now', who: dir.agentName(live.agentId), when: live.startedAt ?? live.createdAt, to: `${base}/runs/${live.id}` };
  else if (note) now = { icon: 'chat', text: plain(note.body, 280), who: dir.agentName(note.authorId), when: note.createdAt };
  else if (issue.status === 'blocked') now = { icon: 'time', text: issue.blockedReason ? `Stopped: ${blockedText(issue.blockedReason)}` : `${assignee} stopped and is waiting for you.` };
  else if (issue.status === 'done') now = { icon: 'check', text: 'Finished.', when: issue.closedAt ?? issue.updatedAt };
  else if (issue.assigneeAgentId) now = { icon: 'time', text: issue.status === 'backlog' ? `In the backlog. ${assignee} will not start until it moves to To do.` : `Waiting for ${assignee} to pick it up on the next run.` };
  else now = { icon: 'time', text: 'Not assigned yet. Assign an agent to get it moving.' };

  return (
    <section className="brief" aria-label="Summary">
      <div className={`brief-now brief-now-${now.icon}`}>
        <span className="brief-now-icon" aria-hidden="true"><Icon name={now.icon} size={15} /></span>
        <div className="grow">
          {now.who ? <span className="brief-now-who">{now.who}{now.when ? <span className="muted"> · {ago(now.when)}</span> : null}</span> : null}
          <p>{now.text}</p>
          {now.to ? <Link to={now.to}>Watch the run<Icon name="right" size={13} /></Link> : null}
        </div>
      </div>
      {need ? <ul className="needs brief-need"><NeedCard need={need} org={org} base={base} bare /></ul> : null}
      <ul className="brief-facts">
        <li><StatusIcon status={issue.status} size={14} />{STATUS_LABEL[issue.status]}</li>
        <li><Icon name="agent" size={14} />{assignee}</li>
        <li><PriorityIcon priority={issue.priority} size={14} />{PRIORITIES[issue.priority]}</li>
        {kids.length ? <li><Icon name="tasks" size={14} />{kidsDone}/{kids.length} sub-tasks done</li> : null}
      </ul>
      {waiting.length ? (
        <div className="brief-chain">
          <span className="mono-label">Holding up {chain > waiting.length ? `${chain} tasks` : ''}</span>
          <ul>
            {waiting.slice(0, 3).map((w) => <li key={w.id}><Link to={`${base}/issues/${w.number}`}><StatusIcon status={w.status} size={13} /><span className="truncate">#{w.number} {w.title}</span></Link></li>)}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
