import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Chip, ConfirmButton, Empty, Field, FormShell, Load, Modal, PageHead, Panel, Segmented } from '../components/ui.js';
import { StatusIcon } from '../components/icons.js';
import { useOpenIssues } from '../lib/work.js';
import { ProjectsPanel } from '../components/projects.js';
import { api } from '../lib/api.js';
import type { CreateGoalInput, Goal, GoalNode, Issue } from '../lib/api.js';
import { dateOnly, fromDateInput, humanize, toDateInput } from '../lib/format.js';
import { k, useDirectory, useOrg, type Directory } from '../lib/org.js';
import { Icon } from '../components/icons.js';
import { useAction, useQuery } from '../lib/query.js';

const GOAL_STATUSES = ['proposed', 'active', 'achieved', 'abandoned'] as const;
const LEVELS = [{ value: 'org', label: 'Organization' }, { value: 'dept', label: 'Department' }, { value: 'agent', label: 'Agent' }] as const;

function flattenNodes(nodes: GoalNode[]): GoalNode[] {
  return nodes.flatMap((n) => [n, ...flattenNodes(n.children)]);
}

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

const DAY = 86_400_000;

/** How a goal is doing, from its open work: blocked tasks, a week without movement, or a due date close or past. */
export function goalHealth(g: Goal, open: Issue[], now = Date.now()): { tone: 'stop' | 'warn' | 'go' | 'idle'; text: string } | null {
  if (g.status !== 'active') return null;
  const mine = open.filter((i) => i.goalId === g.id);
  const blocked = mine.filter((i) => i.status === 'blocked' || (i.status === 'in_review' && !i.reviewerAgentId)).length;
  if (g.due && g.due < now) return { tone: 'stop', text: `Overdue by ${Math.ceil((now - g.due) / DAY)} days` };
  if (blocked) return { tone: 'warn', text: `${blocked} ${blocked === 1 ? 'task waits' : 'tasks wait'} on you` };
  const last = Math.max(0, ...mine.map((i) => i.updatedAt));
  if (mine.length && now - last > 7 * DAY) return { tone: 'warn', text: 'No movement for a week' };
  if (g.due && g.due - now < 7 * DAY) return { tone: 'warn', text: `Due in ${Math.max(1, Math.ceil((g.due - now) / DAY))} days` };
  if (!mine.length) return { tone: 'idle', text: 'No open tasks' };
  return { tone: 'go', text: 'On track' };
}

