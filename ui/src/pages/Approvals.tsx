import { useState } from 'react';
import { Empty, Load, PageHead, Panel, Segmented } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { Approval, Organization } from '../lib/api.js';
import { useQuery } from '../lib/query.js';
import { ApprovalCard, PENDING_KEY } from '../components/approvals.js';
import { OrgTakeovers } from '../components/takeover.js';

export function Approvals({ orgs }: { orgs: Organization[] }) {
  const [view, setView] = useState<'pending' | 'history'>('pending');
  const pending = useQuery(PENDING_KEY, () => api.approvalInbox({ status: 'pending', limit: 500 }), { events: ['approval.'] });
  const history = useQuery(view === 'history' ? 'approvals/history' : null, async () => (await api.approvalInbox({ limit: 300 })).filter((a) => a.status !== 'pending'), { events: ['approval.decided'] });
  const orgOf = (a: Approval) => orgs.find((o) => o.id === a.orgId);
  return (
    <div className="page page-narrow">
      <PageHead icon="approvals" eyebrow="Inbox" title="Approvals" sub="Risky actions wait here for your decision, across every organization. Agents keep working on other things while they wait." />
      <Segmented label="Approvals view" value={view} onChange={setView} options={[{ value: 'pending', label: `Waiting (${pending.data?.length ?? 0})` }, { value: 'history', label: 'History' }]} />
      {view === 'pending' ? <div aria-live="polite">{orgs.filter((o) => o.status === 'active').map((o) => <OrgTakeovers key={o.id} org={o} showOrg={orgs.length > 1} />)}</div> : null}
      {view === 'pending' ? (
        <Panel flush>
          <div aria-live="polite">
            <Load q={pending} empty={<Empty icon="approvals" title="Nothing needs your approval"><p>Hires, payments, first sends to new recipients and other gated actions will appear here.</p></Empty>}>
              {(list) => <ul className="approvals">{list.map((a) => <ApprovalCard key={a.id} approval={a} org={orgOf(a)} />)}</ul>}
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
