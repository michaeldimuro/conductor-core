import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Chip, Empty, Field, FormShell, Load, Modal, PageHead, Panel } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { CreateGoalInput, Goal, GoalNode } from '../lib/api.js';
import { dateOnly, fromDateInput, humanize, toDateInput } from '../lib/format.js';
import { k, useDirectory, useOrg, type Directory } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';

const GOAL_STATUSES = ['proposed', 'active', 'achieved', 'abandoned'] as const;
const LEVELS = [{ value: 'org', label: 'Organization' }, { value: 'dept', label: 'Department' }, { value: 'agent', label: 'Agent' }] as const;

function flatten(nodes: GoalNode[], depth = 0): Array<{ goal: Goal; depth: number }> {
  return nodes.flatMap((n) => [{ goal: n.goal, depth }, ...flatten(n.children, depth + 1)]);
}

function GoalForm({ onClose, goal, parent, tree, dir }: { onClose: () => void; goal?: Goal; parent?: Goal; tree: GoalNode[]; dir: Directory }) {
  const { org } = useOrg();
  const [title, setTitle] = useState(goal?.title ?? '');
  const [description, setDescription] = useState(goal?.description ?? '');
  const [parentId, setParentId] = useState(goal?.parentGoalId ?? parent?.id ?? '');
  const [level, setLevel] = useState<Goal['level']>(goal?.level ?? (parent ? (parent.level === 'org' ? 'dept' : 'agent') : 'org'));
  const [deptId, setDeptId] = useState(goal?.deptId ?? parent?.deptId ?? '');
  const [owner, setOwner] = useState(goal?.ownerAgentId ?? '');
  const [metric, setMetric] = useState(goal?.successMetric ?? '');
  const [target, setTarget] = useState(goal?.target ?? '');
  const [weight, setWeight] = useState(String(goal?.weight ?? 1));
  const [due, setDue] = useState(toDateInput(goal?.due));
  const save = useAction(async () => {
    const input: CreateGoalInput = {
      title: title.trim(), description, parentGoalId: parentId || null, level, deptId: level === 'org' ? null : deptId || null,
      ownerAgentId: owner || null, successMetric: metric, target, weight: Number(weight) || 1, due: fromDateInput(due),
    };
    if (goal) await api.updateGoal(org.id, goal.id, input);
    else await api.createGoal(org.id, input);
    onClose();
  }, { invalidate: [k(org.id, 'goal')], success: goal ? 'Saved goal' : 'Created goal' });
  return (
    <FormShell onSubmit={() => void save.run()} onCancel={onClose} busy={save.busy} error={save.error} submitLabel={goal ? 'Save goal' : 'Create goal'}>
      <div className="form-grid">
        <Field label="Goal" wide><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} placeholder="Grow the newsletter to 10,000 subscribers" autoFocus /></Field>
        <Field label="Description" wide><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Success metric"><input value={metric} onChange={(e) => setMetric(e.target.value)} placeholder="Subscribers" /></Field>
        <Field label="Target"><input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="10,000 by June" /></Field>
        <Field label="Level">
          <select value={level} onChange={(e) => setLevel(e.target.value as Goal['level'])}>{LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</select>
        </Field>
        <Field label="Parent goal">
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">None (top level)</option>
            {flatten(tree).filter((g) => g.goal.id !== goal?.id).map(({ goal: g, depth }) => <option key={g.id} value={g.id}>{'  '.repeat(depth)}{g.title}</option>)}
          </select>
        </Field>
        {level !== 'org' ? (
          <Field label="Department">
            <select value={deptId} onChange={(e) => setDeptId(e.target.value)}>
              <option value="">None</option>
              {dir.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
        ) : null}
        <Field label="Owner">
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">No owner</option>
            {dir.staff.map((a) => <option key={a.id} value={a.id}>{a.name}, {a.role}</option>)}
          </select>
        </Field>
        <Field label="Weight" hint="Higher weights sort first in agent inboxes."><input type="number" min="0" max="1000" step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} /></Field>
        <Field label="Due"><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
    </FormShell>
  );
}

