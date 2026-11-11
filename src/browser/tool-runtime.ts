import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, relative, sep } from 'node:path';
import type { Frame, Locator, Page } from 'playwright';
import type { z } from 'zod';
import type { Kernel } from '../contracts/kernel.js';
import type { ToolCallContext, ToolContent, ToolResult } from '../contracts/tools.js';
import { ConductorError, errorMessage, invalid, isConductorError } from '../shared/errors.js';
import { resolveInside } from '../shared/paths.js';
import { sleep, truncate } from '../shared/util.js';
import { hostOf } from './domains.js';
import type { BrowserEngine, RunBrowser } from './engine.js';
import { DESCRIBE_ELEMENT_JS, type ElementDescriptor } from './page-scripts.js';
import type { OrgLookup } from './profiles.js';
import { descriptorKey, looksLikeCommit, touchesSensitiveDomain, type ActionGate } from './sensitive.js';
import { schemas, type ToolArgs, type ToolName } from './tool-defs.js';

export interface ToolEnv {
  kernel: Kernel;
  engine: BrowserEngine;
  gate: ActionGate;
  org: OrgLookup;
}

/** Everything one tool invocation works with. */
export interface Call {
  ctx: ToolCallContext;
  rb: RunBrowser;
  page: Page;
  env: ToolEnv;
}

const REF_RE = /^(?:f\d+)?e\d+$/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function parseArgs<K extends ToolName>(tool: K, args: unknown): ToolArgs<K> {
  const r = (schemas[tool] as z.ZodType<ToolArgs<K>>).safeParse(args ?? {});
  if (!r.success) {
    throw invalid(`invalid arguments for ${tool}: ${r.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`);
  }
  return r.data;
}

export function hasTarget(t: { ref?: string; selector?: string }): boolean {
  return Boolean(t.ref ?? t.selector);
}

/** Resolve a snapshot ref or a selector to a single element. */
export function locate(page: Page, t: { ref?: string; selector?: string }): Locator {
  if (t.ref) return page.getByRef(t.ref);
  if (t.selector) return page.locator(t.selector).first();
  throw invalid('provide an element `ref` (from snapshot) or a `selector`');
}

/** `field` of fill_secret: a ref when it looks like one, else a selector. */
export function locateField(page: Page, field: string): Locator {
  return REF_RE.test(field) ? page.getByRef(field) : page.locator(field).first();
}

export function errorResult(text: string, untrusted = false): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true, ...(untrusted ? { untrusted: true } : {}) };
}

/** Page-derived output: secrets redacted, marked untrusted. */
export async function pageResult(c: Call, value: unknown, opts: { maxChars?: number; extra?: ToolContent[] } = {}): Promise<ToolResult> {
  await c.env.engine.collectSensitiveValues(c.rb, c.page);
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const text = truncate(c.env.engine.scrub(c.rb, raw), opts.maxChars ?? 100_000);
  return { content: [...(opts.extra ?? []), { type: 'text', text }], untrusted: true };
}

/** Turn any failure into a tool error the agent can read (never leaking a secret through an error message). */
export function failure(env: ToolEnv, rb: RunBrowser | undefined, e: unknown): ToolResult {
  if (isConductorError(e)) return errorResult(env.engine.scrub(rb, e.message));
  let msg = errorMessage(e).replace(ANSI_RE, '');
  if (msg.includes('ERR_BLOCKED_BY_CLIENT')) msg = "navigation blocked: the host is not on this browser profile's domain allowlist";
  else if (msg.includes('aria-ref=')) msg = `element ref not found on the current page — take a new snapshot and use a fresh ref. ${msg}`;
  return errorResult(truncate(env.engine.scrub(rb, msg), 1500), true);
}

/** URL without query/fragment (those can carry tokens) for audit and approval payloads. */
export function publicUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.slice(0, 200);
  }
}

/** Run an action, give a navigation it triggers a moment to commit, then wait for the document to load. */
export async function actAndSettle(page: Page, act: () => Promise<unknown>): Promise<void> {
  let onNav!: () => void;
  const navigated = new Promise<void>((r) => (onNav = r));
  const listener = (f: Frame): void => {
    if (f === page.mainFrame()) onNav();
  };
  page.on('framenavigated', listener);
  try {
    await act();
    await Promise.race([navigated, sleep(300)]);
  } finally {
    page.off('framenavigated', listener);
  }
  if (!page.isClosed()) await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
}

