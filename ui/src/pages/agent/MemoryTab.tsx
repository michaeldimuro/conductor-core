import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Check, Chip, ConfirmButton, Empty, ErrorNote, Field, FormShell, Load, Loading, Modal, Panel, Segmented, Status } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { Agent, DocResponse, Memory, WriteMemoryRequest } from '../../lib/api.js';
import { ago, dateTime, humanize, pct } from '../../lib/format.js';
import { k, useOrg } from '../../lib/org.js';
import { useAction, useQuery, type QueryResult } from '../../lib/query.js';
import { Markdown } from '../../components/markdown.js';

const KINDS = ['procedural', 'semantic', 'episodic', 'lesson', 'profile', 'owner_model'] as const;
const STATUSES = ['active', 'review', 'superseded', 'forgotten'] as const;
type Scope = Memory['scope'];
const PAGE = 100;

function MemoryForm({ onClose, memory, agent }: { onClose: () => void; memory?: Memory; agent: Agent }) {
  const { org } = useOrg();
  const [content, setContent] = useState(memory?.content ?? '');
  const [kind, setKind] = useState<Memory['kind']>(memory?.kind ?? 'semantic');
  const [scope, setScope] = useState<Scope>(memory?.scope ?? 'agent');
  const [importance, setImportance] = useState(memory?.importance ?? 0.5);
  const [confidence, setConfidence] = useState(memory?.confidence ?? 0.9);
  const [pinned, setPinned] = useState(memory?.pinned ?? false);
  const save = useAction(async () => {
    if (memory) await api.updateMemory(org.id, memory.id, { content: content.trim(), kind, importance, confidence, pinned });
    else {
      const scopeId = scope === 'agent' ? agent.id : scope === 'dept' ? agent.deptId : org.id;
      const input: WriteMemoryRequest = { scope, scopeId, kind, content: content.trim(), importance, confidence, pinned };
      await api.writeMemory(org.id, input);
    }
    onClose();
  }, { invalidate: [k(org.id, 'memory')], success: memory ? 'Memory saved' : 'Memory added' });
  return (
    <FormShell onSubmit={() => void save.run()} onCancel={onClose} busy={save.busy} error={save.error} submitLabel={memory ? 'Save memory' : 'Add memory'}>
      <Field label="What to remember"><textarea rows={5} value={content} onChange={(e) => setContent(e.target.value)} required autoFocus /></Field>
      <div className="form-grid">
        <Field label="Type"><select value={kind} onChange={(e) => setKind(e.target.value as Memory['kind'])}>{KINDS.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</select></Field>
        {!memory ? (
          <Field label="Visible to">
            <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              <option value="agent">{agent.name} only</option><option value="dept">Its department</option><option value="org">The whole organization</option>
            </select>
          </Field>
        ) : null}
        <Field label={`Importance ${pct(importance)}`}><input type="range" min="0" max="1" step="0.05" value={importance} onChange={(e) => setImportance(Number(e.target.value))} /></Field>
        <Field label={`Confidence ${pct(confidence)}`}><input type="range" min="0" max="1" step="0.05" value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} /></Field>
      </div>
      <Check label="Pinned" checked={pinned} onChange={setPinned} hint="Pinned memories never decay and are not merged away during consolidation." />
    </FormShell>
  );
}

