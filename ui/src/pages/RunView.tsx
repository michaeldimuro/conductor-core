import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Chip, ConfirmButton, Empty, ErrorNote, JsonView, Loading, Panel, Status } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { RunEvent, TranscriptEntry } from '../lib/api.js';
import { dateTime, duration, humanize, money, tokens } from '../lib/format.js';
import { live } from '../lib/live.js';
import { k, useDirectory, useOrg } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';
import { Markdown } from '../components/markdown.js';
import { OrgTakeovers } from '../components/takeover.js';
import { ArtifactChips, ArtifactViewer } from '../components/artifacts.js';
import { fromArtifact, type ViewerFile } from '../lib/artifacts.js';
import { Icon } from '../components/icons.js';
import { ARTIFACT_EVENTS } from './Artifacts.js';

const LIVE_STATUSES = new Set(['queued', 'running', 'paused']);

/** Journaled transcript plus live `run.event`s, merged by sequence number. */
function useTranscript(orgId: string, runId: string, isLive: boolean) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<unknown>(undefined);
  const [loaded, setLoaded] = useState(false);
  const lastSeq = useRef(0);

  const merge = useCallback((incoming: TranscriptEntry[]) => {
    if (incoming.length === 0) return;
    lastSeq.current = Math.max(lastSeq.current, ...incoming.map((e) => e.seq));
    setEntries((prev) => {
      const bySeq = new Map(prev.map((e) => [e.seq, e]));
      for (const e of incoming) bySeq.set(e.seq, e);
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    });
  }, []);
  const catchUp = useCallback(() => {
    api.runTranscript(orgId, runId, lastSeq.current ? { afterSeq: lastSeq.current } : undefined).then(
      (rows) => {
        merge(rows);
        setError(undefined);
        setLoaded(true);
      },
      (e: unknown) => {
        setError(e);
        setLoaded(true);
      },
    );
  }, [orgId, runId, merge]);

  useEffect(() => {
    setEntries([]);
    setLoaded(false);
    lastSeq.current = 0;
    catchUp();
  }, [catchUp]);

  useEffect(() => {
    if (!isLive) return;
    const unwatch = live.watchRun(runId);
    const off = live.on((msg) => {
      if (msg.name === 'run.event' && msg.payload.runId === runId) {
        // A gap means events were missed (reconnect, slow start): fetch the journal from the last one seen.
        if (msg.payload.seq > lastSeq.current + 1) catchUp();
        merge([{ seq: msg.payload.seq, ts: Date.now(), event: msg.payload.event as RunEvent }]);
      } else if (msg.name === 'run.finished' && msg.payload.runId === runId) catchUp();
    });
    const offReconnect = live.onReconnect(catchUp);
    return () => {
      unwatch();
      off();
      offReconnect();
    };
  }, [runId, isLive, merge, catchUp]);

  return { entries, error, loaded, reload: catchUp };
}

type Row =
  | { kind: 'event'; seq: number; ts: number; event: Exclude<RunEvent, { type: 'tool_call' | 'tool_result' }> }
  | { kind: 'tool'; seq: number; ts: number; name: string; input: unknown; result?: { output: string; isError: boolean } };

/** Pair each tool call with its result so one collapsible row shows both. */
function toRows(entries: TranscriptEntry[]): Row[] {
  const rows: Row[] = [];
  const calls = new Map<string, Extract<Row, { kind: 'tool' }>>();
  for (const { seq, ts, event } of entries) {
    if (event.type === 'tool_call') {
      const row: Row = { kind: 'tool', seq, ts, name: event.name, input: event.input };
      calls.set(event.id, row);
      rows.push(row);
    } else if (event.type === 'tool_result') {
      const call = calls.get(event.id);
      if (call) call.result = { output: event.output, isError: event.isError };
      else rows.push({ kind: 'tool', seq, ts, name: event.name, input: undefined, result: { output: event.output, isError: event.isError } });
    } else rows.push({ kind: 'event', seq, ts, event });
  }
  return rows;
}

