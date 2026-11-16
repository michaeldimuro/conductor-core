import { useState } from 'react';
import { AgentForm, CronField } from '../../components/AgentForm.js';
import { Icon } from '../../components/icons.js';
import { ModelSelect } from '../../components/models.js';
import { Button, Chip, Empty, ErrorNote, Field, FormShell, Modal } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { Agent, Department, OnboardingDraft } from '../../lib/api.js';
import { AUTONOMY_LEVELS, autonomyName, useDirectory, useOrg } from '../../lib/org.js';
import { useAction } from '../../lib/query.js';
import { StepActions, useSetup } from './Setup.js';

type Suggestion = OnboardingDraft['agents'][number];

export const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

function AgentCard({ agent, lead, suggestion }: { agent: Agent; lead: boolean; suggestion?: Suggestion }) {
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [role, setRole] = useState(agent.role);
  const [goal, setGoal] = useState(agent.goal);
  const [backstory, setBackstory] = useState(agent.backstory);
  const [model, setModel] = useState(agent.model ?? '');
  const [autonomy, setAutonomy] = useState(agent.autonomyLevel);
  const [cron, setCron] = useState(agent.heartbeatCron ?? '');
  const binding = agent.providerBinding ?? org.defaultProvider;
  const pending = !!suggestion && (suggestion.goal !== agent.goal || suggestion.backstory !== agent.backstory);
  const dirty = role !== agent.role || goal !== agent.goal || backstory !== agent.backstory || model !== (agent.model ?? '') || autonomy !== agent.autonomyLevel || cron !== (agent.heartbeatCron ?? '');
  const save = useAction(() => api.updateAgent(org.id, agent.id, {
    role: role.trim(), goal, backstory, model: model.trim() || null, autonomyLevel: autonomy, heartbeatCron: cron.trim() || null,
  }), { invalidate: [`${org.id}/`], success: `Saved ${agent.name}` });

  return (
    <li className={`su-agent${open ? ' open' : ''}`}>
      <button type="button" className="su-agent-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="avatar" aria-hidden="true">{initials(agent.name)}</span>
        <span className="grow su-agent-title">
          <span className="row row-tight"><strong>{agent.name}</strong>{lead ? <Chip tone="info">Lead</Chip> : null}{pending ? <Chip tone="warn">Suggestion</Chip> : null}</span>
          <span className="muted truncate">{agent.role}</span>
        </span>
        <span className="su-agent-meta">
          <Chip>{autonomy} · {autonomyName(autonomy)}</Chip>
          <Chip>{agent.model ?? binding?.model ?? binding?.adapter ?? 'No model'}</Chip>
        </span>
        <Icon name="down" size={16} className="su-agent-caret" />
      </button>
      {!open && agent.goal ? <p className="su-agent-goal dim">{agent.goal}</p> : null}
      {open ? (
        <form className="su-agent-body" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          {pending ? (
            <div className="suggest">
              <Icon name="spark" size={15} />
              <div className="grow">
                <strong>Suggested from your interview</strong>
                {suggestion.goal ? <p><span className="mono-label">Goal</span> {suggestion.goal}</p> : null}
                {suggestion.backstory ? <p><span className="mono-label">Backstory</span> {suggestion.backstory}</p> : null}
              </div>
              <Button small onClick={() => { if (suggestion.goal) setGoal(suggestion.goal); if (suggestion.backstory) setBackstory(suggestion.backstory); }}>Use suggestion</Button>
            </div>
          ) : null}
          <div className="form-grid">
            <Field label="Role" hint="What this agent is, in a few words."><input value={role} onChange={(e) => setRole(e.target.value)} required maxLength={200} /></Field>
            {binding?.adapter ? (
              <ModelSelect label="Model" adapterId={binding.adapter} orgId={org.id} value={model} onChange={setModel} emptyLabel={`Organization default${binding.model ? ` (${binding.model})` : ''}`} />
            ) : <Field label="Model" hint="Set a provider on the Models step to pick from a list."><input value={model} onChange={(e) => setModel(e.target.value)} autoCapitalize="none" spellCheck={false} /></Field>}
            <Field label="Goal" wide hint="What the agent is trying to achieve. It reads this on every run."><textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} /></Field>
            <Field label="Backstory" wide hint="Experience, working style and judgment. This is the heart of the agent's prompt."><textarea rows={4} value={backstory} onChange={(e) => setBackstory(e.target.value)} /></Field>
            <Field label="Autonomy">
              <select value={autonomy} onChange={(e) => setAutonomy(Number(e.target.value))}>
                {AUTONOMY_LEVELS.map((l) => <option key={l.level} value={l.level}>{l.level} · {l.name}</option>)}
              </select>
            </Field>
            <CronField value={cron} onChange={setCron} />
          </div>
          <p className="field-hint">{AUTONOMY_LEVELS[autonomy]?.behavior}</p>
          <ErrorNote error={save.error} />
          <div className="row su-agent-actions">
            <Button variant="quiet" icon="tune" onClick={() => setAdvanced(true)}>Provider, budget and limits</Button>
            <span className="grow" />
            <Button variant="primary" type="submit" icon="check" busy={save.busy} disabled={!dirty}>Save {agent.name}</Button>
          </div>
        </form>
      ) : null}
      <AgentForm open={advanced} onClose={() => setAdvanced(false)} agent={agent} />
    </li>
  );
}

