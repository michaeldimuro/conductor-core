import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ActionBadge, actorIcon, actorName } from '../components/activity.js';
import { Icon, PriorityIcon, StatusIcon } from '../components/icons.js';
import { IssueForm, useGoals } from '../components/IssueForm.js';
import { Button, Chip, Empty, ErrorNote, Field, JsonView, Load, Loading, Panel, Segmented, Status } from '../components/ui.js';
import { runNow as runAgentNow } from '../lib/run-now.js';
import { api } from '../lib/api.js';
import type { AddCommentRequest, Agent, Issue, ReviewRequest, TimelineEntry } from '../lib/api.js';
import { AttachButton, PendingChips, TaskFiles, useFileDrop, useStagedUploads } from '../components/attachments.js';
import { ago, dateTime, humanize, money, blockedText } from '../lib/format.js';
import { ISSUE_STATUSES, PRIORITIES, STATUS_LABEL, k, useDirectory, useOrg, type Directory, type IssueStatus } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';
import { Markdown } from '../components/markdown.js';
import { ArtifactChips, ArtifactViewer } from '../components/artifacts.js';
import { fromArtifact, guessType, type ViewerFile } from '../lib/artifacts.js';
import { ARTIFACT_EVENTS } from './Artifacts.js';
import { ApprovalChip, PendingApprovals, approvalIdsIn } from '../components/approvals.js';
import { IssueBrief } from '../components/issue-brief.js';
import { useOpenIssues } from '../lib/work.js';

type CommentAttachments = NonNullable<AddCommentRequest['attachments']>;

/**
 * Comment box with @mention autocomplete over the org's agents (inserted as
 * `@slug`) and file attachments (button, drag and drop, or paste a screenshot).
 */
