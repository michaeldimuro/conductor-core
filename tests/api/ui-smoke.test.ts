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
 * The built console served by the real API over the composed daemon, driven
 * by a real browser: sign-in, the issue board, the approvals inbox and the
 * pages that carry the takeover, browser-profile and lifecycle controls must
 * render without a script error.
 */
describe.skipIf(!ready)('web console smoke test', () => {
  let home: string;
  let services: Awaited<ReturnType<typeof createServices>>;
  let api: ApiServer;
  let browser: Browser;
  let page: Page;
  let origin: string;
  let token: string;
  let slug: string;
  let agentSlug: string;
  const problems: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'conductor-ui-smoke-'));
    services = await createServices({ home, secrets: new MemorySecretStore(), config: { port: 0 }, runtime: { powerAssertion: false } });
    api = await createApiServer(services, { uiDir: DEFAULT_UI_DIR });
    await api.listen('127.0.0.1', 0);
    origin = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
    token = services.governance.tokens.issueOwnerToken('ui-smoke');

    // Seed through the services, exactly as the daemon would hold the data. No run is ever started.
    const org = services.org.createOrg({ name: 'Smoke Test Co', mission: 'Prove the console renders' }, OWNER);
    slug = org.slug;
    const dept = services.org.createDept(org.id, { name: 'Engineering', charter: 'Build' }, OWNER);
    const agent = services.org.hireAgent(org.id, { deptId: dept.id, name: 'Ada Tester', role: 'Engineer' }, OWNER).agent!;
    agentSlug = agent.slug;
    services.work.createIssue(org.id, { title: 'Render the issue board', assigneeAgentId: agent.id }, OWNER);
    services.governance.approvals.request({ orgId: org.id, kind: 'external_send', title: 'Send the launch email', payload: { to: 'customer@example.com' }, requesterAgentId: agent.id });

    browser = await chromium.launch({ headless: true });
    page = await (await browser.newContext()).newPage();
    // Fail on the locator that is missing, well inside the test timeout.
    page.setDefaultTimeout(8000);
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      // The signed-out probe of the session answers 401 by design; Chromium reports that as a console error.
      if (/status of 401/.test(msg.text())) return;
      problems.push(`console: ${msg.text()} (${msg.location().url})`);
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await api?.close();
    await services?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const clean = (where: string): void => {
    expect(problems, `console errors on ${where}`).toEqual([]);
  };

  it('signs in with the owner token', async () => {
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Sign in to this console' }).waitFor();
    await page.getByLabel('Token').fill(token);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Smoke Test Co', level: 1 }).waitFor();
    expect(await page.getByText('Conductor is exposed to your network').count()).toBe(0);
    clean('sign-in');
  });

  it('renders guided setup and the command palette', async () => {
    await page.goto(`${origin}/o/${slug}/setup/interview`);
    await page.getByRole('heading', { name: 'Tell the team how you work' }).waitFor();
    await page.getByRole('textbox', { name: 'Your answer' }).waitFor();
    await page.goto(`${origin}/o/${slug}/setup/guardrails`);
    await page.getByRole('radio', { name: /Balanced/ }).click();
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('issues');
    await page.getByRole('option', { name: /Issues/ }).first().waitFor();
    await page.keyboard.press('Escape');
    clean('guided setup');
  });

  it('renders the owner workflows: Today, Needs you, Team and the phone task list', async () => {
    await page.goto(`${origin}/o/${slug}`);
    await page.getByRole('heading', { name: 'Needs you' }).first().waitFor();
    await page.getByRole('heading', { name: 'Recently done' }).waitFor();
    await page.goto(`${origin}/o/${slug}/inbox`);
    await page.getByRole('heading', { name: 'Needs you', level: 1 }).waitFor();
    await page.getByRole('button', { name: 'Approve' }).first().waitFor();
    await page.goto(`${origin}/o/${slug}/team`);
    await page.getByText('Ada Tester').first().waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/o/${slug}/issues`);
    await page.getByRole('tablist', { name: 'Task status' }).waitFor();
    await page.getByRole('tab', { name: /Up next/ }).click();
    await page.getByText('Render the issue board').first().waitFor();
    await page.setViewportSize({ width: 1280, height: 720 });
    clean('owner workflows');
  });

  it('renders the issue board with the seeded issue', async () => {
    await page.goto(`${origin}/o/${slug}/issues`);
    await page.getByText('Render the issue board').first().waitFor();
    expect(await page.locator('.board').count()).toBe(1);
    clean('the issue board');
  });

  it('renders the approvals inbox with the pending approval', async () => {
    await page.goto(`${origin}/approvals`);
    await page.getByRole('heading', { name: 'Send the launch email' }).waitFor();
    expect(await page.getByRole('button', { name: 'Approve' }).count()).toBe(1);
    clean('approvals');
  });

  it('renders the pages that carry the new controls', async () => {
    await page.goto(`${origin}/o/${slug}/agents/${agentSlug}/browser`);
    await page.getByRole('heading', { name: 'Human takeovers' }).waitFor();
    await page.getByRole('button', { name: 'Create browser profile' }).click();
    await page.locator('select:has(option[value="chromium"])').selectOption('chrome');
    await page.locator('select:has(option[value="headed"])').selectOption('headed');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect.poll(() => services.browser.listProfiles(services.org.getOrgBySlug(slug)!.id).map((p) => p.engine)).toEqual(['channel:chrome']);

    await page.goto(`${origin}/o/${slug}/agents/${agentSlug}/memory`);
    await page.getByRole('radio', { name: /Review queue/ }).click();
    await page.getByText('The review queue is empty').waitFor();

    await page.goto(`${origin}/o/${slug}/goals`);
    await page.getByRole('heading', { name: 'Goals', level: 1 }).waitFor();
    await page.goto(`${origin}/o/${slug}/settings/organization`);
    await page.getByText('External memory backend').waitFor();
    await page.locator('select:has(option[value="mem0"])').waitFor();
    await page.goto(`${origin}/o/${slug}/settings/gateways`);
    await page.getByText('No messaging gateway is connected').waitFor();
    await page.goto(`${origin}/o/${slug}/settings/playbooks`);
    await page.getByRole('button', { name: 'New playbook' }).waitFor();
    clean('agent, goals and settings pages');
  });
});
