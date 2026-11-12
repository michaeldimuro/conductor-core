import { useCallback, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, ReactNode } from 'react';
import { api, errorText } from '../lib/api.js';
import type { IssueFileDto, StagedUploadDto } from '../lib/api.js';
import { bytes, guessType, type ViewerFile } from '../lib/artifacts.js';
import { k } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';
import { toast } from '../lib/toast.js';
import { ArtifactChips, TypeBadge } from './artifacts.js';
import { Icon } from './icons.js';
import { Button, Load } from './ui.js';

/** Matches the daemon's cap (100 MB): refuse early instead of streaming a body it will reject. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Files that are too large are announced and dropped. */
export function acceptable(files: Iterable<File>): File[] {
  const ok: File[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) toast(`${f.name} is larger than 100 MB and was not attached`, 'error');
    else if (f.size === 0) toast(`${f.name} is empty and was not attached`, 'error');
    else ok.push(f);
  }
  return ok;
}

/** A pasted screenshot has no useful name: give it one. */
const named = (f: File, i: number): File =>
  f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${i ? `-${i + 1}` : ''}.${(f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`, { type: f.type });

/**
 * Drag-and-drop and paste for any area that takes files. Spread `props` on the
 * element; `over` is true while files are dragged above it.
 */
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const props = {
    onDragEnter: (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const files = acceptable(Array.from(e.dataTransfer.files));
      if (files.length) onFiles(files);
    },
    onPaste: (e: ClipboardEvent) => {
      if (disabled) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      const ok = acceptable(files.map(named));
      if (ok.length) onFiles(ok);
    },
  };
  return { over, props };
}

/** A paperclip button that opens the file chooser. */
export function AttachButton({ onFiles, disabled, label = 'Attach files', small = true }: { onFiles: (files: File[]) => void; disabled?: boolean; label?: string; small?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button icon="attachment" small={small} disabled={disabled} onClick={() => input.current?.click()}>{label}</Button>
      <input
        ref={input} type="file" multiple hidden aria-hidden="true" tabIndex={-1}
        onChange={(e) => {
          const files = acceptable(Array.from(e.target.files ?? []));
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** A file picked in the browser, before or while it is uploaded. */
export interface PendingFile {
  key: string;
  file: File;
  state: 'waiting' | 'uploading' | 'ready' | 'failed';
  upload?: StagedUploadDto;
  error?: string;
}

let seq = 0;
export const pending = (file: File): PendingFile => ({ key: `p${++seq}`, file, state: 'waiting' });

/** Chips for files about to be attached, each removable. */
export function PendingChips({ files, onRemove }: { files: PendingFile[]; onRemove: (key: string) => void }) {
  if (!files.length) return null;
  return (
    <ul className="artifact-chips pending-chips" aria-label="Files to attach">
      {files.map((p) => (
        <li key={p.key}>
          <span className={`artifact-chip pending-chip is-${p.state}`} title={p.error ?? p.file.name}>
            {p.state === 'uploading' ? <Icon name="spinner" size={15} className="spin" /> : p.state === 'failed' ? <Icon name="error" size={15} /> : <TypeBadge name={p.file.name} contentType={p.file.type || guessType(p.file.name)} />}
            <span className="truncate">{p.file.name}</span>
            <span className="muted nowrap">{p.state === 'failed' ? 'Failed' : bytes(p.file.size)}</span>
            <button type="button" className="chip-remove" onClick={() => onRemove(p.key)} aria-label={`Remove ${p.file.name}`} title="Remove">
              <Icon name="close" size={13} />
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Staged uploads for a comment being written: each picked file uploads at once
 * (so a failure shows before the comment is sent), and `ready()` lists what
 * the comment should attach.
 */
export function useStagedUploads(orgId: string) {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const patch = (key: string, p: Partial<PendingFile>) => setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...p } : f)));
  const add = useCallback((picked: File[]) => {
    const items = picked.map(pending);
    setFiles((list) => [...list, ...items]);
    for (const item of items) {
      patch(item.key, { state: 'uploading' });
      api.stageUpload(orgId, item.file, item.file.name)
        .then((upload) => patch(item.key, { state: 'ready', upload }))
        .catch((e: unknown) => {
          patch(item.key, { state: 'failed', error: errorText(e) });
          toast(`Could not upload ${item.file.name}: ${errorText(e)}`, 'error');
        });
    }
  }, [orgId]);
  return {
    files,
    add,
    remove: (key: string) => setFiles((list) => list.filter((f) => f.key !== key)),
    clear: () => setFiles([]),
    busy: files.some((f) => f.state === 'uploading' || f.state === 'waiting'),
    ready: () => files.flatMap((f) => (f.state === 'ready' && f.upload ? [{ name: f.upload.name, path: f.upload.path, mime: f.upload.mime }] : [])),
  };
}

const issueFileView = (f: IssueFileDto): ViewerFile => ({
  key: `file:${f.path}`, name: f.name, contentType: f.contentType, viewUrl: f.viewPath, downloadUrl: f.downloadPath, bytes: f.bytes, modifiedAt: f.modifiedAt,
});

/** Upload each file to the task, one after the other; failures are announced, the rest still go up. */
export async function uploadTaskFiles(orgId: string, issueId: string, files: File[]): Promise<number> {
  let done = 0;
  for (const f of files) {
    try {
      await api.addIssueFile(orgId, issueId, f, f.name);
      done += 1;
    } catch (e) {
      toast(`Could not attach ${f.name}: ${errorText(e)}`, 'error');
    }
  }
  return done;
}

/**
 * The files attached to the task itself: view, remove, add more (button, drag
 * and drop, or paste). The assignee sees them every time it works the issue.
 */
export function TaskFiles({ orgId, issueId, onOpen, children }: { orgId: string; issueId: string; onOpen: (f: ViewerFile, list: ViewerFile[]) => void; children?: ReactNode }) {
  const q = useQuery(k(orgId, 'issue-files', issueId), () => api.listIssueFiles(orgId, issueId), { orgId, events: ['artifact.'] });
  const [uploading, setUploading] = useState(0);
  const upload = async (files: File[]) => {
    setUploading((n) => n + files.length);
    try {
      const done = await uploadTaskFiles(orgId, issueId, files);
      if (done) toast(done === 1 ? 'Attached 1 file' : `Attached ${done} files`, 'ok');
    } finally {
      setUploading((n) => n - files.length);
      q.reload();
    }
  };
  const remove = useAction((name: string) => api.removeIssueFile(orgId, issueId, name), { invalidate: [k(orgId, 'issue-files', issueId), k(orgId, 'artifacts')], success: 'Removed the file' });
  const drop = useFileDrop((files) => void upload(files));
  return (
    <div className={`task-files file-drop${drop.over ? ' is-over' : ''}`} {...drop.props}>
      {children}
      <div className="spread">
        <h3>Attached files</h3>
        <AttachButton onFiles={(files) => void upload(files)} disabled={uploading > 0} label={uploading ? 'Uploading…' : 'Attach files'} />
      </div>
      <Load q={q} lines={1} empty={<p className="muted">Drop files or screenshots here, or paste them. The agent gets them with the task.</p>}>
        {(list) => {
          const files = list.map(issueFileView);
          return <ArtifactChips label="Attached files" files={files} onOpen={(f) => onOpen(f, files)} onRemove={(f) => void remove.run(f.name)} />;
        }}
      </Load>
      {drop.over ? <div className="file-drop-hint" aria-hidden="true"><Icon name="upload" size={18} />Drop to attach to this task</div> : null}
    </div>
  );
}
