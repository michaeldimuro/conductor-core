import { copyFileSync, constants, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { Comment, Organization } from '../contracts/rows.js';
import { invalid } from '../shared/errors.js';
import { resolveInside } from '../shared/paths.js';
import type { WorkCtx } from './context.js';

type Attachment = Comment['attachments'][number];

/** Larger files stay where they are and are attached by reference only after an explicit decision. */
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

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
