import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart } from '../components/charts.js';
import { Button, Empty, Load, Meter, PageHead, Panel } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { BudgetSummary } from '../lib/api.js';
import { count, dateTime, humanize, money, monthStart, seatTime, shortDay, tokens } from '../lib/format.js';
import { k, useDirectory, useOrg, type Directory } from '../lib/org.js';
import { Icon } from '../components/icons.js';
import { useQuery } from '../lib/query.js';

const DAY = 86_400_000;
type Range = 'month' | '30' | '90';

/** Every day in the range (the ledger buckets by UTC day), so days without spend still show as gaps. */
function fillDays(byDay: BudgetSummary['byDay'], since: number): Array<{ label: string; value: number }> {
  const spent = new Map(byDay.map((d) => [d.day, d.costUsd]));
  const out: Array<{ label: string; value: number }> = [];
  const today = new Date().toISOString().slice(0, 10);
  for (let t = since; ; t += DAY) {
    const key = new Date(t).toISOString().slice(0, 10);
    if (key > today) break;
    out.push({ label: shortDay(key), value: spent.get(key) ?? 0 });
  }
  return out;
}

function lineName(line: BudgetSummary['lines'][number], dir: Directory, orgName: string): string {
  if (line.scope === 'org') return orgName;
  if (line.scope === 'dept') return `${dir.dept(line.id)?.name ?? 'Department'} department`;
  if (line.scope === 'agent') return dir.agentName(line.id);
  return `Project ${line.id}`;
}

/** Straight-line projection of this month's spend: the number that tells you whether to act before the cap does. */
function Forecast({ spent, cap }: { spent: number; cap: number | null }) {
  const now = new Date();
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsed = Math.max(1, (now.getTime() - monthStart(now)) / DAY);
  const projected = (spent / elapsed) * days;
  const over = cap != null && cap > 0 && projected > cap;
  return (
    <div className={`tile${over ? ' tile-warn' : ''}`}>
      <span className="tile-label"><Icon name="trend" size={14} />Projected this month</span>
      <span className="tile-value">{money(projected)}</span>
      <span className="tile-sub">{cap == null ? 'At the current pace' : spent >= cap ? `Already over the ${money(cap)} cap` : over ? `Over the ${money(cap)} cap around day ${Math.max(1, Math.ceil(cap / (spent / elapsed || 1)))}` : `Within the ${money(cap)} cap`}</span>
    </div>
  );
}

