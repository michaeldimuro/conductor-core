import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { Organization } from '../lib/api.js';
import { ownerAsk } from '../lib/asks.js';
import { ago, humanize } from '../lib/format.js';
import { k, useDirectory } from '../lib/org.js';
import { invalidate, useAction, useQuery } from '../lib/query.js';
import { plain, type Need, type NeedKind } from '../lib/work.js';
import { Icon, type IconName } from './icons.js';
import { TakeoverCallouts } from './takeover.js';
import { Button, ErrorNote } from './ui.js';

const KIND: Record<NeedKind, { label: string; icon: IconName; tone: string }> = {
  takeover: { label: 'Sign-in needed', icon: 'browser', tone: 'stop' },
  approval: { label: 'Approval', icon: 'approvals', tone: 'warn' },
  blocked: { label: 'Blocked', icon: 'hand', tone: 'stop' },
  review: { label: 'Ready for review', icon: 'review', tone: 'info' },
};
export const needLabel = (kind: NeedKind): string => KIND[kind].label;

/** The latest message an agent left on an issue: what it did, in its own words. */
export function useLatestAgentNote(orgId: string, issueId: string | null | undefined) {
  return useQuery(issueId ? k(orgId, 'issue', issueId, 'latest-note') : null, async () => {
    const comments = await api.listComments(orgId, issueId!);
    return [...comments].reverse().find((c) => c.authorKind === 'agent') ?? null;
  }, { orgId, events: ['comment.'] });
}

/** The latest note anyone but the owner left on an issue (an escalation is posted by the system). */
function useLatestTeamNote(orgId: string, issueId: string | null | undefined) {
  return useQuery(issueId ? k(orgId, 'issue', issueId, 'latest-team-note') : null, async () => {
    const comments = await api.listComments(orgId, issueId!);
    return [...comments].reverse().find((c) => c.authorKind !== 'human') ?? null;
  }, { orgId, events: ['comment.'] });
}

function Payload({ data }: { data: Record<string, unknown> }) {
  const rows = Object.entries(data).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object').slice(0, 4);
  if (!rows.length) return null;
  return (
    <dl className="need-payload">
      {rows.map(([key, v]) => <div key={key}><dt>{humanize(key)}</dt><dd>{String(v)}</dd></div>)}
    </dl>
  );
}

