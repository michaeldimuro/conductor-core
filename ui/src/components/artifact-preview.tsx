import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Markdown } from './markdown.js';
import { Loading, Segmented } from './ui.js';
import { TEXT_LIMIT, bytes, fetchBytes, fetchText, parseCsv, previewKind, type PreviewKind, type ViewerFile } from '../lib/artifacts.js';
import type { DocBlock, Sheet } from '../lib/ooxml.js';

/** Office files above this are a download only (they are read whole, in the browser). */
const OFFICE_LIMIT = 40 * 1024 * 1024;
const MAX_TABLE_ROWS = 2000;

type Loaded<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T };

/** Load something for the file, cancelled when the file changes or the viewer closes. */
function useLoad<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
  const [out, setOut] = useState<Loaded<T>>({ state: 'loading' });
  useEffect(() => {
    const ctl = new AbortController();
    setOut({ state: 'loading' });
    load(ctl.signal).then(
      (value) => { if (!ctl.signal.aborted) setOut({ state: 'ready', value }); },
      (e: unknown) => { if (!ctl.signal.aborted) setOut({ state: 'error', message: e instanceof Error ? e.message : String(e) }); },
    );
    return () => ctl.abort();
  }, [key]);
  return out;
}

function Pending<T>({ q, children, label }: { q: Loaded<T>; children: (v: T) => ReactNode; label: string }) {
  if (q.state === 'loading') return <div className="viewer-pad"><Loading lines={6} label={label} /></div>;
  if (q.state === 'error') return <NoPreview reason={q.message} />;
  return <>{children(q.value)}</>;
}

export function NoPreview({ reason, children }: { reason: string; children?: ReactNode }) {
  return (
    <div className="viewer-empty">
      <p>{reason}</p>
      {children}
    </div>
  );
}

const Truncated = ({ on }: { on: boolean }) => (on ? <p className="note note-warn viewer-note">Showing the first {bytes(TEXT_LIMIT)}. Download the file for the rest.</p> : null);

function CodeView({ text }: { text: string }) {
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text]);
  return (
    <pre className="viewer-code" tabIndex={0}>
      <code>{lines.map((l, i) => <span key={i} className="code-line"><span className="code-no" aria-hidden="true">{i + 1}</span>{l || ' '}{'\n'}</span>)}</code>
    </pre>
  );
}

