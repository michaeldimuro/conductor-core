import { useCallback, useContext, useMemo, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button, Chip, ErrorNote, KeyValues, Lamp, Loading, Modal, Panel, Status, toneOf } from './ui.js';
import { Icon, type IconName } from './icons.js';
import { MarkdownRefs } from './markdown.js';
import { api, errorText } from '../lib/api.js';
import type { Approval, Organization } from '../lib/api.js';
import { ago, dateTime, humanize } from '../lib/format.js';
import { k, useAgents } from '../lib/org.js';
import { invalidate, setQueryData, useQuery } from '../lib/query.js';
import { toast } from '../lib/toast.js';

/** Cache key of the cross-org pending inbox (the Approvals page and the nav badge). */
export const PENDING_KEY = 'approvals/pending';

/** An approval id as agents write it in comments and tool results: `apr_<ULID>`. */
export const APPROVAL_ID = /\bapr_[0-9A-HJKMNP-TV-Z]{26}\b/g;

/** Every distinct approval id mentioned in the texts, in order of first mention. */
export function approvalIdsIn(texts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').matchAll(APPROVAL_ID)) seen.add(m[0]);
  return [...seen];
}

/** What is being asked, at a glance. */
export const APPROVAL_ICON: Record<string, IconName> = {
  hire_agent: 'hire', terminate_agent: 'stop', budget_raise: 'budget', payment: 'costs', external_send: 'send', publish: 'external',
  grant_connector: 'connectors', grant_skill: 'skills', promote_skill: 'skills', tool_call: 'tool', browser_action: 'browser',
  connector_auth: 'key', config_change: 'settings', other: 'approvals',
};

const oneKey = (orgId: string, id: string): string => k(orgId, 'approvals', 'one', id);

function Requester({ approval }: { approval: Approval }) {
  const agents = useAgents(approval.requesterAgentId ? approval.orgId : null);
  if (!approval.requesterAgentId) return <>Conductor</>;
  return <>{agents.data?.find((a) => a.id === approval.requesterAgentId)?.name ?? 'An agent'}</>;
}

/**
 * One approval request with its payload and, while pending, the note box and
 * Approve / Deny. Deciding updates every cached copy at once (inbox, inline
 * references, the issue panel) and rolls the inbox back if the daemon refuses.
 */