function DepartmentForm({ onClose }: { onClose: () => void }) {
  const { org } = useOrg();
  const [name, setName] = useState('');
  const [charter, setCharter] = useState('');
  const save = useAction(async () => {
    await api.createDepartment(org.id, { name: name.trim(), charter });
    onClose();
  }, { invalidate: [`${org.id}/`], success: 'Department created' });
  return (
    <FormShell onSubmit={() => void save.run()} onCancel={onClose} busy={save.busy} error={save.error} submitLabel="Create department">
      <div className="form-grid">
        <Field label="Name" wide><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="Marketing" /></Field>
        <Field label="Charter" wide hint="What this department owns. Its lead turns goals into issues within it."><textarea rows={3} value={charter} onChange={(e) => setCharter(e.target.value)} /></Field>
      </div>
    </FormShell>
  );
}

function DeptGroup({ dept, agents, suggestions }: { dept: Department; agents: Agent[]; suggestions: Map<string, Suggestion> }) {
  const [hiring, setHiring] = useState(false);
  return (
    <section className="dept-group">
      <header className="dept-group-head">
        <Icon name="dept" size={15} />
        <h2>{dept.name}</h2>
        <span className="rail-count">{agents.length}</span>
        <span className="grow" />
        <Button small variant="quiet" icon="hire" onClick={() => setHiring(true)}>Hire</Button>
      </header>
      {dept.charter ? <p className="muted dept-group-charter">{dept.charter}</p> : null}
      {agents.length ? (
        <ul className="su-agents">{agents.map((a) => <AgentCard key={a.id} agent={a} lead={dept.leadAgentId === a.id} suggestion={suggestions.get(a.id)} />)}</ul>
      ) : <p className="muted">No agents in this department yet.</p>}
      <AgentForm open={hiring} onClose={() => setHiring(false)} deptId={dept.id} />
    </section>
  );
}

export function TeamStep() {
  const { org } = useOrg();
  const setup = useSetup();
  const dir = useDirectory(org.id);
  const [newDept, setNewDept] = useState(false);
  const suggestions = new Map((setup.draft?.agents ?? []).map((s) => [s.id, s]));
  const pending = dir.staff.filter((a) => {
    const s = suggestions.get(a.id);
    return s && (s.goal !== a.goal || s.backstory !== a.backstory);
  });
  const applyAll = useAction(async () => {
    for (const a of pending) {
      const s = suggestions.get(a.id)!;
      await api.updateAgent(org.id, a.id, { ...(s.goal ? { goal: s.goal } : {}), ...(s.backstory ? { backstory: s.backstory } : {}) });
    }
  }, { invalidate: [`${org.id}/`], success: 'Applied the suggested prompts' });
  const save = useAction(() => setup.next());

  return (
    <div className="stack-lg">
      <div className="setup-toolbar">
        <p className="dim grow">{dir.staff.length ? `${dir.staff.length} ${dir.staff.length === 1 ? 'agent' : 'agents'} in ${dir.departments.length} ${dir.departments.length === 1 ? 'department' : 'departments'}. Open an agent to tune its prompt.` : 'Start with a department, then hire its lead.'}</p>
        {pending.length ? <Button icon="spark" busy={applyAll.busy} onClick={() => void applyAll.run()}>Apply {pending.length} suggested {pending.length === 1 ? 'prompt' : 'prompts'}</Button> : null}
        <Button icon="add" onClick={() => setNewDept(true)}>Add a department</Button>
      </div>
      {dir.loading ? null : dir.departments.length === 0 ? (
        <Empty icon="agents" title="Your organization has no team yet">
          <p>Departments group agents around a charter. Most teams start with one led by a generalist who can hire the rest.</p>
          <Button variant="primary" icon="add" onClick={() => setNewDept(true)}>Create the first department</Button>
        </Empty>
      ) : dir.departments.map((d) => <DeptGroup key={d.id} dept={d} agents={dir.staff.filter((a) => a.deptId === d.id)} suggestions={suggestions} />)}
      <ErrorNote error={dir.error} />
      <Modal open={newDept} onClose={() => setNewDept(false)} title="New department">{newDept ? <DepartmentForm onClose={() => setNewDept(false)} /> : null}</Modal>
      <StepActions busy={save.busy} onContinue={() => void save.run()} continueLabel={dir.staff.length ? 'Continue' : 'Continue without agents'} />
    </div>
  );
}