/**
 * After an acting tool: follow a popup if one opened, enforce the allowlist on
 * wherever the tab ended up, and report the resulting location.
 */
export async function afterAction(c: Call, payload: Record<string, unknown>): Promise<ToolResult> {
  const page = await c.env.engine.activePage(c.rb);
  c.page = page;
  const parked = await c.env.engine.enforceAllowlist(c.rb, page);
  const blocked = parked ?? c.rb.blockedHosts[0];
  c.rb.blockedHosts = [];
  if (blocked) {
    return errorResult(`navigation blocked: ${blocked} is not on this browser profile's domain allowlist. The action was performed but the navigation it triggered was refused.`);
  }
  return pageResult(c, { ...payload, url: page.url(), title: await page.title().catch(() => '') });
}

/**
 * Approval gate for a click (or an Enter-submit) on a sensitive domain.
 * Returns the result to hand back instead of acting, or null to proceed.
 */
export async function gateElementAction(c: Call, loc: Locator, action: 'click' | 'submit'): Promise<ToolResult | null> {
  const profile = c.env.engine.profileOf(c.rb);
  if (profile.sensitiveDomains.length === 0) return null;
  const d = await loc.evaluate<ElementDescriptor>(DESCRIBE_ELEMENT_JS);
  if (!touchesSensitiveDomain(profile, c.page.url(), d)) return null;
  if (action === 'click' ? !looksLikeCommit(d) : !d.inForm) return null;
  const host = hostOf(c.page.url()) ?? '';
  const what = d.text || d.label || d.name || d.id || d.tag;
  const scrub = (s: string) => c.env.engine.scrub(c.rb, s);
  return c.env.gate.check({
    ctx: c.ctx, profile, pageUrl: c.page.url(),
    descriptor: action === 'click' ? descriptorKey(d) : ['submit', d.tag, d.name, d.id, d.formAction ? publicUrl(d.formAction) : ''].join('|'),
    title: scrub(action === 'click' ? `Click "${what}" on ${host}` : `Submit the form via "${what}" on ${host}`),
    detail: {
      action, url: publicUrl(c.page.url()),
      element: { tag: d.tag, type: d.type, role: d.role, text: scrub(d.text), name: d.name, id: d.id, submitsForm: d.submits },
      formAction: d.formAction ? publicUrl(d.formAction) : null,
    },
  });
}

function insideReal(root: string, target: string): boolean {
  const base = realpathSync(root);
  // Resolve symlinks on the deepest existing ancestor so a link inside the workspace cannot point out of it.
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  const real = realpathSync(probe);
  return real === base || real.startsWith(base + sep);
}

/** Confine a caller-supplied path to the run workspace (no traversal, no symlink escape). */
export function workspaceFile(workspace: string, rel: string, mode: 'read' | 'write'): string {
  if (!workspace) throw new ConductorError('validation', 'this run has no workspace');
  mkdirSync(workspace, { recursive: true });
  const abs = resolveInside(workspace, rel);
  if (!insideReal(workspace, abs)) throw invalid(`path escapes root: ${rel}`);
  if (mode === 'read') {
    if (!existsSync(abs) || !statSync(abs).isFile()) throw invalid(`not a file in the run workspace: ${rel}`);
  } else {
    if (existsSync(abs) && statSync(abs).isDirectory()) throw invalid(`destination is a directory: ${rel}`);
    mkdirSync(dirname(abs), { recursive: true });
    if (!insideReal(workspace, abs)) throw invalid(`path escapes root: ${rel}`);
  }
  return abs;
}

export function workspaceRelative(workspace: string, abs: string): string {
  return relative(realpathSync(workspace), realpathSync(dirname(abs))) === ''
    ? basename(abs)
    : `${relative(realpathSync(workspace), realpathSync(dirname(abs)))}${sep}${basename(abs)}`;
}

/** A safe file name from a server-suggested one. */
export function safeFileName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'download';
}