function CommentBox({ onSubmit, busy, agents }: { onSubmit: (body: string, attachments: CommentAttachments) => Promise<boolean>; busy: boolean; agents: Agent[] }) {
  const { org } = useOrg();
  const uploads = useStagedUploads(org.id);
  const drop = useFileDrop(uploads.add);
  const [body, setBody] = useState('');
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return agents.filter((a) => a.slug.includes(q) || a.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mention, agents]);

  const track = (value: string, caret: number) => {
    const m = /(^|\s)@([a-z0-9-]*)$/i.exec(value.slice(0, caret));
    setMention(m ? { start: caret - (m[2]?.length ?? 0) - 1, query: m[2] ?? '' } : null);
    setActive(0);
  };
  const pick = (a: Agent) => {
    if (!mention) return;
    const caret = ref.current?.selectionStart ?? body.length;
    const next = `${body.slice(0, mention.start)}@${a.slug} ${body.slice(caret)}`;
    setBody(next);
    setMention(null);
    const pos = mention.start + a.slug.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };
  const attachments = uploads.ready();
  const canSend = (body.trim().length > 0 || attachments.length > 0) && !uploads.busy;
  const send = async () => {
    if (!canSend) return;
    const text = body.trim() ? body : `Attached ${attachments.map((a) => a.name).join(', ')}`;
    if (await onSubmit(text, attachments)) {
      setBody('');
      uploads.clear();
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        return setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return pick(matches[active]!);
      }
      if (e.key === 'Escape') return setMention(null);
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
  };
  return (
    <form
      className={`comment-box file-drop${drop.over ? ' is-over' : ''}`}
      {...drop.props}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="mention-wrap">
        <textarea
          ref={ref} rows={3} value={body} aria-label="Add a comment" placeholder="Comment, type @ to bring an agent in, or paste or drop files"
          role="combobox" aria-expanded={matches.length > 0} aria-controls="mention-list" aria-autocomplete="list"
          aria-activedescendant={matches.length ? `mention-${matches[active]?.id}` : undefined}
          onChange={(e) => {
            setBody(e.target.value);
            track(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKey}
          onBlur={() => window.setTimeout(() => setMention(null), 120)}
        />
        {matches.length > 0 ? (
          <ul className="mention-list" id="mention-list" role="listbox" aria-label="Agents">
            {matches.map((a, i) => (
              <li key={a.id} id={`mention-${a.id}`} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(a); }}>
                <strong>@{a.slug}</strong> <span className="muted">{a.name}, {a.role}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <PendingChips files={uploads.files} onRemove={uploads.remove} />
      <div className="spread">
        <span className="row row-tight">
          <AttachButton onFiles={uploads.add} />
          <span className="muted">Mentioned agents are woken to respond and see attached files.</span>
        </span>
        <Button icon="send" type="submit" variant="primary" busy={busy} disabled={!canSend} title={uploads.busy ? 'Waiting for uploads to finish' : undefined}>Add comment</Button>
      </div>
      {drop.over ? <div className="file-drop-hint" aria-hidden="true"><Icon name="upload" size={18} />Drop to attach to your comment</div> : null}
    </form>
  );
}

/** A comment's attachments as viewer files (served inline by the daemon for viewing). */
const attachmentFiles = (c: Extract<TimelineEntry, { kind: 'comment' }>['comment']): ViewerFile[] => c.attachments.map((a, i) => {
  const url = api.attachmentPath(c.orgId, c.issueId, c.id, i);
  return { key: `${c.id}:${i}`, name: a.name, contentType: guessType(a.name, a.mime), viewUrl: `${url}?inline=1`, downloadUrl: url };
});

type AuditEntry = Extract<TimelineEntry, { kind: 'activity' }>['activity'];

/** The approval an activity row is about: an approval event, or a tool call that was held for one. */
function approvalOf(a: AuditEntry): string | null {
  if (a.entityKind === 'approval' && a.entityId) return a.entityId;
  const id = (a.data ?? {}).approvalId;
  return typeof id === 'string' && id.startsWith('apr_') ? id : null;
}

function Timeline({ entries, dir, base, onOpen }: { entries: TimelineEntry[]; dir: Directory; base: string; onOpen: (f: ViewerFile, list: ViewerFile[]) => void }) {
  if (entries.length === 0) return <Empty icon="activity" title="No activity on this issue yet" />;
  return (
    <ol className="timeline" aria-live="polite">
      {entries.map((e) => {
        if (e.kind === 'comment') {
          const c = e.comment;
          const who = c.authorKind === 'human' ? 'You' : c.authorKind === 'system' ? 'Conductor' : dir.agentName(c.authorId, 'An agent');
          return (
            <li key={`c-${c.id}`} className={`tl-comment tl-${c.authorKind}`}>
              <header className="spread">
                <strong className="tl-author"><span className={`avatar avatar-${c.authorKind}`}><Icon name={actorIcon(c.authorKind)} size={13} /></span>{who}</strong>
                <span className="muted">{c.runId ? <><Link to={`${base}/runs/${c.runId}`}>run</Link> </> : null}<time title={dateTime(c.createdAt)}>{ago(c.createdAt)}</time></span>
              </header>
              <Markdown text={c.body} />
              {c.attachments.length ? (() => {
                const files = attachmentFiles(c);
                return <ArtifactChips label="Attachments" files={files} onOpen={(f) => onOpen(f, files)} />;
              })() : null}
            </li>
          );
        }
        const a = e.activity;
        const data = a.data ?? {};
        const isTool = a.action.startsWith('tool.');
        const summary = isTool
          ? [data.tool ?? data.name, data.status, typeof data.latencyMs === 'number' ? `${data.latencyMs} ms` : null, typeof data.costUsd === 'number' && data.costUsd > 0 ? money(data.costUsd) : null].filter(Boolean).join(', ')
          : [data.status, data.from && data.to ? `${String(data.from)} to ${String(data.to)}` : null, data.reason, data.outcome].filter((v) => typeof v === 'string' && v).join(', ');
        return (
          <li key={`a-${a.id}`} className={`tl-activity${isTool ? ' tl-tool' : ''}`}>
            <details>
              <summary>
                <span className="tl-line"><ActionBadge action={a.action} /><span><strong>{actorName(a, dir)}</strong> {isTool ? 'called a tool' : humanize(a.action).toLowerCase()}{summary ? <span className="dim">: {summary}</span> : null}{approvalOf(a) ? <> <ApprovalChip id={approvalOf(a)!} /></> : null}</span></span>
                <time className="muted" title={dateTime(a.ts)}>{ago(a.ts)}</time>
              </summary>
              <div className="tl-detail">
                {a.runId ? <p><Link to={`${base}/runs/${a.runId}`}>Open the run transcript</Link></p> : null}
                {Object.keys(data).length ? <JsonView value={data} /> : <p className="muted">No further detail was recorded.</p>}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

function Review({ issue }: { issue: Issue }) {
  const { org } = useOrg();
  const [outcome, setOutcome] = useState<ReviewRequest['outcome']>('accepted');
  const [note, setNote] = useState('');
  const review = useAction(() => api.reviewIssue(org.id, issue.id, { outcome, note: note.trim() || undefined }), { invalidate: [k(org.id, 'issue')], success: 'Review recorded' });
  const HELP: Record<ReviewRequest['outcome'], string> = {
    accepted: 'The work is done as delivered. The issue closes.',
    edited: 'You fixed it up yourself. The issue closes and the edit counts against the agent\'s scorecard.',
    rejected: 'The work goes back to the agent for another pass, with your note.',
  };
  return (
    <Panel icon="review" title="Your review">
      <form className="form" onSubmit={(e) => { e.preventDefault(); void review.run(); }}>
        <Segmented label="Verdict" value={outcome} onChange={setOutcome} options={[{ value: 'accepted', label: 'Accept' }, { value: 'edited', label: 'Accept with edits' }, { value: 'rejected', label: 'Reject' }]} />
        <p className="muted">{HELP[outcome]}</p>
        <Field label={outcome === 'rejected' ? 'What needs to change' : 'Note (optional)'}>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} required={outcome === 'rejected'} />
        </Field>
        <ErrorNote error={review.error} />
        <div className="form-actions"><Button icon="review" type="submit" variant={outcome === 'rejected' ? 'danger' : 'primary'} busy={review.busy}>Submit review</Button></div>
      </form>
    </Panel>
  );
}

function IssueLinks({ ids, title }: { ids: string[]; title: string }) {
  const { org, base } = useOrg();
  const q = useQuery(k(org.id, 'issue-set', ids.join(',')), () => Promise.all(ids.map((id) => api.getIssue(org.id, id))), { events: ['issue.'], orgId: org.id });
  return (
    <div>
      <h3>{title}</h3>
      {q.data ? (
        <ul className="lines lines-compact">
          {q.data.map((i) => <li key={i.id} className="line"><StatusIcon status={i.status} /><Link className="truncate" to={`${base}/issues/${i.number}`}>#{i.number} {i.title}</Link></li>)}
        </ul>
      ) : q.error ? <ErrorNote error={q.error} /> : <Loading lines={1} />}
    </div>
  );
}

/** Approval ids the issue's description, comments and activity point at. */
function referencedApprovals(issue: Issue, entries: TimelineEntry[] | undefined): string[] {
  const texts: string[] = [issue.body ?? '', issue.expectedOutput ?? ''];
  const ids: string[] = [];
  for (const e of entries ?? []) {
    if (e.kind === 'comment') texts.push(e.comment.body);
    else {
      const id = approvalOf(e.activity);
      if (id) ids.push(id);
    }
  }
  return [...new Set([...approvalIdsIn(texts), ...ids])];
}

export function IssueDetail() {
  const { org, base } = useOrg();
  const { issue: ref = '' } = useParams();
  const dir = useDirectory(org.id);
  const goals = useGoals(org.id);
  const o = { orgId: org.id };
  const issueQ = useQuery(k(org.id, 'issue', ref), () => api.getIssue(org.id, ref), { ...o, events: ['issue.'] });
  const issue = issueQ.data;
  const timeline = useQuery(k(org.id, 'issue', ref, 'timeline'), () => api.issueTimeline(org.id, ref), { ...o, events: ['comment.', 'issue.', 'run.started', 'run.finished', 'approval.'] });
  const children = useQuery(issue ? k(org.id, 'issues', 'children', issue.id) : null, () => api.listIssues(org.id, { parentIssueId: issue!.id, limit: 100 }), { ...o, events: ['issue.'] });
  const runs = useQuery(issue ? k(org.id, 'runs', 'issue', issue.id) : null, () => api.listRuns(org.id, { issueId: issue!.id, limit: 30 }), { ...o, events: ['run.started', 'run.finished', 'run.paused', 'run.resumed'] });
  const artifacts = useQuery(issue ? k(org.id, 'artifacts', 'issue', issue.id) : null, () => api.listArtifacts(org.id, { issueId: issue!.id }), { ...o, events: ARTIFACT_EVENTS });
  const [viewing, setViewing] = useState<{ file: ViewerFile; list: ViewerFile[] } | null>(null);
  const openFile = (file: ViewerFile, list: ViewerFile[]) => setViewing({ file, list });
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<'updates' | 'details' | 'work'>('updates');
  const [everything, setEverything] = useState(false);
  const openIssues = useOpenIssues(org.id);
  const [subIssue, setSubIssue] = useState(false);
  const inv = { invalidate: [k(org.id, 'issue')] };
  const patch = useAction((p: Parameters<typeof api.updateIssue>[2]) => api.updateIssue(org.id, issue!.id, p), inv);
  const assign = useAction((agentId: string | null) => api.assignIssue(org.id, issue!.id, agentId), inv);
  const comment = useAction((body: string, attachments: CommentAttachments) =>
    api.addComment(org.id, issue!.id, attachments.length ? { body, attachments } : { body }), inv);
  const runNow = useAction(() => runAgentNow(org.id, issue!.assigneeAgentId!, dir.agentName(issue!.assigneeAgentId, 'The agent'), { issueId: issue!.id }), { invalidate: [k(org.id, 'runs')] });

  if (!issue) return <div className="page page-narrow">{issueQ.error ? <ErrorNote error={issueQ.error} retry={issueQ.reload} /> : <Loading lines={5} />}</div>;
  const goal = goals.data?.find((g) => g.id === issue.goalId);
  const referenced = referencedApprovals(issue, timeline.data);
  const ownerReviews = issue.status === 'in_review' && !issue.reviewerAgentId;

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head-text">
          <nav className="crumbs" aria-label="Breadcrumb"><Link to={`${base}/issues`}>Issues</Link><span aria-hidden="true">/</span><span>#{issue.number}</span></nav>
          <h1 className="issue-title"><StatusIcon status={issue.status} size={22} />{issue.title}</h1>
          <p className="row row-tight issue-sub muted"><span>{STATUS_LABEL[issue.status]}</span><span aria-hidden="true">·</span><PriorityIcon priority={issue.priority} /><span>{PRIORITIES[issue.priority]} priority</span>{issue.assigneeAgentId ? <><span aria-hidden="true">·</span><Icon name="agent" size={14} /><span>{dir.agentName(issue.assigneeAgentId)}</span></> : null}</p>
        </div>
        <div className="row page-actions issue-actions">
          <Button icon="edit" onClick={() => setEditing(true)} aria-label="Edit"><span className="btn-label-long">Edit</span></Button>
          <Button icon="add" onClick={() => setSubIssue(true)} aria-label="Add sub-issue"><span className="btn-label-long">Add sub-issue</span></Button>
          <Button icon="play" variant="primary" busy={runNow.busy} disabled={!issue.assigneeAgentId} title={issue.assigneeAgentId ? undefined : 'Assign an agent first'} onClick={() => void runNow.run()}>Run now</Button>
        </div>
      </header>
      <IssueBrief issue={issue} org={org} base={base} dir={dir} timeline={timeline.data} runs={runs.data} children={children.data?.items} open={openIssues.data ?? []} />
      <div className="issue-tabs" role="tablist" aria-label="Task sections">
        {(['updates', 'details', 'work'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : undefined} onClick={() => setTab(t)}>
            {t === 'updates' ? 'Updates' : t === 'details' ? 'Details' : `Files & runs${(runs.data?.length ?? 0) + (artifacts.data?.length ?? 0) ? ` · ${(runs.data?.length ?? 0) + (artifacts.data?.length ?? 0)}` : ''}`}
          </button>
        ))}
      </div>
      <div className={`split issue-body tab-${tab}`}>
        <div className="stack-lg">
          <div data-tab="updates"><PendingApprovals org={org} issueId={issue.id} referencedIds={referenced} /></div>
          <Panel icon="description" title="Description" className="tab-details-only">
            <div className="stack">
              {issue.body ? <Markdown text={issue.body} /> : <p className="muted">No description.</p>}
              {issue.expectedOutput ? <div><h3>Expected output</h3><Markdown text={issue.expectedOutput} className="dim" /></div> : null}
              <TaskFiles orgId={org.id} issueId={issue.id} onOpen={openFile} />
            </div>
          </Panel>
          {ownerReviews ? <details className="tab-details-only review-more"><summary>More review options</summary><Review issue={issue} /></details> : null}
          <Panel icon="activity" title="Updates" flush className="tab-updates-only"
            actions={<Segmented small label="Show" value={everything ? 'all' : 'talk'} onChange={(v) => setEverything(v === 'all')} options={[{ value: 'talk', label: 'Conversation' }, { value: 'all', label: 'All activity' }]} />}>
            <Load q={timeline}>{(entries) => {
              // The conversation (and the status changes that matter) by default; tool calls and edits on request.
              const shown = everything ? entries : entries.filter((e) => e.kind === 'comment' || /^(issue\.(status|review|blocked|escalated|handed)|approval\.)/.test(e.activity.action) || (e.activity.action === 'issue.updated' && typeof e.activity.data?.status === 'string'));
              return shown.length || everything ? <Timeline entries={shown} dir={dir} base={base} onOpen={openFile} /> : <p className="timeline-quiet muted">No messages yet. <button type="button" className="link-btn" onClick={() => setEverything(true)}>Show all activity ({entries.length})</button></p>;
            }}</Load>
            <CommentBox agents={dir.staff} busy={comment.busy} onSubmit={async (body, files) => (await comment.run(body, files)) !== undefined} />
          </Panel>
        </div>
        <aside className="stack-lg" aria-label="Issue details">
          <Panel className="tab-details-only">
            <div className="stack">
              <Field label="Status">
                <select value={issue.status} disabled={patch.busy} onChange={(e) => void patch.run({ status: e.target.value as IssueStatus })}>
                  {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              </Field>
              <Field label="Assignee">
                <select value={issue.assigneeAgentId ?? ''} disabled={assign.busy} onChange={(e) => void assign.run(e.target.value || null)}>
                  <option value="">Unassigned</option>
                  {dir.staff.map((a) => <option key={a.id} value={a.id}>{a.name}, {a.role}</option>)}
                </select>
              </Field>
              <Field label="Priority">
                <select value={issue.priority} disabled={patch.busy} onChange={(e) => void patch.run({ priority: Number(e.target.value) })}>
                  {PRIORITIES.map((p, i) => <option key={p} value={i}>{p}</option>)}
                </select>
              </Field>
              <dl className="kv">
                <div><dt>Reviewer</dt><dd>{dir.agentName(issue.reviewerAgentId, 'You')}</dd></div>
                <div><dt>Goal</dt><dd>{goal ? <Link to={`${base}/issues?goal=${goal.id}`}>{goal.title}</Link> : 'None'}</dd></div>
                <div><dt>Task type</dt><dd>{issue.taskType ?? 'None'}</dd></div>
                <div><dt>Labels</dt><dd className="row row-tight">{issue.labels.length ? issue.labels.map((l) => <Chip key={l}>{l}</Chip>) : 'None'}</dd></div>
                <div><dt>Created</dt><dd>{dateTime(issue.createdAt)} by {issue.creatorKind === 'human' ? 'you' : dir.agentName(issue.creatorId, 'Conductor')}</dd></div>
                {issue.reviewOutcome ? <div><dt>Review</dt><dd><Status value={issue.reviewOutcome} />{issue.reworkCount ? `, ${issue.reworkCount} rework` : ''}</dd></div> : null}
                {issue.checkoutLock ? <div><dt>Checked out</dt><dd><Link to={`${base}/runs/${issue.checkoutLock}`}>by a live run</Link></dd></div> : null}
              </dl>
            </div>
          </Panel>
          <Panel icon="link" title="Related" className="tab-work-only">
            <div className="stack">
              {issue.parentIssueId ? <IssueLinks ids={[issue.parentIssueId]} title="Parent" /> : null}
              {issue.blockedBy.length ? <IssueLinks ids={issue.blockedBy} title="Blocked by" /> : null}
              <div>
                <h3>Sub-issues</h3>
                {children.data?.items.length ? (
                  <ul className="lines lines-compact">
                    {children.data.items.map((i) => <li key={i.id} className="line"><StatusIcon status={i.status} /><Link className="truncate" to={`${base}/issues/${i.number}`}>#{i.number} {i.title}</Link></li>)}
                  </ul>
                ) : <p className="muted">None</p>}
              </div>
            </div>
          </Panel>
          <Panel icon="artifacts" title="Artifacts" className="tab-work-only">
            <Load q={artifacts} lines={2} empty={<p className="muted">Files the agents save or attach while working on this issue show up here.</p>}>
              {(list) => {
                const files = list.map(fromArtifact);
                return <ArtifactChips label="Artifacts" files={files} onOpen={(f) => openFile(f, files)} />;
              }}
            </Load>
          </Panel>
          <Panel icon="runs" title="Runs" flush className="tab-work-only">
            <Load q={runs} lines={2} empty={<Empty icon="issues" title="No agent has worked on this yet" />}>
              {(list) => (
                <ul className="lines">
                  {list.map((r) => (
                    <li key={r.id} className="line">
                      <Status value={r.status} />
                      <Link className="grow truncate" to={`${base}/runs/${r.id}`}>{dir.agentName(r.agentId)}</Link>
                      <span className="muted nowrap">{ago(r.startedAt ?? r.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Load>
          </Panel>
        </aside>
      </div>
      <ArtifactViewer file={viewing?.file ?? null} files={viewing?.list} onOpen={(f) => setViewing((v) => (v ? { ...v, file: f } : v))} onClose={() => setViewing(null)} />
      <IssueForm open={editing} onClose={() => setEditing(false)} issue={issue} />
      <IssueForm open={subIssue} onClose={() => setSubIssue(false)} defaults={{ parentIssueId: issue.id, goalId: issue.goalId, assigneeAgentId: issue.assigneeAgentId }} />
    </div>
  );
}
