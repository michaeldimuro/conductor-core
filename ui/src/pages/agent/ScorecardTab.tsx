import { useState } from 'react';
import { LineChart } from '../../components/charts.js';
import { Empty, Load, Panel } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { Agent } from '../../lib/api.js';
import { money, pct, shortDay } from '../../lib/format.js';
import { k, useOrg } from '../../lib/org.js';
import { Icon } from '../../components/icons.js';
import { useQuery } from '../../lib/query.js';

export function ScorecardTab({ agent }: { agent: Agent }) {
  const { org } = useOrg();
  const [days, setDays] = useState(90);
  const card = useQuery(k(org.id, 'agent', agent.id, 'scorecard', days), () => api.agentScorecard(org.id, agent.id, { days }), { events: ['run.finished', 'issue.done'], orgId: org.id });
  return (
    <div className="stack-lg">
      <div className="toolbar">
        <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={180}>Last 180 days</option><option value={365}>Last year</option>
        </select>
      </div>
      <Load q={card} lines={5}>
        {(s) => (s.runs === 0 ? <Panel><Empty icon="agent" title={`${agent.name} has no graded runs in this period`}><p>The scorecard fills in as issues are closed and reviewed.</p></Empty></Panel> : (
          <>
            <div className="tiles">
              <div className="tile"><span className="tile-label"><Icon name="trend" size={14} />Success rate</span><span className="tile-value">{pct(s.successRate)}</span><span className="tile-sub">{s.runs} runs</span></div>
              <div className="tile"><span className="tile-label"><Icon name="refresh" size={14} />Rework rate</span><span className="tile-value">{pct(s.reworkRate)}</span><span className="tile-sub">Issues sent back after review</span></div>
              <div className="tile"><span className="tile-label"><Icon name="costs" size={14} />Cost per issue</span><span className="tile-value">{money(s.costPerIssue)}</span><span className="tile-sub">{s.issuesClosed} issues closed</span></div>
            </div>
            <div className="grid-2">
              <Panel icon="trend" title="Success rate by week">
                <LineChart label="Weekly success rate" max={1} format={(v) => pct(v)} data={s.trend.map((w) => ({ label: shortDay(w.weekStart), value: w.successRate }))} />
              </Panel>
              <Panel icon="costs" title="Cost per issue by week">
                <LineChart label="Weekly cost per issue" format={(v) => money(v)} data={s.trend.map((w) => ({ label: shortDay(w.weekStart), value: w.costPerIssue }))} />
              </Panel>
            </div>
            <Panel icon="tasks" title="By task type" flush>
              {s.byTaskType.length === 0 ? <Empty icon="issues" title="No task types recorded" /> : (
                <table className="table">
                  <thead><tr><th>Task type</th><th className="num">Runs</th><th className="num">Success rate</th><th className="num">Cost per issue</th></tr></thead>
                  <tbody>
                    {s.byTaskType.map((t) => (
                      <tr key={t.taskType}><td data-label="Task type">{t.taskType}</td><td data-label="Runs" className="num">{t.runs}</td><td data-label="Success rate" className="num">{pct(t.successRate)}</td><td data-label="Cost per issue" className="num">{money(t.costPerIssue)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </>
        ))}
      </Load>
    </div>
  );
}
