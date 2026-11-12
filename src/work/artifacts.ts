import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { ArtifactFilter, IssueArtifact, OrgArtifact } from '../contracts/org-work.js';
import type { Comment, Organization } from '../contracts/rows.js';
import { invalid } from '../shared/errors.js';
import { ID_PREFIX } from '../shared/ids.js';
import { resolveInside, type ConductorPaths } from '../shared/paths.js';
import type { WorkCtx } from './context.js';

type Attachment = Comment['attachments'][number];

/** Larger files stay where they are and are attached by reference only after an explicit decision. */
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

/** A destination in `dir` for `rawName` that does not exist yet (a clash gets a `-2`, `-3`… suffix). */
export function freeArtifactPath(dir: string, rawName: string): string {
  const clean = safeArtifactName(rawName);
  const ext = extname(clean);
  let dest = resolveInside(dir, clean);
  for (let n = 2; existsSync(dest); n++) {
    if (n > 9_999) throw invalid('too many artifacts with this name');
    dest = resolveInside(dir, `${clean.slice(0, clean.length - ext.length)}-${n}${ext}`);
  }
  return dest;
}

/** A file name that is one safe path segment: no separators, no leading dot, bounded length. */
export function safeArtifactName(raw: string): string {
  const base = basename(raw.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[.\s]+/, '').trim();
  return (base || 'artifact').slice(0, 200);
}

export interface StoredAttachments {
  attachments: Attachment[];
  /** Remove what was copied (the comment was not written after all). */
  discard(): void;
}

/**
 * PRD on-disk layout: `orgs/<org>/artifacts/`. An attachment whose path is an
 * existing regular file is copied to `artifacts/<issueId>/<commentId>/<name>`
 * and the comment stores that path, so the artifact outlives the run workspace
 * that produced it. The destination is always confined to the org's artifacts
 * directory. Paths that do not name a file on this machine (and files already
 * inside the artifacts directory) are kept as plain references.
 *
 * Which *source* files an agent may attach is decided at the tool boundary
 * (`sanitizeArtifacts`: run workspace or org directory only); this function
 * additionally refuses symlinks and anything that is not a regular file.
 */
