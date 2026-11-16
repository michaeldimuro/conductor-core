import { useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { AgentForm } from '../../components/AgentForm.js';
import { describeBinding } from '../../components/binding.js';
import { Button, Chip, ConfirmButton, Empty, ErrorNote, JsonView, Load, Loading, Meter, Panel, Status } from '../../components/ui.js';
import { runNow } from '../../lib/run-now.js';
import { api } from '../../lib/api.js';
import type { Agent } from '../../lib/api.js';
import { ago, dateTime, describeCron, duration, money } from '../../lib/format.js';
import { AUTONOMY_LEVELS, k, useDirectory, useOrg } from '../../lib/org.js';
import { useAction, useQuery } from '../../lib/query.js';
import { AgentActions } from '../OrgChart.js';
import { BrowserTab } from './BrowserTab.js';
import { ConnectorsTab } from './ConnectorsTab.js';
import { MemoryTab } from './MemoryTab.js';
import { ChatTab, RunsTab, TasksTab } from './RunsChat.js';
import { ScorecardTab } from './ScorecardTab.js';
import { Icon, type IconName } from '../../components/icons.js';
import { SkillsTab } from './SkillsTab.js';
import { useLiveRuns, useOpenIssues, useRecentlyDone } from '../../lib/work.js';
import { describe } from '../Team.js';
import { initials } from '../setup/TeamStep.js';

/** Chat comes first: opening an agent lands you in the conversation with it. */
const TABS: ReadonlyArray<{ id: string; label: string; icon: IconName }> = [
  { id: 'chat', label: 'Chat', icon: 'chat' }, { id: 'tasks', label: 'Tasks', icon: 'task' }, { id: 'runs', label: 'Runs', icon: 'runs' }, { id: 'config', label: 'Config', icon: 'tune' },
  { id: 'skills', label: 'Skills', icon: 'skills' }, { id: 'connectors', label: 'Connectors', icon: 'connectors' }, { id: 'memory', label: 'Memory', icon: 'memory' },
  { id: 'scorecard', label: 'Scorecard', icon: 'scorecard' }, { id: 'browser', label: 'Browser', icon: 'browser' },
];

function ConfigTab({ agent, onEdit }: { agent: Agent; onEdit: () => void }) {
  const { org, base } = useOrg();
  const dir = useDirectory(org.id);
  const budget = useQuery(k(org.id, 'agent', agent.id, 'budget'), () => api.agentBudget(org.id, agent.id), { events: ['run.finished', 'budget.'], orgId: org.id });
  const revisions = useQuery(k(org.id, 'agent', agent.id, 'revisions'), () => api.listRevisions(org.id, { entityKind: 'agent', entityId: agent.id }), { events: ['agent.'], orgId: org.id });
  const rollback = useAction((revision: number) => api.rollbackRevision(org.id, { entityKind: 'agent', entityId: agent.id, revision }), { invalidate: [`${org.id}/`], success: 'Configuration rolled back' });
  const manager = dir.agent(agent.reportsTo);
  const level = AUTONOMY_LEVELS[agent.autonomyLevel];
  const cron = agent.heartbeatCron ? describeCron(agent.heartbeatCron) : null;
  return (
    <div className="split">
      <div className="stack-lg">
        <Panel icon="persona" title="Persona" actions={agent.status !== 'terminated' ? <Button icon="edit" small onClick={onEdit}>Edit</Button> : null}>
          <dl className="kv">
            <div><dt>Role</dt><dd>{agent.role}</dd></div>
            <div><dt>Goal</dt><dd className="prose">{agent.goal || <span className="muted">None written</span>}</dd></div>
            <div><dt>Backstory</dt><dd className="prose">{agent.backstory || <span className="muted">None written</span>}</dd></div>
            <div><dt>Department</dt><dd>{dir.dept(agent.deptId)?.name ?? agent.deptId}</dd></div>
            <div><dt>Reports to</dt><dd>{manager ? <Link to={`${base}/agents/${manager.slug}`}>{manager.name}</Link> : 'You'}</dd></div>
          </dl>
        </Panel>
        <Panel icon="tune" title="How it runs">
          <dl className="kv">
            <div><dt>Provider</dt><dd>{describeBinding(agent.providerBinding, agent.model)}{!agent.providerBinding && org.defaultProvider ? <span className="muted"> ({describeBinding(org.defaultProvider, agent.model)})</span> : null}</dd></div>
            <div><dt>Heartbeat</dt><dd>{cron ? <>{cron.text} <code>{agent.heartbeatCron}</code>{cron.next[0] ? <span className="muted">, next {dateTime(cron.next[0])}</span> : null}</> : 'None. Wakes on assignment, mention or manual run.'}</dd></div>
            <div><dt>Autonomy</dt><dd><strong>{agent.autonomyLevel} {level?.name}</strong><span className="field-hint">{level?.behavior}</span></dd></div>
            <div><dt>Run limits</dt><dd>{agent.maxSteps} steps, {duration(agent.maxWallMs)} per run, {agent.maxRunsPerHour} runs an hour</dd></div>
          </dl>
        </Panel>
        <Panel icon="runs" title="Revision history" flush>
          <Load q={revisions} lines={2} empty={<Empty icon="runs" title="No revisions recorded" />}>
            {(list) => (
              <ul className="lines">
                {[...list].sort((a, b) => b.revision - a.revision).map((r, i) => (
                  <li key={r.id} className="revision">
                    <details>
                      <summary>
                        <span><strong>Revision {r.revision}</strong> <span className="dim">{r.note ?? 'Changed'}</span></span>
                        <span className="muted" title={dateTime(r.ts)}>{r.author}, {ago(r.ts)}</span>
                      </summary>
                      <div className="tl-detail stack">
                        <JsonView value={r.snapshot} />
                        {i > 0 ? <div><ConfirmButton small label={`Roll back to revision ${r.revision}`} title={`Roll back to revision ${r.revision}`} confirmLabel="Roll back" message="The agent's configuration returns to this snapshot. The rollback itself is recorded as a new revision." onConfirm={() => rollback.run(r.revision)} /></div> : null}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Load>
        </Panel>
      </div>
      <Panel icon="budget" title="Budget this month">
        <Load q={budget} lines={2}>
          {(b) => (
            <div className="stack">
              {!b.allowed ? <p className="note note-stop">{b.reason ?? 'Spending is stopped.'}</p> : null}
              <p><span className="tile-value">{b.remainingUsd == null ? 'Uncapped' : money(b.remainingUsd)}</span>{b.remainingUsd == null ? null : <span className="muted"> left under the tightest cap</span>}</p>
              {b.lines.map((l) => (
                <div key={`${l.scope}-${l.id}`} className="stack budget-line">
                  <div className="spread"><span>{l.scope === 'org' ? 'Organization' : l.scope === 'dept' ? 'Department' : l.scope === 'agent' ? 'This agent' : 'Project'}</span><span className="muted">{money(l.spentUsd)} of {money(l.capUsd)}</span></div>
                  <Meter value={l.spentUsd} cap={l.capUsd} label={`${l.scope} budget used`} />
                </div>
              ))}
              <p className="muted">Seat time {duration(b.seat.usedSeconds * 1000)}{b.seat.capSeconds ? ` of ${duration(b.seat.capSeconds * 1000)}` : ', no quota'}</p>
            </div>
          )}
        </Load>
      </Panel>
    </div>
  );
}

/** What this agent is doing right now and what it got through this week, before any tab. */
function AgentBrief({ agent }: { agent: Agent }) {
  const { org, base } = useOrg();
  const live = useLiveRuns(org.id);
  const open = useOpenIssues(org.id);
  const done = useRecentlyDone(org.id, 7);
  const recent = useQuery(k(org.id, 'runs', 'recent'), () => api.listRuns(org.id, { limit: 100 }), { orgId: org.id, events: ['run.finished'] });
  if (!live.data || !open.data) return null;
  const d = describe(agent, live.data, open.data, recent.data?.find((r) => r.agentId === agent.id && r.status !== 'running'), base);
  const mine = open.data.filter((i) => i.assigneeAgentId === agent.id);
  const finished = (done.data ?? []).filter((i) => i.assigneeAgentId === agent.id);
  return (
    <section className={`agent-brief is-${d.state}`} aria-label="Status">
      <div className="agent-brief-now">
        <span className={`avatar${d.state === 'working' ? ' avatar-live' : ''}`} aria-hidden="true">{initials(agent.name)}</span>
        <p className={`team-line team-line-${d.state}`}>{d.line}</p>
        {d.to ? <Link className="btn btn-sm" to={d.to}>{d.state === 'working' ? 'Watch' : 'Open'}</Link> : null}
      </div>
      <dl className="agent-brief-stats">
        <div><dt>Done this week</dt><dd>{finished.length}</dd></div>
        <div><dt>Open tasks</dt><dd>{mine.length}</dd></div>
        <div><dt>Waiting on you</dt><dd>{mine.filter((i) => i.status === 'blocked' || (i.status === 'in_review' && !i.reviewerAgentId)).length}</dd></div>
      </dl>
    </section>
  );
}

export function AgentPage() {
  const { org, base } = useOrg();
  const { agent: slug = '', tab = 'chat' } = useParams();
  const dir = useDirectory(org.id);
  const [editing, setEditing] = useState(false);
  const [more, setMore] = useState(false);
  const agent = dir.agents.find((a) => a.slug === slug || a.id === slug);
  const run = useAction(() => runNow(org.id, agent!.id, agent!.name), { invalidate: [k(org.id, 'runs')] });
  if (!agent) {
    return (
      <div className="page page-narrow">
        {dir.loading ? <Loading lines={5} /> : dir.error ? <ErrorNote error={dir.error} /> : <Empty icon="search" title="Agent not found"><Link to={`${base}/chart`}>Open the org chart</Link></Empty>}
      </div>
    );
  }
  const here = `${base}/agents/${agent.slug}`;
  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head-text">
          <nav className="crumbs" aria-label="Breadcrumb"><Link to={`${base}/chart`}>Org chart</Link><span aria-hidden="true">/</span><span>{dir.dept(agent.deptId)?.name}</span></nav>
          <h1 className="page-title-icon"><span className="page-icon page-icon-agent"><Icon name="agent" size={22} /></span>{agent.name}</h1>
          <p className="row agent-sub"><span>{agent.role}</span><Status value={agent.status} label={agent.status === 'paused' && agent.pausedReason ? `Paused: ${agent.pausedReason}` : undefined} />{dir.dept(agent.deptId)?.leadAgentId === agent.id ? <Chip tone="info">Lead</Chip> : null}</p>
        </div>
        <div className="row page-actions agent-head-actions">
          <span className={`agent-secondary${more ? ' open' : ''}`}><AgentActions agent={agent} onEdit={() => setEditing(true)} /></span>
          <Button className="more-toggle" icon="menu" aria-expanded={more} onClick={() => setMore((v) => !v)}>Actions</Button>
          <Button icon="play" variant="primary" busy={run.busy} disabled={agent.status !== 'active'} onClick={() => void run.run()}>Run now</Button>
        </div>
      </header>
      <AgentBrief agent={agent} />
      <nav className="tabs" aria-label="Agent sections">
        {TABS.map((t) => <NavLink key={t.id} to={t.id === 'chat' ? here : `${here}/${t.id}`} end><Icon name={t.icon} size={14} />{t.label}</NavLink>)}
      </nav>
      {tab === 'config' ? <ConfigTab agent={agent} onEdit={() => setEditing(true)} /> : null}
      {tab === 'skills' ? <SkillsTab agent={agent} /> : null}
      {tab === 'connectors' ? <ConnectorsTab agent={agent} /> : null}
      {tab === 'memory' ? <MemoryTab agent={agent} /> : null}
      {tab === 'scorecard' ? <ScorecardTab agent={agent} /> : null}
      {tab === 'runs' ? <RunsTab agent={agent} /> : null}
      {tab === 'chat' ? <ChatTab key={agent.id} agent={agent} /> : null}
      {tab === 'tasks' ? <TasksTab agent={agent} /> : null}
      {tab === 'browser' ? <BrowserTab agent={agent} /> : null}
      {!TABS.some((t) => t.id === tab) ? <Empty icon="search" title="No such section" /> : null}
      <AgentForm open={editing} onClose={() => setEditing(false)} agent={agent} />
    </div>
  );
}
