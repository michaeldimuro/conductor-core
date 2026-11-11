import { useState } from 'react';
import { api } from '../lib/api.js';
import type { Agent, HireAgentInput, ProviderBinding, UpdateAgentRequest } from '../lib/api.js';
import { dateTime, describeCron, numOrNull } from '../lib/format.js';
import { AUTONOMY_LEVELS, useDirectory, useOrg } from '../lib/org.js';
import { useAction } from '../lib/query.js';
import { toast } from '../lib/toast.js';
import { BindingEditor, cleanBinding } from './binding.js';
import { Check, Field, FormShell, Modal } from './ui.js';

const CRON_PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'No heartbeat', value: '' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 4 hours', value: '0 */4 * * *' },
  { label: 'Weekdays at 09:00', value: '0 9 * * 1-5' },
  { label: 'Every day at 07:00', value: '0 7 * * *' },
];

export function CronField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const preview = describeCron(value);
  return (
    <Field
      label="Heartbeat schedule (cron)"
      wide
      hint={
        <span className={preview.valid ? undefined : 'cron-bad'} aria-live="polite">
          {preview.text}
          {preview.next.length ? `. Next: ${preview.next.map((t) => dateTime(t)).join(', ')}` : ''}
        </span>
      }
    >
      <div className="row">
        <input className="mono grow" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0 9 * * 1-5" aria-invalid={preview.valid ? undefined : true} autoCapitalize="none" spellCheck={false} style={{ width: 'auto' }} />
        <select aria-label="Schedule presets" value={CRON_PRESETS.some((p) => p.value === value) ? value : 'custom'} onChange={(e) => e.target.value !== 'custom' && onChange(e.target.value)} style={{ width: 'auto' }}>
          {CRON_PRESETS.map((p) => <option key={p.label} value={p.value}>{p.label}</option>)}
          <option value="custom">Custom</option>
        </select>
      </div>
    </Field>
  );
}

