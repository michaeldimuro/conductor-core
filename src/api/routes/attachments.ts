import { createReadStream, realpathSync, statSync } from 'node:fs';
import { basename, extname, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Services } from '../../daemon/container.js';
import type { Organization } from '../../contracts/rows.js';
import { forbidden, invalid, notFound } from '../../shared/errors.js';
import { orgOf, param, resolveIssue, supported } from '../http.js';
import { API_PREFIX, type IssueArtifactDto } from '../types.js';

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.xml': 'application/xml', '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(?:; ?charset=[A-Za-z0-9_-]{1,40})?$/;
/** Never downloadable, wherever a comment points: browser state and vault material are credentials. */
const PRIVATE_SEGMENTS = new Set(['browser-profiles']);

/** The declared type when it is well-formed, else by file extension, else opaque bytes. */
export function attachmentContentType(name: string, path: string, declared: string | undefined): string {
  if (declared && MIME_RE.test(declared)) return declared;
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** RFC 6266: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(name: string): string {
  const clean = basename(name.replace(/[\r\n\0]/g, '')).trim() || 'attachment';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * Send one file of an organization as a download. The path is honoured only
 * when, after resolving symlinks, it is a regular file inside `root` (itself
 * inside the organization's own directory); anything else (another org, the
 * rest of the disk, browser profiles) is refused. Never rendered inline.
 */
function sendConfined(
  s: Services, reply: FastifyReply, org: Organization,
  target: { path: string; name: string; mime?: string; root?: string; log: Record<string, unknown> },
): FastifyReply {
  let root: string;
  let file: string;
  try {
    root = realpathSync(target.root ?? s.kernel.paths.org(org.slug));
    file = realpathSync(target.path);
  } catch {
    throw notFound('attachment file');
  }
  const orgRoot = realpathSync(s.kernel.paths.org(org.slug));
  const inside = file.startsWith(root + sep) && file.startsWith(orgRoot + sep);
  if (!inside || file.slice(orgRoot.length + 1).split(sep).some((seg) => PRIVATE_SEGMENTS.has(seg))) {
    s.kernel.log.warn({ orgId: org.id, ...target.log }, 'refused an attachment outside the organization directory');
    throw forbidden('this attachment is stored outside the organization\'s directory and cannot be downloaded');
  }
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw notFound('attachment file');

  reply.header('content-type', attachmentContentType(target.name, file, target.mime));
  reply.header('content-disposition', contentDisposition(target.name));
  reply.header('content-length', stat.size);
  reply.header('cache-control', 'private, no-store');
  return reply.send(createReadStream(file));
}

/**
 * Downloads of comment attachments and of an issue's run artifacts (browser
 * screenshots and downloads kept under `orgs/<org>/artifacts/<issue>/`), plus
 * the artifact listing. Every file goes through `sendConfined`.
 */
export function attachmentRoutes(app: FastifyInstance, s: Services): void {
  app.get('/orgs/:orgId/issues/:issueId/comments/:commentId/attachments/:index', async (req, reply) => {
    const org = orgOf(s, req);
    const issue = resolveIssue(s, org.id, param(req, 'issueId'));
    const commentId = param(req, 'commentId');
    const rawIndex = param(req, 'index');
    if (!/^\d{1,3}$/.test(rawIndex)) throw invalid('attachment index must be a small non-negative integer');
    const comment = s.work.listComments(org.id, issue.id).find((c) => c.id === commentId);
    if (!comment || comment.orgId !== org.id) throw notFound('comment', commentId);
    const attachment = comment.attachments[Number(rawIndex)];
    if (!attachment) throw notFound('attachment', rawIndex);
    return sendConfined(s, reply, org, { path: attachment.path, name: attachment.name, mime: attachment.mime, log: { commentId, index: Number(rawIndex) } });
  });

  /** Everything stored for the issue: comment attachments and what its runs saved. Newest first. */
  app.get('/orgs/:orgId/issues/:issueId/artifacts', async (req): Promise<IssueArtifactDto[]> => {
    const org = orgOf(s, req);
    const issue = resolveIssue(s, org.id, param(req, 'issueId'));
    const list = supported(s.work.listIssueArtifacts, 'listing issue artifacts').call(s.work, org.id, issue.id);
    const base = `${API_PREFIX}/orgs/${encodeURIComponent(org.id)}/issues/${encodeURIComponent(issue.id)}/artifacts/`;
    return list.map((a) => ({
      ...a, contentType: attachmentContentType(a.name, a.file, undefined), downloadPath: base + a.path.split('/').map(encodeURIComponent).join('/'),
    }));
  });

  /** Download one artifact by its path relative to the issue's artifact folder. */
  app.get('/orgs/:orgId/issues/:issueId/artifacts/*', async (req, reply) => {
    const org = orgOf(s, req);
    const issue = resolveIssue(s, org.id, param(req, 'issueId'));
    const rel = param(req, '*');
    if (rel.includes('\0') || rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw invalid('invalid artifact path');
    const root = s.kernel.paths.artifactDir(org.slug, issue.id);
    return sendConfined(s, reply, org, { path: s.kernel.paths.artifactFile(org.slug, issue.id, rel), name: basename(rel), root, log: { issueId: issue.id, artifact: rel } });
  });
}
