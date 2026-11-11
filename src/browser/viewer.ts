import type { CDPSession, Page } from 'playwright';
import { z } from 'zod';
import type { BrowserInputEvent } from '../contracts/services.js';
import { ConductorError, errorMessage } from '../shared/errors.js';
import type { Logger } from '../shared/util.js';
import { checkNavigation } from './domains.js';
import type { BrowserEngine, RunBrowser } from './engine.js';

const coord = z.number().finite().min(-100_000).max(100_000);
/** Boundary validation for events arriving from the remote viewer (WebSocket). */
export const inputEventSchema: z.ZodType<BrowserInputEvent> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('mouse'), action: z.enum(['move', 'down', 'up', 'click']), x: coord, y: coord, button: z.enum(['left', 'right', 'middle']).optional() }),
  z.strictObject({ type: z.literal('wheel'), x: coord, y: coord, deltaX: coord, deltaY: coord }),
  z.strictObject({ type: z.literal('key'), action: z.enum(['down', 'up', 'press']), key: z.string().min(1).max(32) }),
  z.strictObject({ type: z.literal('text'), text: z.string().max(10_000) }),
  z.strictObject({ type: z.literal('navigate'), url: z.string().min(1).max(4000) }),
]);

export interface FrameMeta {
  width: number;
  height: number;
  url: string;
  title: string;
}
export type SendFrame = (jpegBase64: string, meta: FrameMeta) => void;

interface KeyDef {
  code: string;
  keyCode: number;
  text?: string;
}
const NAMED_KEYS: Record<string, KeyDef> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Shift: { code: 'ShiftLeft', keyCode: 16 },
  Control: { code: 'ControlLeft', keyCode: 17 },
  Alt: { code: 'AltLeft', keyCode: 18 },
  Meta: { code: 'MetaLeft', keyCode: 91 },
};
/** CDP modifier bit field: Alt=1, Ctrl=2, Meta/Command=4, Shift=8. */
const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const;

function keyDef(key: string): KeyDef {
  const named = NAMED_KEYS[key];
  if (named) return named;
  if ([...key].length !== 1) throw new ConductorError('validation', `unsupported key: ${key}`);
  const upper = key.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  return { code: '', keyCode: 0, text: key };
}

/**
 * One remote viewer's link to a run's active tab: JPEG frames out via CDP
 * `Page.startScreencast` (works headless — no virtual display needed), mouse /
 * keyboard / text in via the CDP Input domain. Follows the active tab when a
 * popup opens or the tab closes.
 */
export class ViewerLink {
  private cdp: CDPSession | null = null;
  private page: Page | null = null;
  private frame = { width: 0, height: 0 };
  private stopped = false;
  private modifiers = 0;
  private buttons = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly onPage = (p: Page): void => this.rebind(p);

  constructor(
    private readonly rb: RunBrowser,
    private readonly engine: BrowserEngine,
    private readonly sendFrame: SendFrame,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    await this.bind(await this.engine.activePage(this.rb));
    this.rb.context.on('page', this.onPage);
  }

  private rebind(page: Page): void {
    this.chain = this.chain
      .then(() => this.bind(page))
      .catch((e) => this.log.warn({ err: errorMessage(e), runId: this.rb.runId }, 'takeover viewer could not follow the tab'));
  }

  private async bind(page: Page): Promise<void> {
    if (this.stopped || (this.page === page && this.cdp)) return;
    await this.unbind();
    const cdp = await this.rb.context.newCDPSession(page);
    this.cdp = cdp;
    this.page = page;
    cdp.on('Page.screencastFrame', (f) => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (this.stopped || this.cdp !== cdp) return;
      this.frame = { width: f.metadata.deviceWidth, height: f.metadata.deviceHeight };
      void page.title().catch(() => '').then((title) => {
        if (this.stopped || this.cdp !== cdp) return;
        try {
          this.sendFrame(f.data, { width: this.frame.width, height: this.frame.height, url: page.url(), title });
        } catch (e) {
          this.log.warn({ err: errorMessage(e) }, 'takeover viewer rejected a frame');
        }
      });
    });
    page.once('close', () => {
      if (this.stopped || this.page !== page) return;
      void this.engine.activePage(this.rb).then((p) => this.rebind(p)).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
  }

  private async unbind(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    this.page = null;
    if (!cdp) return;
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.rb.context.off('page', this.onPage);
    await this.chain;
    await this.unbind();
  }

  /** Map viewer coordinates (in the frame's width × height space) to CSS pixels of the page viewport. */
  private toViewport(x: number, y: number): { x: number; y: number } {
    const vp = this.page?.viewportSize() ?? null;
    const fw = this.frame.width || vp?.width || 1;
    const fh = this.frame.height || vp?.height || 1;
    const vw = vp?.width ?? fw;
    const vh = vp?.height ?? fh;
    const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
    return { x: Math.round(clamp(x, fw) * (vw / fw)), y: Math.round(clamp(y, fh) * (vh / fh)) };
  }

  async input(ev: BrowserInputEvent): Promise<void> {
    const cdp = this.cdp;
    const page = this.page;
    if (this.stopped || !cdp || !page) throw new ConductorError('unavailable', 'the shared tab is not available');
    switch (ev.type) {
      case 'mouse': {
        const p = this.toViewport(ev.x, ev.y);
        const button = ev.button ?? 'left';
        const bit = BUTTON_BITS[button];
        const send = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', btn: 'none' | typeof button) =>
          cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: btn, buttons: this.buttons, modifiers: this.modifiers, clickCount: type === 'mouseMoved' ? 0 : 1 });
        if (ev.action === 'move' || ev.action === 'click') await send('mouseMoved', 'none');
        if (ev.action === 'down' || ev.action === 'click') {
          this.buttons |= bit;
          await send('mousePressed', button);
        }
        if (ev.action === 'up' || ev.action === 'click') {
          this.buttons &= ~bit;
          await send('mouseReleased', button);
        }
        return;
      }
      case 'wheel': {
        const p = this.toViewport(ev.x, ev.y);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: ev.deltaX, deltaY: ev.deltaY, modifiers: this.modifiers });
        return;
      }
      case 'key': {
        const def = keyDef(ev.key);
        const bit = MODIFIER_BITS[ev.key] ?? 0;
        const base = { key: ev.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
        if (ev.action === 'down' || ev.action === 'press') {
          this.modifiers |= bit;
          // With Ctrl/Alt/Meta held a key is a shortcut, not text input.
          const text = (this.modifiers & 7) === 0 ? def.text : undefined;
          await cdp.send('Input.dispatchKeyEvent', {
            ...base, type: text ? 'keyDown' : 'rawKeyDown', modifiers: this.modifiers, ...(text ? { text, unmodifiedText: text } : {}),
          });
        }
        if (ev.action === 'up' || ev.action === 'press') {
          this.modifiers &= ~bit;
          await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp', modifiers: this.modifiers });
        }
        return;
      }
      case 'text':
        if (ev.text.length > 0) await cdp.send('Input.insertText', { text: ev.text });
        return;
      case 'navigate': {
        const check = checkNavigation(ev.url, this.engine.profileOf(this.rb).domainAllowlist);
        if (!check.ok) throw new ConductorError('policy_denied', check.reason);
        try {
          await page.goto(check.url, { waitUntil: 'domcontentloaded' });
        } catch (e) {
          throw new ConductorError('unavailable', `navigation failed: ${errorMessage(e).split('\n')[0]}`);
        }
        return;
      }
    }
  }
}
