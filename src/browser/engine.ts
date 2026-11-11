import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Kernel } from '../contracts/kernel.js';
import type { BrowserProfile } from '../contracts/rows.js';
import { SYSTEM } from '../contracts/types.js';
import { ConductorError, errorMessage, forbidden } from '../shared/errors.js';
import { redact } from '../shared/util.js';
import { scrubPlaintextStores } from './at-rest.js';
import { decryptJar, encryptJar } from './crypto.js';
import { hostOf, isUrlAllowed } from './domains.js';
import { SENSITIVE_VALUES_JS } from './page-scripts.js';
import type { ProfileSettings, ProfileStore } from './profiles.js';

export const COOKIE_JAR_FILE = 'cookies.enc';

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** One run's live browser: a leased profile, its context and the tab the agent is on. */
export interface RunBrowser {
  readonly runId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly profileId: string;
  readonly profileDir: string;
  readonly context: BrowserContext;
  /** Set when attached to an external Chrome over CDP (we disconnect instead of closing it). */
  readonly browser: Browser | null;
  readonly ownedPages: Set<Page>;
  page: Page;
  /** Hosts the navigation guard refused since the current tool call started. */
  blockedHosts: string[];
  /** Values that must never appear in tool output for the rest of the run (filled secrets, password fields). */
  readonly secrets: Set<string>;
}

export interface EngineOptions {
  headless: boolean;
  actionTimeoutMs?: number;
  navigationTimeoutMs?: number;
}

export interface RunIdentity {
  orgId: string;
  agentId: string;
  runId: string;
}

/** Launches and tears down per-run browser contexts over leased persistent profiles. */
export class BrowserEngine {
  private readonly runs = new Map<string, RunBrowser>();
  private readonly launching = new Map<string, Promise<RunBrowser>>();

  constructor(private readonly kernel: Kernel, private readonly profiles: ProfileStore, private readonly opts: EngineOptions) {}

  peek(runId: string): RunBrowser | undefined {
    return this.runs.get(runId);
  }

  liveRunIds(): string[] {
    return [...this.runs.keys()];
  }

  /** The run's browser, launching it (and taking the profile lease) on first use. */
  async acquire(id: RunIdentity): Promise<RunBrowser> {
    const existing = this.runs.get(id.runId) ?? (await this.launching.get(id.runId));
    if (existing) {
      if (existing.orgId !== id.orgId || existing.agentId !== id.agentId) throw forbidden('browser session belongs to another agent');
      return existing;
    }
    const p = this.launch(id).finally(() => this.launching.delete(id.runId));
    this.launching.set(id.runId, p);
    return p;
  }