function Table({ rows, header = true }: { rows: string[][]; header?: boolean }) {
  if (!rows.length) return <NoPreview reason="The table is empty." />;
  const [head, ...body] = header ? rows : [[], ...rows];
  const shown = body.slice(0, MAX_TABLE_ROWS);
  return (
    <div className="viewer-table-wrap" tabIndex={0}>
      <table className="viewer-table">
        {header && head?.length ? <thead><tr><th className="row-no" aria-label="Row" />{head.map((c, i) => <th key={i}>{c}</th>)}</tr></thead> : null}
        <tbody>{shown.map((r, i) => <tr key={i}><td className="row-no">{i + 1}</td>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
      {body.length > shown.length ? <p className="muted viewer-pad">Showing {shown.length} of {body.length} rows.</p> : null}
    </div>
  );
}

function TextPreview({ file, kind }: { file: ViewerFile; kind: 'markdown' | 'csv' | 'json' | 'text' }) {
  const q = useLoad(file.viewUrl, (signal) => fetchText(file.viewUrl, signal));
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  return (
    <Pending q={q} label="Loading the file">
      {({ text, truncated }) => {
        let body: ReactNode;
        if (kind === 'text' || mode === 'source') body = <CodeView text={text} />;
        else if (kind === 'markdown') body = <div className="viewer-doc"><Markdown text={text} /></div>;
        else if (kind === 'csv') body = <Table rows={parseCsv(text)} />;
        else {
          let pretty = text;
          try {
            pretty = JSON.stringify(JSON.parse(text), null, 2);
          } catch {
            // not valid JSON (or truncated): show as is
          }
          body = <CodeView text={pretty} />;
        }
        return (
          <div className="viewer-stack">
            {kind !== 'text' ? (
              <div className="viewer-bar"><Segmented small label="Display" value={mode} onChange={setMode} options={[{ value: 'rendered', label: kind === 'json' ? 'Formatted' : kind === 'csv' ? 'Table' : 'Rendered' }, { value: 'source', label: 'Source' }]} /></div>
            ) : null}
            <Truncated on={truncated} />
            {body}
          </div>
        );
      }}
    </Pending>
  );
}

function HtmlPreview({ file }: { file: ViewerFile }) {
  const [mode, setMode] = useState<'page' | 'source'>('page');
  return (
    <div className="viewer-stack viewer-fill">
      <div className="viewer-bar">
        <Segmented small label="Display" value={mode} onChange={setMode} options={[{ value: 'page', label: 'Page' }, { value: 'source', label: 'Source' }]} />
        <span className="muted">Runs in a sandbox, without access to Conductor.</span>
      </div>
      {mode === 'page'
        ? <iframe className="viewer-frame viewer-frame-page" title={file.name} src={file.viewUrl} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />
        : <TextPreview file={file} kind="text" />}
    </div>
  );
}

function DocxView({ blocks }: { blocks: DocBlock[] }) {
  if (!blocks.some((b) => b.type === 'table' || b.runs.length)) return <NoPreview reason="This document has no text to show." />;
  const runs = (b: Extract<DocBlock, { type: 'p' }>) => b.runs.map((r, i) => {
    let node: ReactNode = r.text;
    if (r.italic) node = <em>{node}</em>;
    if (r.bold) node = <strong>{node}</strong>;
    return <span key={i}>{node}</span>;
  });
  return (
    <article className="viewer-doc viewer-page">
      {blocks.map((b, i) => {
        if (b.type === 'table') return <Table key={i} rows={b.rows} header={false} />;
        if (!b.runs.length) return <br key={i} />;
        if (b.heading) {
          const H = (`h${Math.min(b.heading + 1, 6)}`) as 'h2';
          return <H key={i}>{runs(b)}</H>;
        }
        return b.list ? <p key={i} className="doc-li">{runs(b)}</p> : <p key={i}>{runs(b)}</p>;
      })}
    </article>
  );
}

function SheetsView({ sheets }: { sheets: Sheet[] }) {
  const [at, setAt] = useState(0);
  const sheet = sheets[at] ?? sheets[0]!;
  return (
    <div className="viewer-stack">
      {sheets.length > 1 ? (
        <div className="viewer-bar viewer-tabs" role="tablist" aria-label="Sheets">
          {sheets.map((s, i) => <button key={i} type="button" role="tab" aria-selected={i === at} className={i === at ? 'on' : ''} onClick={() => setAt(i)}>{s.name}</button>)}
        </div>
      ) : null}
      {sheet.truncated ? <p className="note note-warn viewer-note">Large sheet: showing the first rows and columns only.</p> : null}
      <Table rows={sheet.rows} />
    </div>
  );
}

function SlidesView({ slides }: { slides: string[][] }) {
  return (
    <ol className="viewer-slides">
      {slides.map((lines, i) => (
        <li key={i} className="viewer-slide">
          <span className="viewer-slide-no">Slide {i + 1}</span>
          {lines.length ? lines.map((l, j) => (j === 0 ? <h3 key={j}>{l}</h3> : <p key={j}>{l}</p>)) : <p className="muted">No text on this slide.</p>}
        </li>
      ))}
    </ol>
  );
}

function OfficePreview({ file, kind }: { file: ViewerFile; kind: 'docx' | 'xlsx' | 'pptx' }) {
  const q = useLoad(file.viewUrl, async (signal) => {
    const { data, truncated } = await fetchBytes(file.viewUrl, OFFICE_LIMIT, signal);
    if (truncated) throw new Error(`This file is too large to preview (over ${bytes(OFFICE_LIMIT)}).`);
    const ooxml = await import('../lib/ooxml.js');
    if (kind === 'docx') return { kind, blocks: await ooxml.readDocx(data) } as const;
    if (kind === 'xlsx') return { kind, sheets: await ooxml.readXlsx(data) } as const;
    return { kind, slides: await ooxml.readPptx(data) } as const;
  });
  return (
    <Pending q={q} label="Reading the document">
      {(v) => (
        <div className="viewer-stack">
          <p className="muted viewer-note">Text preview: layout, images and formatting may differ from the original.</p>
          {v.kind === 'docx' ? <DocxView blocks={v.blocks} /> : v.kind === 'xlsx' ? <SheetsView sheets={v.sheets} /> : <SlidesView slides={v.slides} />}
        </div>
      )}
    </Pending>
  );
}

/** The file itself, shown inside the dashboard. */
export function Preview({ file, kind = previewKind(file.name, file.contentType), onFallback }: { file: ViewerFile; kind?: PreviewKind; onFallback?: () => void }) {
  switch (kind) {
    case 'image':
      return <div className="viewer-media"><img src={file.viewUrl} alt={file.name} /></div>;
    case 'pdf':
      return <iframe className="viewer-frame" title={file.name} src={file.viewUrl} />;
    case 'html':
      return <HtmlPreview file={file} />;
    case 'audio':
      return <div className="viewer-media viewer-pad"><audio controls src={file.viewUrl} preload="metadata">Your browser cannot play this audio.</audio></div>;
    case 'video':
      return <div className="viewer-media"><video controls src={file.viewUrl} preload="metadata">Your browser cannot play this video.</video></div>;
    case 'markdown': case 'csv': case 'json': case 'text':
      return <TextPreview key={kind} file={file} kind={kind} />;
    case 'docx': case 'xlsx': case 'pptx':
      return <OfficePreview file={file} kind={kind} />;
    default:
      return (
        <NoPreview reason="There is no preview for this type of file.">
          {onFallback ? <button type="button" className="btn btn-default btn-sm" onClick={onFallback}>Try to show it as text</button> : null}
        </NoPreview>
      );
  }
}