export function Costs() {
  const { org, base } = useOrg();
  const dir = useDirectory(org.id);
  const [range, setRange] = useState<Range>('month');
  const [ledgerLimit, setLedgerLimit] = useState(100);
  // The raw ledger is reference material: open on a desktop, one tap away on a phone.
  const [showLedger, setShowLedger] = useState(() => !window.matchMedia('(max-width: 860px)').matches);
  const since = useMemo(() => {
    if (range === 'month') return monthStart();
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() - (Number(range) - 1) * DAY;
  }, [range]);
  const o = { events: ['run.finished', 'budget.'], orgId: org.id };
  const summary = useQuery(k(org.id, 'budget', 'summary', since), () => api.budgetSummary(org.id, { since }), o);
  // Caps are monthly, so budget lines always read from the current month.
  const month = useQuery(k(org.id, 'budget', 'month'), () => api.budgetSummary(org.id, { since: monthStart() }), o);
  const finishedQ = useQuery(k(org.id, 'issues', 'done-since', since), async () => (await api.listIssues(org.id, { status: ['done'], limit: 200 })).items.filter((i) => (i.closedAt ?? i.updatedAt) >= since), o);
  const ledger = useQuery(showLedger ? k(org.id, 'budget', 'ledger', ledgerLimit) : null, () => api.budgetLedger(org.id, { limit: ledgerLimit }), o);
  const topAgent = Math.max(0, ...(summary.data?.byAgent.map((a) => a.costUsd) ?? []));

  return (
    <div className="page costs-page">
      <PageHead icon="costs" eyebrow="Spend and seat time" title="Costs" sub="Metered spend comes from each run's usage. Runs on a local subscription login cost nothing extra and count against seat time instead."
        actions={<select aria-label="Period" value={range} onChange={(e) => setRange(e.target.value as Range)} style={{ width: 'auto' }}><option value="month">This month</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select>} />
      <Load q={summary} lines={6}>
        {(s) => (
          <>
            <div className="tiles">
              <div className="tile"><span className="tile-label"><Icon name="costs" size={14} />Spend</span><span className="tile-value">{money(s.totalUsd)}</span><span className="tile-sub">{org.budgetMonthlyUsd == null ? 'No monthly cap' : `Monthly cap ${money(org.budgetMonthlyUsd)}`}</span></div>
              {range === 'month' ? <Forecast spent={s.totalUsd} cap={org.budgetMonthlyUsd} /> : null}
              <div className="tile"><span className="tile-label"><Icon name="time" size={14} />Seat time</span><span className="tile-value">{seatTime(s.seatSeconds)}</span><span className="tile-sub">{org.seatSecondsMonthly ? `Monthly quota ${seatTime(org.seatSecondsMonthly)}` : 'No quota'}</span></div>
              <div className="tile"><span className="tile-label"><Icon name="runs" size={14} />Runs</span><span className="tile-value">{count(s.byAgent.reduce((n, a) => n + a.runs, 0))}</span><span className="tile-sub">{s.byAgent.length} agents</span></div>
              <div className="tile"><span className="tile-label"><Icon name="tokens" size={14} />Tokens</span><span className="tile-value">{tokens(s.byAgent.reduce((n, a) => n + a.tokensIn + a.tokensOut, 0))}</span><span className="tile-sub">In and out</span></div>
            </div>
            <Panel icon="calendar" title="Spend by day" className="costs-chart">
              {s.totalUsd === 0 ? <Empty icon="costs" title="No metered spend in this period" /> : <BarChart label="Spend by day in US dollars" format={(v) => money(v)} data={fillDays(s.byDay, since)} />}
            </Panel>
            <div className="grid-2">
              <Panel icon="budget" title="Budgets this month">
                <Load q={month} lines={3}>
                  {(m) => (m.lines.length === 0 ? <Empty icon="costs" title="No budgets are set"><p>Set caps on the organization, a department or an agent.</p></Empty> : (
                    <ul className="stack">
                      {m.lines.map((l) => (
                        <li key={`${l.scope}-${l.id}`} className="stack budget-line">
                          <div className="spread">
                            <span className="truncate">{lineName(l, dir, org.name)}</span>
                            <span className="muted nowrap">{money(l.spentUsd)} of {money(l.capUsd)}{l.pct != null ? `, ${Math.round(l.pct)}%` : ''}</span>
                          </div>
                          <Meter value={l.spentUsd} cap={l.capUsd} label={`${lineName(l, dir, org.name)} budget used`} />
                        </li>
                      ))}
                      <li className="muted">The mark on each bar is the 80% soft alert. At 100% the agent is paused and its run ends cleanly.</li>
                    </ul>
                  ))}
                </Load>
              </Panel>
              <Panel icon="agents" title="What each agent delivered" flush>
                {s.byAgent.length === 0 ? <Empty icon="agent" title="No agent has spent anything in this period" /> : (
                  <ul className="value-list">
                    {[...s.byAgent].sort((x, y) => y.costUsd - x.costUsd).map((a) => {
                      const agent = dir.agent(a.agentId);
                      const finished = (finishedQ.data ?? []).filter((i) => i.assigneeAgentId === a.agentId).length;
                      const per = finished ? a.costUsd / finished : null;
                      return (
                        <li key={a.agentId}>
                          <div className="value-top">
                            {agent ? <Link to={`${base}/agents/${agent.slug}`}><strong>{agent.name}</strong></Link> : <strong>{dir.agentName(a.agentId)}</strong>}
                            <span className="grow" />
                            <strong className="value-cost">{money(a.costUsd)}</strong>
                          </div>
                          <span className="bar-inline" aria-hidden="true"><span style={{ width: `${topAgent ? (a.costUsd / topAgent) * 100 : 0}%` }} /></span>
                          <p className="value-meta">
                            <span className={per == null && a.costUsd > 0 ? 'value-warn' : undefined}>{finished ? `${finished} finished · ${money(per)} each` : a.costUsd > 0 ? 'Nothing finished yet' : 'No spend'}</span>
                            <span className="muted">{count(a.runs)} runs · {tokens(a.tokensIn + a.tokensOut)} tokens</span>
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>
            </div>
          </>
        )}
      </Load>
      <Panel icon="ledger" title="Ledger" className="costs-ledger" flush actions={<Button small onClick={() => setShowLedger((v) => !v)} aria-expanded={showLedger}>{showLedger ? 'Hide' : 'Show every charge'}</Button>}>
        {showLedger ? <Load q={ledger} empty={<Empty icon="costs" title="The ledger is empty" />}>
          {(rows) => (
            <>
              <table className="table">
                <thead><tr><th>When</th><th>Agent</th><th>Category</th><th>Model</th><th className="num">Tokens</th><th className="num">Cost</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td data-label="When">{r.runId ? <Link to={`${base}/runs/${r.runId}`}>{dateTime(r.ts)}</Link> : dateTime(r.ts)}</td>
                      <td data-label="Agent">{dir.agentName(r.agentId, 'Conductor')}</td>
                      <td data-label="Category">{humanize(r.category)}</td>
                      <td data-label="Model">{[r.provider, r.model].filter(Boolean).join(', ') || <span className="muted">None</span>}</td>
                      <td data-label="Tokens" className="num">{tokens(r.tokensIn + r.tokensOut)}</td>
                      <td data-label="Cost" className="num">{r.subscription ? `Seat ${seatTime(r.seatSeconds)}` : money(r.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length >= ledgerLimit && ledgerLimit < 5000 ? <div className="panel-body"><Button icon="down" small busy={ledger.fetching} onClick={() => setLedgerLimit((l) => Math.min(5000, l + 200))}>Show 200 more</Button></div> : null}
            </>
          )}
        </Load> : <p className="panel-body muted">Every metered charge with its run, model and tokens.</p>}
      </Panel>
    </div>
  );
}
