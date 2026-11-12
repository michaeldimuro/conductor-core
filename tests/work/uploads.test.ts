import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgService, WorkService } from '../../src/contracts/org-work.js';
import type { BuiltinToolProvider } from '../../src/contracts/tools.js';
import { OWNER } from '../../src/contracts/types.js';
import { buildTaskPrompt } from '../../src/runtime/prompt.js';
import { createTasksToolProvider, createWorkService } from '../../src/work/index.js';
import { discardStagedUpload, pruneStagedUploads, stageUpload } from '../../src/work/uploads.js';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { as, codeOf, createFakeOrg, errorOf, mockApprovals, payloadOf, recordEvents, seedCompany, toolCtx, type Fixture } from './helpers.js';

/** A 1×1 transparent PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

describe('work: files the owner attaches to tasks and comments', () => {
  let k: TestKernel;
  let org: OrgService;
  let work: WorkService;
  let tools: BuiltinToolProvider;
  let f: Fixture;

  beforeEach(() => {
    k = createTestKernel();
    org = createFakeOrg(k);
    work = createWorkService(k, { org });
    tools = createTasksToolProvider(k, { work, org, approvals: mockApprovals() });
    f = seedCompany(k);
  });
  afterEach(() => k.dispose());

  const issueFor = () => work.createIssue(f.org.id, { title: 'Redesign the landing page', assigneeAgentId: f.dev.id }, OWNER);
  const view = (path: string, extra: Record<string, unknown> = {}) =>
    tools.call(toolCtx(f.dev), 'view_attachment', { path, ...extra });

  it('stores task files under artifacts/<issue>/files/, never overwriting, and lists them in order', () => {
    const issue = issueFor();
    const events = recordEvents(k);
    const a = work.addIssueFile!(f.org.id, issue.id, { name: 'mockup.png', data: PNG }, OWNER);
    const b = work.addIssueFile!(f.org.id, issue.id, { name: '../../mockup.png', data: Buffer.from('second') }, OWNER);

    expect(a.file).toBe(join(k.paths.artifacts(f.org.slug), issue.id, 'files', 'mockup.png'));
    expect(a.path).toBe(`${issue.id}/files/mockup.png`);
    expect(b.name).toBe('mockup-2.png');
    expect(readFileSync(a.file)).toEqual(PNG);
    expect(work.listIssueFiles!(f.org.id, issue.id).map((x) => x.name)).toEqual(['mockup.png', 'mockup-2.png']);
    expect(events.of('artifact.saved')).toEqual([
      { orgId: f.org.id, path: a.path, issueId: issue.id, runId: null },
      { orgId: f.org.id, path: b.path, issueId: issue.id, runId: null },
    ]);
    expect(k.audit.query({ orgId: f.org.id, action: 'issue.file_attached' })).toHaveLength(2);

    work.removeIssueFile!(f.org.id, issue.id, 'mockup.png', OWNER);
    expect(existsSync(a.file)).toBe(false);
    expect(work.listIssueFiles!(f.org.id, issue.id).map((x) => x.name)).toEqual(['mockup-2.png']);
    expect(events.of('artifact.removed')).toEqual([{ orgId: f.org.id, path: a.path, issueId: issue.id }]);
    expect(codeOf(() => work.removeIssueFile!(f.org.id, issue.id, 'mockup.png', OWNER))).toBe('not_found');
    expect(codeOf(() => work.removeIssueFile!(f.org.id, issue.id, '../files/mockup-2.png', OWNER))).toBe('not_found');
    expect(codeOf(() => work.addIssueFile!(f.org.id, issue.id, { name: 'empty.txt', data: Buffer.alloc(0) }, OWNER))).toBe('validation');
  });

  it('keeps another organization\'s issues out of reach', () => {
    const other = seedCompany(k, 'Globex');
    const theirs = work.createIssue(other.org.id, { title: 'Theirs' }, OWNER);
    expect(codeOf(() => work.addIssueFile!(f.org.id, theirs.id, { name: 'x.txt', data: Buffer.from('x') }, OWNER))).toBe('not_found');
    expect(codeOf(() => work.listIssueFiles!(f.org.id, theirs.id))).toBe('not_found');
  });

  it('copies a staged upload into the comment\'s folder; the staged copy can then be discarded, and stale ones are pruned', () => {
    const issue = issueFor();
    const staged = stageUpload(k.paths, f.org.slug, 'screen shot.png', PNG);
    expect(staged.path.startsWith(join(k.paths.uploads(f.org.slug), staged.id))).toBe(true);
    const comment = work.addComment(f.org.id, issue.id, { body: 'See the screenshot', attachments: [{ name: staged.name, path: staged.path, mime: 'image/png' }] }, OWNER);
    const stored = comment.attachments[0]!;
    expect(stored.path).toBe(join(k.paths.artifacts(f.org.slug), issue.id, comment.id, 'screen shot.png'));
    discardStagedUpload(k.paths, f.org.slug, staged.path);
    expect(existsSync(staged.path)).toBe(false);
    expect(readFileSync(stored.path)).toEqual(PNG);

    const old = stageUpload(k.paths, f.org.slug, 'old.txt', Buffer.from('old'));
    const dir = join(k.paths.uploads(f.org.slug), old.id);
    const twoDaysAgo = new Date(Date.now() - 48 * 3600_000);
    utimesSync(dir, twoDaysAgo, twoDaysAgo);
    const fresh = stageUpload(k.paths, f.org.slug, 'fresh.txt', Buffer.from('fresh'));
    pruneStagedUploads(k.paths, f.org.slug);
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(fresh.path)).toBe(true);
    // Only staged-upload folders are ever removed.
    discardStagedUpload(k.paths, f.org.slug, k.paths.artifacts(f.org.slug));
    expect(existsSync(stored.path)).toBe(true);
  });

  it('view_attachment shows an owner\'s image to the agent as image content (trusted)', async () => {
    const issue = issueFor();
    const file = work.addIssueFile!(f.org.id, issue.id, { name: 'mockup.png', data: PNG }, OWNER);
    const res = await view(file.file);
    expect(res.isError).toBeFalsy();
    expect(res.untrusted).toBe(false);
    expect(res.content[1]).toEqual({ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
    expect(payloadOf(res)).toMatchObject({ name: 'mockup.png', bytes: PNG.length, mimeType: 'image/png' });
  });

  it('view_attachment returns text in pages and marks what agents attached as untrusted', async () => {
    const issue = issueFor();
    const ws = k.paths.agentWorkspace(f.org.slug, f.dev.slug);
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'notes.md'), `# Notes\n${'x'.repeat(150_000)}`);
    const c = work.addComment(f.org.id, issue.id, { body: 'notes', attachments: [{ name: 'notes.md', path: join(ws, 'notes.md') }] }, as(f.lead));

    const first = await view(c.attachments[0]!.path);
    expect(first.untrusted).toBe(true);
    const text = (first.content[0] as { text: string }).text;
    const header = JSON.parse(text.slice(0, text.indexOf('\n'))) as Record<string, unknown>;
    expect(header).toMatchObject({ name: 'notes.md', truncated: true, nextOffset: 100_000 });
    expect(text).toContain('# Notes');
    const second = await view(c.attachments[0]!.path, { offset: 100_000 });
    expect((second.content[0] as { text: string }).text).not.toContain('truncated');

    const mine = work.addComment(f.org.id, issue.id, { body: 'from me', attachments: [{ name: 'notes.md', path: join(ws, 'notes.md') }] }, OWNER);
    expect((await view(mine.attachments[0]!.path)).untrusted).toBe(false);
  });

  it('view_attachment describes binaries and refuses anything outside this org\'s artifact store', async () => {
    const issue = issueFor();
    const pdf = work.addIssueFile!(f.org.id, issue.id, { name: 'brief.pdf', data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]) }, OWNER);
    expect(payloadOf(await view(pdf.file))).toMatchObject({ name: 'brief.pdf', note: expect.stringMatching(/binary file/) });

    writeFileSync(join(k.paths.home, 'owner.token'), 'cnd_secret');
    const other = seedCompany(k, 'Globex');
    const theirs = work.createIssue(other.org.id, { title: 'Theirs' }, OWNER);
    const theirFile = work.addIssueFile!(other.org.id, theirs.id, { name: 'secret.txt', data: Buffer.from('globex only') }, OWNER);
    for (const path of [join(k.paths.home, 'owner.token'), theirFile.file, join(k.paths.artifacts(f.org.slug), '..', '..', other.org.slug, 'artifacts', theirs.id, 'files', 'secret.txt'), 'relative.txt']) {
      const res = await view(path);
      expect(res.isError, path).toBe(true);
      expect(errorOf(res)).not.toMatch(/cnd_secret|globex only/);
    }
    expect(errorOf(await view(join(k.paths.artifacts(f.org.slug), 'missing.png')))).toMatch(/not_found/);
  });

  it('get_issue lists the task files, and the wake prompt tells the agent where every attachment is', async () => {
    const issue = issueFor();
    const file = work.addIssueFile!(f.org.id, issue.id, { name: 'mockup.png', data: PNG }, OWNER);
    const staged = stageUpload(k.paths, f.org.slug, 'bug.png', PNG);
    const c = work.addComment(f.org.id, issue.id, { body: 'It breaks here', attachments: [{ name: 'bug.png', path: staged.path }] }, OWNER);

    const got = payloadOf<{ files: unknown[] }>(await tools.call(toolCtx(f.dev), 'get_issue', { issue: issue.id }));
    expect(got.files).toEqual([{ name: 'mockup.png', path: file.file, bytes: PNG.length }]);

    const prompt = buildTaskPrompt({
      mode: 'issue', issue, orgSlug: f.org.slug, comments: work.listComments(f.org.id, issue.id), files: work.listIssueFiles!(f.org.id, issue.id),
    });
    expect(prompt).toContain('## Files attached to this issue');
    expect(prompt).toContain(`mockup.png — path: ${file.file}`);
    expect(prompt).toContain(`(comment ${c.id}): It breaks here`);
    expect(prompt).toContain(`attachment: bug.png — path: ${c.attachments[0]!.path}`);
    expect(prompt).toContain('conductor-tasks__view_attachment');

    const plain = buildTaskPrompt({ mode: 'issue', issue: issueFor(), orgSlug: f.org.slug, comments: [], files: [] });
    expect(plain).not.toContain('view_attachment');
  });
});