function TranscriptRow({ row }: { row: Row }) {
  if (row.kind === 'tool') {
    const state = !row.result ? 'running' : row.result.isError ? 'failed' : 'done';
    return (
      <li className={`tr tr-tool tr-tool-${state}`}>
        <details>
          <summary>
            <span className="tr-tag">Tool</span>
            <code className="grow truncate">{row.name}</code>
            <Chip tone={state === 'failed' ? 'stop' : state === 'done' ? 'go' : 'info'}>{state === 'running' ? 'Waiting for result' : state === 'failed' ? 'Error' : 'OK'}</Chip>
          </summary>
          <div className="tr-detail">
            <h4>Arguments</h4>
            {row.input === undefined ? <p className="muted">Not recorded.</p> : <JsonView value={row.input} />}
            <h4>Result</h4>
            {row.result ? <JsonView value={row.result.output} /> : <p className="muted">No result yet.</p>}
          </div>
        </details>
      </li>
    );
  }
  const e = row.event;
  switch (e.type) {
    case 'text':
      return <li className="tr tr-text"><Markdown text={e.text} /></li>;
    case 'thinking':
      return <li className="tr tr-thinking"><details><summary><span className="tr-tag">Thinking</span><span className="grow truncate muted">{e.text.slice(0, 120)}</span></summary><div className="prose dim tr-detail">{e.text}</div></details></li>;
    case 'usage':
      return <li className="tr tr-meta"><span className="tr-tag">Usage</span>{tokens(e.tokensIn)} in, {tokens(e.tokensOut)} out, {money(e.costUsd)}{e.cacheReadTokens ? `, ${tokens(e.cacheReadTokens)} cached` : ''}</li>;
    case 'status':
      return <li className="tr tr-meta"><span className="tr-tag">Status</span>{humanize(e.status)}</li>;
    case 'session':
      return <li className="tr tr-meta"><span className="tr-tag">Session</span><code>{e.sessionId}</code></li>;
    case 'error':
      return <li className="tr tr-error" role="alert"><span className="tr-tag">Error</span><span>{humanize(e.kind)}: {e.message}{e.retryable ? ' (will retry)' : ''}</span></li>;
  }
}

export function Transcript({ orgId, runId, isLive }: { orgId: string; runId: string; isLive: boolean }) {
  const t = useTranscript(orgId, runId, isLive);
  const rows = useMemo(() => toRows(t.entries), [t.entries]);
  const end = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (isLive && follow) end.current?.scrollIntoView({ block: 'nearest' });
  }, [rows.length, isLive, follow]);
  if (!t.loaded) return <Loading lines={4} label="Loading transcript" />;
  return (
    <div className="stack">
      <ErrorNote error={t.error} retry={t.reload} />
      {isLive ? (
        <label className="check transcript-follow"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /><span>Follow new events</span></label>
      ) : null}
      {rows.length === 0 ? <Empty icon="approvals" title={isLive ? 'Waiting for the first event' : 'This run recorded no events'} /> : (
        <ol className="transcript" aria-live={isLive ? 'polite' : 'off'} aria-relevant="additions">
          {rows.map((r) => <TranscriptRow key={r.seq} row={r} />)}
        </ol>
      )}
      <div ref={end} />
    </div>
  );
}

