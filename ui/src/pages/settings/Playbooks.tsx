import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Chip, Empty, Field, FormShell, Load, Modal, Panel, Segmented } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { CreatePlaybookRequest, Playbook } from '../../lib/api.js';
import { k, useDirectory, useOrg, type Directory } from '../../lib/org.js';
import { useAction, useQuery } from '../../lib/query.js';
import { toast } from '../../lib/toast.js';

type Step = CreatePlaybookRequest['steps'][number];
const blankStep = (): Step => ({ title: '', description: '', expectedOutput: '' });

function PlaybookForm({ onClose, dir }: { onClose: () => void; dir: Directory }) {
  const { org } = useOrg();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [process, setProcess] = useState<'sequential' | 'hierarchical'>('sequential');
  const [manager, setManager] = useState('');
  const [steps, setSteps] = useState<Step[]>([blankStep()]);
  const setStep = (i: number, patch: Partial<Step>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const save = useAction(async () => {
    await api.createPlaybook(org.id, {
      name: name.trim(), description, process, managerAgentId: process === 'hierarchical' ? manager || null : null,
      steps: steps.map(({ agentId, agentRole, ...s }) => ({ ...s, title: s.title.trim(), ...(agentId ? { agentId } : {}), ...(agentRole?.trim() ? { agentRole: agentRole.trim() } : {}) })),
    });
    onClose();
  }, { invalidate: [k(org.id, 'playbooks')], success: 'Playbook created' });
  return (
    <FormShell onSubmit={() => void save.run()} onCancel={onClose} busy={save.busy} error={save.error} submitLabel="Create playbook">
      <div className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="Weekly newsletter" /></Field>
        <Field label="Process">
          <Segmented label="Process" value={process} onChange={setProcess} options={[{ value: 'sequential', label: 'One step after another' }, { value: 'hierarchical', label: 'A manager delegates' }]} />
        </Field>
        {process === 'hierarchical' ? (
          <Field label="Manager" hint="Assigns every step and reviews the results."><select value={manager} onChange={(e) => setManager(e.target.value)} required><option value="">Choose</option>{dir.staff.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        ) : null}
        <Field label="Description" wide><textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={i}>
            <fieldset>
              <legend>Step {i + 1}</legend>
              <div className="form-grid">
                <Field label="Title"><input value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} required maxLength={500} /></Field>
                <Field label="Who does it">
                  <select value={s.agentId ?? ''} onChange={(e) => setStep(i, { agentId: e.target.value || undefined })}><option value="">Whoever fits the role</option>{dir.staff.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
                </Field>
                {!s.agentId ? <Field label="Role to match"><input value={s.agentRole ?? ''} onChange={(e) => setStep(i, { agentRole: e.target.value })} placeholder="Copywriter" /></Field> : null}
                <Field label="What to do" wide><textarea rows={2} value={s.description} onChange={(e) => setStep(i, { description: e.target.value })} /></Field>
                <Field label="Expected output" wide><textarea rows={2} value={s.expectedOutput} onChange={(e) => setStep(i, { expectedOutput: e.target.value })} /></Field>
              </div>
              {steps.length > 1 ? <div><Button small variant="quiet" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove step {i + 1}</Button></div> : null}
            </fieldset>
          </li>
        ))}
      </ol>
      <div><Button small onClick={() => setSteps([...steps, blankStep()])} disabled={steps.length >= 100}>Add a step</Button></div>
    </FormShell>
  );
}

function RunPlaybook({ playbook }: { playbook: Playbook }) {
  const { org, base } = useOrg();
  const [issue, setIssue] = useState('');
  const run = useAction(async () => {
    const target = await api.getIssue(org.id, issue.trim().replace(/^#/, ''));
    const created = await api.runPlaybook(org.id, playbook.id, target.id);
    toast(`Created ${created.length} sub-issues under #${target.number}`, 'ok');
    setIssue('');
    return target;
  }, { invalidate: [k(org.id, 'issues'), k(org.id, 'issue')] });
  const [last, setLast] = useState<number | null>(null);
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void run.run().then((t) => t && setLast(t.number)); }}>
      <input aria-label={`Issue number to run ${playbook.name} in`} placeholder="Issue number" inputMode="numeric" value={issue} onChange={(e) => setIssue(e.target.value)} required style={{ width: 130 }} />
      <Button small type="submit" busy={run.busy}>Run in this issue</Button>
      {last !== null ? <Link to={`${base}/issues/${last}`}>Open #{last}</Link> : null}
    </form>
  );
}

export function Playbooks() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const playbooks = useQuery(k(org.id, 'playbooks'), () => api.listPlaybooks(org.id));
  const [creating, setCreating] = useState(false);
  return (
    <div className="stack-lg">
      <Panel title="Playbooks" flush actions={<Button small variant="primary" onClick={() => setCreating(true)}>New playbook</Button>}>
        <Load q={playbooks} empty={<Empty title="No playbooks yet"><p>A playbook is a reusable process. Running it inside an issue creates one sub-issue per step.</p></Empty>}>
          {(list) => (
            <ul className="connectors">
              {list.map((p) => (
                <li key={p.id} className="connector">
                  <div className="stack">
                    <div className="row"><strong>{p.name}</strong><Chip>{p.process === 'sequential' ? 'One step after another' : `Managed by ${dir.agentName(p.managerAgentId, 'nobody')}`}</Chip></div>
                    {p.description ? <p className="dim">{p.description}</p> : null}
                    <ol className="playbook-steps">
                      {p.steps.map((s, i) => <li key={i}><strong>{s.title}</strong> <span className="muted">{s.agentId ? dir.agentName(s.agentId) : (s.agentRole ?? 'Any agent')}</span></li>)}
                    </ol>
                    <RunPlaybook playbook={p} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Load>
      </Panel>
      <Modal open={creating} onClose={() => setCreating(false)} title="New playbook" wide>{creating ? <PlaybookForm onClose={() => setCreating(false)} dir={dir} /> : null}</Modal>
    </div>
  );
}

export function DataSettings() {
  const { org } = useOrg();
  const download = useAction(async () => {
    const bundle = await api.exportOrg(org.id);
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${org.slug}-bundle.json`;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    return bundle;
  }, { success: (b) => `Exported ${b.agents.length} agents, ${b.skills.length} skills and ${b.memories.length} memories` });
  return (
    <div className="stack-lg page-narrow">
      <Panel title={`Export ${org.name}`}>
        <div className="stack">
          <p className="dim">A portable bundle with the org chart, agent configurations, goals, playbooks, skills and sanitized memory. Secrets are never included.</p>
          <div><Button variant="primary" busy={download.busy} onClick={() => void download.run()}>Download bundle</Button></div>
        </div>
      </Panel>
      <Panel title="Import">
        <div className="stack">
          <p className="dim">Importing a bundle creates a new organization from it. Existing organizations are never overwritten.</p>
          <div><Link className="btn btn-default" to="/new-org">Import a bundle as a new organization</Link></div>
        </div>
      </Panel>
    </div>
  );
}
