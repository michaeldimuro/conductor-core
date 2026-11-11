import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { errorMessage } from '../shared/errors.js';
import type { Call } from './tool-runtime.js';

/** Larger downloads stay in the run workspace only. */
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

export interface SavedArtifact {
  /** File name inside the artifact folder. */
  name: string;
  /** Absolute path under `<org>/artifacts/`: what the agent passes as an attachment `path`. */
  path: string;
  bytes: number;
}

const safeName = (raw: string): string => {
  const cleaned = basename(raw.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'artifact';
};

/**
 * Where a run's browser artifacts go (PRD on-disk layout `orgs/<org>/artifacts/`):
 * `artifacts/<issueId>/<runId>/` for a run working an issue, so they sit next
 * to that issue's comment attachments and outlive the run workspace; a run
 * without an issue uses `artifacts/<runId>/`. Always inside the caller's org.
 */
function artifactPath(c: Call, name: string): string {
  const { paths } = c.env.kernel;
  const org = c.env.org.getOrg(c.ctx.orgId);
  const scope = c.ctx.issueId ?? c.ctx.runId;
  const folder = c.ctx.issueId ? c.ctx.runId : '';
  const clean = safeName(name);
  let file = paths.artifactFile(org.slug, scope, join(folder, clean));
  for (let n = 2; existsSync(file) && n < 10_000; n++) {
    const ext = extname(clean);
    file = paths.artifactFile(org.slug, scope, join(folder, `${clean.slice(0, clean.length - ext.length)}-${n}${ext}`));
  }
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

/**
 * Keep what a browser tool produced (a screenshot, a download) as a run
 * artifact. Best effort: a failure here is logged and never fails the tool
 * call — the agent still has the image / the file in its workspace.
 */
export function saveArtifact(c: Call, name: string, source: { data: Buffer } | { file: string }): SavedArtifact | null {
  try {
    const bytes = 'data' in source ? source.data.length : statSync(source.file).size;
    if (bytes > MAX_ARTIFACT_BYTES) return null;
    const path = artifactPath(c, name);
    if ('data' in source) writeFileSync(path, source.data, { flag: 'wx' });
    else copyFileSync(source.file, path);
    c.env.kernel.audit.record({
      orgId: c.ctx.orgId, actor: { kind: 'agent', id: c.ctx.agentId, runId: c.ctx.runId }, action: 'artifact.saved', entityKind: 'issue',
      entityId: c.ctx.issueId ?? c.ctx.runId, runId: c.ctx.runId, issueId: c.ctx.issueId ?? undefined,
      data: { name: basename(path), bytes, source: 'conductor-browser' },
    });
    return { name: basename(path), path, bytes };
  } catch (e) {
    c.env.kernel.log.warn({ err: errorMessage(e), runId: c.ctx.runId }, 'could not save a browser artifact');
    return null;
  }
}

/** `screenshot-20260314-101502-example.com.png` */
export function screenshotName(now: number, host: string | null, format: 'png' | 'jpeg'): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `screenshot-${stamp}${host ? `-${host}` : ''}.${format === 'png' ? 'png' : 'jpg'}`;
}

export const ATTACH_HINT = 'To include it in your result, pass it to your comment / report as an attachment: { name, path }.';
