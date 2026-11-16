import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AgentForm } from '../components/AgentForm.js';
import { Button, Chip, ConfirmButton, Empty, Field, FormShell, Load, Modal, PageHead, Panel, Segmented, Status, TagInput } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { Agent, Department, OrgChartNode } from '../lib/api.js';
import { describeCron, money, numOrNull } from '../lib/format.js';
import { autonomyName, k, useDirectory, useOrg, type Directory } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';
import { Icon } from '../components/icons.js';
import { toast } from '../lib/toast.js';

/** Pause, resume and terminate: the same controls on the chart and on the agent page. */
export function AgentActions({ agent, onEdit }: { agent: Agent; onEdit?: () => void }) {
  const { org } = useOrg();
  const inv = { invalidate: [`${org.id}/`] };
  const pause = useAction(() => api.pauseAgent(org.id, agent.id, 'Paused by the owner'), { ...inv, success: `Paused ${agent.name}` });
  const resume = useAction(() => api.resumeAgent(org.id, agent.id), { ...inv, success: `Resumed ${agent.name}` });
  const terminate = useAction(async () => {
    const res = await api.terminateAgent(org.id, agent.id);
    toast(res.approval ? 'Termination sent for approval' : `Terminated ${agent.name}`, 'ok');
  }, inv);
  if (agent.status === 'terminated') return null;
  return (
    <div className="row row-tight">
      {onEdit ? <Button icon="edit" small onClick={onEdit}>Edit</Button> : null}
      {agent.status === 'paused'
        ? <Button icon="play" small busy={resume.busy} onClick={() => void resume.run()}>Resume</Button>
        : <Button icon="pause" small busy={pause.busy} onClick={() => void pause.run()}>Pause</Button>}
      <ConfirmButton icon="fire" small label="Terminate" variant="quiet" danger title={`Terminate ${agent.name}`} confirmLabel="Terminate agent"
        message={`${agent.name} stops for good and its open issues become unassigned. Its history, memory and skills stay on record.`}
        onConfirm={() => terminate.run()} />
    </div>
  );
}

function AgentCard({ agent, dept, isLead, onEdit }: { agent: Agent; dept?: Department; isLead: boolean; onEdit: () => void }) {
  const { base } = useOrg();
  return (
    <div className="agent-card">
      <span className="agent-avatar" aria-hidden="true"><Icon name="agent" size={18} /></span>
      <div className="agent-card-main">
        <div className="row">
          <Link className="agent-name" to={`${base}/agents/${agent.slug}`}>{agent.name}</Link>
          {isLead ? <Chip tone="info">Lead</Chip> : null}
          {dept ? <Chip><Icon name="dept" size={12} />{dept.name}</Chip> : null}
        </div>
        <p className="dim">{agent.role}</p>
        <p className="muted agent-card-meta">
          <Status value={agent.status} label={agent.status === 'paused' && agent.pausedReason ? `Paused: ${agent.pausedReason}` : undefined} />
          <span className="meta-item"><Icon name="gauge" size={13} />{autonomyName(agent.autonomyLevel)}</span>
          <span className="meta-item"><Icon name="time" size={13} />{agent.heartbeatCron ? describeCron(agent.heartbeatCron).text : 'No heartbeat'}</span>
          <span className="meta-item"><Icon name="budget" size={13} />{agent.budgetUsd == null ? 'No budget cap' : `${money(agent.budgetUsd)} a month`}</span>
        </p>
      </div>
      <span className="chart-card-actions"><AgentActions agent={agent} onEdit={onEdit} /></span>
      <Link className="chart-card-open" to={`${base}/agents/${agent.slug}`} aria-label={`Open ${agent.name}`}><Icon name="right" size={16} /></Link>
    </div>
  );
}

function Tree({ nodes, onEdit }: { nodes: OrgChartNode[]; onEdit: (a: Agent) => void }) {
  return (
    <ul className="tree">
      {nodes.map((n) => (
        <li key={n.agent.id}>
          <AgentCard agent={n.agent} dept={n.department} isLead={n.isLead} onEdit={() => onEdit(n.agent)} />
          {n.reports.length > 0 ? <Tree nodes={n.reports} onEdit={onEdit} /> : null}
        </li>
      ))}
    </ul>
  );
}