/** One thing waiting on the owner, with the decision it needs right on the card. */
export function NeedCard({ need, org, base, compact, bare }: { need: Need; org: Organization; base: string; compact?: boolean; /** Inside the task itself: no title or requester line. */ bare?: boolean }) {
  const dir = useDirectory(org.id);
  const [note, setNote] = useState('');
  const [writing, setWriting] = useState(false);
  const meta = KIND[need.kind];
  const issue = need.issue;
  const latest = useLatestAgentNote(org.id, !compact && !bare && need.kind === 'review' ? issue?.id : null);
  const name = dir.agentName(need.agentId, 'The agent');
  const asked = need.kind === 'blocked' ? ownerAsk(issue?.blockedReason, name) : null;
  const thread = useLatestTeamNote(org.id, asked?.detailFromThread && !compact && !bare ? issue?.id : null);
  const detail = asked ? (asked.detailFromThread ? (thread.data ? plain(thread.data.body, 1200) : '') : asked.detail) : '';
  const done = { invalidate: [`${org.id}/`, 'approvals', 'status'] };
  const decide = useAction((decision: 'approved' | 'denied') => api.decideApproval(org.id, need.approval!.id, { decision, ...(note.trim() ? { note: note.trim() } : {}) }), { ...done, success: (a) => (a.status === 'approved' ? 'Approved. The agent continues.' : 'Denied. The agent was told why.') });
  // Always leave a note: it tells the agent what happened and wakes it on the task.
  const proceed = useAction(async () => {
    await api.addComment(org.id, issue!.id, { body: note.trim() || asked?.doneNote || 'Please continue.' });
    await api.updateIssue(org.id, issue!.id, { status: 'todo', blockedReason: null });
  }, { ...done, success: `Sent. ${name} picks it up next.` });
  const review = useAction((outcome: 'accepted' | 'rejected') => api.reviewIssue(org.id, issue!.id, { outcome, ...(note.trim() ? { note: note.trim() } : {}) }), { ...done, success: (i) => (i.status === 'done' ? 'Accepted and closed.' : 'Sent back with your note.') });
  const error = decide.error ?? proceed.error ?? review.error;

  if (need.kind === 'takeover' && need.takeover) {
    return <li className={`need need-${meta.tone}`}><TakeoverCallouts orgId={org.id} sessions={[need.takeover]} /></li>;
  }

  return (
    <li className={`need need-${meta.tone}${compact ? ' need-compact' : ''}`}>
      <div className="need-top">
        <span className="need-kind"><Icon name={meta.icon} size={13} />{meta.label}</span>
        {need.chain > 0 ? <span className="need-chain" title="Open tasks waiting on this">Holding up {need.chain} {need.chain === 1 ? 'task' : 'tasks'}</span> : null}
        <span className="grow" />
        <span className="muted need-age">{ago(need.at)}</span>
      </div>
      {bare ? null : issue ? <Link className="need-title" to={`${base}/issues/${issue.number}`}>{need.title}</Link> : <p className="need-title">{need.title}</p>}
      {bare ? null : <p className="need-who muted">
        <Icon name="agent" size={12} />{dir.agentName(need.agentId, 'An agent')}
        {need.kind === 'approval' && issue ? <> · for <Link to={`${base}/issues/${issue.number}`}>#{issue.number}</Link></> : null}
      </p>}
      {compact ? null : (
        <>
          {asked && !bare ? (
            <>
              <p className="need-do"><span className="need-do-label">What you need to do</span>{asked.ask}</p>
              {detail ? <details className="need-detail"><summary>Details from {name}</summary><p>{detail}</p></details> : null}
            </>
          ) : null}
          {need.kind === 'review' && !bare ? <p className="need-ask">{latest.data ? plain(latest.data.body, 240) : latest.loading ? '…' : 'The agent marked this ready. Open it to see the result.'}</p> : null}
          {need.kind === 'approval' && need.approval ? <Payload data={need.approval.payload} /> : null}
          {writing ? (
            <textarea className="need-note" rows={2} autoFocus value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={need.kind === 'review' ? 'What should change?' : need.kind === 'blocked' ? `Your answer for ${name}, or what you did` : 'Note for the agent (optional)'} aria-label="Note for the agent" />
          ) : null}
          <ErrorNote error={error} />
          <div className="need-actions">
            {need.kind === 'approval' ? (
              <>
                <Button small variant="quiet" icon={writing ? undefined : 'chat'} onClick={() => setWriting((v) => !v)}>{writing ? 'No note' : 'Note'}</Button>
                <span className="grow" />
                <Button small variant="danger" busy={decide.busy} onClick={() => void decide.run('denied')}>Deny</Button>
                <Button small variant="primary" icon="check" busy={decide.busy} onClick={() => void decide.run('approved')}>Approve</Button>
              </>
            ) : null}
            {need.kind === 'blocked' ? (
              <>
                {bare ? null : <Link className="btn btn-sm btn-quiet need-open" to={`${base}/issues/${issue!.number}`}>Open</Link>}
                <Button small variant="quiet" icon={writing ? undefined : 'chat'} onClick={() => setWriting((v) => !v)}>{writing ? 'Cancel' : 'Reply'}</Button>
                <span className="grow" />
                <Button small variant="primary" icon="play" busy={proceed.busy} onClick={() => void proceed.run()}>{note.trim() ? `Send to ${name}` : asked?.done ?? 'Continue'}</Button>
              </>
            ) : null}
            {need.kind === 'review' ? (
              <>
                {bare ? null : <Link className="btn btn-sm btn-quiet need-open" to={`${base}/issues/${issue!.number}`}>Open</Link>}
                <span className="grow" />
                <Button small busy={review.busy} disabled={writing && !note.trim()} onClick={() => (writing ? void review.run('rejected') : setWriting(true))}>{writing ? 'Send back' : 'Changes'}</Button>
                <Button small variant="primary" icon="check" busy={review.busy} onClick={() => void review.run('accepted')}>Accept</Button>
              </>
            ) : null}
          </div>
        </>
      )}
    </li>
  );
}

export const refreshNeeds = (orgId: string) => invalidate(`${orgId}/`);
