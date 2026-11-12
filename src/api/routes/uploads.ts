import { isAbsolute, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../daemon/container.js';
import type { IssueFile } from '../../contracts/org-work.js';
import type { Comment, Organization } from '../../contracts/rows.js';
import { OWNER } from '../../contracts/types.js';
import { invalid } from '../../shared/errors.js';
import { ISSUE_FILES_DIR, MAX_UPLOAD_BYTES, discardStagedUpload, isFileInside, stageUpload } from '../../work/uploads.js';
import { orgOf, param, query, resolveIssue, supported } from '../http.js';
import { API_PREFIX, type IssueFileDto, type Ok, type StagedUploadDto } from '../types.js';
import { attachmentContentType } from './attachments.js';

const RAW = 'application/octet-stream';
/** Never attachable from the API: browser state is credentials. */
const PRIVATE_SEGMENTS = new Set(['browser-profiles']);

const uploadQuery = z.object({
  name: z.string().trim().min(1).max(255),
  /** The browser's idea of the file type; the extension decides when it is missing or malformed. */
  type: z.string().max(200).optional(),
});

function rawBody(req: FastifyRequest): Buffer {
  if (!Buffer.isBuffer(req.body)) throw invalid(`send the file as the request body with content-type ${RAW}`);
  return req.body;
}

const issueFileDto = (org: Organization, issueId: string, f: IssueFile): IssueFileDto => {
  const downloadPath = `${API_PREFIX}/orgs/${encodeURIComponent(org.id)}/issues/${encodeURIComponent(issueId)}/artifacts/${ISSUE_FILES_DIR}/${encodeURIComponent(f.name)}`;
  return {
    name: f.name, path: f.path, bytes: f.bytes, modifiedAt: f.modifiedAt, contentType: attachmentContentType(f.name, f.file, undefined),
    downloadPath, viewPath: `${downloadPath}?inline=1`,
  };
};

/**
 * Files the owner uploads from the dashboard: attached to a task directly
 * (`/issues/:id/files`), or staged (`/uploads`) for a comment about to be
 * posted. Bodies are the raw file bytes (`application/octet-stream`), the name
 * travels in the query string; downloads go through the artifact routes.
 */
export function uploadRoutes(app: FastifyInstance, s: Services): void {
  void app.register(async (r) => {
    r.addContentTypeParser(RAW, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

    r.post('/orgs/:orgId/uploads', { bodyLimit: MAX_UPLOAD_BYTES }, async (req): Promise<StagedUploadDto> => {
      const org = orgOf(s, req);
      const q = query(req, uploadQuery);
      const staged = stageUpload(s.kernel.paths, org.slug, q.name, rawBody(req));
      return { ...staged, mime: attachmentContentType(staged.name, staged.path, q.type) };
    });

    r.post('/orgs/:orgId/issues/:issueId/files', { bodyLimit: MAX_UPLOAD_BYTES }, async (req): Promise<IssueFileDto> => {
      const org = orgOf(s, req);
      const issue = resolveIssue(s, org.id, param(req, 'issueId'));
      const q = query(req, uploadQuery);
      const saved = supported(s.work.addIssueFile, 'attaching files to an issue').call(s.work, org.id, issue.id, { name: q.name, data: rawBody(req) }, OWNER);
      return issueFileDto(org, issue.id, saved);
    });
  });

  app.get('/orgs/:orgId/issues/:issueId/files', async (req): Promise<IssueFileDto[]> => {
    const org = orgOf(s, req);
    const issue = resolveIssue(s, org.id, param(req, 'issueId'));
    return supported(s.work.listIssueFiles, 'listing issue files').call(s.work, org.id, issue.id).map((f) => issueFileDto(org, issue.id, f));
  });

  app.delete('/orgs/:orgId/issues/:issueId/files/:name', async (req): Promise<Ok> => {
    const org = orgOf(s, req);
    const issue = resolveIssue(s, org.id, param(req, 'issueId'));
    supported(s.work.removeIssueFile, 'removing issue files').call(s.work, org.id, issue.id, param(req, 'name'), OWNER);
    return { ok: true };
  });
}

/**
 * Attachments on a comment posted through the API. A file path must name a
 * regular file inside the organization's own directory (an upload, a task
 * file, an artifact): the API never copies arbitrary files off the disk into
 * the store. Anything else that is not an absolute path is kept as a plain
 * reference, as for agents.
 */
export function confineOwnerAttachments(s: Services, org: Organization, list: Comment['attachments'] | undefined): Comment['attachments'] {
  const orgRoot = s.kernel.paths.org(org.slug);
  return (list ?? []).map((a) => {
    if (!isAbsolute(a.path)) return a;
    const path = resolve(a.path);
    const rel = path.startsWith(orgRoot + sep) ? path.slice(orgRoot.length + 1).split(sep) : null;
    if (!rel || rel.some((seg) => PRIVATE_SEGMENTS.has(seg)) || !isFileInside(path, orgRoot)) {
      throw invalid(`attachment "${a.name}" is not a file uploaded to this organization; upload it first`);
    }
    return { ...a, path };
  });
}

/** After the comment holds its own copies, drop the staged uploads it attached. */
export function discardStaged(s: Services, org: Organization, list: Comment['attachments']): void {
  for (const a of list) {
    try {
      discardStagedUpload(s.kernel.paths, org.slug, a.path);
    } catch (err) {
      s.kernel.log.warn({ err, orgId: org.id }, 'could not remove a staged upload');
    }
  }
}