export function AutonomyPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <fieldset>
      <legend>Autonomy level</legend>
      <div className="choice-list">
        {AUTONOMY_LEVELS.map((l) => (
          <label key={l.level} className={`choice${value === l.level ? ' on' : ''}`}>
            <input type="radio" name="autonomy" checked={value === l.level} onChange={() => onChange(l.level)} />
            <span>
              <strong>{l.level} {l.name}</strong>
              <span className="field-hint">{l.behavior}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Hire a new agent, or edit an existing one when `agent` is given. */
export function AgentForm({ open, onClose, agent, deptId }: { open: boolean; onClose: () => void; agent?: Agent; deptId?: string }) {
  return (
    <Modal open={open} onClose={onClose} title={agent ? `Edit ${agent.name}` : 'Hire an agent'} wide>
      <AgentFormBody key={agent?.id ?? 'new'} onClose={onClose} agent={agent} deptId={deptId} />
    </Modal>
  );
}

function AgentFormBody({ onClose, agent, deptId }: { onClose: () => void; agent?: Agent; deptId?: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [name, setName] = useState(agent?.name ?? '');
  const [role, setRole] = useState(agent?.role ?? '');
  const [goal, setGoal] = useState(agent?.goal ?? '');
  const [backstory, setBackstory] = useState(agent?.backstory ?? '');
  const [dept, setDept] = useState(agent?.deptId ?? deptId ?? '');
  const [reportsTo, setReportsTo] = useState(agent?.reportsTo ?? '');
  const [isLead, setIsLead] = useState(agent ? dir.dept(agent.deptId)?.leadAgentId === agent.id : false);
  const [binding, setBinding] = useState<ProviderBinding | null>(agent?.providerBinding ?? null);
  const [model, setModel] = useState(agent?.model ?? '');
  const [cron, setCron] = useState(agent?.heartbeatCron ?? '');
  const [budget, setBudget] = useState(agent?.budgetUsd == null ? '' : String(agent.budgetUsd));
  const [autonomy, setAutonomy] = useState(agent?.autonomyLevel ?? 1);
  const [maxSteps, setMaxSteps] = useState(String(agent?.maxSteps ?? 60));
  const [maxWallMin, setMaxWallMin] = useState(String(Math.round((agent?.maxWallMs ?? 30 * 60_000) / 60_000)));
  const [maxRuns, setMaxRuns] = useState(String(agent?.maxRunsPerHour ?? 12));
  const effectiveDept = dept || dir.departments[0]?.id || '';
  const cronOk = describeCron(cron).valid;

  const save = useAction(async () => {
    const common: Omit<HireAgentInput, 'deptId'> = {
      name: name.trim(), role: role.trim(), goal, backstory,
      reportsTo: reportsTo || null,
      providerBinding: cleanBinding(binding),
      model: model.trim() || null,
      heartbeatCron: cron.trim() || null,
      budgetUsd: numOrNull(budget),
      autonomyLevel: autonomy,
      isLead,
    };
    if (agent) {
      const patch: UpdateAgentRequest = { ...common, deptId: effectiveDept, maxSteps: Number(maxSteps), maxWallMs: Number(maxWallMin) * 60_000, maxRunsPerHour: Number(maxRuns) };
      await api.updateAgent(org.id, agent.id, patch);
      toast(`Saved ${common.name}`, 'ok');
    } else {
      const res = await api.hireAgent(org.id, { ...common, deptId: effectiveDept });
      toast(res.approval ? 'Hire sent for approval' : `Hired ${common.name}`, 'ok');
    }
    onClose();
  }, { invalidate: [`${org.id}/`] });

  return (
    <FormShell onSubmit={() => cronOk && void save.run()} onCancel={onClose} busy={save.busy} error={save.error} submitLabel={agent ? 'Save agent' : 'Hire agent'}>
      <div className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></Field>
        <Field label="Role" hint="What this agent is, in a few words."><input value={role} onChange={(e) => setRole(e.target.value)} required placeholder="SEO specialist" /></Field>
        <Field label="Goal" wide hint="What the agent is trying to achieve."><textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} /></Field>
        <Field label="Backstory" wide hint="Experience and working style that shape how it behaves."><textarea rows={3} value={backstory} onChange={(e) => setBackstory(e.target.value)} /></Field>
        <Field label="Department">
          <select value={effectiveDept} onChange={(e) => setDept(e.target.value)} required>
            {dir.departments.length === 0 ? <option value="">Create a department first</option> : null}
            {dir.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Reports to">
          <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}>
            <option value="">You (the owner)</option>
            {dir.staff.filter((a) => a.id !== agent?.id).map((a) => <option key={a.id} value={a.id}>{a.name}, {a.role}</option>)}
          </select>
        </Field>
        <div className="field-wide"><Check label="Lead of this department" checked={isLead} onChange={setIsLead} hint="The lead breaks department goals into issues and reviews the team's work." /></div>
      </div>
      <BindingEditor value={binding} onChange={setBinding} inheritLabel="Use the organization's default provider" />
      <div className="form-grid">
        <Field label="Model override" hint="Overrides the model of whichever binding applies."><input value={model} onChange={(e) => setModel(e.target.value)} autoCapitalize="none" spellCheck={false} /></Field>
        <Field label="Monthly budget (USD)" hint="Empty means no agent-level cap."><input type="number" min="0" step="0.01" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
        <CronField value={cron} onChange={setCron} />
      </div>
      <AutonomyPicker value={autonomy} onChange={setAutonomy} />
      {agent ? (
        <fieldset>
          <legend>Run limits</legend>
          <div className="form-grid">
            <Field label="Max steps per run"><input type="number" min="1" max="10000" value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} required /></Field>
            <Field label="Max run time (minutes)"><input type="number" min="1" max="1440" value={maxWallMin} onChange={(e) => setMaxWallMin(e.target.value)} required /></Field>
            <Field label="Max runs per hour"><input type="number" min="1" max="1000" value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} required /></Field>
          </div>
        </fieldset>
      ) : null}
    </FormShell>
  );
}
