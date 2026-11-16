import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServices } from '../../src/daemon/compose.js';
import { MemorySecretStore } from '../../src/kernel/index.js';
import { ConductorClient, createApiServer, type ApiServer } from '../../src/api/index.js';
import { DEFAULT_UI_DIR } from '../../src/api/static.js';
import type { AdapterRegistry } from '../../src/contracts/adapter.js';
import { OWNER } from '../../src/contracts/types.js';
import { startGateways, type Gateways } from '../../src/gateways/index.js';
import { startTelegramMock, type TelegramMock } from '../gateways/mock-servers.js';

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

/** No adapter at all: whatever a test clicks, no provider CLI or API can ever be started. */
const NO_ADAPTERS: AdapterRegistry = { get: () => undefined, list: () => [], loadPlugins: async () => {} } as unknown as AdapterRegistry;

/** The agent's page: typing and clicking change both the page and its title, which the viewer shows under the live frame. */
const LOGIN_PAGE = `<!doctype html><title>Sign in to Analytics</title><body style="margin:0;height:100vh" onclick="if(event.target===this)document.title=document.getElementById('clicks').textContent='clicks:'+(++window.n)">
<form onsubmit="event.preventDefault();document.title=document.getElementById('out').textContent='submitted:'+document.getElementById('u').value">
<input id="u" autofocus><button>Sign in</button></form><p id="out">idle</p><p id="clicks">clicks:0</p><script>window.n=0;document.getElementById('u').focus()</script></body>`;

/**
 * The owner's flows that only exist in the browser, clicked for real against
 * the composed daemon: a browser takeover from the console, pairing a chat
 * with a messaging gateway, "Run now" telling the truth, the review verdict,
 * the kill switch, and live updates coming back after the daemon restarts.
 */
