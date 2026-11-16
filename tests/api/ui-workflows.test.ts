import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServices } from '../../src/daemon/compose.js';
import { MemorySecretStore } from '../../src/kernel/index.js';
import { createApiServer, type ApiServer } from '../../src/api/index.js';
import { DEFAULT_UI_DIR } from '../../src/api/static.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Actor } from '../../src/contracts/types.js';

/** Needs a built console (`npm run build:ui`) and Playwright's Chromium; skipped when either is missing. */
const chromiumPath = (): string | null => {
  try {
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
};
const ready = existsSync(join(DEFAULT_UI_DIR, 'index.html')) && chromiumPath() !== null;

/**
 * The owner's workflows, driven end to end on a phone-sized screen with touch: each test does the job the
 * workflow exists for and checks the daemon's state changed, not only that the screen rendered.
 */
describe.skipIf(!ready)('owner workflows on a phone', () => {
  let home: string;
  let services: Awaited<ReturnType<typeof createServices>>;
  let api: ApiServer;
  let browser: Browser;
  let page: Page;
  let origin: string;
  let base: string;
  let orgId: string;
  const ids: Record<string, string> = {};
  const problems: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'conductor-ui-workflows-'));
    services = await createServices({ home, secrets: new MemorySecretStore(), config: { port: 0 }, runtime: { powerAssertion: false } });
    // No model is configured; the setup interview and draft use their offline paths.
    api = await createApiServer(services, { uiDir: DEFAULT_UI_DIR });
    await api.listen('127.0.0.1', 0);
    origin = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
    const token = services.governance.tokens.issueOwnerToken('ui-workflows');

    const org = services.org.createOrg({ name: 'Workflow Co', mission: 'Prove the owner workflows' }, OWNER);
    orgId = org.id;
    base = `/o/${org.slug}`;
    const dept = services.org.createDept(org.id, { name: 'Growth', charter: 'Customers' }, OWNER);
    const lead = services.org.hireAgent(org.id, { deptId: dept.id, name: 'Rae Morgan', role: 'Growth lead', isLead: true }, OWNER).agent!;
    const seo = services.org.hireAgent(org.id, { deptId: dept.id, name: 'Sam Ortiz', role: 'SEO', reportsTo: lead.id }, OWNER).agent!;
    const goal = services.work.createGoal(org.id, { title: 'Reach 1,000 signups', ownerAgentId: lead.id }, OWNER);
    const make = (title: string, assignee: string, status?: string, extra: Record<string, unknown> = {}) => {
      const i = services.work.createIssue(org.id, { title, assigneeAgentId: assignee, goalId: goal.id }, OWNER);
      return status ? services.work.updateIssue(org.id, i.id, { status, ...extra } as never, OWNER) : i;
    };
    const blocked = make('Fix broken docs links', seo.id, 'blocked', { blockedReason: 'needs_owner: log in to the docs CMS' });
    ids.blocked = blocked.id;
    const downstream = make('Re-submit the sitemap', seo.id);
    services.work.updateIssue(org.id, downstream.id, { blockedBy: [blocked.id] } as never, OWNER);
    ids.review = make('Weekly signup report', lead.id, 'in_review').id;
    make('Draft launch emails', lead.id, 'in_progress');
    make('Audit the pricing page', seo.id, 'todo');
    const agentActor: Actor = { kind: 'agent', id: lead.id };
    services.work.addComment(org.id, ids.review, { body: 'Done: the report posts every Monday at 9am.' }, agentActor);
    ids.approval = services.governance.approvals.request({ orgId: org.id, kind: 'payment', title: 'Buy a $49 tool seat', payload: { amountUsd: 49 }, requesterAgentId: seo.id }).id;
    const skill = await services.skills.upsert(org.id, { scope: 'agent', scopeId: seo.id, name: 'weekly-seo-audit', description: 'Audit the top pages every Monday.', body: 'Steps.', status: 'draft' }, { kind: 'agent', id: seo.id });
    ids.skill = skill.id;
    const memory = await services.memory.write(org.id, { scope: 'agent', scopeId: lead.id, kind: 'lesson', content: 'The owner wants emails under 150 words.' }, agentActor);
    await services.memory.update(org.id, memory.id, { status: 'review' }, OWNER);
    ids.memory = memory.id;

    browser = await chromium.launch({ headless: true });
    page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/status of 401/.test(msg.text())) problems.push(`console: ${msg.text()}`);
    });
    await page.goto(origin);
    await page.getByLabel('Token').fill(token);
    await page.getByRole('button', { name: 'Sign in' }).tap();
    await page.getByRole('heading', { level: 1 }).first().waitFor();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await api?.close();
    await services?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const clean = (where: string) => expect(problems, `console errors during ${where}`).toEqual([]);
  const card = (text: string) => page.locator('.need', { hasText: text });

  it('Today answers what needs me, ranked by what it unblocks', async () => {
    await page.goto(`${origin}${base}`);
    await page.getByText(/things need you/).waitFor();
    // The blocked task holds up another one, so it leads.
    await expect.poll(() => page.locator('.need .need-title').first().textContent()).toBe('Fix broken docs links');
    await card('Fix broken docs links').getByText('Holding up 1 task').waitFor();
    clean('Today');
  });

  it('Needs you: approve, unblock with a reply, and accept a review from the cards', async () => {
    await page.goto(`${origin}${base}/inbox`);
    await card('Buy a $49 tool seat').getByRole('button', { name: 'Approve' }).tap();
    await card('Buy a $49 tool seat').waitFor({ state: 'detached' });
    expect(services.governance.approvals.get(orgId, ids.approval!).status).toBe('approved');

    const blocked = card('Fix broken docs links');
    await blocked.getByRole('button', { name: 'Reply' }).tap();
    await blocked.getByRole('textbox').fill('Logged in for you, try again.');
    await blocked.getByRole('button', { name: 'Send and continue' }).tap();
    await blocked.waitFor({ state: 'detached' });
    expect(services.work.getIssue(orgId, ids.blocked!).status).toBe('todo');

    await card('Weekly signup report').getByText('posts every Monday').waitFor();
    await card('Weekly signup report').getByRole('button', { name: 'Accept' }).tap();
    await card('Weekly signup report').waitFor({ state: 'detached' });
    expect(services.work.getIssue(orgId, ids.review!).status).toBe('done');
    clean('Needs you');
  });

  it('keeps what an agent learned, from Needs you', async () => {
    await page.goto(`${origin}${base}/inbox`);
    await page.locator('.need-memory').getByRole('button', { name: 'Keep' }).tap();
    await page.locator('.need-memory').waitFor({ state: 'detached' });
    expect((await services.memory.get(orgId, ids.memory!)).status).toBe('active');
    clean('learned');
  });

  it('works through tasks with status tabs and a filter sheet, then opens one summary-first', async () => {
    await page.goto(`${origin}${base}/issues`);
    await page.getByRole('tab', { name: /Up next/ }).tap();
    await page.locator('.task-row', { hasText: 'Audit the pricing page' }).waitFor();
    await page.getByRole('tab', { name: /In progress/ }).tap();
    await page.locator('.task-row', { hasText: 'Draft launch emails' }).waitFor();
    await page.getByRole('button', { name: /Filter/ }).tap();
    await page.getByRole('dialog').getByLabel('Assignee').selectOption({ label: 'Sam Ortiz' });
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).tap();
    await page.getByRole('tab', { name: /Up next/ }).tap();
    await page.locator('.task-row', { hasText: 'Audit the pricing page' }).tap();
    await page.locator('.brief').waitFor();
    await page.getByRole('tab', { name: 'Details' }).tap();
    await page.getByRole('heading', { name: 'Description' }).waitFor();
    clean('tasks');
  });

  it('checks a goal and changes its status from the goal sheet', async () => {
    await page.goto(`${origin}${base}/goals`);
    await page.getByRole('button', { name: 'Reach 1,000 signups' }).tap();
    const sheet = page.getByRole('dialog');
    await sheet.getByText('Open tasks').waitFor();
    await sheet.getByRole('radio', { name: 'Achieved' }).tap();
    await expect.poll(() => services.work.listGoals(orgId).find((g) => g.title === 'Reach 1,000 signups')?.status).toBe('achieved');
    clean('goals');
  });

  it('activates an agent-written skill from the review queue', async () => {
    await page.goto(`${origin}${base}/skills`);
    await page.locator('.review-queue').getByRole('button', { name: 'Activate anyway' }).tap();
    await page.locator('.review-queue').waitFor({ state: 'detached' });
    expect(services.skills.get(ids.skill!).status).toBe('active');
    clean('skills');
  });

  it('finds a connector in the catalog and opens its install sheet', async () => {
    await page.goto(`${origin}${base}/connectors`);
    await page.getByRole('searchbox', { name: 'Search the catalog' }).fill('github');
    const hit = page.locator('.cat-card', { hasText: 'GitHub' }).first();
    await hit.getByRole('button', { name: 'Install' }).tap();
    await page.getByRole('dialog', { name: /Install GitHub/ }).waitFor();
    clean('connectors');
  });

  it('starts a new organization and lands in guided setup', async () => {
    await page.goto(`${origin}/new-org`);
    await page.getByRole('radio', { name: /From scratch/ }).tap();
    await page.locator('#org-name').fill('Phone Co');
    await page.getByRole('button', { name: /Create and start setup/ }).tap();
    await page.getByRole('heading', { name: 'Tell the team how you work' }).waitFor();
    await page.getByRole('textbox', { name: 'Your answer' }).fill('Bookkeeping for bakeries.');
    await page.getByRole('button', { name: 'Send' }).tap();
    await page.getByText('Bookkeeping for bakeries.').waitFor();
    const org = services.org.getOrgBySlug('phone-co')!;
    await expect.poll(async () => (await api.app.inject({ method: 'GET', url: `/api/v1/orgs/${org.id}/onboarding`, headers: { authorization: `Bearer ${services.governance.tokens.issueOwnerToken('check')}` } })).json().state?.answers?.length).toBe(1);
    clean('new organization');
  });
});