  private async launch(id: RunIdentity): Promise<RunBrowser> {
    const profile = this.profiles.ensure(id.orgId, id.agentId);
    this.profiles.acquireLease(id.orgId, profile.id, id.runId);
    try {
      const dir = this.profiles.dir(profile);
      const settings = this.profiles.settings(profile);
      const engine = settings.engine;
      let context: BrowserContext;
      let browser: Browser | null = null;
      if (engine.kind === 'cdp') {
        browser = await chromium.connectOverCDP(engine.endpoint);
        const first = browser.contexts()[0];
        if (!first) {
          await browser.close().catch(() => {});
          throw new ConductorError('unavailable', 'the Chrome at the CDP endpoint exposes no browser context');
        }
        context = first;
      } else {
        context = await chromium.launchPersistentContext(dir, {
          // Per-profile headed mode wins over the daemon default (a visible window on this Mac).
          headless: settings.headed === null ? this.opts.headless : !settings.headed,
          viewport: { width: 1280, height: 800 },
          acceptDownloads: true,
          ...(engine.kind === 'channel' ? { channel: engine.channel } : {}),
        });
      }
      context.setDefaultTimeout(this.opts.actionTimeoutMs ?? 15_000);
      context.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs ?? 30_000);
      const ownedPages = new Set<Page>();
      // On an attached Chrome never hijack the user's own tabs: work in a tab of our own.
      const page = browser ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));
      ownedPages.add(page);
      const rb: RunBrowser = {
        runId: id.runId, orgId: id.orgId, agentId: id.agentId, profileId: profile.id, profileDir: dir,
        context, browser, ownedPages, page, blockedHosts: [], secrets: new Set(),
      };
      await this.restoreCookies(rb, profile);
      if (profile.domainAllowlist.length > 0) await this.installNavigationGuard(rb);
      context.on('page', (p) => {
        // Popups / target=_blank become the active tab so the agent follows the flow.
        rb.ownedPages.add(p);
        rb.page = p;
      });
      context.on('close', () => {
        if (this.runs.get(id.runId) !== rb) return;
        this.runs.delete(id.runId);
        this.profiles.releaseLease(rb.orgId, rb.profileId, rb.runId);
      });
      this.runs.set(id.runId, rb);
      this.kernel.audit.record({
        orgId: id.orgId, actor: { kind: 'agent', id: id.agentId, runId: id.runId }, action: 'browser.lease_acquired',
        entityKind: 'browser_profile', entityId: profile.id, runId: id.runId, data: { engine: engine.kind },
      });
      return rb;
    } catch (e) {
      this.profiles.releaseLease(id.orgId, profile.id, id.runId);
      throw e;
    }
  }

  /** Engine / headed / 1Password settings of the run's profile. */
  settingsOf(rb: RunBrowser): ProfileSettings {
    return this.profiles.settings(this.profileOf(rb));
  }

  /** Current profile row (allowlist / sensitive domains may be edited mid-run). */
  profileOf(rb: RunBrowser): BrowserProfile {
    return this.profiles.get(rb.orgId, rb.profileId);
  }

  /** The tab the agent is on; falls back to another open tab (or a new one) if it was closed. */
  async activePage(rb: RunBrowser): Promise<Page> {
    if (!rb.page.isClosed()) return rb.page;
    const open = [...rb.ownedPages].filter((p) => !p.isClosed());
    const next = open[open.length - 1] ?? (await rb.context.newPage());
    rb.ownedPages.add(next);
    rb.page = next;
    return next;
  }

  /** Tabs the run may see and control (on an attached Chrome: only the ones it opened). */
  pages(rb: RunBrowser): Page[] {
    for (const p of rb.ownedPages) if (p.isClosed()) rb.ownedPages.delete(p);
    return [...rb.ownedPages];
  }

  /** Block top-level document requests to hosts off the profile's allowlist. */
  private async installNavigationGuard(rb: RunBrowser): Promise<void> {
    await rb.context.route('**/*', async (route) => {
      const req = route.request();
      let topLevelDocument = false;
      try {
        topLevelDocument = req.isNavigationRequest() && req.frame().parentFrame() === null;
      } catch {
        /* service-worker requests have no frame */
      }
      if (topLevelDocument) {
        let allowlist: string[] = [];
        try {
          allowlist = this.profileOf(rb).domainAllowlist;
        } catch {
          /* profile vanished: fail closed below only if we had a list */
        }
        const host = hostOf(req.url());
        if (allowlist.length > 0 && host !== null && !isUrlAllowed(req.url(), allowlist)) {
          this.kernel.audit.record({
            orgId: rb.orgId, actor: { kind: 'agent', id: rb.agentId, runId: rb.runId }, action: 'browser.navigation_blocked',
            entityKind: 'browser_profile', entityId: rb.profileId, runId: rb.runId, data: { host },
          });
          rb.blockedHosts.push(host);
          await route.abort('blockedbyclient').catch(() => {});
          return;
        }
      }
      await route.continue().catch(() => {});
    });
  }

  /**
   * Defence in depth for navigations the request guard cannot see (allowlist
   * added mid-run, history API): if the tab sits on an off-list host, park it
   * on about:blank and report the blocked host.
   */
  async enforceAllowlist(rb: RunBrowser, page: Page): Promise<string | null> {
    const allowlist = this.profileOf(rb).domainAllowlist;
    const url = page.url();
    if (isUrlAllowed(url, allowlist)) return null;
    await page.goto('about:blank').catch(() => {});
    return hostOf(url) ?? url.slice(0, 80);
  }

  /** Merge the encrypted at-rest jar into a live store that lost cookies (session cookies, wiped profile dir). */
  private async restoreCookies(rb: RunBrowser, profile: BrowserProfile): Promise<void> {
    const file = join(rb.profileDir, COOKIE_JAR_FILE);
    if (!existsSync(file)) return;
    try {
      const key = await this.profiles.cookieKey(profile, false);
      if (!key) throw new Error('cookie vault key is missing from the secret store');
      const state = JSON.parse(decryptJar(readFileSync(file), key)) as StorageState;
      const live = await rb.context.cookies();
      if (live.length === 0 && !rb.browser) {
        // Cookie store missing/empty: restore the full state (cookies + localStorage).
        try {
          await rb.context.setStorageState(state);
          return;
        } catch (e) {
          this.kernel.log.warn({ err: errorMessage(e), profileId: profile.id }, 'full storage-state restore failed; restoring cookies only');
        }
      }
      const has = new Set(live.map((c) => `${c.name}\n${c.domain}\n${c.path}`));
      const missing = state.cookies.filter((c) => !has.has(`${c.name}\n${c.domain}\n${c.path}`));
      if (missing.length > 0) await rb.context.addCookies(missing);
    } catch (e) {
      this.kernel.log.warn({ err: errorMessage(e), profileId: profile.id }, 'could not restore encrypted cookie jar');
    }
  }

  /** Export the context's storage state to `<profileDir>/cookies.enc` (AES-256-GCM, key in the secret store). */
  async flushCookies(rb: RunBrowser): Promise<void> {
    const state = await rb.context.storageState({ indexedDB: true });
    const key = await this.profiles.cookieKey(this.profileOf(rb), true);
    if (!key) throw new ConductorError('internal', 'could not obtain cookie vault key');
    const file = join(rb.profileDir, COOKIE_JAR_FILE);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, encryptJar(JSON.stringify(state), key), { mode: 0o600 });
    renameSync(tmp, file);
  }

  /**
   * Persist the storage state encrypted, close the context (or detach from an
   * external Chrome), remove Chromium's plaintext stores and release the lease.
   * At rest the profile directory then holds credentials only inside `cookies.enc`.
   */
  async close(runId: string): Promise<void> {
    await this.launching.get(runId)?.catch(() => {});
    const rb = this.runs.get(runId);
    if (!rb) return;
    this.runs.delete(runId);
    let sealed = false;
    try {
      await this.flushCookies(rb);
      sealed = true;
    } catch (e) {
      this.kernel.log.warn({ err: errorMessage(e), runId }, 'could not persist encrypted cookie jar');
    }
    try {
      if (rb.browser) {
        for (const p of rb.ownedPages) await p.close().catch(() => {});
        await rb.browser.close();
      } else {
        await rb.context.close();
        // Only when the jar was written: otherwise the plaintext store is the last copy of the login.
        if (sealed) {
          const { failed } = scrubPlaintextStores(rb.profileDir);
          if (failed.length > 0) this.kernel.log.warn({ runId, profileId: rb.profileId, failed: failed.length }, 'some plaintext browser stores could not be removed');
        } else {
          this.kernel.log.warn({ runId, profileId: rb.profileId }, 'browser profile left unencrypted at rest: the cookie jar could not be written');
        }
      }
    } catch (e) {
      this.kernel.log.warn({ err: errorMessage(e), runId }, 'browser context did not close cleanly');
    } finally {
      this.profiles.releaseLease(rb.orgId, rb.profileId, rb.runId);
      this.kernel.audit.record({
        orgId: rb.orgId, actor: SYSTEM, action: 'browser.lease_released', entityKind: 'browser_profile', entityId: rb.profileId, runId,
      });
    }
  }

  async closeAll(): Promise<void> {
    const ids = new Set([...this.runs.keys(), ...this.launching.keys()]);
    await Promise.all([...ids].map((id) => this.close(id)));
  }

  /** Remember what is currently typed into password / secret-filled fields so it can be redacted from output. */
  async collectSensitiveValues(rb: RunBrowser, page: Page): Promise<void> {
    for (const frame of page.frames()) {
      try {
        const values = await frame.evaluate(SENSITIVE_VALUES_JS);
        for (const v of values) if (typeof v === 'string' && v.length > 0) rb.secrets.add(v);
      } catch {
        /* detached or cross-process frame mid-navigation */
      }
    }
  }

  /** Redact every known secret value (raw, URL-encoded, JSON-escaped) plus anything credential-shaped. */
  scrub(rb: RunBrowser | undefined, text: string): string {
    let out = text;
    if (rb) {
      const needles = new Set<string>();
      const short: string[] = [];
      for (const s of rb.secrets) {
        if (s.length < 4) {
          short.push(s);
          continue;
        }
        needles.add(s);
        needles.add(encodeURIComponent(s));
        needles.add(JSON.stringify(s).slice(1, -1));
        needles.add(s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
      }
      for (const n of [...needles].sort((a, b) => b.length - a.length)) out = out.split(n).join('[REDACTED]');
      // Very short secrets (PINs) are only redacted as whole tokens so ordinary text survives.
      for (const s of short) {
        const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'g'), '[REDACTED]');
      }
    }
    return redact(out);
  }
}
