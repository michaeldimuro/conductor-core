import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Services } from '../daemon/container.js';
import type { BrowserService } from '../contracts/services.js';
import { ConductorError, errorMessage } from '../shared/errors.js';
import { randomToken } from '../shared/util.js';
import { OriginGuard, TAKEOVER_COOKIE_PATH, VIEWER_COOKIE, appendCookie, parseCookies, serializeCookie } from './auth.js';
import { RateLimiter, body, param, parse, tooMany } from './http.js';
import { browserInput, claimBody } from './schemas/capabilities.js';
import type { ClaimResponse, Ok, TakeoverServerMessage } from './types.js';

const OPEN = 1;
const VIEWER_ID_RE = /^[A-Za-z0-9_-]{20,128}$/;
const VIEWER_COOKIE_MAX_AGE_SEC = 12 * 3600;
/** Frames are droppable: a viewer on a slow link gets a lower frame rate, not a growing queue. */
const MAX_BUFFERED_FRAMES = 4 * 1024 * 1024;

type ViewerHandle = Awaited<ReturnType<BrowserService['attachViewer']>>;

/**
 * Remote takeover (FR-13). The share token is the credential: claiming it
 * binds the session to one device via an HttpOnly viewer cookie, and every
 * later call presents that cookie. All validity checks (signature, 15-minute
 * TTL, single viewer) live in the browser service.
 */
export function takeoverRoutes(app: FastifyInstance, s: Services, guard: OriginGuard): void {
  const claims = new RateLimiter(30, 60_000);
  const viewerOf = (req: FastifyRequest): string | null => {
    const v = parseCookies(req.headers.cookie)[VIEWER_COOKIE];
    return v && VIEWER_ID_RE.test(v) ? v : null;
  };
  const requireViewer = (req: FastifyRequest): string => {
    const v = viewerOf(req);
    if (!v) throw new ConductorError('unauthorized', 'this device has not claimed the takeover link');
    return v;
  };
  /** Browser calls always carry an Origin on POST / WebSocket; when present it must be ours. */
  const checkOrigin = (req: FastifyRequest, required: boolean): void => {
    if (required || req.headers.origin !== undefined) guard.assertSameOrigin(req);
  };

  // The explicit "confirm this device" step.
  app.post('/takeover/claim', { config: { auth: 'public' } }, async (req, reply): Promise<ClaimResponse> => {
    if (!claims.take(req.ip)) throw tooMany('takeover claims');
    checkOrigin(req, false);
    const { token } = body(req, claimBody);
    // Re-claiming from the same device (page reload) must present the same viewer id.
    const viewerId = viewerOf(req) ?? randomToken(24);
    const session = s.browser.claimShare(token, viewerId);
    appendCookie(reply, serializeCookie(VIEWER_COOKIE, viewerId, { path: TAKEOVER_COOKIE_PATH, maxAgeSec: VIEWER_COOKIE_MAX_AGE_SEC, secure: guard.isSecure(req) }));
    reply.header('cache-control', 'no-store');
    return { sessionId: session.id, reason: session.reason, expiresAt: session.expiresAt };
  });

  app.post('/takeover/:sessionId/hand-back', { config: { auth: 'public' } }, async (req): Promise<Ok> => {
    checkOrigin(req, false);
    await s.browser.handBack(param(req, 'sessionId'), requireViewer(req));
    return { ok: true };
  });

  app.get('/takeover/:sessionId/ws', {
    websocket: true,
    config: { auth: 'public' },
    // Runs before the upgrade, so a device without the cookie gets a plain 401/403.
    preValidation: async (req) => {
      requireViewer(req);
      checkOrigin(req, true);
    },
  }, (socket, req) => {
    const sessionId = param(req, 'sessionId');
    const viewerId = requireViewer(req);
    const closeFns: Array<() => void> = [];
    let handle: ViewerHandle | null = null;
    let closed = false;
    let inputs: Promise<void> = Promise.resolve();
    const send = (msg: TakeoverServerMessage): void => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(msg));
    };

    const attached = s.browser.attachViewer(sessionId, viewerId, {
      sendFrame: (data, meta) => {
        if (socket.readyState === OPEN && socket.bufferedAmount < MAX_BUFFERED_FRAMES) socket.send(JSON.stringify({ type: 'frame', data, meta } satisfies TakeoverServerMessage));
      },
      onClose: (fn) => {
        if (closed) fn();
        else closeFns.push(fn);
      },
    }).then((h) => {
      handle = h;
      if (closed) void h.detach().catch(() => {});
      return h;
    }).catch((e: unknown) => {
      send({ type: 'error', message: errorMessage(e) });
      socket.close(4403, 'takeover not available');
      return null;
    });

    socket.on('message', (data) => {
      let event: ReturnType<typeof browserInput.parse>;
      try {
        event = parse(browserInput, JSON.parse(String(data)));
      } catch {
        return send({ type: 'error', message: 'invalid input event' });
      }
      // Input is applied strictly in arrival order, including events sent while the viewer was still attaching.
      inputs = inputs.then(async () => {
        const h = handle ?? (await attached);
        if (!h || closed) return;
        await h.input(event);
      }).catch((e: unknown) => send({ type: 'error', message: errorMessage(e) }));
    });

    const onClose = (): void => {
      if (closed) return;
      closed = true;
      for (const fn of closeFns.splice(0)) {
        try {
          fn();
        } catch (err) {
          s.kernel.log.warn({ err, sessionId }, 'takeover close handler failed');
        }
      }
      void handle?.detach().catch((err: unknown) => s.kernel.log.warn({ err, sessionId }, 'takeover detach failed'));
    };
    socket.on('close', onClose);
    socket.on('error', onClose);
  });
}
