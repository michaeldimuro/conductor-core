import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { BuiltinToolProvider, ToolCallContext, ToolDef, ToolResult } from '../contracts/tools.js';
import { AUTONOMY } from '../contracts/types.js';
import { invalid, notFound } from '../shared/errors.js';
import { sha256, truncate } from '../shared/util.js';
import { checkNavigation, hostOf } from './domains.js';
import type { RunBrowser } from './engine.js';
import { ATTRIBUTES_JS, LINKS_JS, MARK_SECRET_JS, SECRET_FIELDS_SELECTOR, TABLES_JS } from './page-scripts.js';
import { touchesSensitiveDomain } from './sensitive.js';
import type { TakeoverManager } from './takeover.js';
import { isToolName, toolDefs, type ToolName } from './tool-defs.js';
import {
  actAndSettle, afterAction, errorResult, failure, gateElementAction, hasTarget, locate, locateField, pageResult, parseArgs,
  publicUrl, runAgentScript, safeFileName, workspaceFile, workspaceRelative, type Call, type ToolEnv,
} from './tool-runtime.js';

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
type Handler = (c: Call, args: unknown) => Promise<ToolResult>;

const agentActor = (c: Call) => ({ kind: 'agent' as const, id: c.ctx.agentId, runId: c.ctx.runId });