export function ApprovalCard({ approval, org, onDecided, hideIssueLink }: {
  approval: Approval;
  org?: Organization;
  onDecided?: (decided: Approval) => void;
  /** Already on that issue: no "Open the issue" link. */
  hideIssueLink?: boolean;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = approval.status === 'pending';
  const base = org ? `/o/${org.slug}` : null;
  const decide = (decision: 'approved' | 'denied') => {
    setBusy(true);
    // One tap: the card leaves the inbox at once and returns if the daemon refuses.
    const undo = setQueryData<Approval[]>(PENDING_KEY, (prev) => prev?.filter((a) => a.id !== approval.id));
    api.decideApproval(approval.orgId, approval.id, { decision, note: note.trim() || undefined }).then(
      (decided) => {
        setQueryData<Approval>(oneKey(approval.orgId, approval.id), () => decided);
        toast(decision === 'approved' ? `Approved: ${approval.title}` : `Denied: ${approval.title}`, 'ok');
        invalidate('approvals/', 'status', `${approval.orgId}/approvals`);
        setBusy(false);
        onDecided?.(decided);
      },
      (e: unknown) => {
        undo();
        setBusy(false);
        toast(errorText(e), 'error');
        // It may have been decided or expired elsewhere meanwhile: show the current state.
        invalidate(`${approval.orgId}/approvals`);
      },
    );
  };
  return (
    <li className="approval">
      <div className="approval-main">
        <p className="row row-tight">
          <Chip tone="warn"><Icon name={APPROVAL_ICON[approval.kind] ?? 'approvals'} size={12} />{humanize(approval.kind)}</Chip>
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
          {base && approval.issueId && !hideIssueLink ? <Link to={`${base}/issues/${approval.issueId}`}>Open the issue</Link> : null}
          {base && approval.runId ? <Link to={`${base}/runs/${approval.runId}`}>Open the run</Link> : null}
          <span className="dim apr-id">{approval.id}</span>
        </p>
        {!pending && (approval.decidedAt || approval.decisionNote) ? (
          <p className="dim">{approval.decidedAt ? `Decided ${dateTime(approval.decidedAt)}` : ''}{approval.decisionNote ? `: ${approval.decisionNote}` : ''}</p>
        ) : null}
      </div>
      {pending ? (
        <div className="approval-actions">
          <input aria-label={`Note for ${approval.title}`} placeholder="Note for the agent (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row">
            <Button icon="check" variant="primary" disabled={busy} busy={busy} onClick={() => decide('approved')}>Approve</Button>
            <Button icon="close" variant="danger" disabled={busy} onClick={() => decide('denied')}>Deny</Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** One approval, kept fresh by the bus. */
function useApproval(orgId: string, id: string | null) {
  return useQuery(id ? oneKey(orgId, id) : null, () => api.getApproval(orgId, id!), { events: ['approval.'], orgId });
}

const STATUS_WORD: Record<Approval['status'], string> = { pending: 'needs you', approved: 'approved', denied: 'denied', expired: 'expired', cancelled: 'cancelled' };

/**
 * An approval id in prose, rendered as a live chip: status lamp plus what is
 * asked. Clicking opens the request in a dialog on the current page.
 */
function ApprovalRef({ orgId, id, onOpen }: { orgId: string; id: string; onOpen: (id: string) => void }) {
  const q = useApproval(orgId, id);
  const a = q.data;
  const open = (e: MouseEvent) => {
    // Inside a timeline <summary>: open the dialog, do not toggle the row.
    e.preventDefault();
    e.stopPropagation();
    onOpen(id);
  };
  if (q.error && !a) return <code className="apr-ref-missing" title="This approval was not found in this organization">{id}</code>;
  const label = a ? a.title : 'Approval request';
  const tone = a ? toneOf(a.status) : 'idle';
  return (
    <button
      type="button" className={`apr-ref apr-ref-${tone}`} onClick={open}
      title={`${id}${a ? `: ${STATUS_WORD[a.status]}` : ''}. Click to review${a?.status === 'pending' ? ' and decide' : ''}.`}
      aria-label={`Approval: ${label}${a ? `, ${STATUS_WORD[a.status]}` : ''}. Open`}
    >
      <Lamp tone={tone} live={a?.status === 'pending'} />
      <span className="apr-ref-title">{label}</span>
      {a ? <span className="apr-ref-status">{STATUS_WORD[a.status]}</span> : null}
    </button>
  );
}

/** The request behind an approval id, decidable in place. Closes once decided. */
export function ApprovalDialog({ org, id, onClose }: { org: Organization; id: string | null; onClose: () => void }) {
  const q = useApproval(org.id, id);
  return (
    <Modal open={id !== null} onClose={onClose} title={q.data?.status === 'pending' ? 'Waiting for your decision' : 'Approval request'} wide>
      {q.data ? (
        <ul className="approvals approvals-dialog">
          <ApprovalCard approval={q.data} org={org} onDecided={onClose} />
        </ul>
      ) : q.error ? <ErrorNote error={q.error} retry={q.reload} /> : <Loading lines={3} />}
    </Modal>
  );
}

/**
 * Makes every approval id in Markdown under it a clickable chip that opens
 * the request (with Approve / Deny) in a dialog, without leaving the page.
 */
export function ApprovalRefs({ org, children }: { org: Organization; children: ReactNode }) {
  const orgId = org.id;
  const [openId, setOpenId] = useState<string | null>(null);
  const onOpen = useCallback((id: string) => setOpenId(id), []);
  const refs = useMemo(() => ({ approval: (id: string, key: string) => <ApprovalRef key={key} orgId={orgId} id={id} onOpen={onOpen} /> }), [orgId, onOpen]);
  return (
    <MarkdownRefs.Provider value={refs}>
      {children}
      <ApprovalDialog org={org} id={openId} onClose={() => setOpenId(null)} />
    </MarkdownRefs.Provider>
  );
}

/** An approval chip outside Markdown (e.g. an activity row), using the shared dialog. */
export function ApprovalChip({ id }: { id: string }) {
  const refs = useContext(MarkdownRefs);
  return refs?.approval ? <>{refs.approval(id, id)}</> : <code>{id}</code>;
}

/**
 * Everything on this issue still waiting for the owner: approvals raised while
 * working on it plus any its comments point at, each decidable right here.
 */
export function PendingApprovals({ org, issueId, referencedIds }: { org: Organization; issueId: string; referencedIds: string[] }) {
  const ids = referencedIds.slice(-100);
  const q = useQuery(k(org.id, 'approvals', 'issue', issueId, ids.join(',')), async () => {
    const [linked, mentioned] = await Promise.all([
      api.listApprovals(org.id, { issueId, status: 'pending', limit: 100 }),
      ids.length ? api.listApprovals(org.id, { ids, status: 'pending', limit: 100 }) : Promise.resolve([] as Approval[]),
    ]);
    // Filter again here too: a daemon older than these query filters ignores them and returns every pending approval.
    const wanted = new Set(ids);
    const all = new Map<string, Approval>();
    for (const a of [...linked.filter((x) => x.issueId === issueId), ...mentioned.filter((x) => wanted.has(x.id))]) all.set(a.id, a);
    return [...all.values()].sort((a, b) => a.createdAt - b.createdAt);
  }, { events: ['approval.'], orgId: org.id });
  const list = q.data ?? [];
  if (list.length === 0) return null;
  return (
    <Panel icon="approvals" className="panel-attention" title={<>Waiting on you <span className="attention-count">{list.length}</span></>} flush>
      <p className="panel-lede muted">This work is paused until you decide. The agent is woken with your answer.</p>
      <ul className="approvals">
        {list.map((a) => <ApprovalCard key={a.id} approval={a} org={org} hideIssueLink={a.issueId === issueId} />)}
      </ul>
    </Panel>
  );
}