function DeptForm({ open, onClose, dept, dir }: { open: boolean; onClose: () => void; dept?: Department; dir: Directory }) {
  return (
    <Modal open={open} onClose={onClose} title={dept ? `Edit ${dept.name}` : 'Create a department'}>
      <DeptFormBody key={dept?.id ?? 'new'} onClose={onClose} dept={dept} dir={dir} />
    </Modal>
  );
}

function DeptFormBody({ onClose, dept, dir }: { onClose: () => void; dept?: Department; dir: Directory }) {
  const { org } = useOrg();
  const connectors = useQuery(k(org.id, 'connectors'), () => api.listConnectors(org.id));
  const [name, setName] = useState(dept?.name ?? '');
  const [charter, setCharter] = useState(dept?.charter ?? '');
  const [budget, setBudget] = useState(dept?.budgetUsd == null ? '' : String(dept.budgetUsd));
  const [lead, setLead] = useState(dept?.leadAgentId ?? '');
  const [skills, setSkills] = useState<string[]>(dept?.sharedSkills ?? []);
  const [shared, setShared] = useState<string[]>(dept?.sharedConnectors ?? []);
  const members = dept ? dir.staff.filter((a) => a.deptId === dept.id) : [];
  const save = useAction(async () => {
    const input = { name: name.trim(), charter, budgetUsd: numOrNull(budget), sharedSkills: skills, sharedConnectors: shared };
    if (dept) await api.updateDepartment(org.id, dept.id, { ...input, leadAgentId: lead || null });
    else await api.createDepartment(org.id, input);
    onClose();
  }, { invalidate: [`${org.id}/`], success: dept ? 'Saved department' : 'Created department' });
  return (
    <FormShell onSubmit={() => void save.run()} onCancel={onClose} busy={save.busy} error={save.error} submitLabel={dept ? 'Save department' : 'Create department'}>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></Field>
      <Field label="Charter" hint="What this department is responsible for. Every member reads it."><textarea rows={4} value={charter} onChange={(e) => setCharter(e.target.value)} /></Field>
      <div className="form-grid">
        <Field label="Monthly budget (USD)" hint="Empty means no department cap."><input type="number" min="0" step="0.01" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
        {dept ? (
          <Field label="Lead">
            <select value={lead} onChange={(e) => setLead(e.target.value)}>
              <option value="">No lead</option>
              {members.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        ) : null}
      </div>
      <Field label="Shared skills" hint="Skill names every member inherits."><TagInput label="Shared skills" value={skills} onChange={setSkills} placeholder="Type a skill name and press Enter" /></Field>
      <fieldset>
        <legend>Shared connectors</legend>
        {(connectors.data ?? []).length === 0 ? <p className="muted">No connectors are installed in this organization yet.</p> : null}
        {(connectors.data ?? []).map((c) => (
          <label key={c.id} className="check">
            <input type="checkbox" checked={shared.includes(c.id)} onChange={(e) => setShared(e.target.checked ? [...shared, c.id] : shared.filter((x) => x !== c.id))} />
            <span>{c.name} <span className="muted">{c.kind}</span></span>
          </label>
        ))}
      </fieldset>
    </FormShell>
  );
}

export function OrgChart() {
  const { org, base } = useOrg();
  const dir = useDirectory(org.id);
  const chart = useQuery(k(org.id, 'chart'), () => api.orgChart(org.id), { events: ['agent.', 'org.updated'], orgId: org.id });
  const [view, setView] = useState<'lines' | 'departments'>('lines');
  // `?hire=1` (from the command palette) opens the hire form on arrival.
  const [hire, setHire] = useState<{ deptId?: string } | null>(() => (new URLSearchParams(window.location.search).get('hire') === '1' ? {} : null));
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [deptForm, setDeptForm] = useState<{ dept?: Department } | null>(null);
  const deptStatus = useAction((d: Department, archive: boolean) => (archive ? api.archiveDepartment(org.id, d.id) : api.unarchiveDepartment(org.id, d.id)),
    { invalidate: [`${org.id}/`], success: (d) => (d.status === 'archived' ? `Archived ${d.name}` : `Restored ${d.name}`) });

  return (
    <div className="page">
      <PageHead icon="chart"
        eyebrow="Team"
        title="Org chart"
        sub="Who does what, and who answers to whom. Agents can only assign work down their own reporting line."
        actions={<>
          <Segmented label="View" value={view} onChange={setView} options={[{ value: 'lines', label: 'Reporting lines' }, { value: 'departments', label: 'Departments' }]} />
          <Button icon="add" onClick={() => setDeptForm({})}>New department</Button>
          <Button icon="hire" variant="primary" onClick={() => setHire({})} disabled={dir.departments.length === 0}>Hire agent</Button>
        </>}
      />
      {view === 'lines' ? (
        <Panel icon="reports" title="Reports to you">
          <Load q={chart} empty={<Empty icon="agent" title="No agents yet">{dir.departments.length === 0 ? <p>Create a department, then hire the first agent into it.</p> : <Button icon="hire" variant="primary" onClick={() => setHire({})}>Hire the first agent</Button>}</Empty>}>
            {(nodes) => <Tree nodes={nodes} onEdit={setEditAgent} />}
          </Load>
        </Panel>
      ) : null}
      {view === 'departments' || (chart.data?.length === 0 && dir.departments.length > 0) ? (
        <Load q={{ ...chart, data: dir.loading ? undefined : dir.departments }} empty={<Panel><Empty icon="dept" title="No departments yet"><Button icon="add" variant="primary" onClick={() => setDeptForm({})}>Create the first department</Button><Link to={`${base}/setup/team`}>Or build the team in guided setup</Link></Empty></Panel>}>
          {(depts) => (
            <div className="stack-lg">
              {depts.map((d) => {
                const members = dir.agents.filter((a) => a.deptId === d.id && a.status !== 'terminated');
                return (
                  <Panel key={d.id} title={<>{d.name} {d.status === 'archived' ? <Chip>Archived</Chip> : null}</>} actions={d.status === 'archived'
                    ? <Button icon="refresh" small busy={deptStatus.busy} onClick={() => void deptStatus.run(d, false)}>Restore department</Button>
                    : <>
                      <Button icon="edit" small onClick={() => setDeptForm({ dept: d })}>Edit department</Button>
                      <Button small onClick={() => setHire({ deptId: d.id })}>Hire into {d.name}</Button>
                      <ConfirmButton icon="archive" small variant="quiet" danger label="Archive" title={`Archive ${d.name}`} confirmLabel="Archive department" disabled={members.length > 0}
                        message="The department is hidden from hiring and assignment. Its goals, issues and history are kept, and you can restore it later." onConfirm={() => deptStatus.run(d, true)} />
                    </>}>
                    <div className="stack">
                      <p className="prose dim">{d.charter || 'No charter written yet.'}</p>
                      <p className="row muted">
                        <span>Lead: {dir.agentName(d.leadAgentId, 'none')}</span>
                        <span>Budget: {d.budgetUsd == null ? 'no cap' : `${money(d.budgetUsd)} a month`}</span>
                        <span>{d.sharedSkills.length} shared skills</span>
                        <span>{d.sharedConnectors.length} shared connectors</span>
                      </p>
                      {members.length === 0 ? <p className="muted">{d.status === 'archived' ? 'Archived. Restore it to hire into it again.' : 'Nobody works here yet. An empty department can be archived.'}</p> : (
                        <ul className="tree tree-flat">
                          {members.map((a) => <li key={a.id}><AgentCard agent={a} isLead={d.leadAgentId === a.id} onEdit={() => setEditAgent(a)} /></li>)}
                        </ul>
                      )}
                    </div>
                  </Panel>
                );
              })}
            </div>
          )}
        </Load>
      ) : null}
      <AgentForm open={hire !== null} onClose={() => setHire(null)} deptId={hire?.deptId} />
      <AgentForm open={editAgent !== null} onClose={() => setEditAgent(null)} agent={editAgent ?? undefined} />
      <DeptForm open={deptForm !== null} onClose={() => setDeptForm(null)} dept={deptForm?.dept} dir={dir} />
    </div>
  );
}
