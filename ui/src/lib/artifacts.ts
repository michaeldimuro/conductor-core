import type { ArtifactDto } from './api.js';

/** How the dashboard shows a file. */
export type PreviewKind =
  | 'image' | 'pdf' | 'html' | 'audio' | 'video' | 'markdown' | 'csv' | 'json' | 'text'
  | 'docx' | 'xlsx' | 'pptx' | 'none';

/** Anything the viewer can open: a store artifact or a comment attachment. */
export interface ViewerFile {
  key: string;
  name: string;
  contentType: string;
  /** Served for display (sandboxed by the daemon). */
  viewUrl: string;
  downloadUrl: string;
  bytes?: number;
  modifiedAt?: number;
  artifact?: ArtifactDto;
}

const EXT_TYPE: Record<string, string> = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', jsonl: 'text/plain', yaml: 'application/yaml', yml: 'application/yaml', xml: 'application/xml', html: 'text/html', htm: 'text/html',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Source code and config: shown as text whatever type the server sends. */
const TEXT_EXT = new Set([
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'bash', 'zsh',
  'sql', 'css', 'scss', 'toml', 'ini', 'cfg', 'conf', 'env', 'diff', 'patch', 'ics', 'eml', 'srt', 'vtt', 'tex', 'r', 'lua', 'pl', 'dockerfile', 'makefile',
]);

export const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : name.toLowerCase();
};

export const guessType = (name: string, declared?: string): string => declared || EXT_TYPE[extOf(name)] || 'application/octet-stream';

export function previewKind(name: string, contentType: string): PreviewKind {
  const ext = extOf(name);
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (ext === 'md' || ext === 'markdown' || type === 'text/markdown') return 'markdown';
  if (ext === 'csv' || ext === 'tsv' || type === 'text/csv' || type === 'text/tab-separated-values') return 'csv';
  if (ext === 'json' || type === 'application/json') return 'json';
  if (ext === 'html' || ext === 'htm' || type === 'text/html') return 'html';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'pptx') return 'pptx';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('text/') || TEXT_EXT.has(ext) || /(\+json|\+xml|\/xml|\/yaml|\/javascript)$/.test(type)) return 'text';
  return 'none';
}

export type KindGroup = 'docs' | 'images' | 'data' | 'web' | 'media' | 'other';
export const KIND_GROUP: Record<PreviewKind, KindGroup> = {
  markdown: 'docs', docx: 'docs', pdf: 'docs', pptx: 'docs', text: 'docs',
  image: 'images', csv: 'data', json: 'data', xlsx: 'data', html: 'web', audio: 'media', video: 'media', none: 'other',
};

/** Short label for the file-type badge. */
export function typeLabel(name: string, kind: PreviewKind): string {
  const ext = extOf(name);
  if (ext && ext.length <= 5 && ext !== name.toLowerCase()) return ext.toUpperCase();
  return kind === 'none' ? 'FILE' : kind.toUpperCase();
}

export function bytes(n: number | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export const fromArtifact = (a: ArtifactDto): ViewerFile => ({
  key: a.path, name: a.name, contentType: a.contentType, viewUrl: a.viewPath, downloadUrl: a.downloadPath, bytes: a.bytes, modifiedAt: a.modifiedAt, artifact: a,
});

/** Text previews stop here; the rest is a download. */
export const TEXT_LIMIT = 2 * 1024 * 1024;

/** Fetch at most `limit` bytes of a file (same-origin, session cookie). */
export async function fetchBytes(url: string, limit: number, signal?: AbortSignal): Promise<{ data: Uint8Array; truncated: boolean }> {
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(res.status === 404 ? 'The file is no longer there.' : `Could not load the file (HTTP ${res.status}).`);
  if (!res.body) return { data: new Uint8Array(await res.arrayBuffer()), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > limit) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const out = new Uint8Array(Math.min(size, limit));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - at);
    out.set(c.subarray(0, take), at);
    at += take;
    if (at >= out.length) break;
  }
  return { data: out, truncated };
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const { data, truncated } = await fetchBytes(url, TEXT_LIMIT, signal);
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(data), truncated };
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF; delimiter `,` or tab. */
export function parseCsv(text: string, delimiter = text.split('\n', 1)[0]!.includes('\t') && !text.split('\n', 1)[0]!.includes(',') ? '\t' : ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
