import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER } from '../../src/contracts/types.js';
import type { Comment, Issue } from '../../src/contracts/rows.js';
import { addIssueFile, listIssueFiles, removeIssueFile } from '../../src/work/uploads.js';
import { createHarness, type Harness } from './fake-services.js';

let h: Harness;
let issue: Issue;
beforeEach(async () => {
  h = await createHarness();
  issue = h.work.createIssue(h.orgA.id, { title: 'Landing page' }, OWNER);
  // The fake work service delegates task files to the real storage functions.
  h.work.addIssueFile.mockImplementation((_o, id, input) => addIssueFile(h.kernel.paths, h.orgA.slug, id, input.name, input.data));
  h.work.listIssueFiles.mockImplementation((_o, id) => listIssueFiles(h.kernel.paths, h.orgA.slug, id));
  h.work.removeIssueFile.mockImplementation((_o, id, name) => removeIssueFile(h.kernel.paths, h.orgA.slug, id, name));
  h.work.addComment.mockImplementation((orgId, issueId, input) => ({ id: 'cmt_1', orgId, issueId, body: input.body, attachments: input.attachments ?? [] }) as unknown as Comment);
});
afterEach(async () => {
  await h.close();
});

const raw = (url: string, data: Buffer, headers: Record<string, string> = h.owner) =>
  h.api.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: data });
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  h.api.app.inject({ method, url: `/api/v1${url}`, headers: h.owner, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe('dashboard uploads', () => {
  it('stages a raw upload, attaches it to a comment, then drops the staged copy', async () => {
    const res = await raw(`/orgs/${h.orgA.slug}/uploads?name=${encodeURIComponent('bug report.png')}&type=image/png`, Buffer.from('png-bytes'));
    expect(res.statusCode).toBe(200);
    const up = res.json();
    expect(up).toMatchObject({ name: 'bug report.png', bytes: 9, mime: 'image/png' });
    expect(readFileSync(up.path, 'utf8')).toBe('png-bytes');

    const posted = await call('POST', `/orgs/${h.orgA.slug}/issues/${issue.number}/comments`, { body: 'Broken here', attachments: [{ name: up.name, path: up.path, mime: up.mime }] });
    expect(posted.statusCode).toBe(200);
    expect(h.work.addComment).toHaveBeenCalledWith(h.orgA.id, issue.id, { body: 'Broken here', attachments: [{ name: up.name, path: up.path, mime: 'image/png' }] }, OWNER);
    expect(existsSync(up.path)).toBe(false);
  });

  it('refuses comment attachments that are not files of this organization', async () => {
    writeFileSync(join(h.kernel.paths.home, 'owner.token'), 'cnd_secret');
    const profile = join(h.kernel.paths.org(h.orgA.slug), 'browser-profiles', 'ada');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'cookies'), 'jar');
    const theirs = join(h.kernel.paths.org(h.orgB.slug), 'artifacts');
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, 'secret.txt'), 'globex');
    for (const path of [join(h.kernel.paths.home, 'owner.token'), join(profile, 'cookies'), join(theirs, 'secret.txt'), '/etc/hosts']) {
      const res = await call('POST', `/orgs/${h.orgA.slug}/issues/${issue.number}/comments`, { body: 'x', attachments: [{ name: 'f', path }] });
      expect(res.statusCode, path).toBe(400);
    }
    expect(h.work.addComment).not.toHaveBeenCalled();
  });

  it('attaches, lists, serves and removes files on the task itself', async () => {
    const up = await raw(`/orgs/${h.orgA.slug}/issues/${issue.number}/files?name=spec.md`, Buffer.from('# Spec\n'));
    expect(up.statusCode).toBe(200);
    const dto = up.json();
    expect(dto).toMatchObject({ name: 'spec.md', bytes: 7, contentType: 'text/markdown; charset=utf-8', path: `${issue.id}/files/spec.md` });

    const list = await call('GET', `/orgs/${h.orgA.slug}/issues/${issue.number}/files`);
    expect(list.json().map((f: { name: string }) => f.name)).toEqual(['spec.md']);

    const got = await h.api.app.inject({ method: 'GET', url: dto.downloadPath, headers: h.owner });
    expect(got.statusCode).toBe(200);
    expect(got.body).toBe('# Spec\n');

    expect((await call('DELETE', `/orgs/${h.orgA.slug}/issues/${issue.number}/files/spec.md`)).statusCode).toBe(200);
    expect((await call('GET', `/orgs/${h.orgA.slug}/issues/${issue.number}/files`)).json()).toEqual([]);
    expect((await call('DELETE', `/orgs/${h.orgA.slug}/issues/${issue.number}/files/spec.md`)).statusCode).toBe(404);
  });

  it('needs the owner, a name and a raw body; another org\'s issue is not found', async () => {
    expect((await raw(`/orgs/${h.orgA.slug}/uploads?name=a.txt`, Buffer.from('a'), {})).statusCode).toBe(401);
    expect((await raw(`/orgs/${h.orgA.slug}/uploads`, Buffer.from('a'))).statusCode).toBe(400);
    expect((await raw(`/orgs/${h.orgA.slug}/uploads?name=a.txt`, Buffer.alloc(0))).statusCode).toBe(400);
    expect((await call('POST', `/orgs/${h.orgA.slug}/uploads?name=a.txt`, { not: 'raw' })).statusCode).toBe(400);
    expect((await raw(`/orgs/${h.orgB.slug}/issues/${issue.id}/files?name=a.txt`, Buffer.from('a'))).statusCode).toBe(404);
  });
});
