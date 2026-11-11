import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgService, WorkService } from '../../src/contracts/org-work.js';
import type { BuiltinToolProvider } from '../../src/contracts/tools.js';
import { OWNER } from '../../src/contracts/types.js';
import { safeArtifactName } from '../../src/work/artifacts.js';
import { createTasksToolProvider, createWorkService } from '../../src/work/index.js';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { as, codeOf, createFakeOrg, errorOf, mockApprovals, payloadOf, seedCompany, toolCtx, type Fixture } from './helpers.js';

/** PRD on-disk layout: `orgs/<org>/artifacts/` holds what agents attach to issues. */
describe('work: comment attachments are stored under the org artifacts directory', () => {
  let k: TestKernel;
  let org: OrgService;
  let work: WorkService;
  let tools: BuiltinToolProvider;
  let f: Fixture;
  let workspace: string;
  let artifactsDir: string;

  beforeEach(() => {
    k = createTestKernel();
    org = createFakeOrg(k);
    work = createWorkService(k, { org });
    tools = createTasksToolProvider(k, { work, org, approvals: mockApprovals() });
    f = seedCompany(k);
    workspace = join(k.paths.agentWorkspace(f.org.slug, f.dev.slug));
    mkdirSync(join(workspace, 'out'), { recursive: true });
    writeFileSync(join(workspace, 'out', 'report.md'), '# Report\nAll green.\n');
    artifactsDir = k.paths.artifacts(f.org.slug);
  });
  afterEach(() => k.dispose());

  const issueFor = (title = 'Ship it') => work.createIssue(f.org.id, { title, assigneeAgentId: f.dev.id }, OWNER);

  it('copies an attached file to artifacts/<issue>/<comment>/ and stores that path', () => {
    const issue = issueFor();
    const source = join(workspace, 'out', 'report.md');
    const comment = work.addComment(f.org.id, issue.id, { body: 'Done', attachments: [{ name: 'report.md', path: source, mime: 'text/markdown' }] }, as(f.dev));

    const stored = comment.attachments[0]!;
    expect(stored).toEqual({ name: 'report.md', path: join(artifactsDir, issue.id, comment.id, 'report.md'), mime: 'text/markdown' });
    expect(readFileSync(stored.path, 'utf8')).toBe('# Report\nAll green.\n');
    // The artifact outlives the workspace file; the source is left alone.
    expect(existsSync(source)).toBe(true);
    expect(work.listComments(f.org.id, issue.id)[0]?.attachments).toEqual([stored]);
    expect(k.audit.query({ orgId: f.org.id, action: 'comment.created' })[0]?.data).toMatchObject({ attachments: 1 });
  });

  it('keeps every stored file inside the artifacts directory whatever the attachment is called', () => {
    const issue = issueFor();
    const source = join(workspace, 'out', 'report.md');
    const comment = work.addComment(f.org.id, issue.id, {
      body: 'Names',
      attachments: [
        { name: '../../../../etc/passwd', path: source },
        { name: '.hidden', path: source },
        { name: 'a/b\\c:d*e.txt', path: source },
        { name: 'passwd', path: source },
      ],
    }, OWNER);
    const dir = join(artifactsDir, issue.id, comment.id);
    for (const a of comment.attachments) expect(a.path.startsWith(dir + sep)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['2-passwd', 'c_d_e.txt', 'hidden', 'passwd']);
    expect(safeArtifactName('..')).toBe('artifact');
    expect(safeArtifactName('x'.repeat(500))).toHaveLength(200);
  });

  it('keeps references it cannot store and refuses symlinks', () => {
    const issue = issueFor();
    const kept = work.addComment(f.org.id, issue.id, {
      body: 'Refs',
      attachments: [{ name: 'gone', path: join(workspace, 'missing.txt') }, { name: 'folder', path: join(workspace, 'out') }, { name: 'relative', path: 'out/report.md' }],
    }, OWNER);
    expect(kept.attachments.map((a) => a.path)).toEqual([join(workspace, 'missing.txt'), join(workspace, 'out'), 'out/report.md']);
    expect(existsSync(join(artifactsDir, issue.id, kept.id))).toBe(false);

    const secret = join(k.paths.home, 'outside-secret.txt');
    writeFileSync(secret, 'TOP SECRET');
    symlinkSync(secret, join(workspace, 'out', 'link.txt'));
    expect(codeOf(() => work.addComment(f.org.id, issue.id, { body: 'Link', attachments: [{ name: 'link.txt', path: join(workspace, 'out', 'link.txt') }] }, OWNER))).toBe('validation');
    expect(codeOf(() => work.addComment(f.org.id, issue.id, { body: 'Traversal', attachments: [{ name: 'x', path: `${workspace}/../x` }] }, OWNER))).toBe('validation');
    expect(work.listComments(f.org.id, issue.id)).toHaveLength(1);
  });

  it('removes what it copied when the comment is not written', () => {
    const issue = issueFor();
    const source = join(workspace, 'out', 'report.md');
    const attachments = [{ name: 'report.md', path: source }, { name: 'link', path: join(workspace, 'out', 'link.txt') }];
    symlinkSync(source, join(workspace, 'out', 'link.txt'));
    expect(codeOf(() => work.addComment(f.org.id, issue.id, { body: 'Half', attachments }, OWNER))).toBe('validation');
    expect(work.listComments(f.org.id, issue.id)).toEqual([]);
    expect(existsSync(join(artifactsDir, issue.id)) ? readdirSync(join(artifactsDir, issue.id)) : []).toEqual([]);
  });

  it('report_progress stores artifacts from the run workspace; the tool refuses paths that escape it', async () => {
    const issue = issueFor();
    const ctx = toolCtx(f.dev, { issueId: issue.id, runId: 'run_a', workspacePath: workspace });
    const out = payloadOf<{ commentId: string }>(
      await tools.call(ctx, 'report_progress', { status: 'in_review', summary: 'See the report.', artifacts: [{ name: 'report.md', path: 'out/report.md' }] }),
    );
    const [comment] = work.listComments(f.org.id, issue.id);
    expect(comment?.attachments).toEqual([{ name: 'report.md', path: join(artifactsDir, issue.id, out.commentId, 'report.md') }]);

    const outside = join(k.paths.home, 'outside-secret.txt');
    writeFileSync(outside, 'TOP SECRET');
    symlinkSync(outside, join(workspace, 'innocent.txt'));
    symlinkSync(k.paths.home, join(workspace, 'home-link'));
    const attempt = (path: string) => tools.call(ctx, 'comment', { body: 'x', attachments: [{ name: 'f', path }] });
    expect(errorOf(await attempt(outside))).toMatch(/validation.*outside the run workspace/);
    expect(errorOf(await attempt('../../../../outside-secret.txt'))).toMatch(/validation/);
    expect(errorOf(await attempt('innocent.txt'))).toMatch(/validation.*resolves outside/);
    expect(errorOf(await attempt('home-link/outside-secret.txt'))).toMatch(/validation.*resolves outside/);
    // Nothing leaked into the artifacts directory.
    expect(readdirSync(join(artifactsDir, issue.id))).toEqual([out.commentId]);
  });

  it('keeps organizations apart on disk', () => {
    const other = seedCompany(k, 'Other');
    const theirs = work.createIssue(other.org.id, { title: 'Theirs' }, OWNER);
    const comment = work.addComment(other.org.id, theirs.id, { body: 'x', attachments: [{ name: 'r.md', path: join(workspace, 'out', 'report.md') }] }, OWNER);
    expect(comment.attachments[0]!.path.startsWith(k.paths.artifacts(other.org.slug) + sep)).toBe(true);
    expect(existsSync(artifactsDir)).toBe(false);
  });
  it('lists everything stored for an issue: what its runs saved and comment attachments, never symlinks or other issues', () => {
    const issue = issueFor();
    const otherIssue = issueFor('Another');
    expect(work.listIssueArtifacts!(f.org.id, issue.id)).toEqual([]);

    // What the browser tools save for a run working the issue.
    const shot = k.paths.artifactFile(f.org.slug, issue.id, join('run_01ABC', 'screenshot.png'));
    mkdirSync(join(shot, '..'), { recursive: true });
    writeFileSync(shot, 'png-bytes');
    mkdirSync(k.paths.artifactDir(f.org.slug, otherIssue.id), { recursive: true });
    writeFileSync(k.paths.artifactFile(f.org.slug, otherIssue.id, 'elsewhere.txt'), 'x', { flag: 'w' });
    symlinkSync(join(k.paths.home, 'owner.token'), k.paths.artifactFile(f.org.slug, issue.id, join('run_01ABC', 'link.txt')));

    // The agent attaches the saved artifact to its result comment: it is already stored for the issue, so it is referenced, not copied again.
    const comment = work.addComment(f.org.id, issue.id, { body: 'Screenshot attached', attachments: [{ name: 'screenshot.png', path: shot }] }, as(f.dev));
    expect(comment.attachments[0]!.path).toBe(shot);
    expect(readFileSync(comment.attachments[0]!.path, 'utf8')).toBe('png-bytes');

    const list = work.listIssueArtifacts!(f.org.id, issue.id);
    expect(list.map((a) => [a.origin, a.originId, a.path])).toEqual([['run', 'run_01ABC', 'run_01ABC/screenshot.png']]);
    expect(list.every((a) => a.bytes === 9 && a.file.startsWith(k.paths.artifactDir(f.org.slug, issue.id) + sep))).toBe(true);
    // Org isolation: the issue id of one org lists nothing through another org.
    expect(codeOf(() => work.listIssueArtifacts!('org_other', issue.id))).toBe('not_found');
  });
});
