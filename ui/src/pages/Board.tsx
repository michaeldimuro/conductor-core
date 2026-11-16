import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { IssueForm, useGoals } from '../components/IssueForm.js';
import { Button, Chip, ErrorNote, Field, Loading, Modal, PageHead, Segmented } from '../components/ui.js';
import { TaskList } from '../components/task-list.js';
import { Icon, PriorityIcon, StatusIcon } from '../components/icons.js';
import { api } from '../lib/api.js';
import type { Issue, ListIssuesQuery } from '../lib/api.js';
import { ISSUE_STATUSES, STATUS_LABEL, k, priorityName, useDirectory, useOrg, type Directory, type IssueStatus } from '../lib/org.js';
import { invalidate, setQueryData, useQuery } from '../lib/query.js';
import { errorText } from '../lib/api.js';
import { toast } from '../lib/toast.js';
import { blockedText } from '../lib/format.js';
import { IssueTree } from './IssueTree.js';

const PAGE = 40;
const API_MAX = 500;

interface ColumnData {
  items: Issue[];
  more: boolean;
}
type Filter = Pick<ListIssuesQuery, 'assigneeAgentId' | 'goalId' | 'label' | 'search'>;

/** Fetch the first `want` issues of one status, in API-sized chunks. */
async function fetchColumn(orgId: string, status: IssueStatus, filter: Filter, want: number): Promise<ColumnData> {
  const items: Issue[] = [];
  let offset: number | null = 0;
  while (offset !== null && items.length < want) {
    const page = await api.listIssues(orgId, { ...filter, status, limit: Math.min(API_MAX, want - items.length), offset });
    items.push(...page.items);
    offset = page.nextOffset;
  }
  return { items, more: offset !== null };
}

