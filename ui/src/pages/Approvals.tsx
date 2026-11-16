import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Load, PageHead, Panel, Segmented } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { Approval, Organization } from '../lib/api.js';
import { useQuery } from '../lib/query.js';
import { humanize } from '../lib/format.js';
import { ApprovalCard, PENDING_KEY } from '../components/approvals.js';
import { OrgTakeovers } from '../components/takeover.js';

export function Approvals({ orgs }: { orgs: Organization[] }) {
  const [view, setView] = useState<'pending' | 'history'>('pending');
  const pending = useQuery(PENDING_KEY, () => api.approvalInbox({ status: 'pending', limit: 500 }), { events: ['approval.'] });
  const history = useQuery(view === 'history' ? 'approvals/history' : null, async () => (await api.approvalInbox({ limit: 300 })).filter((a) => a.status !== 'pending'), { events: ['approval.decided'] });
  const orgOf = (a: Approval) => orgs.find((o) => o.id === a.orgId);
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState<'expiring' | 'newest'>('expiring');
  const all = pending.data ?? [];
  const kinds = [...new Set(all.map((a) => a.kind))];
  const now = Date.now();
  const soon = all.filter((a) => a.expiresAt != null && a.expiresAt - now < 86_400_000).length;
  const arrange = (list: Approval[]) => list
    .filter((a) => !kind || a.kind === kind)
    .sort((a, b) => (sort === 'newest' ? b.createdAt - a.createdAt : (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)));
  return (
    <div className="page page-narrow">
      <PageHead icon="approvals" eyebrow="Inbox" title="Approvals" sub="Risky actions wait here for your decision, across every organization. Agents keep working on other things while they wait." />
      <Segmented label="Approvals view" value={view} onChange={setView} options={[{ value: 'pending', label: `Waiting (${pending.data?.length ?? 0})` }, { value: 'history', label: 'History' }]} />
      {view === 'pending' && all.length > 1 ? (
        <div className="setup-toolbar approvals-tools">
          {kinds.length > 1 ? (
            <div className="filter-chips" role="group" aria-label="Kind">
              <button type="button" aria-pressed={!kind} onClick={() => setKind('')}>All {all.length}</button>
              {kinds.map((x) => <button key={x} type="button" aria-pressed={kind === x} onClick={() => setKind(kind === x ? '' : x)}>{humanize(x)} {all.filter((a) => a.kind === x).length}</button>)}
            </div>
          ) : null}
          <span className="grow" />
          {soon ? <span className="attention-chip attention-warn" role="status">{soon} {soon === 1 ? 'expires' : 'expire'} within a day</span> : null}
          <select aria-label="Sort approvals" value={sort} onChange={(e) => setSort(e.target.value as 'expiring' | 'newest')} style={{ width: 'auto' }}>
            <option value="expiring">Expiring soonest</option><option value="newest">Newest first</option>
          </select>
        </div>
      ) : null}
      {view === 'pending' ? <div aria-live="polite">{orgs.filter((o) => o.status === 'active').map((o) => <OrgTakeovers key={o.id} org={o} showOrg={orgs.length > 1} />)}</div> : null}
      {view === 'pending' ? (
        <Panel flush>
          <div aria-live="polite">
            <Load q={pending} empty={<Empty icon="approvals" title="Nothing needs your approval"><p>Hires, payments, first sends to new recipients and other gated actions will appear here.</p></Empty>}>
              {(list) => {
                const sorted = arrange(list);
                const groups = [...new Set(sorted.map((a) => a.orgId))];
                // One organization: a flat list. Several: grouped, each with a way into that org's full inbox.
                return groups.length <= 1 ? <ul className="approvals">{sorted.map((a) => <ApprovalCard key={a.id} approval={a} org={orgOf(a)} />)}</ul> : (
                  <>
                    {groups.map((id) => {
                      const o = orgs.find((x) => x.id === id);
                      return (
                        <section key={id} className="approval-group">
                          <header className="approval-group-head"><strong>{o?.name ?? 'Organization'}</strong>{o ? <Link to={`/o/${o.slug}/inbox`}>Everything waiting in {o.name}</Link> : null}</header>
                          <ul className="approvals">{sorted.filter((a) => a.orgId === id).map((a) => <ApprovalCard key={a.id} approval={a} org={o} />)}</ul>
                        </section>
                      );
                    })}
                  </>
                );
              }}
            </Load>
          </div>
        </Panel>
      ) : (
        <Panel flush>
          <Load q={history} empty={<Empty icon="approvals" title="No decisions recorded yet" />}>
            {(list) => <ul className="approvals">{list.map((a) => <ApprovalCard key={a.id} approval={a} org={orgOf(a)} />)}</ul>}
          </Load>
        </Panel>
      )}
    </div>
  );
}
