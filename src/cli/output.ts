/** Human output helpers: colour (TTY only), aligned tables, compact value formatting. */

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

const wrap = (open: number, close: number, on: boolean) => (s: string) => (on && s ? `\u001b[${open}m${s}\u001b[${close}m` : s);

/** No colour when stdout is not a terminal or `NO_COLOR` is set (https://no-color.org). */
export function colourEnabled(isTTY: boolean, env: Record<string, string | undefined>): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return isTTY;
}

export function makeStyle(enabled: boolean): Style {
  return {
    bold: wrap(1, 22, enabled),
    dim: wrap(2, 22, enabled),
    red: wrap(31, 39, enabled),
    green: wrap(32, 39, enabled),
    yellow: wrap(33, 39, enabled),
    cyan: wrap(36, 39, enabled),
  };
}

export type Cell = string | number | boolean | null | undefined;

export function cell(v: Cell): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v).replace(/\s*\n\s*/g, ' ');
}

/** Compact aligned table; the last column is never padded. */
export function table(headers: string[], rows: Cell[][], style: Style): string[] {
  const body = rows.map((r) => headers.map((_, i) => cell(r[i])));
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd();
  return [style.bold(line(headers.map((h) => h.toUpperCase()))), ...body.map(line)];
}

/** `key: value` pairs with aligned values; empty values are skipped. */
export function fields(pairs: Array<[string, Cell]>, style: Style): string[] {
  const shown = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '');
  const width = Math.max(0, ...shown.map(([k]) => k.length));
  return shown.map(([k, v]) => `${style.dim(`${k}:`.padEnd(width + 1))} ${cell(v)}`);
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;
}

export function clip(s: string | null | undefined, max: number): string {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, Math.max(0, max - 1))}…` : one;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)}m` : ''}`;
  return `${Math.floor(s / 86_400)}d`;
}

export function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return '-';
  return ts > now ? `in ${duration(ts - now)}` : `${duration(now - ts)} ago`;
}

export function clock(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

export function percent(n: number | null | undefined): string {
  return n === null || n === undefined ? '-' : `${Math.round(n * 100)}%`;
}
