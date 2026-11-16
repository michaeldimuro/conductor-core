import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useConnectors } from '../../components/connectors.js';
import { Icon } from '../../components/icons.js';
import { Button, Check, ErrorNote, Panel } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { k, useDirectory, useOrg } from '../../lib/org.js';
import { invalidate, useAction, useQuery } from '../../lib/query.js';
import { saveOnboarding, useChecklist } from '../../lib/setup.js';
import { toast } from '../../lib/toast.js';
import { useSetup } from './Setup.js';

interface GoalDraft { include: boolean; title: string; successMetric: string; owner: string }

export function LaunchStep() {
  const { org, base } = useOrg();
  const setup = useSetup();
  const nav = useNavigate();
  const dir = useDirectory(org.id);
  const goals = useQuery(k(org.id, 'goals'), () => api.listGoals(org.id), { orgId: org.id, events: ['goal.'] });
  const connectors = useConnectors(org.id);
  const skills = useQuery(k(org.id, 'skills'), () => api.listSkills(org.id), { orgId: org.id, events: ['skill.'] });
  const existing = goals.data ?? [];
  const checklist = useChecklist(org, { goals: existing.length, connectors: connectors.data?.length, skills: skills.data?.filter((s) => s.status === 'active').length });
  // The top of the reporting tree plans the work: an agent reporting to the owner, preferring a department lead.
  const leads = new Set(dir.departments.map((d) => d.leadAgentId).filter(Boolean));
  const top = dir.staff.find((a) => !a.reportsTo && leads.has(a.id)) ?? dir.staff.find((a) => !a.reportsTo) ?? dir.staff[0];
  const [rows, setRows] = useState<GoalDraft[]>(() => {
    const fromDraft = (setup.draft?.goals ?? []).map((g) => ({ include: true, title: g.title, successMetric: g.successMetric, owner: '' }));
    return fromDraft.length ? fromDraft : [{ include: true, title: '', successMetric: '', owner: '' }];
  });
  const [kickoff, setKickoff] = useState(true);
  const providerOk = checklist.find((c) => c.id === 'models')?.done ?? false;
  const blocking = checklist.filter((c) => !c.done && !c.optional && c.id !== 'goal');
  const toCreate = rows.filter((r) => r.include && r.title.trim());
  const set = (i: number, patch: Partial<GoalDraft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const launch = useAction(async () => {
    for (const r of toCreate) {
      await api.createGoal(org.id, { title: r.title.trim(), successMetric: r.successMetric.trim() || undefined, level: 'org', ownerAgentId: r.owner || top?.id || null });
    }
    let woke = false;
    if (kickoff && providerOk && top) {
      const res = await api.runAgent(org.id, top.id, { prompt: 'Kick-off: the owner just finished setting up this organization. Review the mission and goals, then break them into the first issues and delegate them to the team.' });
      woke = !!res.jobId;
    }
    await saveOnboarding(org.id, setup.state, { status: 'complete', step: 'launch', done: ['launch'] });
    invalidate(`${org.id}/`, 'orgs', 'status');
    toast(woke && top ? `${org.name} is live. ${top.name} is planning the first issues.` : `${org.name} is set up.`, 'ok');
    nav(base);
  });

  return (
    <div className="stack-lg">
      <Panel icon="tasks" title="Readiness" flush>
        <ul className="checklist">
          {checklist.map((c) => (
            <li key={c.id} className={c.done ? 'is-done' : c.optional ? 'is-optional' : 'is-todo'}>
              <span className="check-dot" aria-hidden="true">{c.done ? <Icon name="check" size={12} strokeWidth={3} /> : null}</span>
              <span className="grow"><strong>{c.label}</strong><span className="muted">{c.detail}</span></span>
              <span className="sr-only">{c.done ? 'Done' : c.optional ? 'Optional' : 'Not done'}</span>
              {!c.done && c.step !== 'launch' ? <Link to={`${base}/setup/${c.step}`}>{c.optional ? 'Add' : 'Fix'}</Link> : null}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel icon="goals" title={existing.length ? 'Add more goals' : 'First goals'}>
        <div className="stack">
          {existing.length ? <p className="dim">{existing.length} {existing.length === 1 ? 'goal already exists' : 'goals already exist'}: {existing.slice(0, 3).map((g) => g.title).join(', ')}{existing.length > 3 ? '…' : ''}</p> : <p className="dim">Each goal is owned by an agent, who breaks it into issues. Keep them outcome-shaped: &ldquo;Reach 100 paying customers&rdquo; beats &ldquo;do marketing&rdquo;.</p>}
          <ul className="goal-rows">
            {rows.map((r, i) => (
              <li key={i}>
                <input type="checkbox" aria-label={`Create goal ${i + 1}`} checked={r.include} onChange={(e) => set(i, { include: e.target.checked })} />
                <input aria-label={`Goal ${i + 1}`} placeholder="What should be true?" value={r.title} onChange={(e) => set(i, { title: e.target.value })} maxLength={200} />
                <input aria-label={`Success metric for goal ${i + 1}`} placeholder="How you'll measure it" value={r.successMetric} onChange={(e) => set(i, { successMetric: e.target.value })} maxLength={300} />
                <select aria-label={`Owner of goal ${i + 1}`} value={r.owner || top?.id || ''} onChange={(e) => set(i, { owner: e.target.value })}>
                  {dir.staff.length === 0 ? <option value="">No agents yet</option> : null}
                  {dir.staff.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </li>
            ))}
          </ul>
          <div><Button small variant="quiet" icon="add" onClick={() => setRows([...rows, { include: true, title: '', successMetric: '', owner: '' }])}>Add a goal</Button></div>
        </div>
      </Panel>

      <div className="launch-card">
        <div className="launch-glow" aria-hidden="true" />
        <div className="grow stack">
          <h2>Ready when you are</h2>
          {blocking.length ? (
            <p className="dim">You can launch now, but {blocking.map((b) => b.label.toLowerCase()).join(' and ')} {blocking.length === 1 ? 'is' : 'are'} still open. Agents will wait until {blocking.length === 1 ? 'it is' : 'they are'} done.</p>
          ) : <p className="dim">{toCreate.length ? `${toCreate.length} ${toCreate.length === 1 ? 'goal' : 'goals'} will be created.` : 'No new goals will be created.'} You can change anything later from Settings.</p>}
          {top ? <Check label={`Wake ${top.name} now to plan the first issues`} checked={kickoff && providerOk} onChange={setKickoff} hint={providerOk ? 'Otherwise the team starts on its next heartbeat.' : 'Needs a model provider first.'} /> : null}
          <ErrorNote error={launch.error} />
        </div>
        <Button variant="primary" icon="launch" busy={launch.busy} onClick={() => void launch.run()}>Launch {org.name}</Button>
      </div>
    </div>
  );
}
