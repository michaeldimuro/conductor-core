import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArtifactOrigin, ArtifactViewer, TypeBadge } from '../components/artifacts.js';
import { Empty, Load, PageHead, Panel, Segmented } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { ArtifactDto } from '../lib/api.js';
import { KIND_GROUP, bytes, fromArtifact, previewKind, type KindGroup, type ViewerFile } from '../lib/artifacts.js';
import { ago, dateTime } from '../lib/format.js';
import { k, useDirectory, useOrg } from '../lib/org.js';
import { FileIcon } from '../components/icons.js';
import { useQuery } from '../lib/query.js';

type Source = '' | ArtifactDto['source'];
const LAYOUT_KEY = 'conductor.artifacts.layout';
const recallLayout = (): string | null => {
  try {
    return localStorage.getItem(LAYOUT_KEY);
  } catch {
    return null;
  }
};
const rememberLayout = (l: string): void => {
  try {
    localStorage.setItem(LAYOUT_KEY, l);
  } catch {
    /* ignore */
  }
};
type Layout = 'grid' | 'list';

const SOURCES: ReadonlyArray<{ value: Source; label: string }> = [
  { value: '', label: 'All' }, { value: 'task', label: 'Tasks' }, { value: 'chat', label: 'Chats' }, { value: 'run', label: 'Other runs' },
];
const GROUPS: ReadonlyArray<{ value: '' | KindGroup; label: string }> = [
  { value: '', label: 'Any type' }, { value: 'docs', label: 'Documents' }, { value: 'images', label: 'Images' }, { value: 'data', label: 'Data and sheets' },
  { value: 'web', label: 'Web pages' }, { value: 'media', label: 'Audio and video' }, { value: 'other', label: 'Other' },
];

/** Live: new files arrive from tools, comments and finished runs. */
export const ARTIFACT_EVENTS = ['artifact.', 'comment.created', 'run.finished'];

function Card({ a, onOpen }: { a: ArtifactDto; onOpen: () => void }) {
  const isImage = previewKind(a.name, a.contentType) === 'image';
  return (
    <li className="artifact-card">
      <button type="button" className="artifact-card-open" onClick={onOpen} aria-label={`View ${a.name}`}>
        <span className={`artifact-card-thumb${isImage ? ' has-image' : ''}`}>
          {isImage ? <img src={a.viewPath} alt="" loading="lazy" /> : <span className="artifact-card-glyph"><FileIcon kind={previewKind(a.name, a.contentType)} size={30} /><TypeBadge name={a.name} contentType={a.contentType} /></span>}
        </span>
      </button>
      <div className="artifact-card-body">
        <button type="button" className="artifact-card-name truncate" onClick={onOpen} title={a.name}>{a.name}</button>
        <span className="artifact-card-meta muted"><time title={dateTime(a.modifiedAt)}>{ago(a.modifiedAt)}</time><span>{bytes(a.bytes)}</span></span>
        <ArtifactOrigin a={a} />
      </div>
    </li>
  );
}

function Rows({ list, onOpen }: { list: ArtifactDto[]; onOpen: (a: ArtifactDto) => void }) {
  return (
    <table className="table artifact-table">
      <thead><tr><th>Name</th><th>From</th><th className="num">Size</th><th>Saved</th></tr></thead>
      <tbody>
        {list.map((a) => (
          <tr key={a.path}>
            <td data-label="Name">
              <button type="button" className="artifact-row-name" onClick={() => onOpen(a)} title={`View ${a.name}`}>
                <TypeBadge name={a.name} contentType={a.contentType} /><span className="truncate">{a.name}</span>
              </button>
            </td>
            <td data-label="From"><ArtifactOrigin a={a} /></td>
            <td data-label="Size" className="num">{bytes(a.bytes)}</td>
            <td data-label="Saved"><time title={dateTime(a.modifiedAt)}>{ago(a.modifiedAt)}</time></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The artifact store: every file agents produced, on tasks and in chats, with
 * where it came from. Any file opens in the built-in viewer.
 */
export function Artifacts() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [query, setQuery] = useState(search);
  const source = (params.get('source') ?? '') as Source;
  const agentId = params.get('agent') ?? '';
  const group = (params.get('type') ?? '') as '' | KindGroup;
  const [layout, setLayoutState] = useState<Layout>(() => (recallLayout() === 'list' ? 'list' : 'grid'));
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    rememberLayout(l);
  };
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const set = (key: string, value: string) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (value) next.set(key, value);
    else next.delete(key);
    return next;
  }, { replace: true });

  const list = useQuery(k(org.id, 'artifacts', source, agentId, query), () => api.listArtifacts(org.id, {
    source: source || undefined, agentId: agentId || undefined, q: query || undefined, limit: 1000,
  }), { events: ARTIFACT_EVENTS, orgId: org.id });
  const shown = useMemo(() => (list.data ?? []).filter((a) => !group || KIND_GROUP[previewKind(a.name, a.contentType)] === group), [list.data, group]);
  const files = useMemo(() => shown.map(fromArtifact), [shown]);

  // `?open=<path>` deep-links one file (from chat replies, issues and runs).
  const openPath = params.get('open');
  const open: ViewerFile | null = openPath ? files.find((f) => f.key === openPath) ?? null : null;
  const show = (f: ViewerFile | ArtifactDto) => set('open', 'path' in f ? f.path : f.key);
  const missing = !!openPath && !!list.data && !open;

  return (
    <div className="page">
      <PageHead icon="artifacts" title="Artifacts" sub="Files your agents made on tasks and in chats. Open any of them here, no download needed." />
      <div className="toolbar artifact-toolbar">
        <input type="search" className="toolbar-search" aria-label="Search file names" placeholder="Search file names" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Segmented label="Where it came from" value={source} onChange={(v) => set('source', v)} options={SOURCES} />
        <select aria-label="Agent" value={agentId} onChange={(e) => set('agent', e.target.value)}>
          <option value="">Any agent</option>
          {dir.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select aria-label="File type" value={group} onChange={(e) => set('type', e.target.value)}>
          {GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
        <span className="grow" />
        <Segmented small label="Layout" value={layout} onChange={setLayout} options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]} />
      </div>
      {missing ? <p className="note note-warn">That file is not in this view. It may have been removed, or a filter hides it.</p> : null}
      <Load q={list} lines={6}>
        {() => (shown.length === 0 ? (
          <Panel>
            <Empty icon="artifacts" title={list.data?.length || query || source || agentId ? 'No files match' : 'No artifacts yet'}>
              <p>When an agent saves a report, document, spreadsheet, chart or screenshot, on a task or in a chat, it shows up here.</p>
            </Empty>
          </Panel>
        ) : layout === 'grid' ? (
          <ul className="artifact-grid" aria-label="Artifacts">{shown.map((a) => <Card key={a.path} a={a} onOpen={() => show(a)} />)}</ul>
        ) : (
          <Panel flush><Rows list={shown} onOpen={show} /></Panel>
        ))}
      </Load>
      {list.data && list.data.length >= 1000 ? <p className="muted">Showing the newest 1000 files. Search or filter to find older ones.</p> : null}
      <ArtifactViewer file={open} files={files} onOpen={show} onClose={() => set('open', '')} />
    </div>
  );
}
