import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServices } from '../../src/daemon/compose.js';
import { MemorySecretStore } from '../../src/kernel/index.js';
import { createApiServer, type ApiServer } from '../../src/api/index.js';
import { DEFAULT_UI_DIR } from '../../src/api/static.js';
import { execCli, type CliExec } from '../../src/adapters/shared/cli-exec.js';
import { OWNER } from '../../src/contracts/types.js';

const chromiumPath = (): string | null => {
  try {
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
};
const ready = existsSync(join(DEFAULT_UI_DIR, 'index.html')) && chromiumPath() !== null;

const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]
  --effort <level>     Effort level for the current session (low, medium, high, max)
  -p, --print          Print response and exit
  --model <model>      Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.
  -h, --help           Display help for command
`;

const CODEX_MODELS = {
  models: [
    { slug: 'gpt-fake-codex', display_name: 'GPT Fake Codex', priority: 1, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
    { slug: 'gpt-fake-mini', display_name: 'GPT Fake Mini', priority: 2, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
    { slug: 'gpt-old-hidden', display_name: 'Old Hidden', priority: 3, visibility: 'hide' },
  ],
};

/**
 * Fake `claude` and `codex` binaries: canned help, status and catalog; a device login that flips a state file.
 * The device login completes only once the test has seen its code (it writes `codex-approved`), the way a person
 * finishes signing in after reading it. A timed exit raced the page's polling on a loaded machine.
 */
function writeFakeClis(dir: string): { claude: string; codex: string; approve: string } {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'help.txt'), CLAUDE_HELP);
  writeFileSync(join(dir, 'models.json'), JSON.stringify(CODEX_MODELS));
  const state = join(dir, 'codex-logged-in');
  const approve = join(dir, 'codex-approved');
  const claude = join(dir, 'claude');
  writeFileSync(claude, `#!/bin/sh
case "$1" in
  --version) echo "9.9.9 (Claude Code)" ;;
  --help) cat "${join(dir, 'help.txt')}" ;;
  auth) if [ "$2" = status ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'; else echo "fake: refusing $*" >&2; exit 2; fi ;;
  *) echo "fake: unknown $*" >&2; exit 2 ;;
esac
`);
  const codex = join(dir, 'codex');
  writeFileSync(codex, `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "codex-cli 0.0.0-fake" ;;
  "debug models") cat "${join(dir, 'models.json')}" ;;
  "login status") if [ -f "${state}" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in"; exit 1; fi ;;
  "login --device-auth")
    echo "Follow these steps to sign in with ChatGPT using device code authorization:"
    echo "1. Open this link in your browser and sign in to your account"
    echo "   https://auth.openai.com/codex/device"
    echo "2. Enter this one-time code (expires in 15 minutes)"
    echo "   FAKE-CODE42"
    i=0
    while [ ! -f "${approve}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    touch "${state}"
    exit 0 ;;
  "logout "*) rm -f "${state}" ;;
  *) echo "fake: unknown $*" >&2; exit 2 ;;