const handlers: Record<Exclude<ToolName, 'request_human'>, Handler> = {
  async navigate(c, args) {
    const a = parseArgs('navigate', args);
    const check = checkNavigation(a.url, c.env.engine.profileOf(c.rb).domainAllowlist);
    if (!check.ok) {
      c.env.kernel.audit.record({
        orgId: c.ctx.orgId, actor: agentActor(c), action: 'browser.navigation_blocked', entityKind: 'browser_profile', entityId: c.rb.profileId,
        runId: c.ctx.runId, data: { host: hostOf(a.url), why: check.reason },
      });
      return errorResult(check.reason);
    }
    const resp = await c.page.goto(check.url, { waitUntil: a.waitUntil });
    return afterAction(c, { status: resp?.status() ?? null });
  },

  async snapshot(c) {
    const tree = await c.page.ariaSnapshot({ mode: 'ai' });
    return pageResult(c, `url: ${c.page.url()}\ntitle: ${await c.page.title().catch(() => '')}\n\n${tree}`);
  },

  async click(c, args) {
    const a = parseArgs('click', args);
    const loc = locate(c.page, a);
    const gated = await gateElementAction(c, loc, 'click');
    if (gated) return gated;
    await actAndSettle(c.page, () => loc.click({ button: a.button, clickCount: a.doubleClick ? 2 : 1 }));
    return afterAction(c, { clicked: true });
  },

  async type(c, args) {
    const a = parseArgs('type', args);
    const loc = locate(c.page, a);
    if (a.submit) {
      const gated = await gateElementAction(c, loc, 'submit');
      if (gated) return gated;
    }
    await actAndSettle(c.page, async () => {
      if (a.clear) await loc.fill(a.text);
      else await loc.pressSequentially(a.text);
      if (a.submit) await loc.press('Enter');
    });
    return afterAction(c, { typed: true, submitted: a.submit });
  },

  async select(c, args) {
    const a = parseArgs('select', args);
    const loc = locate(c.page, a);
    let selected: string[] = [];
    await actAndSettle(c.page, async () => {
      try {
        selected = await loc.selectOption(a.values, { timeout: 3000 });
      } catch {
        selected = await loc.selectOption(a.values.map((label) => ({ label })));
      }
    });
    return afterAction(c, { selected });
  },

  async screenshot(c, args) {
    const a = parseArgs('screenshot', args);
    const mask = [c.page.locator(SECRET_FIELDS_SELECTOR)];
    const buf = hasTarget(a)
      ? await locate(c.page, a).screenshot({ type: a.format, mask })
      : await c.page.screenshot({ type: a.format, fullPage: a.fullPage, mask });
    return pageResult(c, `Screenshot of ${c.page.url()}`, {
      extra: [{ type: 'image', data: buf.toString('base64'), mimeType: a.format === 'png' ? 'image/png' : 'image/jpeg' }],
    });
  },

  async extract(c, args) {
    const a = parseArgs('extract', args);
    const root = hasTarget(a) ? locate(c.page, a) : c.page.locator('body');
    const many = a.all && a.selector ? c.page.locator(a.selector) : null;
    let value: unknown;
    if (a.kind === 'text') value = many ? await many.allInnerTexts() : await root.innerText();
    else if (a.kind === 'links') value = await root.evaluate(LINKS_JS);
    else if (a.kind === 'tables') value = await root.evaluate(TABLES_JS);
    else {
      if (!a.attribute) throw invalid('extract: `attribute` is required when kind is "attribute"');
      const values = await (many ?? root).evaluateAll(ATTRIBUTES_JS, a.attribute);
      if (!many && values.length === 0) throw invalid('extract: no element matched');
      value = many ? values : values[0];
    }
    return pageResult(c, value, { maxChars: a.maxChars });
  },

  async download(c, args) {
    const a = parseArgs('download', args);
    const ws = c.ctx.workspacePath;
    const dest = (suggested: string) => workspaceFile(ws, a.path ?? join('downloads', safeFileName(suggested)), 'write');
    if (a.path) dest(''); // refuse an escaping destination before touching the network
    if (a.url) {
      let url = a.url;
      for (let hop = 0; ; hop++) {
        const check = checkNavigation(url, c.env.engine.profileOf(c.rb).domainAllowlist);
        if (!check.ok) return errorResult(check.reason.replace('navigation', 'download'));
        const resp = await c.rb.context.request.get(check.url, { maxRedirects: 0 });
        const location = resp.headers()['location'];
        if (resp.status() >= 300 && resp.status() < 400 && location) {
          await resp.dispose();
          if (hop >= 5) return errorResult('download failed: too many redirects');
          url = new URL(location, check.url).toString();
          continue;
        }
        if (!resp.ok()) return errorResult(`download failed: HTTP ${resp.status()}`);
        const body = await resp.body();
        if (body.length > MAX_DOWNLOAD_BYTES) return errorResult('download failed: file is larger than 200 MB');
        const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(resp.headers()['content-disposition'] ?? '')?.[1];
        const file = dest(named ? decodeURIComponent(named) : new URL(check.url).pathname.split('/').pop() || 'download');
        writeFileSync(file, body);
        return pageResult(c, { saved: workspaceRelative(ws, file), bytes: body.length, from: publicUrl(check.url) });
      }
    }
    const loc = locate(c.page, a);
    const gated = await gateElementAction(c, loc, 'click');
    if (gated) return gated;
    const [dl] = await Promise.all([c.page.waitForEvent('download'), loc.click()]);
    const file = dest(dl.suggestedFilename());
    await dl.saveAs(file);
    return pageResult(c, { saved: workspaceRelative(ws, file), bytes: statSync(file).size, suggestedFilename: dl.suggestedFilename() });
  },

  async upload(c, args) {
    const a = parseArgs('upload', args);
    const files = a.paths.map((p) => workspaceFile(c.ctx.workspacePath, p, 'read'));
    await locate(c.page, a).setInputFiles(files);
    return afterAction(c, { uploaded: a.paths });
  },

  async tabs(c, args) {
    const a = parseArgs('tabs', args);
    const { engine } = c.env;
    const pick = (): Page => {
      const p = a.index === undefined ? undefined : engine.pages(c.rb)[a.index];
      if (!p) throw invalid(`tabs: no tab with index ${a.index ?? '(missing)'}`);
      return p;
    };
    if (a.action === 'new') {
      const check = a.url ? checkNavigation(a.url, engine.profileOf(c.rb).domainAllowlist) : null;
      if (check && !check.ok) return errorResult(check.reason);
      const page = await c.rb.context.newPage();
      c.rb.ownedPages.add(page);
      c.rb.page = page;
      if (check?.ok) await page.goto(check.url);
    } else if (a.action === 'switch') {
      c.rb.page = pick();
      await c.rb.page.bringToFront().catch(() => {});
    } else if (a.action === 'close') {
      await (a.index === undefined ? c.page : pick()).close();
    }
    const active = await engine.activePage(c.rb);
    c.page = active;
    const parked = await engine.enforceAllowlist(c.rb, active);
    c.rb.blockedHosts = [];
    if (parked) return errorResult(`navigation blocked: ${parked} is not on this browser profile's domain allowlist`);
    const tabs = await Promise.all(engine.pages(c.rb).map(async (p, index) => ({
      index, url: p.url(), title: await p.title().catch(() => ''), active: p === active,
    })));
    return pageResult(c, { tabs });
  },

  async evaluate(c, args) {
    const a = parseArgs('evaluate', args);
    const profile = c.env.engine.profileOf(c.rb);
    const host = hostOf(c.page.url()) ?? '';
    const scriptSha256 = sha256(a.script);
    if (touchesSensitiveDomain(profile, c.page.url())) {
      const gated = c.env.gate.check({
        ctx: c.ctx, profile, pageUrl: c.page.url(), descriptor: `evaluate|${scriptSha256}`,
        title: `Run a script on ${host}`,
        detail: { action: 'evaluate', url: publicUrl(c.page.url()), scriptSha256, scriptPreview: c.env.engine.scrub(c.rb, truncate(a.script, 400)) },
      });
      if (gated) return gated;
    }
    c.env.kernel.audit.record({
      orgId: c.ctx.orgId, actor: agentActor(c), action: 'browser.evaluate', entityKind: 'browser_profile', entityId: c.rb.profileId,
      runId: c.ctx.runId, issueId: c.ctx.issueId ?? undefined, data: { host, scriptSha256 },
    });
    let value: unknown;
    await actAndSettle(c.page, async () => {
      value = await runAgentScript(c.page, hasTarget(a) ? locate(c.page, a) : null, a.script);
    });
    return afterAction(c, { result: value ?? null });
  },

  async fill_secret(c, args) {
    const a = parseArgs('fill_secret', args);
    const ref = a.secret_ref;
    const prefix = `org/${c.env.org.getOrg(c.ctx.orgId).slug}/`;
    const audit = (action: string, data: Record<string, unknown>) => c.env.kernel.audit.record({
      orgId: c.ctx.orgId, actor: agentActor(c), action, entityKind: 'browser_profile', entityId: c.rb.profileId,
      runId: c.ctx.runId, issueId: c.ctx.issueId ?? undefined,
      data: { secretRef: ref, field: a.field, host: hostOf(c.page.url()), ...data },
    });
    // Org confinement: only this org's namespace, and never the browser service's own keys.
    if (!ref.startsWith(prefix) || ref.includes('..') || ref.startsWith(`${prefix}browser/`)) {
      audit('browser.secret_refused', { why: 'reference is outside this organization' });
      return errorResult(`secret reference ${ref} is not available to this organization (use ${prefix}…)`);
    }
    const value = await c.env.kernel.secrets.get(ref);
    if (value === null || value.length === 0) {
      audit('browser.secret_refused', { why: 'not found' });
      return errorResult(`secret reference ${ref} was not found`);
    }
    c.rb.secrets.add(value); // before touching the page, so even an error message cannot echo it
    const loc = locateField(c.page, a.field);
    await loc.fill(value);
    await loc.evaluate(MARK_SECRET_JS);
    audit('browser.secret_filled', {});
    return pageResult(c, { filled: true, field: a.field, secret_ref: ref });
  },
};

