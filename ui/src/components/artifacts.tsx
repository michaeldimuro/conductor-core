import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Preview } from './artifact-preview.js';
import type { ArtifactDto } from '../lib/api.js';
import { bytes, previewKind, typeLabel, type PreviewKind, type ViewerFile } from '../lib/artifacts.js';
import { ago, dateTime } from '../lib/format.js';
import { useDirectory, useOrg } from '../lib/org.js';

/** The file-type badge (colored by kind). */
export function TypeBadge({ name, contentType, large }: { name: string; contentType: string; large?: boolean }) {
  const kind = previewKind(name, contentType);
  return <span className={`type-badge type-${kind}${large ? ' type-badge-lg' : ''}`} aria-hidden="true">{typeLabel(name, kind)}</span>;
}

/** Where a stored artifact came from: its task, the chat it was made in, or its run. */
export function ArtifactOrigin({ a, withAgent = true }: { a: ArtifactDto; withAgent?: boolean }) {
  const { org, base } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agent(a.agentId);
  const who = a.author === 'human' ? 'You' : agent?.name ?? (a.agentId ? 'An agent' : null);
  return (
    <span className="artifact-origin">
      {withAgent && who ? <span>{who}</span> : null}
      {a.source === 'task' && a.issue ? <Link to={`${base}/issues/${a.issue.number}`} title={a.issue.title}>#{a.issue.number} {a.issue.title}</Link> : null}
      {a.source === 'chat' ? (agent ? <Link to={`${base}/agents/${agent.slug}`}>Chat</Link> : <span>Chat</span>) : null}
      {a.source === 'run' && a.runId ? <Link to={`${base}/runs/${a.runId}`}>Run</Link> : null}
    </span>
  );
}

const Arrow = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d={dir === 'left' ? 'M10 3.5L5.5 8l4.5 4.5' : 'M6 3.5L10.5 8 6 12.5'} stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/**
 * Full-size viewer for one file, inside the dashboard: no download needed.
 * With `files`, ← and → step through the list.
 */
export function ArtifactViewer({ file, files = [], onOpen, onClose }: { file: ViewerFile | null; files?: ViewerFile[]; onOpen?: (f: ViewerFile) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { base } = useOrg();
  const [forced, setForced] = useState<PreviewKind | null>(null);
  useEffect(() => setForced(null), [file?.key]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (file && !d.open) d.showModal();
    if (!file && d.open) d.close();
  }, [file]);

  const at = file ? files.findIndex((f) => f.key === file.key) : -1;
  const step = useCallback((by: number) => {
    if (at < 0 || !onOpen) return;
    const next = files[at + by];
    if (next) onOpen(next);
  }, [at, files, onOpen]);
  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, step]);

  const a = file?.artifact;
  const kind = file ? forced ?? previewKind(file.name, file.contentType) : 'none';
  const canForce = file && kind === 'none' && (file.bytes ?? 0) <= 2 * 1024 * 1024;
  return (
    <dialog ref={ref} className="modal viewer" aria-labelledby={titleId} onClose={onClose} onMouseDown={(e) => { if (e.target === ref.current) onClose(); }}>
      {file ? (
        <div className="modal-inner viewer-inner">
          <header className="viewer-head">
            <TypeBadge name={file.name} contentType={file.contentType} large />
            <div className="viewer-title">
              <h2 id={titleId} className="truncate" title={file.name}>{file.name}</h2>
              <p className="viewer-meta muted">
                {file.bytes != null ? <span>{bytes(file.bytes)}</span> : null}
                {file.modifiedAt ? <time title={dateTime(file.modifiedAt)}>{ago(file.modifiedAt)}</time> : null}
                {a ? <ArtifactOrigin a={a} /> : null}
                {a?.runId && a.source !== 'run' ? <Link to={`${base}/runs/${a.runId}`}>Run transcript</Link> : null}
              </p>
            </div>
            <div className="row viewer-actions">
              {files.length > 1 && at >= 0 ? (
                <span className="row row-tight">
                  <button type="button" className="icon-btn" onClick={() => step(-1)} disabled={at <= 0} aria-label="Previous file" title="Previous (←)"><Arrow dir="left" /></button>
                  <span className="muted nowrap viewer-count">{at + 1} / {files.length}</span>
                  <button type="button" className="icon-btn" onClick={() => step(1)} disabled={at >= files.length - 1} aria-label="Next file" title="Next (→)"><Arrow dir="right" /></button>
                </span>
              ) : null}
              <a className="btn btn-default btn-sm" href={file.viewUrl} target="_blank" rel="noreferrer noopener">Open in new tab</a>
              <a className="btn btn-default btn-sm" href={file.downloadUrl} download={file.name}>Download</a>
              <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" /></svg>
              </button>
            </div>
          </header>
          <div className="viewer-body">
            <Preview key={`${file.key}:${kind}`} file={file} kind={kind} onFallback={canForce ? () => setForced('text') : undefined} />
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/** Compact, clickable file list (chat replies, comments, run pages). Images show a thumbnail. */
export function ArtifactChips({ files, onOpen, onRemove, label = 'Files' }: { files: ViewerFile[]; onOpen: (f: ViewerFile) => void; onRemove?: (f: ViewerFile) => void; label?: string }) {
  if (!files.length) return null;
  return (
    <ul className="artifact-chips" aria-label={label}>
      {files.map((f) => (
        <li key={f.key} className={onRemove ? 'has-remove' : undefined}>
          <button type="button" className="artifact-chip" onClick={() => onOpen(f)} title={`View ${f.name}`}>
            {previewKind(f.name, f.contentType) === 'image'
              ? <img className="artifact-thumb" src={f.viewUrl} alt="" loading="lazy" />
              : <TypeBadge name={f.name} contentType={f.contentType} />}
            <span className="truncate">{f.name}</span>
            {f.bytes != null ? <span className="muted nowrap">{bytes(f.bytes)}</span> : null}
          </button>
          {onRemove ? (
            <button type="button" className="chip-remove chip-remove-float" onClick={() => onRemove(f)} aria-label={`Remove ${f.name}`} title="Remove">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8m0-8l-8 8" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" /></svg>
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Viewer state for a page: which file is open. */
export function useViewer(): { open: ViewerFile | null; show: (f: ViewerFile) => void; close: () => void } {
  const [open, setOpen] = useState<ViewerFile | null>(null);
  return { open, show: setOpen, close: useCallback(() => setOpen(null), []) };
}
