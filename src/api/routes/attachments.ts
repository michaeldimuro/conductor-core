import { createReadStream, realpathSync, statSync } from 'node:fs';
import { basename, extname, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Services } from '../../daemon/container.js';
import { z } from 'zod';
import type { Comment, Issue, Organization, Run } from '../../contracts/rows.js';
import { forbidden, invalid, notFound } from '../../shared/errors.js';
import { ISSUE_FILES_DIR } from '../../work/uploads.js';
import { orgOf, param, query, resolveIssue, supported } from '../http.js';
import { API_PREFIX, type ArtifactDto, type IssueArtifactDto } from '../types.js';

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.jsonl': 'text/plain; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8', '.tsx': 'text/plain; charset=utf-8', '.js': 'text/plain; charset=utf-8', '.mjs': 'text/plain; charset=utf-8', '.jsx': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8', '.rb': 'text/plain; charset=utf-8', '.go': 'text/plain; charset=utf-8', '.rs': 'text/plain; charset=utf-8', '.java': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8', '.sql': 'text/plain; charset=utf-8', '.css': 'text/plain; charset=utf-8', '.toml': 'text/plain; charset=utf-8', '.ini': 'text/plain; charset=utf-8',
  '.diff': 'text/plain; charset=utf-8', '.patch': 'text/plain; charset=utf-8', '.ics': 'text/plain; charset=utf-8', '.eml': 'text/plain; charset=utf-8',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.mov': 'video/quicktime', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.xml': 'application/xml', '.html': 'text/html; charset=utf-8',
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
export function contentDisposition(name: string, kind: 'attachment' | 'inline' = 'attachment'): string {
  const clean = basename(name.replace(/[\r\n\0]/g, '')).trim() || 'attachment';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * Policy for a file viewed inline in the dashboard. Agent-made content is
 * untrusted: HTML and SVG run in a CSP sandbox (an opaque origin with no
 * access to the session, the API or the console that frames it) and may not
 * open connections; scripts are allowed there so generated reports and charts
 * render. PDFs cannot be sandboxed (browsers refuse to run their viewer in
 * one) and get a policy that loads nothing. Only the console may frame either.
 */
export function inlinePolicy(contentType: string): string {
  if (contentType === 'application/pdf') return "default-src 'none'; frame-ancestors 'self'";
  return [
    'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
    "default-src 'none'",
    "script-src 'unsafe-inline' https:",
    "style-src 'unsafe-inline' https:",
    'img-src data: blob: https:',
    'font-src data: https:',
    'media-src data: blob: https:',
    "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

const wantsInline = (req: { query: unknown }): boolean => {
  const q = req.query as Record<string, unknown> | undefined;
  return q?.inline === '1' || q?.inline === 'true';
};

/**
 * Send one file of an organization as a download. The path is honoured only
 * when, after resolving symlinks, it is a regular file inside `root` (itself
 * inside the organization's own directory); anything else (another org, the
 * rest of the disk, browser profiles) is refused. A download by default;
 * `inline` (the dashboard's viewer) serves it for display under `inlinePolicy`.
 */
function sendConfined(
  s: Services, reply: FastifyReply, org: Organization,
  target: { path: string; name: string; mime?: string; root?: string; inline?: boolean; log: Record<string, unknown> },
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

  const type = attachmentContentType(target.name, file, target.mime);
  reply.header('content-type', type);
  reply.header('content-disposition', contentDisposition(target.name, target.inline ? 'inline' : 'attachment'));
  if (target.inline) {
    reply.header('content-security-policy', inlinePolicy(type));
    reply.header('x-frame-options', 'SAMEORIGIN');
  }
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
    return sendConfined(s, reply, org, {
      path: attachment.path, name: attachment.name, mime: attachment.mime, inline: wantsInline(req), log: { commentId, index: Number(rawIndex) },
    });
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
    const rel = relPath(param(req, '*'));
    const root = s.kernel.paths.artifactDir(org.slug, issue.id);
    return sendConfined(s, reply, org, {
      path: s.kernel.paths.artifactFile(org.slug, issue.id, rel), name: basename(rel), root, inline: wantsInline(req), log: { issueId: issue.id, artifact: rel },
    });
  });

  /** The org-wide artifact store: files from tasks, agent chats and other runs, newest first. */
  app.get('/orgs/:orgId/artifacts', async (req): Promise<ArtifactDto[]> => {
    const org = orgOf(s, req);
    const q = query(req, listArtifactsQuery);
    const issue = q.issueId ? resolveIssue(s, org.id, q.issueId) : null;
    const list = supported(s.work.listArtifacts, 'the artifact store').call(s.work, org.id, {
      issueId: issue?.id, runId: q.runId, search: q.q, limit: q.agentId || q.source ? 2000 : q.limit,
    });
    const rows = describeArtifacts(s, org, list);
    return rows.filter((a) => (!q.agentId || a.agentId === q.agentId) && (!q.source || a.source === q.source)).slice(0, q.limit);
  });

  /** One file of the store by its path relative to the org's artifacts folder (`?inline=1` to view). */
  app.get('/orgs/:orgId/artifacts/files/*', async (req, reply) => {
    const org = orgOf(s, req);
    const rel = relPath(param(req, '*'));
    const root = s.kernel.paths.artifacts(org.slug);
    const [scope, ...rest] = rel.split('/');
    if (!scope || rest.length === 0) throw invalid('invalid artifact path');
    return sendConfined(s, reply, org, {
      path: s.kernel.paths.artifactFile(org.slug, scope, rest.join('/')), name: basename(rel), root, inline: wantsInline(req), log: { artifact: rel },
    });
  });
}

const listArtifactsQuery = z.object({
  issueId: z.string().min(1).max(200).optional(),
  runId: z.string().min(1).max(200).optional(),
  agentId: z.string().min(1).max(200).optional(),
  source: z.enum(['task', 'chat', 'run']).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

/** A wildcard path as relative segments: no empty, `.`, `..` or NUL segments. */
function relPath(rel: string): string {
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw invalid('invalid artifact path');
  return rel;
}

const encodePath = (rel: string): string => rel.split('/').map(encodeURIComponent).join('/');

/** Tag each stored file with the task, run, agent and conversation it belongs to. */
function describeArtifacts(s: Services, org: Organization, list: NonNullable<ReturnType<NonNullable<Services['work']['listArtifacts']>>>): ArtifactDto[] {
  const runs = new Map<string, Run | null>();
  const issues = new Map<string, Issue | null>();
  const comments = new Map<string, Map<string, Comment>>();
  const runOf = (id: string | null): Run | null => {
    if (!id) return null;
    if (!runs.has(id)) {
      try {
        runs.set(id, s.runtime.getRun(org.id, id));
      } catch {
        runs.set(id, null);
      }
    }
    return runs.get(id)!;
  };
  const issueOf = (id: string | null): Issue | null => {
    if (!id) return null;
    if (!issues.has(id)) {
      const found = s.work.findIssue(org.id, id);
      issues.set(id, found && found.orgId === org.id ? found : null);
    }
    return issues.get(id)!;
  };
  const commentOf = (issueId: string | null, id: string | null): Comment | null => {
    if (!issueId || !id) return null;
    if (!comments.has(issueId)) {
      let byId = new Map<string, Comment>();
      try {
        byId = new Map(s.work.listComments(org.id, issueId).map((c) => [c.id, c]));
      } catch {
        // an issue that is gone: the files are still listed
      }
      comments.set(issueId, byId);
    }
    return comments.get(issueId)!.get(id) ?? null;
  };
  const base = `${API_PREFIX}/orgs/${encodeURIComponent(org.id)}/artifacts/files/`;
  return list.map((a) => {
    const comment = commentOf(a.issueId, a.commentId);
    const run = runOf(a.runId ?? comment?.runId ?? null);
    const issue = issueOf(a.issueId ?? run?.issueId ?? null);
    const agentId = run?.agentId ?? (comment?.authorKind === 'agent' ? comment.authorId : null);
    const source: ArtifactDto['source'] = run?.trigger === 'chat' ? 'chat' : issue ? 'task' : 'run';
    const downloadPath = base + encodePath(a.path);
    return {
      name: a.name, path: a.path, bytes: a.bytes, modifiedAt: a.modifiedAt, contentType: attachmentContentType(a.name, a.file, undefined),
      source, issue: issue ? { id: issue.id, number: issue.number, title: issue.title } : null,
      runId: run?.id ?? a.runId, commentId: a.commentId, agentId, trigger: run?.trigger ?? null,
      author: comment ? comment.authorKind : agentId ? 'agent' : a.issueId && a.path.split('/')[1] === ISSUE_FILES_DIR ? 'human' : null,
      downloadPath, viewPath: `${downloadPath}?inline=1`,
    };
  });
}