/** One goal in a sheet: where it stands, the open work under it, and every action, so a phone row stays a single tap. */
function GoalSheet({ goal, node, onClose, onEdit, onAdd, open }: { goal: Goal | null; node?: GoalNode; onClose: () => void; onEdit: (g: Goal) => void; onAdd: (g: Goal) => void; open: Issue[] }) {
  const { org, base } = useOrg();
  const dir = useDirectory(org.id);
  const setStatus = useAction((status: Goal['status']) => api.updateGoal(org.id, goal!.id, { status }), { invalidate: [k(org.id, 'goal')], success: 'Goal updated' });
  const remove = useAction(async () => { await api.deleteGoal(org.id, goal!.id); onClose(); }, { invalidate: [k(org.id, 'goal'), k(org.id, 'projects'), k(org.id, 'issues')], success: 'Goal deleted' });
  const g = goal;
  // What waits on the owner first, then what is moving, then by priority.
  const rank = (i: Issue) => (i.status === 'blocked' || (i.status === 'in_review' && !i.reviewerAgentId) ? 0 : i.status === 'in_progress' ? 1 : 2);
  const tasks = g ? open.filter((i) => i.goalId === g.id).sort((a, b) => rank(a) - rank(b) || a.priority - b.priority) : [];
  const total = node ? node.issueCounts.open + node.issueCounts.done : 0;
  const health = g ? goalHealth(g, open) : null;
  return (
    <Modal open={!!g} onClose={onClose} title={g?.title ?? 'Goal'}>
      {g ? (
        <div className="stack goal-sheet">
          {health ? <p className={`goal-health goal-health-${health.tone}`}>{health.text}</p> : null}
          <dl className="agent-brief-stats">
            <div><dt>Done</dt><dd>{node ? `${node.issueCounts.done}/${total}` : '–'}</dd></div>
            <div><dt>Owner</dt><dd className="truncate">{dir.agentName(g.ownerAgentId, 'None')}</dd></div>
            <div><dt>Due</dt><dd>{g.due ? dateOnly(g.due) : 'None'}</dd></div>
          </dl>
          {g.successMetric || g.target ? <p className="dim">Measured by {[g.successMetric, g.target].filter(Boolean).join(': ')}</p> : null}
          <Segmented label="Status" value={g.status} onChange={(v) => void setStatus.run(v)} options={GOAL_STATUSES.map((st) => ({ value: st, label: humanize(st) }))} />
          {tasks.length ? (
            <div className="stack">
              <span className="mono-label">Open tasks</span>
              <ul className="brief-chain-list">
                {tasks.slice(0, 8).map((i) => <li key={i.id}><Link to={`${base}/issues/${i.number}`} onClick={onClose}><StatusIcon status={i.status} size={14} /><span className="truncate">#{i.number} {i.title}</span><span className="muted nowrap">{dir.agentName(i.assigneeAgentId)}</span></Link></li>)}
              </ul>
              {tasks.length > 8 ? <Link to={`${base}/issues?goal=${g.id}`} onClick={onClose}>All {tasks.length} open tasks</Link> : null}
            </div>
          ) : <p className="muted">No open tasks. The owner breaks the goal into tasks on its next run.</p>}
          <div className="form-actions goal-sheet-actions">
            <ConfirmButton icon="remove" variant="quiet" danger label="Delete" title={`Delete "${g.title}"`} confirmLabel="Delete goal"
              message="Its sub-goals, projects and issues move up to the parent goal, so no work is lost. To keep it for the record, set its status to Abandoned instead." onConfirm={() => remove.run()} />
            <span className="grow" />
            <Button icon="add" onClick={() => { onClose(); onAdd(g); }}>Sub-goal</Button>
            <Button icon="edit" variant="primary" onClick={() => { onClose(); onEdit(g); }}>Edit</Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function Node({ node, dir, onEdit, onAdd, onOpen, open }: { node: GoalNode; dir: Directory; onEdit: (g: Goal) => void; onAdd: (parent: Goal) => void; onOpen: (n: GoalNode) => void; open: Issue[] }) {
  const { org, base } = useOrg();
  const g = node.goal;
  const total = node.issueCounts.open + node.issueCounts.done;
  const setStatus = useAction((status: Goal['status']) => api.updateGoal(org.id, g.id, { status }), { invalidate: [k(org.id, 'goal')] });
  const remove = useAction(() => api.deleteGoal(org.id, g.id), { invalidate: [k(org.id, 'goal'), k(org.id, 'projects'), k(org.id, 'issues')], success: `Deleted goal: ${g.title}` });
  return (
    <li>
      <div className={`goal goal-${g.status}`}>
        <div className="goal-main">
          <div className="row">
            <Icon name="goals" size={16} className={`goal-icon goal-icon-${g.status}`} />
            <button type="button" className="goal-title goal-open" onClick={() => onOpen(node)}>{g.title}</button>
            <Chip>{LEVELS.find((l) => l.value === g.level)?.label}</Chip>
            {g.deptId ? <Chip>{dir.dept(g.deptId)?.name ?? 'Department'}</Chip> : null}
          </div>
          {(() => { const h = goalHealth(g, open); return h ? <p className={`goal-health goal-health-${h.tone}`}>{h.text}</p> : null; })()}
          {g.description ? <p className="dim prose goal-desc">{g.description}</p> : null}
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
        <div className="row row-tight goal-actions">
          <select aria-label={`Status of ${g.title}`} value={g.status} disabled={setStatus.busy} onChange={(e) => void setStatus.run(e.target.value as Goal['status'])} style={{ width: 'auto' }}>
            {GOAL_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </select>
          <Button icon="edit" small onClick={() => onEdit(g)}>Edit</Button>
          <Button icon="add" small onClick={() => onAdd(g)}>Add sub-goal</Button>
          <ConfirmButton icon="remove" small variant="quiet" danger label="Delete" title={`Delete "${g.title}"`} confirmLabel="Delete goal"
            message="Its sub-goals, projects and issues move up to the parent goal, so no work is lost. To keep the goal for the record, set its status to Abandoned instead." onConfirm={() => remove.run()} />
        </div>
      </div>
      {node.children.length > 0 ? <ul className="tree">{node.children.map((c) => <Node key={c.goal.id} node={c} dir={dir} onEdit={onEdit} onAdd={onAdd} onOpen={onOpen} open={open} />)}</ul> : null}
    </li>
  );
}

export function Goals() {
  const { org, base } = useOrg();
  const dir = useDirectory(org.id);
  const tree = useQuery(k(org.id, 'goal-tree'), () => api.goalTree(org.id), { events: ['goal.', 'issue.'], orgId: org.id });
  const [form, setForm] = useState<{ goal?: Goal; parent?: Goal } | null>(null);
  const [sheet, setSheet] = useState<GoalNode | null>(null);
  const openIssues = useOpenIssues(org.id);
  const open = openIssues.data ?? [];
  // Keep the sheet on live data after a status change.
  const live = sheet ? flattenNodes(tree.data ?? []).find((n) => n.goal.id === sheet.goal.id) ?? sheet : null;
  return (
    <div className="page">
      <PageHead icon="goals" eyebrow="Direction" title="Goals" sub="Organization goals cascade into department and agent goals. Every issue traces back to one of them." actions={<Button icon="add" variant="primary" onClick={() => setForm({})}>New goal</Button>} />
      <Panel>
        <Load q={tree} empty={<Empty icon="goals" title="No goals yet"><p>Set an organization goal and the lead agents break it down into department goals and issues.</p><Button icon="add" variant="primary" onClick={() => setForm({})}>Set the first goal</Button><Link to={`${base}/setup/interview`}>Or let the setup interview draft them</Link></Empty>}>
          {(nodes) => <ul className="tree tree-root">{nodes.map((n) => <Node key={n.goal.id} node={n} dir={dir} onEdit={(goal) => setForm({ goal })} onAdd={(parent) => setForm({ parent })} onOpen={setSheet} open={open} />)}</ul>}
        </Load>
      </Panel>
      <GoalSheet goal={live?.goal ?? null} node={live ?? undefined} open={open} onClose={() => setSheet(null)} onEdit={(goal) => setForm({ goal })} onAdd={(parent) => setForm({ parent })} />
      <ProjectsPanel goals={flatten(tree.data ?? []).map((n) => n.goal)} />
      <Modal open={form !== null} onClose={() => setForm(null)} title={form?.goal ? 'Edit goal' : form?.parent ? `Sub-goal of ${form.parent.title}` : 'New goal'} wide>
        {form ? <GoalForm key={form.goal?.id ?? form.parent?.id ?? 'new'} onClose={() => setForm(null)} goal={form.goal} parent={form.parent} tree={tree.data ?? []} dir={dir} /> : null}
      </Modal>
    </div>
  );
}
