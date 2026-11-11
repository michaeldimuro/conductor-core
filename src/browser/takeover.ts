import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { browserSessions } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { BrowserSession } from '../contracts/rows.js';
import type { BrowserInputEvent, BrowserService, RunControl } from '../contracts/services.js';
import type { ToolCallContext, ToolResult } from '../contracts/tools.js';
import { SYSTEM, type Actor } from '../contracts/types.js';
import { ConductorError, conflict, errorMessage, forbidden, invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { sha256 } from '../shared/util.js';
import { mintShareToken, newKey, verifyShareToken } from './crypto.js';
import type { BrowserEngine } from './engine.js';
import type { OrgLookup } from './profiles.js';
import { inputEventSchema, ViewerLink } from './viewer.js';

export const SHARE_TTL_MS = 15 * 60_000;
export const SHARE_SIGNING_KEY_REF = 'conductor/share-signing-key';
const EXPIRY_POLL_MS = 200;

type Outcome = 'handed_back' | 'expired' | 'cancelled';
type ViewerIo = Parameters<BrowserService['attachViewer']>[2];

interface LiveTakeover {
  sessionId: string;
  orgId: string;
  runId: string;
  expiresAt: number;
  state: 'pending' | 'active';
  viewer: ViewerLink | null;
  done: Promise<Outcome>;
  settle: (o: Outcome) => void;
  timer: NodeJS.Timeout;
}

const createSchema = z.strictObject({
  orgId: z.string().min(1), agentId: z.string().min(1), runId: z.string().min(1),
  issueId: z.string().min(1).nullable(), reason: z.string().trim().min(1).max(500),
});
const viewerIdSchema = z.string().min(1).max(200);

/** Human-in-the-loop takeover sessions: one-time signed share links, single viewer, live view, hand-back. */
export class TakeoverManager {
  private readonly live = new Map<string, LiveTakeover>();
  private readonly byRun = new Map<string, LiveTakeover>();
  private signingKey: string | null = null;
  private readonly keyLoaded: Promise<void>;

  constructor(
    private readonly kernel: Kernel,
    private readonly engine: BrowserEngine,
    private readonly deps: { runControl: RunControl; org: OrgLookup; shareBaseUrl: () => string },
  ) {
    this.keyLoaded = kernel.secrets.get(SHARE_SIGNING_KEY_REF).then(
      (v) => void (this.signingKey ??= v),
      (e) => kernel.log.warn({ err: errorMessage(e) }, 'could not read the share signing key'),
    );
  }

  /** Signing key from the secret store, created on first use. */
  private async ensureKey(): Promise<string> {
    await this.keyLoaded;
    if (!this.signingKey) {
      const key = (await this.kernel.secrets.get(SHARE_SIGNING_KEY_REF)) ?? newKey();
      await this.kernel.secrets.set(SHARE_SIGNING_KEY_REF, key);
      this.signingKey ??= key;
    }
    return this.signingKey;
  }

  private row(sessionId: string): BrowserSession | undefined {
    return this.kernel.db.select().from(browserSessions).where(eq(browserSessions.id, sessionId)).get();
  }

  list(orgId: string, filter?: { status?: BrowserSession['status'] }): BrowserSession[] {
    return this.kernel.db.select().from(browserSessions)
      .where(and(eq(browserSessions.orgId, orgId), filter?.status ? eq(browserSessions.status, filter.status) : undefined))
      .orderBy(desc(browserSessions.createdAt), desc(browserSessions.id)).all();
  }

  /** Why the agent may not touch the page right now, or null when it has control. */
  lockReason(runId: string): string | null {
    const t = this.byRun.get(runId);
    if (!t) return null;
    return t.state === 'active'
      ? 'human has control of the browser; wait for hand-back'
      : 'human has control of the browser: a takeover was requested and is waiting for the human';
  }

  async create(input: Parameters<BrowserService['createTakeover']>[0]): Promise<{ session: BrowserSession; shareUrl: string; token: string }> {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw invalid(`takeover: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const v = parsed.data;
    if (this.byRun.has(v.runId)) throw conflict('a human takeover is already open for this run');
    const rb = await this.engine.acquire({ orgId: v.orgId, agentId: v.agentId, runId: v.runId });
    const key = await this.ensureKey();
    if (this.byRun.has(v.runId)) throw conflict('a human takeover is already open for this run');

    const token = mintShareToken(key);
    const now = this.kernel.clock.now();
    const id = newId('browserSession');
    const reason = this.engine.scrub(rb, v.reason);
    this.kernel.db.insert(browserSessions).values({
      id, orgId: v.orgId, profileId: rb.profileId, runId: v.runId, issueId: v.issueId, agentId: v.agentId, reason,
      tokenHash: sha256(token), expiresAt: now + SHARE_TTL_MS, status: 'pending', createdAt: now,
    }).run();

    let settle!: (o: Outcome) => void;
    const done = new Promise<Outcome>((r) => (settle = r));
    const t: LiveTakeover = {
      sessionId: id, orgId: v.orgId, runId: v.runId, expiresAt: now + SHARE_TTL_MS, state: 'pending', viewer: null, done, settle,
      // Polls the kernel clock (not a wall-clock timeout) so expiry follows the same clock as every stored timestamp.
      timer: setInterval(() => {
        if (this.kernel.clock.now() >= t.expiresAt) void this.finish(t, 'expired');
      }, EXPIRY_POLL_MS),
    };
    t.timer.unref?.();
    this.live.set(id, t);
    this.byRun.set(v.runId, t);
    this.kernel.audit.record({
      orgId: v.orgId, actor: { kind: 'agent', id: v.agentId, runId: v.runId }, action: 'browser.takeover_created',
      entityKind: 'browser_session', entityId: id, runId: v.runId, issueId: v.issueId ?? undefined,
      data: { profileId: rb.profileId, reason, expiresAt: t.expiresAt },
    });
    const base = this.deps.shareBaseUrl().replace(/\/+$/, '');
    return { session: this.row(id)!, shareUrl: `${base}/takeover/${token}`, token };
  }

  /**
   * Owner asks for the link again (no messaging gateway, lost notification, or
   * the wrong device claimed it): mint a fresh single-use token for the same
   * session. The previous token stops working, any attached viewer is dropped
   * and the session waits for its one viewer again. The expiry does not move.
   */
  async reissue(orgId: string, sessionId: string, actor: Actor): Promise<{ session: BrowserSession; shareUrl: string; token: string }> {
    const session = this.row(sessionId);
    if (!session || session.orgId !== orgId) throw notFound('takeover session', sessionId);
    const t = this.live.get(sessionId);
    if (t && this.kernel.clock.now() >= t.expiresAt) await this.finish(t, 'expired');
    if (!t || this.live.get(sessionId) !== t) {
      const status = this.row(sessionId)?.status ?? session.status;
      throw conflict(`this takeover is ${status === 'pending' || status === 'active' ? 'no longer live' : status.replace('_', ' ')}; the agent has to ask again`);
    }
    const key = await this.ensureKey();
    if (this.live.get(sessionId) !== t) throw conflict('this takeover ended while the link was being issued');
    const token = mintShareToken(key);
    const res = this.kernel.db.update(browserSessions)
      .set({ tokenHash: sha256(token), status: 'pending', viewerId: null, claimedAt: null })
      .where(and(eq(browserSessions.id, sessionId), eq(browserSessions.orgId, orgId), inArray(browserSessions.status, ['pending', 'active']))).run();
    if (res.changes !== 1) throw conflict('this takeover is no longer waiting for a human');
    t.state = 'pending';
    const viewer = t.viewer;
    t.viewer = null;
    await viewer?.stop().catch(() => {});
    this.kernel.audit.record({
      orgId, actor, action: 'browser.takeover_link_reissued', entityKind: 'browser_session', entityId: sessionId, runId: t.runId,
      issueId: session.issueId ?? undefined, data: { expiresAt: t.expiresAt },
    });
    const base = this.deps.shareBaseUrl().replace(/\/+$/, '');
    return { session: this.row(sessionId)!, shareUrl: `${base}/takeover/${token}`, token };
  }

  /** End a live takeover without a hand-back (expiry, run ended, shutdown). */
  private async finish(t: LiveTakeover, outcome: 'expired' | 'cancelled'): Promise<void> {
    if (this.live.get(t.sessionId) !== t) return;
    this.forget(t);
    this.kernel.db.update(browserSessions).set({ status: outcome })
      .where(and(eq(browserSessions.id, t.sessionId), inArray(browserSessions.status, ['pending', 'active']))).run();
    this.kernel.audit.record({
      orgId: t.orgId, actor: SYSTEM, action: `browser.takeover_${outcome}`, entityKind: 'browser_session', entityId: t.sessionId, runId: t.runId,
    });
    await t.viewer?.stop().catch(() => {});
    t.viewer = null;
    t.settle(outcome);
  }

  private forget(t: LiveTakeover): void {
    clearInterval(t.timer);
    this.live.delete(t.sessionId);
    if (this.byRun.get(t.runId) === t) this.byRun.delete(t.runId);
  }

  private reject(session: BrowserSession | undefined, why: string, viewerId: string): never {
    this.kernel.audit.record({
      orgId: session?.orgId ?? null, actor: { kind: 'human', id: viewerId.slice(0, 200) }, action: 'browser.takeover_claim_rejected',
      entityKind: 'browser_session', entityId: session?.id, runId: session?.runId ?? undefined, data: { why },
    });
    throw forbidden(`share link rejected: ${why}`);
  }

  /** Verify signature, TTL and status, then bind the session to its first (and only) viewer. */
  claim(token: string, viewerId: string): BrowserSession {
    if (!viewerIdSchema.safeParse(viewerId).success) throw invalid('viewerId is required');
    if (typeof token !== 'string' || !this.signingKey || !verifyShareToken(token, this.signingKey)) {
      return this.reject(undefined, 'invalid or tampered link', String(viewerId));
    }
    const session = this.kernel.db.select().from(browserSessions).where(eq(browserSessions.tokenHash, sha256(token))).get();
    if (!session) return this.reject(undefined, 'unknown link', viewerId);
    const t = this.live.get(session.id);
    if (this.kernel.clock.now() >= session.expiresAt) {
      if (t) void this.finish(t, 'expired');
      return this.reject(session, 'link expired', viewerId);
    }
    if (!t) return this.reject(session, 'session is no longer live', viewerId);
    if (session.status === 'pending') {
      const res = this.kernel.db.update(browserSessions)
        .set({ status: 'active', viewerId, claimedAt: this.kernel.clock.now() })
        .where(and(eq(browserSessions.id, session.id), eq(browserSessions.status, 'pending'), isNull(browserSessions.viewerId))).run();
      if (res.changes === 1) {
        t.state = 'active';
        this.kernel.audit.record({
          orgId: session.orgId, actor: { kind: 'human', id: viewerId }, action: 'browser.takeover_claimed',
          entityKind: 'browser_session', entityId: session.id, runId: session.runId ?? undefined,
        });
        return this.row(session.id)!;
      }
    }
    const current = this.row(session.id);
    // The claiming device may re-open its own link while it still holds control; nobody else, and never after hand-back.
    if (current && current.status === 'active' && current.viewerId === viewerId) return current;
    return this.reject(session, 'link already used', viewerId);
  }

  private activeFor(sessionId: string, viewerId: string): { t: LiveTakeover; session: BrowserSession } {
    const session = this.row(sessionId);
    const t = this.live.get(sessionId);
    if (!session || !t || session.status !== 'active' || session.viewerId !== viewerId || this.kernel.clock.now() >= session.expiresAt) {
      throw forbidden('not the active viewer of this takeover session');
    }
    return { t, session };
  }

  async attach(sessionId: string, viewerId: string, io: ViewerIo): Promise<{ input: (event: BrowserInputEvent) => Promise<void>; detach: () => Promise<void> }> {
    const { t, session } = this.activeFor(sessionId, viewerId);
    const rb = this.engine.peek(t.runId);
    if (!rb) throw new ConductorError('unavailable', 'the browser for this takeover session is no longer running');
    await t.viewer?.stop();
    const viewer = new ViewerLink(rb, this.engine, io.sendFrame, this.kernel.log);
    t.viewer = viewer;
    const detach = async (): Promise<void> => {
      if (t.viewer === viewer) t.viewer = null;
      await viewer.stop();
    };
    io.onClose(() => void detach().catch(() => {}));
    try {
      await viewer.start();
    } catch (e) {
      await detach().catch(() => {});
      throw new ConductorError('unavailable', `could not start the live view: ${errorMessage(e).split('\n')[0]}`);
    }
    this.kernel.audit.record({
      orgId: session.orgId, actor: { kind: 'human', id: viewerId }, action: 'browser.takeover_viewer_attached',
      entityKind: 'browser_session', entityId: sessionId, runId: t.runId,
    });
    return {
      input: async (event) => {
        if (t.viewer !== viewer || this.live.get(sessionId) !== t) throw forbidden('takeover session is no longer active');
        const parsed = inputEventSchema.safeParse(event);
        if (!parsed.success) throw invalid('invalid input event');
        await viewer.input(parsed.data);
      },
      detach,
    };
  }

  /** Human clicks "Hand back": stop the live view, persist cookies, unlock the agent, let the run continue. */
  async handBack(sessionId: string, viewerId: string): Promise<void> {
    const { t, session } = this.activeFor(sessionId, viewerId);
    await t.viewer?.stop().catch(() => {});
    t.viewer = null;
    const rb = this.engine.peek(t.runId);
    if (rb) {
      const page = await this.engine.activePage(rb);
      // Whatever the human typed into password fields must stay out of later tool output.
      await this.engine.collectSensitiveValues(rb, page);
      await this.engine.flushCookies(rb).catch((e) => this.kernel.log.warn({ err: errorMessage(e), sessionId }, 'could not persist cookies on hand-back'));
    }
    const res = this.kernel.db.update(browserSessions)
      .set({ status: 'handed_back', handedBackAt: this.kernel.clock.now() })
      .where(and(eq(browserSessions.id, sessionId), eq(browserSessions.status, 'active'), eq(browserSessions.viewerId, viewerId))).run();
    if (res.changes !== 1) throw forbidden('not the active viewer of this takeover session');
    this.forget(t);
    this.kernel.audit.record({
      orgId: session.orgId, actor: { kind: 'human', id: viewerId }, action: 'browser.takeover_handed_back',
      entityKind: 'browser_session', entityId: sessionId, runId: t.runId, issueId: session.issueId ?? undefined,
    });
    this.kernel.bus.emit('browser.handed_back', { orgId: session.orgId, runId: t.runId, sessionId });
    t.settle('handed_back');
  }

  /** The `request_human` tool: share link → pause → notify → wait for hand-back (or expiry) → resume. */
  async requestHuman(ctx: ToolCallContext, reason: string): Promise<ToolResult> {
    const { session, shareUrl } = await this.create({ orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId, issueId: ctx.issueId, reason });
    const t = this.live.get(session.id);
    if (!t) return { content: [{ type: 'text', text: 'Error: the takeover session ended before it started' }], isError: true };
    this.deps.runControl.pauseRun(ctx.runId, 'needs_human');
    let agentName = ctx.agentId;
    try {
      agentName = this.deps.org.getAgent(ctx.orgId, ctx.agentId).name;
    } catch {
      /* fall back to the id */
    }
    this.kernel.bus.emit('browser.human_requested', { orgId: ctx.orgId, runId: ctx.runId, sessionId: session.id, reason: session.reason });
    this.kernel.bus.emit('notification', {
      orgId: ctx.orgId, kind: 'takeover', title: `${agentName} needs you in the browser`, body: session.reason, link: shareUrl,
      data: { sessionId: session.id, runId: ctx.runId, issueId: ctx.issueId, agentId: ctx.agentId, expiresAt: session.expiresAt },
    });

    const outcome = await t.done;
    if (outcome === 'cancelled') {
      return { content: [{ type: 'text', text: 'Error: the human takeover was cancelled because the run ended.' }], isError: true };
    }
    this.deps.runControl.resumeRun(ctx.runId);
    if (outcome === 'expired') {
      return {
        content: [{ type: 'text', text: 'Error: nobody completed the takeover within 15 minutes, so the share link expired. The page is unchanged; you have control again. Report the blocker on the issue or call request_human again.' }],
        isError: true,
      };
    }
    const rb = this.engine.peek(ctx.runId);
    const page = rb ? await this.engine.activePage(rb) : null;
    const state = {
      status: 'handed_back',
      message: 'The human completed the step and handed control back. Continue from the current page; do not log in again.',
      url: page?.url() ?? null,
      title: page ? await page.title().catch(() => '') : null,
    };
    return { content: [{ type: 'text', text: this.engine.scrub(rb, JSON.stringify(state, null, 2)) }], untrusted: true };
  }

  /** The run is ending: abandon its takeover (the pending `request_human` call resolves with an error). */
  async cancelForRun(runId: string): Promise<void> {
    const t = this.byRun.get(runId);
    if (t) await this.finish(t, 'cancelled');
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.live.values()].map((t) => this.finish(t, 'cancelled')));
  }

  /** Crash recovery: sessions left pending/active by runs that no longer exist can never be completed. */
  cancelOrphans(liveRunIds: readonly string[]): void {
    const alive = new Set(liveRunIds);
    const open = this.kernel.db.select().from(browserSessions).where(inArray(browserSessions.status, ['pending', 'active'])).all();
    for (const s of open) {
      if (this.live.has(s.id) || (s.runId && alive.has(s.runId))) continue;
      this.kernel.db.update(browserSessions).set({ status: 'cancelled' })
        .where(and(eq(browserSessions.id, s.id), eq(browserSessions.orgId, s.orgId), inArray(browserSessions.status, ['pending', 'active']))).run();
      this.kernel.audit.record({
        orgId: s.orgId, actor: SYSTEM, action: 'browser.takeover_cancelled', entityKind: 'browser_session', entityId: s.id,
        runId: s.runId ?? undefined, data: { why: 'run no longer alive' },
      });
    }
  }
}