esac
`);
  chmodSync(claude, 0o755);
  chmodSync(codex, 0o755);
  return { claude, codex, approve };
}

/**
 * Model dropdowns and provider logins in the built console, over the real API and
 * composed daemon, against fake CLIs only: the user's real Claude Code / Codex logins are never touched.
 */
describe.skipIf(!ready)('web console: models and provider accounts', () => {
  let home: string;
  let services: Awaited<ReturnType<typeof createServices>>;
  let api: ApiServer;
  let browser: Browser;
  let page: Page;
  let origin: string;
  let slug: string;
  let orgId: string;
  let codexAgent: { id: string; slug: string };
  let claudeAgent: { id: string; slug: string };
  const saved: Record<string, string | undefined> = {};
  const problems: string[] = [];
  /** Written once the test has read the device code: the fake login then completes. */
  let approveFile = '';

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'conductor-ui-models-'));
    // Isolate CLI state the daemon passes through, in case anything reached a real CLI.
    for (const v of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
      saved[v] = process.env[v];
      process.env[v] = mkdtempSync(join(home, `${v.toLowerCase()}-`));
    }
    const fakes = writeFakeClis(join(home, 'bin'));
    approveFile = fakes.approve;
    const cliExec: CliExec = (command, args, opts) => {
      const target = command === 'claude' || command === fakes.claude ? fakes.claude : command === 'codex' || command === fakes.codex ? fakes.codex : null;
      if (!target) return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: Object.assign(new Error('blocked in test'), { code: 'ENOENT' }) });
      return execCli(target, args, opts);
    };
    services = await createServices({
      home, secrets: new MemorySecretStore(), config: { port: 0 }, runtime: { powerAssertion: false, systemJobs: false },
      cliExec, cliCommands: fakes,
    });
    api = await createApiServer(services, { uiDir: DEFAULT_UI_DIR });
    await api.listen('127.0.0.1', 0);
    origin = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
    const token = services.governance.tokens.issueOwnerToken('ui-models');

    const org = services.org.createOrg({ name: 'Model Picker Co', mission: 'Pick models' }, OWNER);
    slug = org.slug;
    orgId = org.id;
    services.org.updateOrg(org.id, { defaultProvider: { adapter: 'claude_local' } }, OWNER);
    const dept = services.org.createDept(org.id, { name: 'Engineering', charter: 'Build' }, OWNER);
    codexAgent = services.org.hireAgent(org.id, { deptId: dept.id, name: 'Cody Codex', role: 'Engineer', providerBinding: { adapter: 'codex_local' } }, OWNER).agent!;
    claudeAgent = services.org.hireAgent(org.id, { deptId: dept.id, name: 'Claire Default', role: 'Writer' }, OWNER).agent!;

    browser = await chromium.launch({ headless: true });
    page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error' || /status of 401/.test(msg.text())) return;
      problems.push(`console: ${msg.text()} (${msg.location().url})`);
    });
    await page.goto(origin);
    await page.getByLabel('Token').fill(token);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Model Picker Co', level: 1 }).waitFor();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await api?.close();
    await services?.close();
    for (const [v, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[v];
      else process.env[v] = val;
    }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const optionLabels = (select: ReturnType<Page['getByLabel']>) => select.locator('option').allTextContents();

  it('picks a Codex model and effort from the catalog and saves them', async () => {
    await page.goto(`${origin}/o/${slug}/agents/${codexAgent.slug}`);
    await page.getByRole('button', { name: 'Edit' }).first().click();
    const dialog = page.getByRole('dialog');
    const model = dialog.getByLabel('Primary model', { exact: true });
    await expect.poll(() => optionLabels(model)).toContain('GPT Fake Codex (gpt-fake-codex)');
    expect(await optionLabels(model)).not.toContain('Old Hidden (gpt-old-hidden)');
    await dialog.getByRole('button', { name: /Show all models/ }).first().click();
    expect(await optionLabels(model)).toContain('Old Hidden (gpt-old-hidden)');

    const effort = dialog.getByLabel('Primary effort', { exact: true });
    await model.selectOption('gpt-fake-codex');
    expect(await optionLabels(effort)).toEqual(['Default (medium)', 'low', 'medium', 'high']);
    await effort.selectOption('high');
    // "high" is not offered by the mini model: switching resets it to Default.
    await model.selectOption('gpt-fake-mini');
    expect(await effort.inputValue()).toBe('');
    expect(await optionLabels(effort)).toEqual(['Default (low)', 'low', 'medium']);
    await effort.selectOption('medium');

    await dialog.getByLabel('Authentication').selectOption('api_key');
    await dialog.getByText('conductor/openai-api-key').first().waitFor();
    await dialog.getByLabel('Authentication').selectOption('login');

    await dialog.getByRole('button', { name: 'Save agent' }).click();
    await expect.poll(() => services.org.getAgent(orgId, codexAgent.id).providerBinding).toEqual({ adapter: 'codex_local', model: 'gpt-fake-mini', config: { reasoningEffort: 'medium' } });
    expect(problems).toEqual([]);
  });

  it('offers the Claude aliases for an agent that inherits the org default', async () => {
    await page.goto(`${origin}/o/${slug}/agents/${claudeAgent.slug}`);
    await page.getByRole('button', { name: 'Edit' }).first().click();
    const dialog = page.getByRole('dialog');
    const override = dialog.getByLabel('Model override', { exact: true });
    await expect.poll(() => optionLabels(override)).toEqual(expect.arrayContaining(['Fable (latest)', 'Opus (latest)', 'Sonnet (latest)', 'Custom model id…']));
    await override.selectOption('opus');
    await dialog.getByRole('button', { name: 'Save agent' }).click();
    await expect.poll(() => services.org.getAgent(orgId, claudeAgent.id).model).toBe('opus');

    // A saved id that is not in the catalog still shows as selected.
    services.org.updateAgent(orgId, claudeAgent.id, { model: 'my-private-model' }, OWNER);
    await page.reload();
    await page.getByRole('button', { name: 'Edit' }).first().click();
    const again = page.getByRole('dialog').getByLabel('Model override', { exact: true });
    await expect.poll(() => again.locator('option:checked').textContent()).toBe('my-private-model (custom)');
    expect(problems).toEqual([]);
  });

  it('shows both accounts and finishes a Codex device login', async () => {
    await page.goto(`${origin}/o/${slug}/settings/providers`);
    const claude = page.getByRole('region', { name: 'Claude Code account' });
    const codex = page.getByRole('region', { name: 'Codex account' });
    await claude.getByText('Logged in with Claude subscription', { exact: true }).waitFor();
    await claude.getByText('max', { exact: true }).waitFor();
    await claude.getByText(`org/${slug}/claude-oauth-token`).waitFor();
    await codex.getByText('Not logged in', { exact: true }).waitFor();

    await codex.getByRole('button', { name: 'Log in' }).click();
    await codex.getByText('Only at the Mac').waitFor();
    await codex.getByRole('radio', { name: /ChatGPT \(device code\)/ }).check();
    await codex.getByRole('button', { name: 'Start login' }).click();
    await codex.getByText('https://auth.openai.com/codex/device').waitFor();
    await codex.getByText('FAKE-CODE42').waitFor();
    writeFileSync(approveFile, ''); // the person finishes signing in
    await codex.getByRole('link', { name: 'Open the sign-in page' }).waitFor();
    await codex.getByText('Logged in with ChatGPT account', { exact: true }).waitFor({ timeout: 15_000 });
    expect(await codex.getByText('Logged in', { exact: true }).count()).toBe(1);
    expect(problems).toEqual([]);
  }, 30_000);

  it('fits a phone screen without horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.goto(`${origin}/o/${slug}/settings/providers`);
    await page.getByRole('region', { name: 'Codex account' }).getByText('Logged in with ChatGPT account', { exact: true }).waitFor();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.goto(`${origin}/o/${slug}/agents/${codexAgent.slug}`);
    // On a phone the agent's secondary actions sit behind Actions.
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('button', { name: 'Edit' }).first().click();
    await page.getByRole('dialog').getByLabel('Primary model', { exact: true }).waitFor();
    expect(await overflow()).toBeLessThanOrEqual(0);
    const dialogOverflow = await page.getByRole('dialog').evaluate((d) => {
      const body = d.querySelector('.modal-body');
      return body ? body.scrollWidth - body.clientWidth : 0;
    });
    expect(dialogOverflow).toBeLessThanOrEqual(0);
    expect(problems).toEqual([]);
  });
});
