import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, ConfirmButton, Empty, ErrorNote, Load, Panel, Status } from '../../components/ui.js';
import { IssueForm } from '../../components/IssueForm.js';
import { api } from '../../lib/api.js';
import type { Agent, Run } from '../../lib/api.js';
import { ago, dateTime, duration, humanize, money, tokens } from '../../lib/format.js';
import { STATUS_LABEL, k, useOrg } from '../../lib/org.js';
import { useAction, useQuery } from '../../lib/query.js';
import { Markdown } from '../../components/markdown.js';
import { ArtifactChips, ArtifactViewer } from '../../components/artifacts.js';
import { fromArtifact, type ViewerFile } from '../../lib/artifacts.js';
import { Icon } from '../../components/icons.js';
import { ARTIFACT_EVENTS } from '../Artifacts.js';

const RUN_STATUSES = ['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'released'] as const;

export function RunsTable({ runs, base }: { runs: Run[]; base: string }) {
  return (
    <table className="table">
      <thead><tr><th>Status</th><th>Started</th><th>Trigger</th><th className="num">Duration</th><th className="num">Steps</th><th className="num">Tokens</th><th className="num">Cost</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id}>
            <td data-label="Status"><Link to={`${base}/runs/${r.id}`}><Status value={r.status} /></Link></td>
            <td data-label="Started">{dateTime(r.startedAt ?? r.createdAt)}</td>
            <td data-label="Trigger">{humanize(r.trigger)}</td>
            <td data-label="Duration" className="num">{r.startedAt ? duration((r.endedAt ?? Date.now()) - r.startedAt) : 'Queued'}</td>
            <td data-label="Steps" className="num">{r.steps}</td>
            <td data-label="Tokens" className="num">{tokens(r.tokensIn + r.tokensOut)}</td>
            <td data-label="Cost" className="num">{r.subscription ? 'Seat time' : money(r.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RunsTab({ agent }: { agent: Agent }) {
  const { org, base } = useOrg();
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(50);
  const runs = useQuery(k(org.id, 'runs', 'agent', agent.id, status, limit), () => api.listRuns(org.id, { agentId: agent.id, status: (status || undefined) as Run['status'] | undefined, limit }),
    { events: ['run.started', 'run.finished', 'run.paused', 'run.resumed'], orgId: org.id });
  return (
    <div className="stack">
      <div className="toolbar">
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{RUN_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
      </div>
      <Panel flush>
        <Load q={runs} empty={<Empty icon="agent" title={`${agent.name} has not run yet`}><p>Assign it an issue, mention it in a comment, or press Run now.</p></Empty>}>
          {(list) => (
            <>
              <RunsTable runs={list} base={base} />
              {list.length >= limit ? <div className="panel-body"><Button icon="down" small busy={runs.fetching} onClick={() => setLimit((l) => l + 50)}>Show 50 more</Button></div> : null}
            </>
          )}
        </Load>
      </Panel>
    </div>
  );
}

const OPEN_TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'] as const;

/** Issues assigned to the agent: the other way to talk to it, for work that should be tracked. */
export function AgentTasks({ agent, all, onAssign }: { agent: Agent; all?: boolean; onAssign: () => void }) {
  const { org, base } = useOrg();
  const tasks = useQuery(k(org.id, 'issues', 'agent', agent.id, all ? 'all' : 'open'),
    () => api.listIssues(org.id, { assigneeAgentId: agent.id, status: all ? undefined : [...OPEN_TASK_STATUSES], limit: all ? 100 : 20 } as Parameters<typeof api.listIssues>[1]),
    { events: ['issue.', 'comment.'], orgId: org.id });
  return (
    <Panel icon="task" title={all ? 'Tasks' : 'Open tasks'} flush actions={<Button icon="task" small onClick={onAssign}>Assign a task</Button>}>
      <Load q={tasks} lines={3} empty={<div className="panel-body"><Empty icon="issues" title={all ? `Nothing assigned to ${agent.name} yet` : 'No open tasks'}><p>Assign a task for work you want tracked on the board, reviewed and reported back.</p></Empty></div>}>
        {(page) => (
          <ul className="lines task-lines">
            {[...page.items].sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt).map((i) => (
              <li key={i.id}>
                <Link to={`${base}/issues/${i.number}`} className="task-line">
                  <span className="grow truncate"><span className="muted">#{i.number}</span> {i.title}</span>
                  <Status value={i.status} label={STATUS_LABEL[i.status]} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Load>
      {!all ? <div className="panel-body"><Link to={`${base}/agents/${agent.slug}/tasks`}>All tasks</Link></div> : null}
    </Panel>
  );
}

export function TasksTab({ agent }: { agent: Agent }) {
  const [assigning, setAssigning] = useState(false);
  return (
    <>
      <AgentTasks agent={agent} all onAssign={() => setAssigning(true)} />
      <IssueForm open={assigning} onClose={() => setAssigning(false)} defaults={{ assigneeAgentId: agent.id, status: 'todo' }} />
    </>
  );
}

/**
 * The direct conversation with an agent. Both sides are stored by the daemon,
 * so the history is there when you come back, and the recent turns are
 * replayed to the agent so it picks up where you left off. Each message is its own run.
 */
export function ChatTab({ agent }: { agent: Agent }) {
  const { org, base } = useOrg();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [assign, setAssign] = useState<{ title: string; body: string } | null>(null);
  const log = useRef<HTMLOListElement>(null);
  const historyKey = k(org.id, 'chat', agent.id);
  const history = useQuery(historyKey, () => api.chatHistory(org.id, agent.id, { limit: 200 }), { events: ['chat.message'], orgId: org.id });
  const messages = history.data?.messages ?? [];
  // Files the agent saved during its chat turns, shown under the reply of the run that made them.
  const saved = useQuery(k(org.id, 'artifacts', 'chat', agent.id), () => api.listArtifacts(org.id, { agentId: agent.id, source: 'chat', limit: 1000 }),
    { events: [...ARTIFACT_EVENTS, 'chat.message'], orgId: org.id });
  const filesByRun = useMemo(() => {
    const m = new Map<string, ViewerFile[]>();
    for (const a of [...(saved.data ?? [])].reverse()) {
      if (!a.runId) continue;
      m.set(a.runId, [...(m.get(a.runId) ?? []), fromArtifact(a)]);
    }
    return m;
  }, [saved.data]);
  const [viewing, setViewing] = useState<{ file: ViewerFile; list: ViewerFile[] } | null>(null);
  const send = useAction(async (message: string) => {
    setPending(message);
    setDraft('');
    try {
      await api.chatWithAgent(org.id, agent.id, { message });
    } finally {
      setPending(null);
    }
  }, { invalidate: [historyKey, k(org.id, 'runs')], quiet: true });
  const clear = useAction(() => api.clearChat(org.id, agent.id), { invalidate: [historyKey], success: 'Chat history cleared' });
  // A reply that is still being worked on (sent from another tab, or before you navigated away and back).
  const awaiting = !pending && messages.length > 0 && messages[messages.length - 1]!.role === 'user';
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending, send.busy]);
  const submit = () => {
    if (draft.trim() && !send.busy) void send.run(draft.trim());
  };
  const toTask = () => {
    const text = draft.trim();
    const firstLine = text.split('\n')[0]!.slice(0, 120);
    setAssign({ title: firstLine, body: text });
  };
  return (
    <div className="split chat-split">
      <Panel icon="chat" title={`Chat with ${agent.name}`} className="chat-panel"
        actions={messages.length ? <ConfirmButton icon="remove" small label="Clear history" title="Clear chat history" confirmLabel="Clear"
          message={`Deletes this conversation with ${agent.name}. The runs behind it stay in the Runs tab.`} onConfirm={() => clear.run()} /> : null}>
        <div className="chat">
          <ol className="chat-log" aria-live="polite" ref={log}>
            {history.loading ? <li className="chat-empty muted">Loading the conversation…</li> : null}
            {!history.loading && messages.length === 0 && !pending ? (
              <li className="chat-empty muted">Ask {agent.name} a question or give a quick instruction. The conversation is saved, and {agent.name} sees the recent messages each time you write. For work you want tracked, assign a task instead.</li>
            ) : null}
            {messages.map((m) => (
              <li key={m.id} className={`chat-turn ${m.role === 'user' ? 'chat-you' : 'chat-agent'}${m.error ? ' chat-failed' : ''}`}>
                <span className="chat-meta"><span className={`avatar avatar-${m.role === 'user' ? 'human' : 'agent'}`}><Icon name={m.role === 'user' ? 'user' : 'agent'} size={13} /></span><strong>{m.role === 'user' ? 'You' : agent.name}</strong><span className="muted" title={dateTime(m.createdAt)}>{ago(m.createdAt)}</span></span>
                {m.error ? <p className="muted">No reply: {m.error}</p> : m.body ? <Markdown text={m.body} /> : <p className="muted">(empty reply)</p>}
                {m.runId && m.role === 'agent' && filesByRun.get(m.runId)?.length ? (
                  <ArtifactChips label="Files from this reply" files={filesByRun.get(m.runId)!} onOpen={(file) => setViewing({ file, list: filesByRun.get(m.runId!)! })} />
                ) : null}
                {m.runId ? <Link className="chat-run" to={`${base}/runs/${m.runId}`}><Icon name="log" size={12} />Run transcript</Link> : null}
              </li>
            ))}
            {pending ? <li className="chat-turn chat-you"><span className="chat-meta"><strong>You</strong><span className="muted">now</span></span><Markdown text={pending} /></li> : null}
            {pending || awaiting ? <li className="chat-turn chat-agent"><span className="chat-meta"><span className="avatar avatar-agent"><Icon name="agent" size={13} /></span><strong>{agent.name}</strong></span><div className="muted chat-working"><Icon name="spinner" size={14} className="spin" />Working on a reply…</div></li> : null}
          </ol>
          <ErrorNote error={history.error ?? send.error} />
          {agent.status !== 'active' ? <p className="note note-warn">{agent.name} is {agent.status} and cannot reply.</p> : null}
          <form className="comment-box" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <textarea rows={3} aria-label={`Message ${agent.name}`} placeholder={`Message ${agent.name}. Enter to send, Shift+Enter for a new line`} value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
            <div className="spread">
              <span className="muted">Each message starts a run and counts against the budget.</span>
              <span className="row">
                <Button icon="task" disabled={!draft.trim()} onClick={toTask} title="Create a tracked issue assigned to this agent from your message">Assign as task</Button>
                <Button icon="send" type="submit" variant="primary" busy={send.busy} disabled={!draft.trim() || agent.status !== 'active'}>Send</Button>
              </span>
            </div>
          </form>
        </div>
      </Panel>
      <AgentTasks agent={agent} onAssign={() => setAssign({ title: '', body: '' })} />
      <ArtifactViewer file={viewing?.file ?? null} files={viewing?.list} onOpen={(f) => setViewing((v) => (v ? { ...v, file: f } : v))} onClose={() => setViewing(null)} />
      <IssueForm key={assign ? 'open' : 'closed'} open={!!assign} onClose={() => setAssign(null)}
        defaults={{ assigneeAgentId: agent.id, status: 'todo', title: assign?.title ?? '', body: assign?.body ?? '' }}
        onCreated={() => { if (assign?.body && assign.body === draft.trim()) setDraft(''); }} />
    </div>
  );
}