function MemoryItem({ memory, score, onEdit }: { memory: Memory; score?: number; onEdit: (m: Memory) => void }) {
  const { org, base } = useOrg();
  const inv = { invalidate: [k(org.id, 'memory')] };
  const patch = useAction((p: Parameters<typeof api.updateMemory>[2]) => api.updateMemory(org.id, memory.id, p), inv);
  const forget = useAction(() => api.forgetMemory(org.id, memory.id), { ...inv, success: 'Memory forgotten' });
  return (
    <li className="memory">
      <Markdown text={memory.content} />
      <p className="row row-tight muted">
        <Chip>{humanize(memory.kind)}</Chip>
        <Chip>{memory.scope === 'agent' ? 'Agent' : memory.scope === 'dept' ? 'Department' : 'Organization'}</Chip>
        {memory.status !== 'active' ? <Status value={memory.status} /> : null}
        {memory.pinned ? <Chip tone="info">Pinned</Chip> : null}
        <span>importance {pct(memory.importance)}, confidence {pct(memory.confidence)}</span>
        {score !== undefined ? <span>match {score.toFixed(2)}</span> : null}
        <span title={dateTime(memory.createdAt)}>by {memory.author}, {ago(memory.createdAt)}, used {memory.useCount} times</span>
        {memory.sourceRunId ? <Link to={`${base}/runs/${memory.sourceRunId}`}>Source run</Link> : null}
      </p>
      <div className="row row-tight">
        {memory.status === 'review' ? <Button small variant="primary" busy={patch.busy} onClick={() => void patch.run({ status: 'active' })}>Keep</Button> : null}
        <Button small onClick={() => onEdit(memory)}>Edit</Button>
        <Button small busy={patch.busy} onClick={() => void patch.run({ pinned: !memory.pinned })}>{memory.pinned ? 'Unpin' : 'Pin'}</Button>
        {memory.status !== 'forgotten' ? <ConfirmButton small variant="quiet" danger label="Delete" title="Delete this memory" confirmLabel="Delete memory" message="The agent will no longer recall this. The record stays in the audit log." onConfirm={() => forget.run()} /> : null}
      </div>
    </li>
  );
}

/** Editor for a whole-document memory (MEMORY.md, owner model). */
function DocEditor({ q, onSave, label, hint }: { q: QueryResult<DocResponse>; onSave: (content: string) => Promise<unknown>; label: string; hint: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (q.data && text === null) setText(q.data.content);
  }, [q.data, text]);
  const save = useAction(async () => {
    await onSave(text ?? '');
    q.reload();
  }, { success: `${label} saved` });
  if (text === null) return q.error ? <ErrorNote error={q.error} retry={q.reload} /> : <Loading lines={4} />;
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <Field label={label} hint={hint}><textarea className="mono" rows={16} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /></Field>
      <ErrorNote error={save.error} />
      <div className="form-actions">
        <Button onClick={() => setText(q.data?.content ?? '')} disabled={text === q.data?.content}>Discard changes</Button>
        <Button type="submit" variant="primary" busy={save.busy} disabled={text === q.data?.content}>Save</Button>
      </div>
    </form>
  );
}

