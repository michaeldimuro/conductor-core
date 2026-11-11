import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { CreateIssueInput, Issue } from '../lib/api.js';
import { ISSUE_STATUSES, PRIORITIES, STATUS_LABEL, k, useDirectory, useOrg, type IssueStatus } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';
import { Field, FormShell, Modal, TagInput } from './ui.js';

export const useGoals = (orgId: string) => useQuery(k(orgId, 'goals'), () => api.listGoals(orgId), { events: ['goal.'], orgId });

/** Create an issue, or edit one when `issue` is given. */
export function IssueForm({ open, onClose, issue, defaults }: { open: boolean; onClose: () => void; issue?: Issue; defaults?: Partial<CreateIssueInput> }) {
  return (
    <Modal open={open} onClose={onClose} title={issue ? `Edit issue #${issue.number}` : 'Create an issue'} wide>
      <Body key={issue?.id ?? 'new'} onClose={onClose} issue={issue} defaults={defaults} />
    </Modal>
  );
}

/** The daemon only accepts these as a starting status; the rest are reached by doing the work. */
const CREATE_STATUSES: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'blocked'];

function Body({ onClose, issue, defaults }: { onClose: () => void; issue?: Issue; defaults?: Partial<CreateIssueInput> }) {
  const { org, base } = useOrg();
  const nav = useNavigate();
  const dir = useDirectory(org.id);
  const goals = useGoals(org.id);
  const init = issue ?? defaults ?? {};
  const [title, setTitle] = useState(init.title ?? '');
  const [body, setBody] = useState(init.body ?? '');
  const [expected, setExpected] = useState(init.expectedOutput ?? '');
  const [taskType, setTaskType] = useState(init.taskType ?? '');
  const [goalId, setGoalId] = useState(init.goalId ?? '');
  const [assignee, setAssignee] = useState(init.assigneeAgentId ?? '');
  const [reviewer, setReviewer] = useState(init.reviewerAgentId ?? '');
  const [status, setStatus] = useState<IssueStatus>(init.status ?? 'todo');
  const [priority, setPriority] = useState(init.priority ?? 2);
  const [labels, setLabels] = useState<string[]>(init.labels ?? []);

  const save = useAction(async () => {
    const input: CreateIssueInput = {
      title: title.trim(), body, expectedOutput: expected, taskType: taskType.trim() || null, goalId: goalId || null,
      assigneeAgentId: assignee || null, reviewerAgentId: reviewer || null, status, priority, labels,
      ...(issue ? {} : { parentIssueId: defaults?.parentIssueId ?? null }),
    };
    if (issue) await api.updateIssue(org.id, issue.id, input);
    else {
      const created = await api.createIssue(org.id, input);
      nav(`${base}/issues/${created.number}`);
    }
    onClose();
  }, { invalidate: [k(org.id, 'issues'), k(org.id, 'issue')], success: issue ? 'Saved issue' : 'Created issue' });

  return (
    <FormShell onSubmit={() => void save.run()} onCancel={onClose} busy={save.busy} error={save.error} submitLabel={issue ? 'Save issue' : 'Create issue'}>
      <div className="form-grid">
        <Field label="Title" wide><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={500} autoFocus /></Field>
        <Field label="Description" wide><textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        <Field label="Expected output" wide hint="What done looks like. The reviewer checks the result against this."><textarea rows={2} value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
        <Field label="Assignee">
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {dir.staff.map((a) => <option key={a.id} value={a.id}>{a.name}, {a.role}</option>)}
          </select>
        </Field>
        <Field label="Reviewer">
          <select value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
            <option value="">You (the owner)</option>
            {dir.staff.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value as IssueStatus)}>
            {ISSUE_STATUSES.filter((s) => issue || CREATE_STATUSES.includes(s)).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            {PRIORITIES.map((p, i) => <option key={p} value={i}>{p}</option>)}
          </select>
        </Field>
        <Field label="Goal" hint="Left empty, the goal is inherited from the parent issue or the assignee.">
          <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            <option value="">Inherit</option>
            {(goals.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
        </Field>
        <Field label="Task type" hint="Groups repeated work for scorecards and skills."><input value={taskType} onChange={(e) => setTaskType(e.target.value)} placeholder="seo-audit" autoCapitalize="none" /></Field>
        <Field label="Labels" wide><TagInput label="Labels" value={labels} onChange={setLabels} placeholder="Type a label and press Enter" /></Field>
      </div>
    </FormShell>
  );
}
