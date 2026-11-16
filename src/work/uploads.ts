import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { ulid } from 'ulid';
import type { IssueFile } from '../contracts/org-work.js';
import { invalid, notFound } from '../shared/errors.js';
import { resolveInside, type ConductorPaths } from '../shared/paths.js';
import { MAX_ARTIFACT_BYTES, freeArtifactPath, safeArtifactName } from './artifacts.js';

/**
 * Files the owner uploads from the dashboard.
 *
 * - **Task files** are attached to the issue itself and live in
 *   `artifacts/<issue>/files/`, next to everything else stored for the issue.
 * - **Staged uploads** wait in `uploads/<id>/<name>` until a comment that
 *   attaches them is written; `addComment` then copies them into
 *   `artifacts/<issue>/<comment>/` like any other attachment, and the staged
 *   copy is discarded. Abandoned uploads are pruned after a day.
 */

/** Sub-folder of an issue's artifact folder that holds the files attached to the task itself. */
export const ISSUE_FILES_DIR = 'files';
export const MAX_UPLOAD_BYTES = MAX_ARTIFACT_BYTES;
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const STAGED_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface StagedUpload {
  id: string;
  name: string;
  /** Absolute path of the staged file: what a comment attachment's `path` names. */
  path: string;
  bytes: number;
}

function checkSize(data: Buffer): void {
  if (data.length === 0) throw invalid('the file is empty');
  if (data.length > MAX_UPLOAD_BYTES) throw invalid(`the file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`);
}

/** Store an upload that a comment will attach. Also prunes staged uploads older than a day. */
export function stageUpload(paths: ConductorPaths, orgSlug: string, rawName: string, data: Buffer, now = Date.now()): StagedUpload {
  checkSize(data);
  pruneStagedUploads(paths, orgSlug, now);
  const id = ulid(now);
  const name = safeArtifactName(rawName);
  const file = resolveInside(resolveInside(paths.uploads(orgSlug), id), name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data, { flag: 'wx' });
  return { id, name, path: file, bytes: data.length };
}

/** The staged upload folder `path` lies in, or null when it is not a staged upload of this org. */
export function stagedUploadDir(paths: ConductorPaths, orgSlug: string, path: string): string | null {
  const root = paths.uploads(orgSlug);
  if (!path.startsWith(root + sep)) return null;
  const id = path.slice(root.length + 1).split(sep)[0] ?? '';
  return STAGED_ID.test(id) ? join(root, id) : null;
}

/** Remove a staged upload once a comment holds its own copy. */
export function discardStagedUpload(paths: ConductorPaths, orgSlug: string, path: string): void {
  const dir = stagedUploadDir(paths, orgSlug, path);
  if (dir) rmSync(dir, { recursive: true, force: true });
}

export function pruneStagedUploads(paths: ConductorPaths, orgSlug: string, now = Date.now()): void {
  const root = paths.uploads(orgSlug);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const id of entries) {
    if (!STAGED_ID.test(id)) continue;
    const stat = lstatSync(join(root, id), { throwIfNoEntry: false });
    if (stat && now - stat.mtimeMs > STAGED_TTL_MS) rmSync(join(root, id), { recursive: true, force: true });
  }
}

const filesDir = (paths: ConductorPaths, orgSlug: string, issueId: string): string => paths.artifactFile(orgSlug, issueId, ISSUE_FILES_DIR);

function describe(paths: ConductorPaths, orgSlug: string, file: string): IssueFile {
  const stat = lstatSync(file);
  const root = paths.artifacts(orgSlug);
  return {
    name: basename(file), file, path: file.slice(root.length + 1).split(sep).join('/'), bytes: stat.size, modifiedAt: Math.round(stat.mtimeMs),
  };
}

/** Attach a file to the task itself. Never overwrites: a clash gets a `-2`, `-3`… suffix. */
export function addIssueFile(paths: ConductorPaths, orgSlug: string, issueId: string, rawName: string, data: Buffer): IssueFile {
  checkSize(data);
  const dir = filesDir(paths, orgSlug, issueId);
  mkdirSync(dir, { recursive: true });
  const dest = freeArtifactPath(dir, rawName);
  writeFileSync(dest, data, { flag: 'wx' });
  return describe(paths, orgSlug, dest);
}

/** The files attached to the task, oldest first (the order they were added). Symlinks are never listed. */
export function listIssueFiles(paths: ConductorPaths, orgSlug: string, issueId: string): IssueFile[] {
  const dir = filesDir(paths, orgSlug, issueId);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  // Order of attachment: nanosecond mtime (two files saved in the same millisecond still order), then a
  // clash copy (`name-2.ext`) after its original, then the name.
  return entries
    .filter((e) => e.isFile())
    .map((e) => ({ file: describe(paths, orgSlug, join(dir, e.name)), ns: lstatSync(join(dir, e.name), { bigint: true }).mtimeNs, copy: copyOf(e.name) }))
    .sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0) || a.copy.stem.localeCompare(b.copy.stem) || a.copy.n - b.copy.n || a.file.name.localeCompare(b.file.name))
    .map((x) => x.file);
}

/** `report-2.pdf` → { stem: 'report.pdf', n: 2 }; an original is copy 1. */
function copyOf(name: string): { stem: string; n: number } {
  const m = /^(.*)-(\d+)(\.[^.]*)?$/.exec(name);
  return m && Number(m[2]) >= 2 ? { stem: `${m[1]}${m[3] ?? ''}`, n: Number(m[2]) } : { stem: name, n: 1 };
}

/** Detach (delete) one task file by name. */
export function removeIssueFile(paths: ConductorPaths, orgSlug: string, issueId: string, name: string): IssueFile {
  if (name !== safeArtifactName(name)) throw notFound('task file', name);
  const dir = filesDir(paths, orgSlug, issueId);
  const file = resolveInside(dir, name);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw notFound('task file', name);
  const gone = describe(paths, orgSlug, file);
  rmSync(file);
  return gone;
}

/** True when `path` (after resolving symlinks) is a regular file inside `root`. */
export function isFileInside(path: string, root: string): boolean {
  try {
    const real = realpathSync(path);
    return real.startsWith(realpathSync(root) + sep) && lstatSync(real).isFile();
  } catch {
    return false;
  }
}
