import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useParams } from 'react-router-dom';
import { Button, ErrorNote, Lamp, Logo, Segmented } from '../components/ui.js';
import { ConductorApiError, api, errorText, wsUrl } from '../lib/api.js';
import type { BrowserInputEvent, ClaimResponse, TakeoverServerMessage } from '../lib/api.js';
import { clock } from '../lib/format.js';

const SHARE_TTL_MS = 15 * 60_000;
const TAP_SLOP = 8;
const TAP_MS = 500;
const MAX_RETRIES = 5;
/** The daemon stops serving a viewer without closing its socket when the link is re-issued or the session ends elsewhere. */
const DISPLACED = /no longer active|not the active viewer/i;
const DISPLACED_TEXT = 'This device no longer has control. The takeover was reopened on another device, handed back, or it expired.';
type Conn = 'connecting' | 'live' | 'reconnecting' | 'lost';
type Meta = Extract<TakeoverServerMessage, { type: 'frame' }>['meta'];
type Phase = { step: 'confirm' } | { step: 'live'; session: ClaimResponse; deadline: number; exact: boolean } | { step: 'done' } | { step: 'ended'; why: string };

const BUTTONS = ['left', 'middle', 'right'] as const;
/** scroll: a drag scrolls the agent's page. drag: a drag is a held mouse button. pan: a drag moves the zoomed view; taps still click. */
type TouchMode = 'scroll' | 'drag' | 'pan';
type Zoom = '1' | '2' | '3';

/**
 * The viewer socket: JPEG frames in, input events out. Frames are decoded one
 * at a time; while one decodes only the newest waiting frame is kept, so a slow
 * phone falls behind in frame rate, never in time.
 */
function useViewer(sessionId: string, canvas: React.RefObject<HTMLCanvasElement | null>, onEnded: (why: string) => void) {
  const [conn, setConn] = useState<Conn>('connecting');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;

  useEffect(() => {
    let closed = false;
    let retries = 0;
    let timer: number | undefined;
    let decoding = false;
    let waiting: { data: string; meta: Meta } | null = null;

    const draw = (frame: { data: string; meta: Meta }) => {
      decoding = true;
      const img = new Image();
      img.onload = () => {
        const c = canvas.current;
        if (c && !closed) {
          if (c.width !== frame.meta.width || c.height !== frame.meta.height) {
            c.width = frame.meta.width;
            c.height = frame.meta.height;
          }
          c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
          setMeta((prev) => (prev && prev.width === frame.meta.width && prev.height === frame.meta.height && prev.url === frame.meta.url && prev.title === frame.meta.title ? prev : frame.meta));
        }
        next();
      };
      img.onerror = next;
      img.src = `data:image/jpeg;base64,${frame.data}`;
    };
    const next = () => {
      decoding = false;
      if (waiting && !closed) {
        const f = waiting;
        waiting = null;
        draw(f);
      }
    };

    const connect = () => {
      const ws = new WebSocket(wsUrl(`/api/v1/takeover/${encodeURIComponent(sessionId)}/ws`));
      socket.current = ws;
      ws.onopen = () => {
        retries = 0;
        setConn('live');
      };
      ws.onmessage = (ev) => {
        let msg: TakeoverServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as TakeoverServerMessage;
        } catch {
          return;
        }
        if (msg.type === 'error') return DISPLACED.test(msg.message) ? ended.current(DISPLACED_TEXT) : setNotice(msg.message);
        if (decoding) waiting = msg;
        else draw(msg);
      };
      ws.onclose = (ev) => {
        if (closed || socket.current !== ws) return;
        socket.current = null;
        // 4403: the service refused the viewer (expired, handed back, or claimed elsewhere). Retrying cannot help.
        if (ev.code === 4403) return ended.current('This takeover session is no longer available. It may have expired or already been handed back.');
        if (retries >= MAX_RETRIES) return setConn('lost');
        setConn('reconnecting');
        timer = window.setTimeout(connect, Math.min(8000, 400 * 2 ** retries++));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      socket.current?.close(1000);
      socket.current = null;
    };
  }, [sessionId, canvas]);

  const send = useCallback((event: BrowserInputEvent) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(event));
  }, []);
  return { conn, meta, notice, clearNotice: () => setNotice(null), send };
}

