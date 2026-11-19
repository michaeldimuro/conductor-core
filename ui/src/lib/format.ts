import { Cron } from 'croner';
import { parseWait } from '../../../src/work/waits.js';

const usd2 = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd4 = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const int = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });

export const money = (n: number | null | undefined): string => (n == null ? 'No cap' : Math.abs(n) > 0 && Math.abs(n) < 1 ? usd4.format(n) : usd2.format(n));
export const count = (n: number): string => int.format(n);
export const tokens = (n: number): string => compact.format(n);
export const pct = (ratio: number | null | undefined, digits = 0): string => (ratio == null || !Number.isFinite(ratio) ? 'n/a' : `${(ratio * 100).toFixed(digits)}%`);
export const dateTime = (ts: number | null | undefined): string => (ts ? dateTimeFmt.format(ts) : 'never');
export const dateOnly = (ts: number | null | undefined): string => (ts ? dateFmt.format(ts) : 'none');
export const shortDay = (ts: number | string): string => dayFmt.format(typeof ts === 'string' ? new Date(`${ts}T12:00:00`) : ts);

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.round((ts - now) / 1000);
  const a = Math.abs(s);
  if (a < 45) return 'just now';
  if (a < 3600) return rel.format(Math.round(s / 60), 'minute');
  if (a < 86_400) return rel.format(Math.round(s / 3600), 'hour');
  if (a < 30 * 86_400) return rel.format(Math.round(s / 86_400), 'day');
  return dateFmt.format(ts);
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return 'n/a';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const seatTime = (seconds: number): string => duration(seconds * 1000);
export const clock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** `in_review` → `In review`, `tool.called` → `Tool called`. */
export function humanize(s: string): string {
  const t = s.replace(/[._-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Blocked reasons are either a machine code ("waiting_on_children", "needs_human: detail") or free text. */
/** One line for a blocked issue: what it waits on, in words (board cards, task lists, the task header). */
export function blockedText(reason: string): string {
  const w = parseWait(reason);
  const one = (s: string, max = 160) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  switch (w.kind) {
    case 'owner': return `Needs you: ${w.ask}`;
    case 'agent': return `Waiting on @${w.agent}`;
    case 'until': return `Waiting until ${dateTime(w.until)}`;
    case 'approval': return `Waiting on ${w.approvalIds.length === 1 ? 'an approval' : `${w.approvalIds.length} approvals`}`;
    case 'external': return w.note ? `Waiting on: ${one(w.note, 100)}` : 'Waiting on something outside the company';
    case 'system': return w.note ? `${humanize(w.reason)}: ${one(w.note)}` : humanize(w.reason);
    default: return one(w.text);
  }
}

export const shortId = (id: string | null | undefined): string => (id ? (id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-6)}` : id) : 'none');
export const monthStart = (now = new Date()): number => new Date(now.getFullYear(), now.getMonth(), 1).getTime();
export const toDateInput = (ts: number | null | undefined): string => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const fromDateInput = (v: string): number | null => (v ? new Date(`${v}T12:00:00`).getTime() : null);
export const numOrNull = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (h: string, m: string): string => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
const isNum = (s: string | undefined): s is string => s !== undefined && /^\d+$/.test(s);

function phrase(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return 'Custom schedule';
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const anyDay = dom === '*' && mon === '*' && dow === '*';
  const step = /^\*\/(\d+)$/;
  if (anyDay && hour === '*' && min === '*') return 'Every minute';
  if (anyDay && hour === '*' && step.test(min)) return `Every ${step.exec(min)![1]} minutes`;
  if (anyDay && hour === '*' && isNum(min)) return `Every hour at ${min.padStart(2, '0')} minutes past`;
  if (anyDay && step.test(hour) && isNum(min)) return `Every ${step.exec(hour)![1]} hours at ${min.padStart(2, '0')} minutes past`;
  if (anyDay && isNum(hour) && isNum(min)) return `Every day at ${hhmm(hour, min)}`;
  if (dom === '*' && mon === '*' && isNum(hour) && isNum(min)) {
    if (dow === '1-5') return `Weekdays at ${hhmm(hour, min)}`;
    if (/^[0-7](,[0-7])*$/.test(dow)) return `${dow.split(',').map((d) => DAYS[Number(d) % 7]).join(', ')} at ${hhmm(hour, min)}`;
  }
  if (mon === '*' && dow === '*' && isNum(dom) && isNum(hour) && isNum(min)) return `Day ${dom} of every month at ${hhmm(hour, min)}`;
  return 'Custom schedule';
}

export interface CronPreview {
  valid: boolean;
  text: string;
  next: number[];
}

/** Human-readable reading of a cron expression plus its next runs (parsed by the same library the scheduler uses). */
export function describeCron(expr: string): CronPreview {
  const trimmed = expr.trim();
  if (!trimmed) return { valid: true, text: 'No heartbeat: wakes only on assignment, mention or manual run', next: [] };
  try {
    const next = new Cron(trimmed, { paused: true }).nextRuns(3).map((d) => d.getTime());
    return { valid: true, text: phrase(trimmed), next };
  } catch (e) {
    return { valid: false, text: e instanceof Error ? e.message : 'Not a valid cron expression', next: [] };
  }
}
