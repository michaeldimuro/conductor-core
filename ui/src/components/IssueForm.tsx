import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { CreateIssueInput, Issue } from '../lib/api.js';
import { ISSUE_STATUSES, PRIORITIES, STATUS_LABEL, k, useDirectory, useOrg, type IssueStatus } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';
import { Field, FormShell, Modal, TagInput } from './ui.js';
import { AttachButton, PendingChips, pending, uploadTaskFiles, useFileDrop, type PendingFile } from './attachments.js';

export const useGoals = (orgId: string) => useQuery(k(orgId, 'goals'), () => api.listGoals(orgId), { events: ['goal.'], orgId });

/** Create an issue, or edit one when `issue` is given. */
/** `onCreated` keeps you where you are instead of opening the new issue. */
export function IssueForm({ open, onClose, issue, defaults, onCreated }: { open: boolean; onClose: () => void; issue?: Issue; defaults?: Partial<CreateIssueInput>; onCreated?: (issue: Issue) => void }) {
  return (
    <Modal open={open} onClose={onClose} title={issue ? `Edit issue #${issue.number}` : 'Create an issue'} wide>
      <Body key={issue?.id ?? 'new'} onClose={onClose} issue={issue} defaults={defaults} onCreated={onCreated} />
    </Modal>
  );
}

/** The daemon only accepts these as a starting status; the rest are reached by doing the work. */
const CREATE_STATUSES: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'blocked'];

function Body({ onClose, issue, defaults, onCreated }: { onClose: () => void; issue?: Issue; defaults?: Partial<CreateIssueInput>; onCreated?: (issue: Issue) => void }) {
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
  const [files, setFiles] = useState<PendingFile[]>([]);
  const addFiles = (picked: File[]) => setFiles((list) => [...list, ...picked.map(pending)]);
  const drop = useFileDrop(addFiles, !!issue);

  const save = useAction(async () => {
    const input: CreateIssueInput = {
      title: title.trim(), body, expectedOutput: expected, taskType: taskType.trim() || null, goalId: goalId || null,
      assigneeAgentId: assignee || null, reviewerAgentId: reviewer || null, status, priority, labels,
      ...(issue ? {} : { parentIssueId: defaults?.parentIssueId ?? null }),
    };
    if (issue) await api.updateIssue(org.id, issue.id, input);
    else {
      // Assigning wakes the agent, so with files the issue is assigned only once they are attached.
      const assignLater = files.length > 0 && !!input.assigneeAgentId;
      let created = await api.createIssue(org.id, assignLater ? { ...input, assigneeAgentId: null } : input);
      // The issue exists either way; a file that fails to upload is announced and can be re-attached on its page.
      if (files.length) await uploadTaskFiles(org.id, created.id, files.map((f) => f.file));
      if (assignLater) created = await api.assignIssue(org.id, created.id, input.assigneeAgentId!);
      if (onCreated) onCreated(created);
      else nav(`${base}/issues/${created.number}`);
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
        {issue ? null : (
          <div className={`field field-wide file-drop${drop.over ? ' is-over' : ''}`} {...drop.props}>
            <span className="field-label">Attachments</span>
            <div className="row row-tight">
              <AttachButton onFiles={addFiles} />
              <span className="muted">Screenshots, mockups, documents. Drop or paste them here too. The assignee sees them with the task.</span>
            </div>
            <PendingChips files={files} onRemove={(key) => setFiles((list) => list.filter((f) => f.key !== key))} />
          </div>
        )}
      </div>
    </FormShell>
  );
}
