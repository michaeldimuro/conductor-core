import type { Command } from 'commander';
import type { ProviderBinding } from '../api/types.js';
import type { CliDeps } from './deps.js';
import { Ctx, type GlobalOptions } from './context.js';
import { UsageError } from './errors.js';

/** Raw commander option values for one command. */
export type Opts = Record<string, unknown>;
export type Arg = string | string[] | undefined;
export type Handler = (ctx: Ctx, args: Arg[], opts: Opts) => Promise<void> | void;

/** Adapt a `(ctx, args, opts)` handler to commander's `(…args, opts, command)` action signature. */
export function action(deps: CliDeps, fn: Handler): (...a: unknown[]) => Promise<void> {
  return async (...a: unknown[]) => {
    const command = a[a.length - 1] as Command;
    const opts = (a[a.length - 2] ?? {}) as Opts;
    const args = a.slice(0, -2) as Arg[];
    await fn(new Ctx(deps, command.optsWithGlobals<GlobalOptions>()), args, opts);
  };
}

/* ── positional arguments ── */
export function arg(args: Arg[], i: number, name: string): string {
  const v = args[i];
  const s = Array.isArray(v) ? v.join(' ') : v;
  if (s === undefined || s.trim() === '') throw new UsageError(`missing <${name}>`);
  return s;
}

export function optArg(args: Arg[], i: number): string | undefined {
  const v = args[i];
  const s = Array.isArray(v) ? v.join(' ') : v;
  return s === undefined || s === '' ? undefined : s;
}

/* ── option values ── */
export function str(opts: Opts, key: string): string | undefined {
  const v = opts[key];
  return typeof v === 'string' ? v : undefined;
}

export function flag(opts: Opts, key: string): boolean {
  return opts[key] === true;
}

export function list(opts: Opts, key: string): string[] {
  const v = opts[key];
  const items = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
  return items.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
}

export function parseNumber(value: string, name: string, c: { min?: number; max?: number; int?: boolean } = {}): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) throw new UsageError(`${name} must be a number (got "${value}")`);
  if (c.int && !Number.isInteger(n)) throw new UsageError(`${name} must be a whole number (got "${value}")`);
  if (c.min !== undefined && n < c.min) throw new UsageError(`${name} must be at least ${c.min}`);
  if (c.max !== undefined && n > c.max) throw new UsageError(`${name} must be at most ${c.max}`);
  return n;
}

export function num(opts: Opts, key: string, c: { min?: number; max?: number; int?: boolean } = {}): number | undefined {
  const v = str(opts, key);
  return v === undefined ? undefined : parseNumber(v, `--${kebab(key)}`, c);
}

export function oneOf<T extends string>(value: string, name: string, values: readonly T[]): T {
  if (!(values as readonly string[]).includes(value)) throw new UsageError(`${name} must be one of: ${values.join(', ')} (got "${value}")`);
  return value as T;
}

export function choice<T extends string>(opts: Opts, key: string, values: readonly T[]): T | undefined {
  const v = str(opts, key);
  return v === undefined ? undefined : oneOf(v, `--${kebab(key)}`, values);
}

export function choices<T extends string>(opts: Opts, key: string, values: readonly T[]): T[] | undefined {
  const items = list(opts, key);
  return items.length ? items.map((v) => oneOf(v, `--${kebab(key)}`, values)) : undefined;
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** `adapter[:model]`, e.g. `claude_local` or `claude_api:claude-sonnet-4-5`. */
export function parseProvider(value: string): ProviderBinding {
  const i = value.indexOf(':');
  const adapter = (i === -1 ? value : value.slice(0, i)).trim();
  const model = i === -1 ? '' : value.slice(i + 1).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(adapter)) throw new UsageError(`--provider must look like adapter[:model] (got "${value}")`);
  return model ? { adapter, model } : { adapter };
}

export function parseJsonObject(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageError(`${name} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError(`${name} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

/** Drop undefined members so request bodies only carry what the user set. */
export function compact<T extends object>(o: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function isEmpty(o: object): boolean {
  return Object.keys(o).length === 0;
}