describe.skipIf(!ready)('web console flows', () => {
  const secrets = new MemorySecretStore();
  let home: string;
  let services: Awaited<ReturnType<typeof createServices>>;
  let gateways: Gateways;
  let api: ApiServer;
  let client: ConductorClient;
  let tg: TelegramMock;
  let site: http.Server;
  let browser: Browser;
  let page: Page;
  let origin: string;
  let port = 0;
  let orgId: string;
  let slug: string;
  let agent: { id: string; slug: string; deptId: string; name: string };
  const problems: string[] = [];
  let quiet = false;

  /** Compose the daemon on `home` and serve it; called again to simulate a daemon restart. */
  const boot = async (): Promise<void> => {
    services = await createServices({
      home, secrets, config: { port }, registry: NO_ADAPTERS, browserHeadless: true, watchPlugins: false,
      runtime: { systemJobs: false, powerAssertion: false },
    });
    gateways = await startGateways(services, { pollMs: 200 });
    api = await createApiServer(services, { uiDir: DEFAULT_UI_DIR, plugins: [gateways.routes], gateways });
    await api.listen('127.0.0.1', port);
    port = (api.app.server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;
    client = new ConductorClient({ baseUrl: origin, token: services.governance.tokens.issueOwnerToken('ui-flows') });
    await services.runtime.start();
  };
  const shutdown = async (): Promise<void> => {
    await gateways?.stop();
    await api?.close();
    await services?.close({ graceMs: 5000 });
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'conductor-ui-flows-'));
    await boot();
    const org = services.org.createOrg({ name: 'Flow Test Co', mission: 'Prove the flows work' }, OWNER);
    orgId = org.id;
    slug = org.slug;
    const dept = services.org.createDept(org.id, { name: 'Engineering', charter: 'Build' }, OWNER);
    const hired = services.org.hireAgent(org.id, { deptId: dept.id, name: 'Ada Tester', role: 'Engineer' }, OWNER).agent!;
    agent = { id: hired.id, slug: hired.slug, deptId: dept.id, name: hired.name };

    tg = await startTelegramMock();
    site = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(LOGIN_PAGE));
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      // The signed-out probe answers 401 by design; while the daemon is down every request fails by design.
      if (msg.type() !== 'error' || quiet || /status of 401/.test(msg.text())) return;
      problems.push(`console: ${msg.text()} (${msg.location().url})`);
    });
    await page.goto(origin);
    await page.getByLabel('Token').fill(services.governance.tokens.issueOwnerToken('ui-flows-browser'));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Flow Test Co', level: 1 }).waitFor();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await shutdown();
    await tg?.close();
    site?.closeAllConnections();
    site?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  }, 60_000);

  const dialog = () => page.locator('dialog[open]').last();
  const toast = async (text: RegExp): Promise<string> => {
    const t = page.locator('.toast', { hasText: text }).first();
    await t.waitFor();
    const said = (await t.textContent()) ?? '';
    await t.getByRole('button', { name: 'Dismiss' }).click();
    return said;
  };
  const clean = (where: string): void => {
    expect(problems, `console errors during ${where}`).toEqual([]);
  };

  it('takes over an agent browser from the console and hands it back', async () => {
    const runId = 'run_ui_flows_takeover';
    const ctx = { orgId, agentId: agent.id, deptId: agent.deptId, runId, issueId: null, workspacePath: home, autonomyLevel: 2 };
    const tools = services.browser.toolProvider();
    await tools.call(ctx, 'navigate', { url: `http://127.0.0.1:${(site.address() as AddressInfo).port}/` });
    const first = await services.browser.createTakeover({ orgId, agentId: agent.id, runId, issueId: null, reason: 'Login wall on the analytics dashboard' });

    // No messaging gateway exists: the console itself must offer the way in, with a link of its own.
    await page.goto(`${origin}/o/${slug}`);
    await page.getByText('needs you in its browser: Login wall on the analytics dashboard').waitFor();
    await page.getByRole('button', { name: 'Take over', exact: true }).click();
    await page.waitForURL(/\/takeover\//);
    expect(page.url()).not.toContain(first.token);
    await expect(client.claimTakeover(first.token)).rejects.toThrow(/share link rejected/);

    await page.getByRole('button', { name: 'Take control on this device' }).click();
    const canvas = page.locator('canvas.takeover-canvas:not([hidden])');
    await canvas.waitFor({ timeout: 20_000 });
    expect(services.browser.listSessions(orgId, { status: 'active' }).map((s) => s.id)).toEqual([first.session.id]);

    // The countdown is the session's real expiry, not a guess from the claim time.
    const clock = (await page.getByRole('timer').textContent()) ?? '';
    expect(clock).toMatch(/^\d+:\d\d$/);
    const [min, sec] = clock.split(':').map(Number) as [number, number];
    expect(Math.abs(min * 60 + sec - (first.session.expiresAt - Date.now()) / 1000)).toBeLessThan(5);

    // Typed text and a click reach the page, and the frames that come back show the result.
    await page.getByLabel('Text to type into the page').fill('ada@example.com');
    await page.getByRole('button', { name: 'Type and Enter' }).click();
    await page.locator('.takeover-url').getByText('submitted:ada@example.com').waitFor();
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
    await page.locator('.takeover-url').getByText('clicks:1').waitFor();
    const read = async (): Promise<string> => JSON.stringify(await tools.call(ctx, 'evaluate', { script: "document.getElementById('out').textContent + '|' + document.getElementById('clicks').textContent" }));

    await page.getByRole('button', { name: 'Hand back' }).click();
    await page.getByRole('heading', { name: 'Handed back' }).waitFor();
    expect(services.browser.listSessions(orgId, { status: 'handed_back' }).map((s) => s.id)).toEqual([first.session.id]);
    // The agent has its page again, with what the owner clicked and typed in it.
    const state = await read();
    expect(state).toContain('submitted:ada@example.com');
    expect(state).toContain('clicks:1');
    await services.browser.endRun(runId);

    await page.goto(`${origin}/o/${slug}`);
    await page.getByRole('heading', { name: 'Needs you' }).waitFor();
    expect(await page.getByRole('button', { name: 'Take over', exact: true }).count()).toBe(0);
    clean('the takeover');
  }, 90_000);

  it('takes over from a phone: from Needs you into the browser and back, without sideways scrolling', async () => {
    const runId = 'run_ui_flows_takeover_phone';
    const ctx = { orgId, agentId: agent.id, deptId: agent.deptId, runId, issueId: null, workspacePath: home, autonomyLevel: 2 };
    const tools = services.browser.toolProvider();
    await tools.call(ctx, 'navigate', { url: `http://127.0.0.1:${(site.address() as AddressInfo).port}/` });
    await services.browser.createTakeover({ orgId, agentId: agent.id, runId, issueId: null, reason: 'Two-factor code on the bank portal' });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    try {
      await page.goto(`${origin}/o/${slug}/inbox`);
      await page.getByText('needs you in its browser: Two-factor code on the bank portal').waitFor();
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.getByRole('button', { name: 'Take over', exact: true }).click();
      await page.waitForURL(/\/takeover\//);
      await page.getByRole('button', { name: 'Take control on this device' }).click();
      const canvas = page.locator('canvas.takeover-canvas:not([hidden])');
      await canvas.waitFor({ timeout: 20_000 });
      // A desktop page shown whole is unreadable on a phone, so the view starts zoomed in, inside a stage that
      // fits the screen and pans; the console itself never scrolls sideways.
      await page.getByRole('radio', { name: 'Finger moves view' }).waitFor();
      expect((await page.locator('.takeover-stage').boundingBox())!.width).toBeLessThanOrEqual(390);
      expect((await canvas.boundingBox())!.width).toBeGreaterThan(390);
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.getByLabel('Text to type into the page').fill('482913');
      await page.getByRole('button', { name: 'Type and Enter' }).click();
      await page.locator('.takeover-url').getByText('submitted:482913').waitFor();
      await page.getByRole('button', { name: 'Hand back' }).click();
      await page.getByRole('heading', { name: 'Handed back' }).waitFor();
      await services.browser.endRun(runId);
      clean('the phone takeover');
    } finally {
      await page.setViewportSize({ width: 1280, height: 720 });
    }
  }, 90_000);

  it('pairs a chat with a Telegram gateway created in settings', async () => {
    await page.goto(`${origin}/o/${slug}/settings/gateways`);
    await page.getByRole('button', { name: 'Add gateway' }).click();
    await dialog().getByLabel('Name', { exact: true }).fill('Owner Telegram');
    await dialog().getByLabel('Bot token').fill(tg.token);
    await dialog().locator('summary', { hasText: 'Advanced platform settings' }).click();
    await dialog().getByLabel('Other non-secret config').fill(JSON.stringify({ apiBaseUrl: tg.url }));
    await dialog().getByRole('button', { name: 'Add gateway' }).click();
    await toast(/Gateway added/);

    const row = page.locator('li.connector', { hasText: 'Owner Telegram' });
    await row.getByText('Connected', { exact: true }).waitFor();
    const [gateway] = await client.listGateways();
    expect(gateways.status().find((s) => s.id === gateway!.id)?.status).toBe('active');

    await row.getByRole('button', { name: 'Pair a chat' }).click();
    const command = (await dialog().getByLabel('Pairing command').textContent()) ?? '';
    expect(command).toMatch(/^\/pair [A-Z0-9]{6,}$/);
    // Ten minutes, counting down, and never more than the full ten.
    const shown = (await dialog().getByText(/Expires in \d+:\d\d/).textContent()) ?? '';
    const [, m, s] = /Expires in (\d+):(\d\d)/.exec(shown)!;
    expect(Number(m) * 60 + Number(s)).toBeGreaterThan(590);
    expect(Number(m) * 60 + Number(s)).toBeLessThanOrEqual(600);

    tg.pushMessage(4242, 7, command);
    await dialog().getByText('Paired.').waitFor();
    expect(((await client.getGateway(gateway!.id)).config.allowedChatIds as unknown[]).map(String)).toEqual(['4242']);
    await dialog().getByRole('button', { name: 'Done' }).click();
    await row.getByText('1 allowed chats').waitFor();
    await row.getByText('Connected', { exact: true }).waitFor();
    clean('gateway pairing');
  }, 60_000);

  it('says why Run now started nothing, and engages and releases the kill switch', async () => {
    await page.goto(`${origin}/o/${slug}/agents/${agent.slug}`);
    await page.getByRole('button', { name: 'Run now' }).click();
    expect(await toast(/No run started/)).toMatch(/No run started for Ada Tester: no work/);
    expect(services.runtime.listRuns(orgId, { agentId: agent.id })).toEqual([]);

    await page.getByRole('button', { name: 'Kill switch' }).click();
    await dialog().getByRole('button', { name: 'Stop everything' }).click();
    await dialog().getByLabel('Type stop to confirm').fill('stop');
    await dialog().getByRole('button', { name: 'Stop all runs' }).click();
    await page.getByRole('button', { name: 'All runs stopped' }).waitFor();
    expect((await client.status()).killSwitch.global).toBe(true);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Run now' }).click();
    expect(await toast(/No run started/)).toMatch(/kill switch engaged\. It will run when that clears\./);

    await page.getByRole('button', { name: 'All runs stopped' }).click();
    await dialog().getByRole('button', { name: 'Release' }).first().click();
    await page.locator('header.strip').getByRole('button', { name: 'Kill switch' }).waitFor();
    expect((await client.status()).killSwitch.global).toBe(false);
    await page.keyboard.press('Escape');
    clean('run now and the kill switch');
  }, 60_000);

  it('accepts one review and sends another back with a note', async () => {
    const inReview = async (title: string) => {
      const issue = await client.createIssue(orgId, { title, status: 'todo' });
      await client.updateIssue(orgId, issue.id, { status: 'in_progress' });
      return client.updateIssue(orgId, issue.id, { status: 'in_review' });
    };
    const good = await inReview('Ship the pricing page');
    const bad = await inReview('Draft the launch email');

    // The task's summary carries the verdict: Accept, or Changes plus a note to send it back.
    await page.goto(`${origin}/o/${slug}/issues/${good.number}`);
    await page.locator('.brief').getByRole('button', { name: 'Accept' }).click();
    await toast(/Accepted and closed/);
    expect(await client.getIssue(orgId, good.id)).toMatchObject({ status: 'done', reviewOutcome: 'accepted' });

    await page.goto(`${origin}/o/${slug}/issues/${bad.number}`);
    await page.locator('.brief').getByRole('button', { name: 'Changes' }).click();
    await page.locator('.brief').getByLabel('Note for the agent').fill('Lead with the customer problem.');
    await page.locator('.brief').getByRole('button', { name: 'Send back' }).click();
    await toast(/Sent back with your note/);
    const sentBack = await client.getIssue(orgId, bad.id);
    expect(sentBack.reviewOutcome).toBe('rejected');
    expect(['todo', 'in_progress']).toContain(sentBack.status);
    expect((await client.listComments(orgId, bad.id)).some((c) => c.body.includes('Lead with the customer problem.'))).toBe(true);
    await page.locator('.timeline').getByText('Lead with the customer problem.').first().waitFor();
    clean('reviews');
  }, 60_000);

  it('gets live updates back after the daemon restarts, without a reload', async () => {
    await page.goto(`${origin}/o/${slug}`);
    await page.getByRole('heading', { name: 'Goals' }).waitFor();
    await page.evaluate(() => {
      (window as unknown as { marker?: string }).marker = 'same document';
    });

    quiet = true;
    await shutdown();
    await page.getByText('Reconnecting').waitFor({ timeout: 30_000 });
    await boot();
    await page.getByText('Reconnecting').waitFor({ state: 'detached', timeout: 30_000 });
    quiet = false;

    await client.createGoal(orgId, { title: 'Announced after the restart', level: 'org' });
    await page.getByText('Announced after the restart').first().waitFor();
    expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe('same document');
    clean('the reconnect');
  }, 120_000);
});
