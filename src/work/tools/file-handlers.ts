import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { textResult } from '../../contracts/tools.js';
import { ID_PREFIX } from '../../shared/ids.js';
import { invalid, notFound } from '../../shared/errors.js';
import { ISSUE_FILES_DIR } from '../uploads.js';
import { rawResult, type Handlers, type ToolEnv } from './support.js';
import type { ToolCallContext } from '../../contracts/tools.js';

/** Image types every vision model accepts; anything else is described, not shown. */
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** Model APIs cap one image at ~5 MB once base64-encoded. */
const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4) - 1024;
const MAX_TEXT_CHARS = 100_000;
const SNIFF_BYTES = 8192;

/** Text when the first bytes hold no NUL and decode as UTF-8 without replacement characters. */
function looksLikeText(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
    const head = buf.subarray(0, n);
    if (head.includes(0)) return false;
    // A multi-byte character cut at the sniff boundary is not a reason to call it binary.
    return !new TextDecoder('utf-8').decode(n === SNIFF_BYTES ? head.subarray(0, n - 4) : head).includes('�');
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the owner put the file there (a task file, or an attachment on a
 * comment the owner wrote). Everything else (what runs saved, browser
 * downloads, other agents' attachments) is untrusted content.
 */
function fromOwner(env: ToolEnv, ctx: ToolCallContext, rel: string[]): boolean {
  const [issueId, scope] = rel;
  if (!issueId?.startsWith(`${ID_PREFIX.issue}_`) || rel.length < 3) return false;
  if (scope === ISSUE_FILES_DIR) return true;
  if (!scope?.startsWith(`${ID_PREFIX.comment}_`)) return false;
  try {
    return env.work.listComments(ctx.orgId, issueId).some((c) => c.id === scope && c.authorKind === 'human');
  } catch {
    return false;
  }
}

export const fileHandlers: Handlers<'view_attachment'> = {
  /** Show an attachment to the agent: confined to this organization's artifact store. */
  view_attachment(env, ctx, args) {
    if (args.path.includes('\0') || !isAbsolute(args.path)) throw invalid('pass the attachment\'s absolute `path` as listed on the issue or comment');
    const root = env.kernel.paths.artifacts(env.org.getOrg(ctx.orgId).slug);
    let file: string;
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
      file = realpathSync(resolve(args.path));
    } catch {
      throw notFound('attachment', args.path);
    }
    if (!file.startsWith(realRoot + sep)) throw invalid('only files attached to this organization\'s issues and comments (or saved as artifacts) can be viewed with this tool');
    const stat = statSync(file);
    if (!stat.isFile()) throw notFound('attachment', args.path);

    const rel = file.slice(realRoot.length + 1).split(sep);
    const untrusted = !fromOwner(env, ctx, rel);
    const name = rel[rel.length - 1]!;
    const about = { name, path: args.path, bytes: stat.size };
    const ext = extname(name).toLowerCase();

    const image = IMAGE_TYPES[ext];
    if (image) {
      if (stat.size > MAX_IMAGE_BYTES) {
        return { ...about, note: `The image is too large to show (over ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB). Make a smaller copy in your workspace with your own tools and look at that.` };
      }
      return rawResult({
        content: [
          { type: 'text', text: JSON.stringify({ ...about, mimeType: image }) },
          { type: 'image', data: readFileSync(file).toString('base64'), mimeType: image },
        ],
        untrusted,
      });
    }

    if (looksLikeText(file)) {
      const text = readFileSync(file, 'utf8');
      const offset = Math.min(args.offset ?? 0, text.length);
      const chunk = text.slice(offset, offset + MAX_TEXT_CHARS);
      const end = offset + chunk.length;
      const header = { ...about, chars: text.length, offset, ...(end < text.length ? { truncated: true, nextOffset: end } : {}) };
      return rawResult(textResult(`${JSON.stringify(header)}\n\n${chunk}`, { untrusted }));
    }

    return {
      ...about,
      note: 'This is a binary file (e.g. PDF, office document, archive, audio or video) and cannot be shown here. Open it from this path with your own tools (a PDF reader, a script, or your file-reading tool).',
    };
  },
};