function Card({ issue, dir, onMove, onAssign }: { issue: Issue; dir: Directory; onMove: (i: Issue, to: IssueStatus) => void; onAssign: (i: Issue, agentId: string | null) => void }) {
  const { base } = useOrg();
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData('application/x-conductor-issue', JSON.stringify({ id: issue.id, status: issue.status }));
    e.dataTransfer.effectAllowed = 'move';
  };
  return (
    <li className={`card card-p${Math.min(issue.priority, 3)}`} draggable onDragStart={onDragStart}>
      <Link className="card-title" to={`${base}/issues/${issue.number}`}>
        <span className="card-glyphs" title={`${priorityName(issue.priority)} priority, ${STATUS_LABEL[issue.status]}`}><PriorityIcon priority={issue.priority} /><StatusIcon status={issue.status} /></span>
        <span><span className="muted">#{issue.number}</span> {issue.title}</span>
      </Link>
      {issue.blockedReason && issue.status === 'blocked' ? <p className="card-blocked">{blockedText(issue.blockedReason)}</p> : null}
      <div className="row row-tight">
        {issue.priority < 2 ? <Chip tone={issue.priority === 0 ? 'stop' : 'warn'}>{priorityName(issue.priority)}</Chip> : null}
        {issue.checkoutLock ? <Chip tone="go"><Icon name="agent" size={12} />Agent working</Chip> : null}
        {issue.reworkCount > 0 ? <Chip tone="warn"><Icon name="refresh" size={12} />Rework {issue.reworkCount}</Chip> : null}
        {issue.labels.map((l) => <Chip key={l}><Icon name="label" size={12} />{l}</Chip>)}
      </div>
      <div className="card-controls">
        <select aria-label={`Assignee of issue ${issue.number}`} value={issue.assigneeAgentId ?? ''} onChange={(e) => onAssign(issue, e.target.value || null)}>
          <option value="">Unassigned</option>
          {dir.staff.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          {issue.assigneeAgentId && !dir.staff.some((a) => a.id === issue.assigneeAgentId) ? <option value={issue.assigneeAgentId}>{dir.agentName(issue.assigneeAgentId)}</option> : null}
        </select>
        <select aria-label={`Status of issue ${issue.number}`} value={issue.status} onChange={(e) => onMove(issue, e.target.value as IssueStatus)}>
          {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </div>
    </li>
  );
}

function Column({ status, filter, filterKey, dir, register, onMove, onAssign }: {
  status: IssueStatus; filter: Filter; filterKey: string; dir: Directory;
  register: (status: IssueStatus, key: string) => void; onMove: (i: Issue, to: IssueStatus) => void; onAssign: (i: Issue, agentId: string | null) => void;
}) {
  const { org } = useOrg();
  const [want, setWant] = useState(PAGE);
  const [over, setOver] = useState(false);
  useEffect(() => setWant(PAGE), [filterKey]);
  const key = k(org.id, 'issues', 'col', status, filterKey, want);
  register(status, key);
  const q = useQuery(key, () => fetchColumn(org.id, status, filter, want), { events: ['issue.'], orgId: org.id });
  // Keep showing the previous page while a larger one loads.
  const last = useRef<ColumnData | undefined>(undefined);
  if (q.data) last.current = q.data;
  const data = q.data ?? last.current;
  const onDrop = (e: DragEvent) => {
    setOver(false);
    const raw = e.dataTransfer.getData('application/x-conductor-issue');
    if (!raw) return;
    e.preventDefault();
    const dropped = JSON.parse(raw) as { id: string; status: IssueStatus };
    if (dropped.status !== status) onMove({ id: dropped.id, status: dropped.status } as Issue, status);
  };
  return (
    <section
      className={`column${over ? ' column-over' : ''}`}
      aria-label={STATUS_LABEL[status]}
      id={`col-${status}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-conductor-issue')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <header className={`column-head column-${status}`}>
        <h2><StatusIcon status={status} />{STATUS_LABEL[status]}</h2>
        <span className="muted">{data ? `${data.items.length}${data.more ? '+' : ''}` : ''}</span>
      </header>
      <div className="column-body">
        {!data ? (q.error ? <ErrorNote error={q.error} retry={q.reload} /> : <Loading lines={2} />) : null}
        {data && data.items.length === 0 ? <p className="column-empty">Nothing here</p> : null}
        {data ? <ul className="cards">{data.items.map((i) => <Card key={i.id} issue={i} dir={dir} onMove={onMove} onAssign={onAssign} />)}</ul> : null}
        {data?.more ? <Button small busy={q.fetching} onClick={() => setWant((w) => w + PAGE)}>Show {PAGE} more</Button> : null}
      </div>
    </section>
  );
}

export function Board() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const goals = useGoals(org.id);
  const [params, setParams] = useSearchParams();
  // `?new=1` (from the command palette) opens the new-issue form on arrival.
  const [creating, setCreating] = useState(() => params.get('new') === '1');
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const attention = useQuery(k(org.id, 'issues', 'needs-owner'), () => api.listIssues(org.id, { status: ['blocked', 'in_review'], limit: 50 }), { orgId: org.id, events: ['issue.'] });
  const blockedCount = attention.data?.items.filter((i) => i.status === 'blocked').length ?? 0;
  const reviewCount = attention.data?.items.filter((i) => i.status === 'in_review').length ?? 0;
  const jump = (status: IssueStatus) => {
    if (params.get('view') !== 'board') setParam('view', 'board');
    window.setTimeout(() => document.getElementById(`col-${status}`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }), 50);
  };
  const keys = useRef(new Map<IssueStatus, string>());

  const setParam = (name: string, value: string) => {
    // Start from the address bar, not this render's copy: the debounced search must never write back stale filters.
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((new URLSearchParams(window.location.search).get('q') ?? '') !== search.trim()) setParam('q', search.trim());
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== 'c' || e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      setCreating(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filter = useMemo<Filter>(() => ({
    assigneeAgentId: params.get('assignee') || undefined,
    goalId: params.get('goal') || undefined,
    label: params.get('label') || undefined,
    search: params.get('q') || undefined,
  }), [params]);
  const filterKey = JSON.stringify(filter);
  const filtered = Object.values(filter).some(Boolean);
  // Phones default to the list: a sideways board of columns is hard to work through with a thumb.
  const phone = typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches;
  const named = params.get('view');
  const view: 'board' | 'list' | 'tree' = named === 'tree' || named === 'list' || named === 'board' ? named : phone ? 'list' : 'board';
  const setView = (v: 'board' | 'list' | 'tree') => {
    setParam('view', v);
    try {
      window.localStorage.setItem('conductor.issues.view', v);
    } catch {
      // Storage blocked: the address bar still carries the choice.
    }
  };
  useEffect(() => {
    // Reopen the view you used last, unless the link already names one.
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem('conductor.issues.view');
    } catch {
      // ignore
    }
    if ((saved === 'tree' || saved === 'list' || (saved === 'board' && !phone)) && !params.has('view')) setParam('view', saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => invalidate(k(org.id, 'issues'), k(org.id, 'issue'));
  const onMove = (issue: Issue, to: IssueStatus) => {
    if (issue.status === to) return;
    // Optimistic: the card changes column at once and snaps back if the daemon refuses.
    const fromKey = keys.current.get(issue.status);
    const toKey = keys.current.get(to);
    const held: { issue?: Issue } = {};
    const undo: Array<() => void> = [];
    if (fromKey) {
      undo.push(setQueryData<ColumnData>(fromKey, (prev) => {
        held.issue = prev?.items.find((i) => i.id === issue.id);
        return prev && { ...prev, items: prev.items.filter((i) => i.id !== issue.id) };
      }));
    }
    if (toKey && held.issue) {
      const card = { ...held.issue, status: to };
      undo.push(setQueryData<ColumnData>(toKey, (prev) => prev && { ...prev, items: [card, ...prev.items] }));
    }
    api.updateIssue(org.id, issue.id, { status: to }).then(refresh, (e: unknown) => {
      for (const fn of undo.reverse()) fn();
      toast(errorText(e), 'error');
    });
  };
  const onAssign = (issue: Issue, agentId: string | null) => {
    const key = keys.current.get(issue.status);
    const undo = key ? setQueryData<ColumnData>(key, (prev) => prev && { ...prev, items: prev.items.map((i) => (i.id === issue.id ? { ...i, assigneeAgentId: agentId } : i)) }) : () => {};
    api.assignIssue(org.id, issue.id, agentId).then(refresh, (e: unknown) => {
      undo();
      toast(errorText(e), 'error');
    });
  };

  return (
    <div className="page board-page">
      <PageHead icon="issues" eyebrow="Work" title="Issues" actions={<Button variant="primary" icon="add" onClick={() => setCreating(true)}>New issue</Button>} />
      {view === 'board' && blockedCount + reviewCount > 0 ? (
        <div className="attention-strip" role="group" aria-label="Needs you">
          <span className="mono-label">Needs you</span>
          {blockedCount ? <button type="button" className="attention-chip attention-stop" onClick={() => jump('blocked')}><Icon name="hand" size={14} />{blockedCount} blocked</button> : null}
          {reviewCount ? <button type="button" className="attention-chip attention-warn" onClick={() => jump('in_review')}><Icon name="review" size={14} />{reviewCount} to review</button> : null}
        </div>
      ) : null}
      <div className="toolbar board-toolbar" role="search">
        <div className="segmented segmented-sm view-toggle" role="group" aria-label="Issue view">
          <button type="button" className={view === 'list' ? 'on' : undefined} aria-pressed={view === 'list'} onClick={() => setView('list')}><Icon name="tasks" size={13} /> List</button>
          <button type="button" className={view === 'board' ? 'on' : undefined} aria-pressed={view === 'board'} onClick={() => setView('board')}><Icon name="grid" size={13} /> Board</button>
          <button type="button" className={view === 'tree' ? 'on' : undefined} aria-pressed={view === 'tree'} onClick={() => setView('tree')}><Icon name="list" size={13} /> Tree</button>
        </div>
        <input className="toolbar-search" type="search" data-search placeholder="Search titles and descriptions" aria-label="Search issues" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button className="filters-toggle" icon="filter" onClick={() => setFiltersOpen(true)}>{filtered ? 'Filtered' : 'Filter'}</Button>
        <select className="filter-extra" aria-label="Filter by assignee" value={filter.assigneeAgentId ?? ''} onChange={(e) => setParam('assignee', e.target.value)}>
          <option value="">Any assignee</option>
          {dir.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select className="filter-extra" aria-label="Filter by goal" value={filter.goalId ?? ''} onChange={(e) => setParam('goal', e.target.value)}>
          <option value="">Any goal</option>
          {(goals.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
        </select>
        <input className="filter-extra" aria-label="Filter by label" placeholder="Label" value={filter.label ?? ''} onChange={(e) => setParam('label', e.target.value.trim())} autoCapitalize="none" />
        {filtered ? <Button className="filter-extra" variant="quiet" icon="close" onClick={() => { setSearch(''); setParams(view === 'board' ? {} : { view }, { replace: true }); }}>Clear filters</Button> : null}
        {view === 'board' ? <select className="board-jump" aria-label="Jump to column" value="" onChange={(e) => document.getElementById(`col-${e.target.value}`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })}>
          <option value="" disabled>Jump to column</option>
          {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select> : null}
      </div>
      <Modal open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filter tasks">
        <div className="form">
          <Segmented label="View" value={view} onChange={(v) => setView(v)} options={[{ value: 'list', label: 'List' }, { value: 'board', label: 'Board' }, { value: 'tree', label: 'Tree' }]} />
          <Field label="Assignee">
            <select value={filter.assigneeAgentId ?? ''} onChange={(e) => setParam('assignee', e.target.value)}>
              <option value="">Anyone</option>
              {dir.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Goal">
            <select value={filter.goalId ?? ''} onChange={(e) => setParam('goal', e.target.value)}>
              <option value="">Any goal</option>
              {(goals.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
            </select>
          </Field>
          <Field label="Label"><input value={filter.label ?? ''} onChange={(e) => setParam('label', e.target.value.trim())} autoCapitalize="none" placeholder="Any label" /></Field>
          <div className="form-actions">
            {filtered ? <Button variant="quiet" onClick={() => { setSearch(''); setParams(view === 'board' ? {} : { view }, { replace: true }); }}>Clear</Button> : null}
            <Button variant="primary" onClick={() => setFiltersOpen(false)}>Done</Button>
          </div>
        </div>
      </Modal>
      {view === 'list' ? <TaskList filter={filter} dir={dir} /> : view === 'tree' ? <IssueTree filter={filter} filterKey={filterKey} dir={dir} /> : (
        <div className="board">
          {ISSUE_STATUSES.map((s) => (
            <Column key={s} status={s} filter={filter} filterKey={filterKey} dir={dir} register={(st, key) => keys.current.set(st, key)} onMove={onMove} onAssign={onAssign} />
          ))}
        </div>
      )}
      <IssueForm open={creating} onClose={() => setCreating(false)} defaults={{ goalId: filter.goalId, assigneeAgentId: filter.assigneeAgentId }} />
    </div>
  );
}
