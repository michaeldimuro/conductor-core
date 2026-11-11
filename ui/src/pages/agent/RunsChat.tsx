import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Empty, ErrorNote, Load, Panel, Status } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { Agent, Run } from '../../lib/api.js';
import { dateTime, duration, humanize, money, tokens } from '../../lib/format.js';
import { k, useOrg } from '../../lib/org.js';
import { useAction, useQuery } from '../../lib/query.js';
import { Markdown } from '../../components/markdown.js';

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
        <Load q={runs} empty={<Empty title={`${agent.name} has not run yet`}><p>Assign it an issue, mention it in a comment, or press Run now.</p></Empty>}>
          {(list) => (
            <>
              <RunsTable runs={list} base={base} />
              {list.length >= limit ? <div className="panel-body"><Button small busy={runs.fetching} onClick={() => setLimit((l) => l + 50)}>Show 50 more</Button></div> : null}
            </>
          )}
        </Load>
      </Panel>
    </div>
  );
}

interface Turn {
  id: number;
  from: 'you' | 'agent';
  text: string;
  runId?: string;
}

/** One-off conversation outside the issue loop. Each message is its own run. */
export function ChatTab({ agent }: { agent: Agent }) {
  const { org, base } = useOrg();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const send = useAction(async (message: string) => {
    setTurns((t) => [...t, { id: nextId.current++, from: 'you', text: message }]);
    setDraft('');
    const res = await api.chatWithAgent(org.id, agent.id, { message });
    setTurns((t) => [...t, { id: nextId.current++, from: 'agent', text: res.reply, runId: res.runId }]);
  }, { invalidate: [k(org.id, 'runs')], quiet: true });
  useEffect(() => {
    // Block body on purpose: newer browsers return a promise from scrollIntoView, and an effect must not return one.
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [turns.length, send.busy]);
  const submit = () => {
    if (draft.trim() && !send.busy) void send.run(draft.trim());
  };
  return (
    <Panel title={`Chat with ${agent.name}`}>
      <div className="chat">
        <ol className="chat-log" aria-live="polite">
          {turns.length === 0 ? <li className="chat-empty muted">Ask a question or give a quick instruction. This conversation is not saved when you leave the page; the runs behind it are.</li> : null}
          {turns.map((t) => (
            <li key={t.id} className={`chat-turn chat-${t.from}`}>
              <strong>{t.from === 'you' ? 'You' : agent.name}</strong>
              {t.text ? <Markdown text={t.text} /> : <p className="muted">(empty reply)</p>}
              {t.runId ? <Link to={`${base}/runs/${t.runId}`}>Run transcript</Link> : null}
            </li>
          ))}
          {send.busy ? <li className="chat-turn chat-agent"><strong>{agent.name}</strong><div className="muted">Working on a reply…</div></li> : null}
        </ol>
        <div ref={end} />
        <ErrorNote error={send.error} />
        {agent.status !== 'active' ? <p className="note note-warn">{agent.name} is {agent.status} and cannot reply.</p> : null}
        <form className="comment-box" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <textarea rows={3} aria-label={`Message ${agent.name}`} placeholder={`Message ${agent.name}`} value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
          <div className="spread"><span className="muted">Each message starts a run and counts against the budget.</span><Button type="submit" variant="primary" busy={send.busy} disabled={!draft.trim() || agent.status !== 'active'}>Send</Button></div>
        </form>
      </div>
    </Panel>
  );
}