export function storeAttachments(
  ctx: WorkCtx,
  org: Organization,
  issueId: string,
  commentId: string,
  attachments: Attachment[],
): StoredAttachments {
  if (attachments.length === 0) return { attachments: [], discard: () => {} };
  const root = ctx.kernel.paths.artifacts(org.slug);
  const dir = resolveInside(root, join(issueId, commentId));
  const used = new Set<string>();
  let created = false;

  const discard = (): void => {
    if (created) rmSync(dir, { recursive: true, force: true });
  };
  const store = (a: Attachment): Attachment => {
    if (!isAbsolute(a.path)) return a;
    const source = resolve(a.path);
    if (source === root || source.startsWith(root + sep)) return { ...a, path: source };
    const stat = lstatSync(source, { throwIfNoEntry: false });
    if (!stat) return a;
    if (stat.isSymbolicLink()) throw invalid(`attachment "${a.name}" is a symbolic link; attach the file itself`);
    if (!stat.isFile()) return a;
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw invalid(`attachment "${a.name}" is larger than ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MB`);
    }

    let name = safeArtifactName(a.name);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${n}-${safeArtifactName(a.name)}`;
    used.add(name.toLowerCase());
    if (!created) {
      mkdirSync(dir, { recursive: true });
      created = true;
    }
    const dest = resolveInside(dir, name);
    copyFileSync(source, dest, constants.COPYFILE_EXCL);
    return { ...a, path: dest };
  };

  try {
    return { attachments: attachments.map(store), discard };
  } catch (e) {
    // One bad attachment refuses the whole comment: leave nothing half-copied.
    discard();
    throw e;
  }
}

const MAX_LISTED_ARTIFACTS = 2000;
const MAX_ARTIFACT_DEPTH = 6;

/**
 * Every regular file under `orgs/<org>/artifacts/<issueId>/`, newest first:
 * `<commentId>/…` are comment attachments, `<runId>/…` what a run's tools saved
 * (browser screenshots and downloads). Symlinks are never followed or listed.
 */
export function listIssueArtifacts(ctx: WorkCtx, org: Organization, issueId: string): IssueArtifact[] {
  const root = ctx.kernel.paths.artifactDir(org.slug, issueId);
  const out: IssueArtifact[] = [];
  const walk = (dir: string, rel: string[], depth: number): void => {
    if (depth > MAX_ARTIFACT_DEPTH || out.length >= MAX_LISTED_ARTIFACTS) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no artifacts yet
    }
    for (const entry of entries) {
      if (out.length >= MAX_LISTED_ARTIFACTS) return;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file, [...rel, entry.name], depth + 1);
      else if (entry.isFile()) {
        const stat = lstatSync(file, { throwIfNoEntry: false });
        if (!stat?.isFile()) continue;
        const top = rel[0] ?? '';
        const origin = top.startsWith(`${ID_PREFIX.run}_`) ? 'run' : top.startsWith(`${ID_PREFIX.comment}_`) ? 'comment' : 'other';
        out.push({
          name: entry.name, path: [...rel, entry.name].join('/'), file, bytes: stat.size, modifiedAt: Math.round(stat.mtimeMs),
          origin, originId: origin === 'other' ? null : top,
        });
      }
    }
  };
  walk(root, [], 0);
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
}

const MAX_ORG_SCAN = 20_000;
const isId = (seg: string | undefined, kind: keyof typeof ID_PREFIX): boolean => !!seg && seg.startsWith(`${ID_PREFIX[kind]}_`);

/**
 * The org-wide artifact store: every regular file under `orgs/<org>/artifacts/`,
 * newest first, each tagged with the issue / run / comment its folder names.
 * Symlinks are never followed or listed. `issueId` narrows the walk to that
 * issue's folder; other filters apply to the result.
 */
export function listOrgArtifacts(ctx: WorkCtx, org: Organization, filter: ArtifactFilter = {}): OrgArtifact[] {
  const root = ctx.kernel.paths.artifacts(org.slug);
  const start = filter.issueId ? [filter.issueId] : [];
  const out: OrgArtifact[] = [];
  let scanned = 0;
  const walk = (dir: string, rel: string[]): void => {
    if (rel.length > MAX_ARTIFACT_DEPTH + 1 || scanned >= MAX_ORG_SCAN) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++scanned >= MAX_ORG_SCAN) return;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file, [...rel, entry.name]);
      else if (entry.isFile() && rel.length > 0) {
        const stat = lstatSync(file, { throwIfNoEntry: false });
        if (!stat?.isFile()) continue;
        const [top, second] = rel;
        const issueId = isId(top, 'issue') ? top! : null;
        const runId = isId(top, 'run') ? top! : issueId && isId(second, 'run') ? second! : null;
        const commentId = issueId && isId(second, 'comment') ? second! : null;
        out.push({ name: entry.name, path: [...rel, entry.name].join('/'), file, bytes: stat.size, modifiedAt: Math.round(stat.mtimeMs), issueId, runId, commentId });
      }
    }
  };
  walk(start.length ? ctx.kernel.paths.artifactDir(org.slug, start[0]!) : root, start);
  const needle = filter.search?.trim().toLowerCase();
  const rows = out.filter((a) => (!filter.runId || a.runId === filter.runId) && (!needle || a.name.toLowerCase().includes(needle)));
  rows.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  return rows.slice(0, Math.min(Math.max(filter.limit ?? 500, 1), MAX_LISTED_ARTIFACTS));
}

export interface PublishedArtifact {
  name: string;
  /** Absolute path of the stored copy (what an attachment `path` may point at). */
  file: string;
  /** Path relative to the org's artifacts folder. */
  path: string;
  bytes: number;
}

/**
 * Copy one file a run produced into the org's artifact store:
 * `artifacts/<issue>/<run>/<name>` for a run working an issue, else
 * `artifacts/<run>/<name>` (chat turns and other runs without an issue).
 * Refuses symlinks, non-files and anything over the size cap; never
 * overwrites (a clash gets a `-2`, `-3`… suffix).
 */
export function publishRunArtifact(
  paths: ConductorPaths, orgSlug: string, scope: { issueId: string | null; runId: string }, source: string, rawName: string,
): PublishedArtifact {
  const stat = lstatSync(source, { throwIfNoEntry: false });
  if (!stat) throw invalid(`file not found: ${source}`);
  if (stat.isSymbolicLink()) throw invalid('the path is a symbolic link; save the file itself');
  if (!stat.isFile()) throw invalid('the path is not a regular file');
  if (stat.size > MAX_ARTIFACT_BYTES) throw invalid(`the file is larger than ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MB`);
  const dir = scope.issueId ? paths.artifactFile(orgSlug, scope.issueId, scope.runId) : paths.artifactDir(orgSlug, scope.runId);
  const dest = freeArtifactPath(dir, rawName);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(realpathSync(source), dest, constants.COPYFILE_EXCL);
  const root = paths.artifacts(orgSlug);
  return { name: basename(dest), file: dest, path: dest.slice(root.length + 1).split(sep).join('/'), bytes: stat.size };
}