export function RunView() {
  const { org, base } = useOrg();
  const { runId = '' } = useParams();
  const dir = useDirectory(org.id);
  const runQ = useQuery(k(org.id, 'run', runId), () => api.getRun(org.id, runId), { events: ['run.'], orgId: org.id, pollMs: 15_000 });
  const run = runQ.data;
  const issue = useQuery(run?.issueId ? k(org.id, 'issue', run.issueId) : null, () => api.getIssue(org.id, run!.issueId!), { orgId: org.id });
  const cancel = useAction(() => api.cancelRun(org.id, runId, 'Cancelled by the owner'), { invalidate: [k(org.id, 'run')], success: 'Cancelling run' });
  const saved = useQuery(runId ? k(org.id, 'artifacts', 'run', runId) : null, () => api.listArtifacts(org.id, { runId }), { events: ARTIFACT_EVENTS, orgId: org.id });
  const files = useMemo(() => (saved.data ?? []).map(fromArtifact), [saved.data]);
  const [viewing, setViewing] = useState<ViewerFile | null>(null);
  if (!run) return <div className="page page-narrow">{runQ.error ? <ErrorNote error={runQ.error} retry={runQ.reload} /> : <Loading lines={5} />}</div>;
  const isLive = LIVE_STATUSES.has(run.status);
  const agent = dir.agent(run.agentId);
  const snap = run.capabilitySnapshot;
  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head-text">
          <nav className="crumbs" aria-label="Breadcrumb">
            {agent ? <><Link to={`${base}/agents/${agent.slug}/runs`}>{agent.name}</Link><span aria-hidden="true">/</span></> : null}
            <span>Run</span>
          </nav>
          <h1 className="row"><Status value={run.status} /> <span>{humanize(run.trigger)} run</span></h1>
          {issue.data ? <p>Working on <Link to={`${base}/issues/${issue.data.number}`}>#{issue.data.number} {issue.data.title}</Link></p> : null}
        </div>
        {isLive ? (
          <ConfirmButton icon="stop" label="Cancel run" danger title="Cancel this run" confirmLabel="Cancel run" message="The agent stops at the next step and the issue it holds is released." onConfirm={() => cancel.run()} />
        ) : <Button icon="refresh" onClick={runQ.reload}>Refresh</Button>}
      </header>
      {run.error ? <p className="note note-stop">{run.error}</p> : null}
      {isLive ? <OrgTakeovers org={org} runId={run.id} /> : null}
      <div className="tiles">
        <div className="tile"><span className="tile-label"><Icon name="calendar" size={14} />Started</span><span className="tile-sub">{dateTime(run.startedAt ?? run.createdAt)}</span></div>
        <div className="tile"><span className="tile-label"><Icon name="duration" size={14} />Duration</span><span className="tile-value">{run.startedAt ? duration((run.endedAt ?? Date.now()) - run.startedAt) : 'Queued'}</span></div>
        <div className="tile"><span className="tile-label"><Icon name="steps" size={14} />Steps</span><span className="tile-value">{run.steps}</span></div>
        <div className="tile"><span className="tile-label"><Icon name="tokens" size={14} />Tokens</span><span className="tile-value">{tokens(run.tokensIn + run.tokensOut)}</span><span className="tile-sub">{tokens(run.tokensIn)} in, {tokens(run.tokensOut)} out</span></div>
        <div className="tile"><span className="tile-label"><Icon name="budget" size={14} />Cost</span><span className="tile-value">{run.subscription ? 'Seat time' : money(run.costUsd)}</span><span className="tile-sub">{run.subscription ? duration(run.seatSeconds * 1000) : `${run.provider ?? 'No provider'}${run.model ? `, ${run.model}` : ''}`}</span></div>
        <div className="tile"><span className="tile-label"><Icon name="outcome" size={14} />Outcome</span><span className="tile-sub">{run.outcome ? humanize(run.outcome) : 'In progress'}{run.grade ? `, graded ${run.grade.success ? 'a success' : 'a miss'}` : ''}</span></div>
      </div>
      {run.ingestedUntrusted ? <p className="note note-warn">This run read content from outside Conductor. High-risk actions after that point (sends, payments, publishing, destructive commands, data uploads) were escalated for approval.</p> : null}
      <div className="split">
        <Panel icon="log" title="Transcript"><Transcript orgId={org.id} runId={run.id} isLive={isLive} /></Panel>
        <div className="stack-lg">
        <Panel icon="artifacts" title="Files it saved">
          {files.length ? <ArtifactChips label="Files this run saved" files={files} onOpen={setViewing} /> : <p className="muted">{isLive ? 'Nothing saved yet.' : 'This run saved no files.'}</p>}
        </Panel>
        <Panel icon="tool" title="What it could use">
          {snap ? (
            <div className="stack">
              <dl className="kv">
                <div><dt>Provider</dt><dd>{snap.provider.adapter}{snap.provider.model ? `, ${snap.provider.model}` : ''}</dd></div>
                <div><dt>Autonomy</dt><dd>Level {snap.autonomyLevel}</dd></div>
                <div><dt>Budget left</dt><dd>{snap.budget.remainingUsd == null ? 'Uncapped' : money(snap.budget.remainingUsd)}</dd></div>
              </dl>
              <div><h3>Skills</h3>{snap.skills.length ? <p className="row row-tight">{snap.skills.map((s) => <Chip key={s.id}>{s.name} v{s.version}</Chip>)}</p> : <p className="muted">None</p>}</div>
              <div><h3>Connectors</h3>{snap.connectors.length ? <p className="row row-tight">{snap.connectors.map((c) => <Chip key={c.id}>{c.name}{c.tools ? ` (${c.tools.length} tools)` : ''}</Chip>)}</p> : <p className="muted">None</p>}</div>
            </div>
          ) : <p className="muted">Capabilities are recorded when the run starts.</p>}
        </Panel>
        </div>
      </div>
      <ArtifactViewer file={viewing} files={files} onOpen={setViewing} onClose={() => setViewing(null)} />
    </div>
  );
}