function Node({ node, dir, onEdit, onAdd }: { node: GoalNode; dir: Directory; onEdit: (g: Goal) => void; onAdd: (parent: Goal) => void }) {
  const { org, base } = useOrg();
  const g = node.goal;
  const total = node.issueCounts.open + node.issueCounts.done;
  const setStatus = useAction((status: Goal['status']) => api.updateGoal(org.id, g.id, { status }), { invalidate: [k(org.id, 'goal')] });
  return (
    <li>
      <div className={`goal goal-${g.status}`}>
        <div className="goal-main">
          <div className="row">
            <strong className="goal-title">{g.title}</strong>
            <Chip>{LEVELS.find((l) => l.value === g.level)?.label}</Chip>
            {g.deptId ? <Chip>{dir.dept(g.deptId)?.name ?? 'Department'}</Chip> : null}
          </div>
          {g.description ? <p className="dim prose">{g.description}</p> : null}
          <p className="row muted">
            {g.successMetric || g.target ? <span>{[g.successMetric, g.target].filter(Boolean).join(': ')}</span> : null}
            <span>Owner: {dir.agentName(g.ownerAgentId, 'none')}</span>
            {g.due ? <span>Due {dateOnly(g.due)}</span> : null}
            <Link to={`${base}/issues?goal=${g.id}`}>{node.issueCounts.open} open, {node.issueCounts.done} done</Link>
          </p>
          {total > 0 ? (
            <div className="meter meter-go" role="meter" aria-label="Issues done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={node.issueCounts.done}>
              <span className="meter-fill" style={{ width: `${(node.issueCounts.done / total) * 100}%` }} />
            </div>
          ) : null}
        </div>
        <div className="row row-tight">
          <select aria-label={`Status of ${g.title}`} value={g.status} disabled={setStatus.busy} onChange={(e) => void setStatus.run(e.target.value as Goal['status'])} style={{ width: 'auto' }}>
            {GOAL_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </select>
          <Button small onClick={() => onEdit(g)}>Edit</Button>
          <Button small onClick={() => onAdd(g)}>Add sub-goal</Button>
        </div>
      </div>
      {node.children.length > 0 ? <ul className="tree">{node.children.map((c) => <Node key={c.goal.id} node={c} dir={dir} onEdit={onEdit} onAdd={onAdd} />)}</ul> : null}
    </li>
  );
}

export function Goals() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const tree = useQuery(k(org.id, 'goal-tree'), () => api.goalTree(org.id), { events: ['goal.', 'issue.'], orgId: org.id });
  const [form, setForm] = useState<{ goal?: Goal; parent?: Goal } | null>(null);
  return (
    <div className="page">
      <PageHead title="Goals" sub="Organization goals cascade into department and agent goals. Every issue traces back to one of them." actions={<Button variant="primary" onClick={() => setForm({})}>New goal</Button>} />
      <Panel>
        <Load q={tree} empty={<Empty title="No goals yet"><p>Set an organization goal and the lead agents break it down into department goals and issues.</p><Button variant="primary" onClick={() => setForm({})}>Set the first goal</Button></Empty>}>
          {(nodes) => <ul className="tree tree-root">{nodes.map((n) => <Node key={n.goal.id} node={n} dir={dir} onEdit={(goal) => setForm({ goal })} onAdd={(parent) => setForm({ parent })} />)}</ul>}
        </Load>
      </Panel>
      <Modal open={form !== null} onClose={() => setForm(null)} title={form?.goal ? 'Edit goal' : form?.parent ? `Sub-goal of ${form.parent.title}` : 'New goal'} wide>
        {form ? <GoalForm key={form.goal?.id ?? form.parent?.id ?? 'new'} onClose={() => setForm(null)} goal={form.goal} parent={form.parent} tree={tree.data ?? []} dir={dir} /> : null}
      </Modal>
    </div>
  );
}
