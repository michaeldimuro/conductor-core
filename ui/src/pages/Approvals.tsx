import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Chip, Empty, KeyValues, Load, PageHead, Panel, Segmented, Status } from '../components/ui.js';
import { api, errorText } from '../lib/api.js';
import type { Approval, Organization } from '../lib/api.js';
import { ago, dateTime, humanize } from '../lib/format.js';
import { useAgents } from '../lib/org.js';
import { invalidate, setQueryData, useQuery } from '../lib/query.js';
import { toast } from '../lib/toast.js';
import { OrgTakeovers } from '../components/takeover.js';

const PENDING_KEY = 'approvals/pending';

function Requester({ approval }: { approval: Approval }) {
  const agents = useAgents(approval.requesterAgentId ? approval.orgId : null);
  if (!approval.requesterAgentId) return <>Conductor</>;
  return <>{agents.data?.find((a) => a.id === approval.requesterAgentId)?.name ?? 'An agent'}</>;
}

function ApprovalCard({ approval, org }: { approval: Approval; org?: Organization }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = approval.status === 'pending';
  const base = org ? `/o/${org.slug}` : null;
  const decide = (decision: 'approved' | 'denied') => {
    setBusy(true);
    // One tap: the card leaves the inbox at once and returns if the daemon refuses.
    const undo = setQueryData<Approval[]>(PENDING_KEY, (prev) => prev?.filter((a) => a.id !== approval.id));
    api.decideApproval(approval.orgId, approval.id, { decision, note: note.trim() || undefined }).then(
      () => {
        toast(decision === 'approved' ? `Approved: ${approval.title}` : `Denied: ${approval.title}`, 'ok');
        invalidate('approvals/', 'status', `${approval.orgId}/approvals`);
      },
      (e: unknown) => {
        undo();
        setBusy(false);
        toast(errorText(e), 'error');
      },
    );
  };
  return (
    <li className="approval">
      <div className="approval-main">
        <p className="row row-tight">
          <Chip tone="warn">{humanize(approval.kind)}</Chip>
          {org ? <Chip>{org.name}</Chip> : null}
          {!pending ? <Status value={approval.status} /> : null}
          <span className="muted" title={dateTime(approval.createdAt)}>asked {ago(approval.createdAt)} by <Requester approval={approval} /></span>
          {pending && approval.expiresAt ? <span className="muted">expires {ago(approval.expiresAt)}</span> : null}
        </p>
        <h3 className="approval-title">{approval.title}</h3>
        <details open={pending && Object.keys(approval.payload).length <= 6}>
          <summary>What exactly is being asked</summary>
          <KeyValues data={approval.payload} />
        </details>
        <p className="row muted">
          {base && approval.issueId ? <Link to={`${base}/issues/${approval.issueId}`}>Open the issue</Link> : null}
          {base && approval.runId ? <Link to={`${base}/runs/${approval.runId}`}>Open the run</Link> : null}
        </p>
        {!pending && (approval.decidedAt || approval.decisionNote) ? (
          <p className="dim">{approval.decidedAt ? `Decided ${dateTime(approval.decidedAt)}` : ''}{approval.decisionNote ? `: ${approval.decisionNote}` : ''}</p>
        ) : null}
      </div>
      {pending ? (
        <div className="approval-actions">
          <input aria-label={`Note for ${approval.title}`} placeholder="Note for the agent (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row">
            <Button variant="primary" disabled={busy} onClick={() => decide('approved')}>Approve</Button>
            <Button variant="danger" disabled={busy} onClick={() => decide('denied')}>Deny</Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function Approvals({ orgs }: { orgs: Organization[] }) {
  const [view, setView] = useState<'pending' | 'history'>('pending');
  const pending = useQuery(PENDING_KEY, () => api.approvalInbox({ status: 'pending', limit: 500 }), { events: ['approval.'] });
  const history = useQuery(view === 'history' ? 'approvals/history' : null, async () => (await api.approvalInbox({ limit: 300 })).filter((a) => a.status !== 'pending'), { events: ['approval.decided'] });
  const orgOf = (a: Approval) => orgs.find((o) => o.id === a.orgId);
  return (
    <div className="page page-narrow">
      <PageHead title="Approvals" sub="Risky actions wait here for your decision, across every organization. Agents keep working on other things while they wait." />
      <Segmented label="Approvals view" value={view} onChange={setView} options={[{ value: 'pending', label: `Waiting (${pending.data?.length ?? 0})` }, { value: 'history', label: 'History' }]} />
      {view === 'pending' ? <div aria-live="polite">{orgs.filter((o) => o.status === 'active').map((o) => <OrgTakeovers key={o.id} org={o} showOrg={orgs.length > 1} />)}</div> : null}
      {view === 'pending' ? (
        <Panel flush>
          <div aria-live="polite">
            <Load q={pending} empty={<Empty title="Nothing needs your approval"><p>Hires, payments, first sends to new recipients and other gated actions will appear here.</p></Empty>}>
              {(list) => <ul className="approvals">{list.map((a) => <ApprovalCard key={a.id} approval={a} org={orgOf(a)} />)}</ul>}
            </Load>
          </div>
        </Panel>
      ) : (
        <Panel flush>
          <Load q={history} empty={<Empty title="No decisions recorded yet" />}>
            {(list) => <ul className="approvals">{list.map((a) => <ApprovalCard key={a.id} approval={a} org={orgOf(a)} />)}</ul>}
          </Load>
        </Panel>
      )}
    </div>
  );
}