function Stage({ session, deadline, exact, onDone, onEnded }: { session: ClaimResponse; deadline: number; exact: boolean; onDone: () => void; onEnded: (why: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const { conn, meta, notice, clearNotice, send } = useViewer(session.sessionId, canvas, onEnded);
  const [touchMode, setTouchMode] = useState<TouchMode>('scroll');
  const [zoom, setZoom] = useState<Zoom>('1');
  const autoZoomed = useRef(false);
  const [text, setText] = useState('');
  const [address, setAddress] = useState('');
  const [left, setLeft] = useState(() => deadline - Date.now());
  const [handing, setHanding] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  useEffect(() => {
    const t = window.setInterval(() => {
      const ms = deadline - Date.now();
      setLeft(ms);
      if (ms <= 0) onEnded('The 15 minutes for this takeover are up. Ask the agent to request help again if you were not finished.');
    }, 1000);
    return () => window.clearInterval(t);
  }, [deadline, onEnded]);

  // Fit the frame inside the stage, letterboxed. The canvas keeps the frame's own pixel grid, so
  // pointer positions map back to page pixels by one ratio (frame size over displayed size).
  useEffect(() => {
    const el = stage.current;
    const c = canvas.current;
    if (!el || !c || !meta) return;
    const fit = () => {
      const whole = Math.min(el.clientWidth / meta.width, el.clientHeight / meta.height);
      // A desktop-sized page on a phone is unreadable when shown whole, so start zoomed in once.
      if (!autoZoomed.current) {
        autoZoomed.current = true;
        if (whole < 0.45) {
          setZoom('2');
          setTouchMode('pan');
          return;
        }
      }
      const scale = whole * Number(zoom);
      c.style.width = `${Math.max(1, Math.floor(meta.width * scale))}px`;
      c.style.height = `${Math.max(1, Math.floor(meta.height * scale))}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [meta, zoom]);
  const changeZoom = (z: Zoom) => {
    setZoom(z);
    if (z === '1' && touchMode === 'pan') setTouchMode('scroll');
  };

  const point = (e: { clientX: number; clientY: number }): { x: number; y: number; scale: number } => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const scale = r.width > 0 ? c.width / r.width : 1;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    return { x: clamp(Math.round((e.clientX - r.left) * scale), c.width), y: clamp(Math.round((e.clientY - r.top) * (r.height > 0 ? c.height / r.height : 1)), c.height), scale };
  };

  // Mouse moves are coalesced to one per animation frame.
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const queueMove = (x: number, y: number) => {
    const scheduled = pendingMove.current !== null;
    pendingMove.current = { x, y };
    if (scheduled) return;
    requestAnimationFrame(() => {
      const p = pendingMove.current;
      pendingMove.current = null;
      if (p) send({ type: 'mouse', action: 'move', x: p.x, y: p.y });
    });
  };
  const flushMove = () => {
    const p = pendingMove.current;
    pendingMove.current = null;
    if (p) send({ type: 'mouse', action: 'move', x: p.x, y: p.y });
  };

  const touch = useRef<{ id: number; x: number; y: number; t: number; moved: boolean } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    stage.current?.focus({ preventScroll: true });
    if (e.pointerType !== 'mouse' && touchMode === 'pan') {
      // The browser pans the zoomed view itself; only a tap is forwarded.
      touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    if (e.pointerType === 'mouse' || touchMode === 'drag') {
      flushMove();
      send({ type: 'mouse', action: 'move', x: p.x, y: p.y });
      send({ type: 'mouse', action: 'down', x: p.x, y: p.y, button: BUTTONS[e.button] ?? 'left' });
      if (e.pointerType !== 'mouse') touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), moved: true };
    } else touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = point(e);
    if (e.pointerType === 'mouse' || touchMode === 'drag') {
      if (e.pointerType !== 'mouse' && touch.current?.id !== e.pointerId) return;
      return queueMove(p.x, p.y);
    }
    const t = touch.current;
    if (!t || t.id !== e.pointerId) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    if (!t.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    t.moved = true;
    if (touchMode === 'pan') return;
    t.x = e.clientX;
    t.y = e.clientY;
    // Dragging a finger scrolls the page under it, like a touch screen would.
    send({ type: 'wheel', x: p.x, y: p.y, deltaX: Math.round(-dx * p.scale), deltaY: Math.round(-dy * p.scale) });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = point(e);
    if (e.pointerType === 'mouse' || touchMode === 'drag') {
      flushMove();
      send({ type: 'mouse', action: 'up', x: p.x, y: p.y, button: BUTTONS[e.button] ?? 'left' });
      touch.current = null;
      return;
    }
    const t = touch.current;
    touch.current = null;
    if (t && t.id === e.pointerId && !t.moved && Date.now() - t.t < TAP_MS) send({ type: 'mouse', action: 'click', x: p.x, y: p.y, button: 'left' });
  };

  // React attaches wheel listeners passively; a native one is needed to stop the page itself scrolling.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = point(e);
      const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 600 : 1;
      send({ type: 'wheel', x: p.x, y: p.y, deltaX: Math.round(e.deltaX * unit), deltaY: Math.round(e.deltaY * unit) });
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send]);

  const onKey = (action: 'down' | 'up') => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && e.target !== canvas.current) return;
    // Paste arrives through the paste event as text; forwarding the shortcut too would paste twice.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return;
    if (e.key === 'Unidentified' || e.key === 'Process' || e.key === 'Dead') return;
    e.preventDefault();
    send({ type: 'key', action, key: e.key });
  };
  const sendText = (pressEnter: boolean) => {
    if (text) send({ type: 'text', text });
    if (pressEnter) send({ type: 'key', action: 'press', key: 'Enter' });
    setText('');
  };
  const handBack = () => {
    setHanding(true);
    setError(undefined);
    api.handBackTakeover(session.sessionId).then(onDone, (e: unknown) => {
      // 403: this device is not the viewer any more, so there is nothing left to hand back from here.
      if (e instanceof ConductorApiError && e.status === 403) return onEnded(DISPLACED_TEXT);
      setHanding(false);
      setError(e);
    });
  };

  return (
    <div className="takeover">
      <header className="takeover-bar">
        <div className="takeover-reason">
          <span className="status" aria-live="polite">
            <Lamp tone={conn === 'live' ? 'go' : conn === 'lost' ? 'stop' : 'warn'} live={conn === 'live'} />
            {conn === 'live' ? 'You have control' : conn === 'connecting' ? 'Connecting' : conn === 'reconnecting' ? 'Reconnecting' : 'Connection lost'}
          </span>
          <p className="truncate" title={session.reason}>{session.reason || 'The agent asked for your help in its browser.'}</p>
        </div>
        <span className={`takeover-clock${left < 120_000 ? ' takeover-clock-low' : ''}`} role="timer" aria-label={`${exact ? 'Time left' : 'At most'} ${clock(left)}`} title={exact ? 'Time left' : 'Counted from when you took control. The link was valid for 15 minutes from when it was sent, so the session can end sooner.'}>
          {exact ? '' : 'up to '}{clock(left)}
        </span>
        <Button icon="hand" variant="primary" className="takeover-handback" busy={handing} onClick={handBack}>Hand back</Button>
      </header>
      {error ? <ErrorNote error={error} /> : null}
      {notice ? <div className="note note-warn" role="alert"><span>{notice}</span><Button icon="close" small onClick={clearNotice}>Dismiss</Button></div> : null}
      {conn === 'lost' ? <div className="note note-stop" role="alert"><span>The live view stopped responding.</span><Button icon="refresh" small onClick={() => window.location.reload()}>Reload and reconnect</Button></div> : null}
      <div
        className={`takeover-stage${zoom === '1' ? '' : ' takeover-stage-zoomed'}`} ref={stage} tabIndex={0} role="application" aria-label={meta ? `Live view of the agent's browser: ${meta.title || meta.url}` : "Live view of the agent's browser"}
        onKeyDown={onKey('down')} onKeyUp={onKey('up')}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text');
          if (pasted) {
            e.preventDefault();
            send({ type: 'text', text: pasted });
          }
        }}
      >
        {!meta ? <p className="takeover-wait">{conn === 'live' ? 'Waiting for the first frame' : 'Connecting to the browser'}</p> : null}
        <canvas ref={canvas} className="takeover-canvas" hidden={!meta} style={{ touchAction: touchMode === 'pan' ? 'pan-x pan-y' : 'none' }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={() => { touch.current = null; }} onContextMenu={(e) => e.preventDefault()} />
      </div>
      <footer className="takeover-keys">
        {meta ? <p className="takeover-url truncate" title={meta.url}>{meta.title ? `${meta.title} ` : ''}<span className="muted">{meta.url}</span></p> : null}
        <form className="row" onSubmit={(e) => { e.preventDefault(); sendText(false); }}>
          <input className="grow" aria-label="Text to type into the page" placeholder="Type or paste here, then send" value={text} onChange={(e) => setText(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="send" style={{ width: 'auto' }} />
          <Button icon="edit" type="submit" variant="primary" disabled={!text}>Type it</Button>
          <Button onClick={() => sendText(true)}>{text ? 'Type and Enter' : 'Enter'}</Button>
        </form>
        <div className="row takeover-quick">
          {(['Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown'] as const).map((key) => (
            <Button small key={key} onClick={() => send({ type: 'key', action: 'press', key })}>{key === 'Escape' ? 'Esc' : key === 'ArrowUp' ? 'Up' : key === 'ArrowDown' ? 'Down' : key}</Button>
          ))}
          <Segmented small label="Zoom" value={zoom} onChange={changeZoom} options={[{ value: '1', label: 'Whole page' }, { value: '2', label: '2x' }, { value: '3', label: '3x' }]} />
          <Segmented small label="What a one-finger drag does" value={touchMode} onChange={setTouchMode}
            options={[...(zoom === '1' ? [] : [{ value: 'pan' as const, label: 'Finger moves view' }]), { value: 'scroll', label: 'Finger scrolls page' }, { value: 'drag', label: 'Finger drags' }]} />
        </div>
        <details>
          <summary>Go to another address</summary>
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (address.trim()) send({ type: 'navigate', url: address.trim() }); }}>
            <input className="grow" type="url" aria-label="Address" placeholder="https://" value={address} onChange={(e) => setAddress(e.target.value)} autoCapitalize="none" spellCheck={false} style={{ width: 'auto' }} />
            <Button type="submit" disabled={!address.trim()}>Go</Button>
          </form>
        </details>
      </footer>
    </div>
  );
}

export function Takeover() {
  const { token = '' } = useParams();
  const [phase, setPhase] = useState<Phase>({ step: 'confirm' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const onDone = useCallback(() => setPhase({ step: 'done' }), []);
  const onEnded = useCallback((why: string) => setPhase((p) => (p.step === 'done' ? p : { step: 'ended', why })), []);

  const claim = () => {
    setBusy(true);
    setError(undefined);
    api.claimTakeover(token).then(
      (session) => {
        // The countdown is exact when the claim carries the session's expiry; an older daemon may omit it.
        const expiresAt = (session as ClaimResponse & { expiresAt?: number }).expiresAt;
        setPhase({ step: 'live', session, deadline: expiresAt ?? Date.now() + SHARE_TTL_MS, exact: typeof expiresAt === 'number' });
      },
      (e: unknown) => {
        setBusy(false);
        setError(e);
      },
    );
  };

  if (phase.step === 'live') return <Stage session={phase.session} deadline={phase.deadline} exact={phase.exact} onDone={onDone} onEnded={onEnded} />;
  return (
    <div className="center-screen">
      <main className="center-card">
        <p className="wordmark"><Logo size={28} />conductor<Lamp tone={phase.step === 'done' ? 'go' : phase.step === 'ended' ? 'stop' : 'warn'} /></p>
        {phase.step === 'confirm' ? (
          <>
            <h1>An agent needs you in its browser</h1>
            <p className="dim">It reached something only a person can do, such as a login, a verification code or a CAPTCHA. You will see its browser tab live and control it from this device.</p>
            <ul className="takeover-facts">
              <li>This link works on one device only. Once you take control here, it cannot be opened anywhere else.</li>
              <li>The agent cannot touch the page while you have control.</li>
              <li>The session ends 15 minutes after the link was sent, or when you hand back.</li>
            </ul>
            {error ? <div className="note note-stop" role="alert"><span>{errorText(error)}. Links are single use and expire after 15 minutes. If this one is spent, the agent can ask again.</span></div> : null}
            <Button icon="hand" variant="primary" className="takeover-claim" busy={busy} onClick={claim}>Take control on this device</Button>
          </>
        ) : phase.step === 'done' ? (
          <>
            <h1>Handed back</h1>
            <p className="dim">The agent has its browser again and is carrying on from where it paused. Anything you signed in to stays signed in for that agent only.</p>
            <p className="dim">You can close this page.</p>
          </>
        ) : (
          <>
            <h1>This takeover has ended</h1>
            <p className="dim">{phase.why}</p>
          </>
        )}
      </main>
    </div>
  );
}