/** The `conductor-browser` builtin tool server. */
export function createToolProvider(env: ToolEnv, takeover: TakeoverManager): BuiltinToolProvider {
  return {
    id: 'conductor-browser',
    description: 'A real Chromium with persistent logins: navigate, read, click, type, download/upload, and ask a human to take over for logins, MFA or CAPTCHAs.',
    tools(ctx: ToolCallContext): ToolDef[] {
      return toolDefs(ctx.autonomyLevel);
    },
    async call(ctx: ToolCallContext, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
      if (!isToolName(tool)) throw notFound('conductor-browser tool', tool);
      let rb: RunBrowser | undefined = env.engine.peek(ctx.runId);
      try {
        if (tool === 'evaluate' && ctx.autonomyLevel < AUTONOMY.AUTONOMOUS) {
          return errorResult('evaluate is refused by policy below autonomy level 2 (Autonomous)');
        }
        // The agent is input-locked while a human has (or is being handed) control of the tab.
        const lock = takeover.lockReason(ctx.runId);
        if (lock) return errorResult(lock);
        if (tool === 'request_human') return await takeover.requestHuman(ctx, parseArgs('request_human', args).reason);
        parseArgs(tool, args); // reject bad input before launching a browser
        rb = await env.engine.acquire({ orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId });
        rb.blockedHosts = [];
        const page = await env.engine.activePage(rb);
        const parked = await env.engine.enforceAllowlist(rb, page);
        if (parked && tool !== 'navigate' && tool !== 'tabs') {
          return errorResult(`navigation blocked: ${parked} is not on this browser profile's domain allowlist`);
        }
        return await handlers[tool]({ ctx, rb, page, env }, args);
      } catch (e) {
        return failure(env, rb ?? env.engine.peek(ctx.runId), e);
      }
    },
  };
}
