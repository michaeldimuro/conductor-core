import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/icons.js';
import { NeedCard, needLabel } from '../components/needs.js';
import { LearnedSection } from '../components/learned.js';
import { Loading } from '../components/ui.js';
import { useDirectory, useOrg } from '../lib/org.js';
import { useLiveRuns, useNeeds, type NeedKind } from '../lib/work.js';

const FILTERS: ReadonlyArray<{ id: '' | NeedKind; label: string }> = [
  { id: '', label: 'All' }, { id: 'approval', label: 'Approvals' }, { id: 'blocked', label: 'Blocked' }, { id: 'review', label: 'Reviews' }, { id: 'takeover', label: 'Sign-ins' },
];

/**
 * Needs you: every decision the team is waiting on, ranked by how much work it
 * unblocks, each answerable from the card. Built to be cleared from a phone.
 */
export function Inbox() {
  const { org, base } = useOrg();
  const dir = useDirectory(org.id);
  const { needs, loading } = useNeeds(org.id);
  const live = useLiveRuns(org.id);
  const [filter, setFilter] = useState<'' | NeedKind>('');
  const shown = needs.filter((n) => !filter || n.kind === filter);
  const counts = new Map<string, number>();
  for (const n of needs) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  const unblocks = needs.reduce((s, n) => s + n.chain, 0);
  const working = (live.data ?? []).filter((r) => r.status === 'running');

  return (
    <div className="page page-narrow inbox-page">
      <header className="screen-head">
        <span className="eyebrow">{org.name}</span>
        <h1>Needs you</h1>
        <p className="dim">
          {loading ? 'Checking what is waiting…' : needs.length === 0 ? 'Nothing is waiting on you.' : `${needs.length} ${needs.length === 1 ? 'decision' : 'decisions'}${unblocks ? `, unblocking ${unblocks} ${unblocks === 1 ? 'task' : 'tasks'}` : ''}. Most important first.`}
        </p>
      </header>
      {needs.length > 1 ? (
        <div className="filter-chips scroll-chips" role="group" aria-label="Show">
          {FILTERS.filter((f) => !f.id || counts.get(f.id)).map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}{f.id ? ` ${counts.get(f.id)}` : ` ${needs.length}`}</button>
          ))}
        </div>
      ) : null}
      {loading ? <Loading lines={4} /> : shown.length ? (
        <ul className="needs" aria-live="polite">{shown.map((n) => <NeedCard key={n.key} need={n} org={org} base={base} />)}</ul>
      ) : (
        <div className="all-clear">
          <span className="all-clear-mark" aria-hidden="true"><Icon name="check" size={22} strokeWidth={2.5} /></span>
          <h2>{filter ? `No ${needLabel(filter).toLowerCase()} items` : 'You are all caught up'}</h2>
          <p className="dim">{working.length ? `${working.map((r) => dir.agentName(r.agentId)).join(', ')} ${working.length === 1 ? 'is' : 'are'} working. You will see it here the moment anyone needs a decision.` : 'Agents bring approvals, questions and finished work here.'}</p>
          <div className="row"><Link className="btn" to={base}>Back to Today</Link><Link className="btn btn-quiet" to={`${base}/issues`}>All tasks</Link></div>
        </div>
      )}
      {filter ? null : <LearnedSection org={org} base={base} />}
    </div>
  );
}
