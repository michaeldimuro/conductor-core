import { useState } from 'react';
import { Button, Chip, Empty, Field, FormShell, Load, Modal, Panel, Status } from './ui.js';
import { api } from '../lib/api.js';
import type { Goal, Project } from '../lib/api.js';
import { money, numOrNull } from '../lib/format.js';
import { k, useOrg } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';

function ProjectForm({ project, goals, onClose }: { project: Project; goals: Goal[]; onClose: () => void }) {
  const { org } = useOrg();
  const [name, setName] = useState(project.name);
  const [goalId, setGoalId] = useState(project.goalId ?? '');
  const [workspace, setWorkspace] = useState(project.workspacePath ?? '');
  const [budget, setBudget] = useState(project.budgetUsd == null ? '' : String(project.budgetUsd));
  const save = useAction(async () => {
    await api.updateProject(org.id, project.id, { name: name.trim(), goalId: goalId || null, workspacePath: workspace.trim() || null, budgetUsd: numOrNull(budget) });
    onClose();
  }, { invalidate: [k(org.id, 'projects')], success: 'Project saved' });
  return (
    <FormShell onSubmit={() => void save.run()} onCancel={onClose} busy={save.busy} error={save.error} submitLabel="Save project">
      <div className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></Field>
        <Field label="Goal it serves">
          <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            <option value="">None</option>
            {goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
        </Field>
        <Field label="Workspace folder" wide hint="Agents working on this project's issues run in this folder. Empty uses each agent's own workspace.">
          <input className="mono" value={workspace} onChange={(e) => setWorkspace(e.target.value)} autoCapitalize="none" spellCheck={false} placeholder="/Users/you/code/website" />
        </Field>
        <Field label="Budget (USD)" hint="Empty means no project cap."><input type="number" min="0" step="0.01" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
      </div>
    </FormShell>
  );
}

/** Projects group issues under a goal. They are created by agents and from the CLI; here they can be edited and archived. */
export function ProjectsPanel({ goals }: { goals: Goal[] }) {
  const { org } = useOrg();
  const projects = useQuery(k(org.id, 'projects'), () => api.listProjects(org.id), { events: ['project.', 'goal.deleted'], orgId: org.id });
  const [editing, setEditing] = useState<Project | null>(null);
  const setStatus = useAction((p: Project, status: Project['status']) => api.updateProject(org.id, p.id, { status }), { invalidate: [k(org.id, 'projects')] });
  if (!projects.loading && !projects.error && (projects.data?.length ?? 0) === 0) return null;
  return (
    <>
      <Panel title="Projects" flush>
        <Load q={projects} lines={2} empty={<Empty title="No projects yet" />}>
          {(list) => (
            <ul className="lines">
              {list.map((p) => (
                <li key={p.id} className="line">
                  <Status value={p.status} />
                  <span className="grow truncate">
                    <strong>{p.name}</strong>{' '}
                    <span className="muted">{goals.find((g) => g.id === p.goalId)?.title ?? 'No goal'}{p.workspacePath ? ` · ${p.workspacePath}` : ''}</span>
                  </span>
                  {p.budgetUsd != null ? <Chip>{money(p.budgetUsd)}</Chip> : null}
                  <Button small onClick={() => setEditing(p)}>Edit</Button>
                  <Button small busy={setStatus.busy} onClick={() => void setStatus.run(p, p.status === 'archived' ? 'active' : 'archived')}>{p.status === 'archived' ? 'Restore' : 'Archive'}</Button>
                </li>
              ))}
            </ul>
          )}
        </Load>
      </Panel>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Edit ${editing.name}` : 'Edit project'} wide>
        {editing ? <ProjectForm key={editing.id} project={editing} goals={goals} onClose={() => setEditing(null)} /> : null}
      </Modal>
    </>
  );
}