export function MemoryTab({ agent }: { agent: Agent }) {
  const { org } = useOrg();
  const [view, setView] = useState<'browse' | 'review' | 'rules' | 'owner'>('browse');
  const [scope, setScope] = useState<Scope>('agent');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState<Memory['status']>('active');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [form, setForm] = useState<{ memory?: Memory } | null>(null);
  const scopeId = scope === 'agent' ? agent.id : scope === 'dept' ? agent.deptId : org.id;
  const o = { events: ['memory.'], orgId: org.id };

  const list = useQuery(view === 'browse' && !query ? k(org.id, 'memory', 'list', scope, scopeId, kind, status, limit) : null,
    () => api.listMemory(org.id, { scope, scopeId, kind: (kind || undefined) as Memory['kind'] | undefined, status, limit }), o);
  const found = useQuery(view === 'browse' && query ? k(org.id, 'memory', 'search', agent.id, query, kind) : null,
    () => api.searchMemory(org.id, { agentId: agent.id, text: query, kinds: kind ? [kind as Memory['kind']] : undefined, limit: 50, includeReview: true }), o);
  const review = useQuery(k(org.id, 'memory', 'review', agent.id), () => api.listMemory(org.id, { scope: 'agent', scopeId: agent.id, status: 'review', limit: 200 }), o);
  const rules = useQuery(view === 'rules' ? k(org.id, 'memory-doc', agent.id) : null, () => api.getAgentMemoryDoc(org.id, agent.id));
  const owner = useQuery(view === 'owner' ? k(org.id, 'owner-model') : null, () => api.getOwnerModel(org.id));
  const reviewCount = review.data?.length ?? 0;

  return (
    <div className="stack-lg">
      <div className="spread">
        <Segmented label="Memory view" value={view} onChange={setView} options={[
          { value: 'browse', label: 'Browse' }, { value: 'review', label: reviewCount ? `Review queue (${reviewCount})` : 'Review queue' },
          { value: 'rules', label: 'MEMORY.md' }, { value: 'owner', label: 'Owner model' },
        ]} />
        <Button variant="primary" onClick={() => setForm({})}>Add memory</Button>
      </div>

      {view === 'browse' ? (
        <>
          <form className="toolbar" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(text.trim()); }}>
            <input className="toolbar-search" type="search" data-search placeholder={`Search what ${agent.name} can recall`} aria-label="Search memory" value={text} onChange={(e) => { setText(e.target.value); if (!e.target.value) setQuery(''); }} />
            <Button type="submit">Search</Button>
            <select aria-label="Filter by type" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Any type</option>{KINDS.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</select>
            {!query ? (
              <>
                <select aria-label="Filter by scope" value={scope} onChange={(e) => { setScope(e.target.value as Scope); setLimit(PAGE); }}>
                  <option value="agent">{agent.name}'s own</option><option value="dept">Department</option><option value="org">Organization</option>
                </select>
                <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as Memory['status'])}>{STATUSES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</select>
              </>
            ) : null}
          </form>
          <Panel flush>
            {query ? (
              <Load q={found} empty={<Empty title={`Nothing recalled for "${query}"`} />}>
                {(hits) => <ul className="memories">{hits.map((h) => <MemoryItem key={h.memory.id} memory={h.memory} score={h.score} onEdit={(memory) => setForm({ memory })} />)}</ul>}
              </Load>
            ) : (
              <Load q={list} empty={<Empty title="No memories match these filters"><p>Agents write memories after each run. You can also add one yourself.</p></Empty>}>
                {(items) => (
                  <>
                    <ul className="memories">{items.map((m) => <MemoryItem key={m.id} memory={m} onEdit={(memory) => setForm({ memory })} />)}</ul>
                    {items.length >= limit ? <div className="panel-body"><Button small busy={list.fetching} onClick={() => setLimit((l) => l + PAGE)}>Show {PAGE} more</Button></div> : null}
                  </>
                )}
              </Load>
            )}
          </Panel>
        </>
      ) : null}

      {view === 'review' ? (
        <Panel title="Low-confidence memories waiting for you" flush>
          <Load q={review} empty={<Empty title="The review queue is empty"><p>Memories an agent is unsure about land here before they are used.</p></Empty>}>
            {(items) => <ul className="memories">{items.map((m) => <MemoryItem key={m.id} memory={m} onEdit={(memory) => setForm({ memory })} />)}</ul>}
          </Load>
        </Panel>
      ) : null}

      {view === 'rules' ? (
        <Panel title={`${agent.name}'s standing rules`}>
          <DocEditor q={rules} label="MEMORY.md" hint="Injected into every run. Keep it short: the nightly consolidation rewrites it to stay under budget." onSave={(content) => api.putAgentMemoryDoc(org.id, agent.id, content)} />
        </Panel>
      ) : null}
      {view === 'owner' ? (
        <Panel title="What agents know about you">
          <DocEditor q={owner} label="Owner model" hint={`Shared by every agent in ${org.name}: your preferences, tone and standing instructions.`} onSave={(content) => api.putOwnerModel(org.id, content)} />
        </Panel>
      ) : null}

      <Modal open={form !== null} onClose={() => setForm(null)} title={form?.memory ? 'Edit memory' : 'Add a memory'}>
        {form ? <MemoryForm key={form.memory?.id ?? 'new'} onClose={() => setForm(null)} memory={form.memory} agent={agent} /> : null}
      </Modal>
    </div>
  );
}
