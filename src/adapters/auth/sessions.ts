import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import type { CliProvider, LoginMethod, LoginSession } from '../../contracts/providers.js';
import { newId } from '../../shared/ids.js';
import { redact } from '../../shared/util.js';
import { CLI_STATE_ENV, stripAnsi } from '../shared/cli-exec.js';
import { minimalEnv } from '../shared/proc.js';
import { CLI_COMMAND } from './status.js';

/** How long a login may wait for the human (Codex device codes live 15 minutes). */
export const LOGIN_TTL_MS = 15 * 60_000;
const OUTPUT_LIMIT = 32 * 1024;

export interface SpawnedLogin {
  child: ChildProcess;
}

/** argv of the CLI login for each method. Credentials never appear here (they go to stdin). */
export function loginArgs(provider: CliProvider, method: LoginMethod): string[] | null {
  if (provider === 'claude' && method === 'subscription') return ['auth', 'login', '--claudeai'];
  if (provider === 'claude' && method === 'console') return ['auth', 'login', '--console'];
  if (provider === 'codex' && method === 'device') return ['login', '--device-auth'];
  if (provider === 'codex' && method === 'browser') return ['login'];
  if (provider === 'codex' && method === 'api_key') return ['login', '--with-api-key'];
  return null;
}

// eslint-disable-next-line no-control-regex -- a URL ends where a terminal colour code starts
const URL_RE = /https:\/\/[^\s"'<>\u001b]+/g;
const DEVICE_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,8})\b/;
const CODE_REJECTED_RE = /invalid (code|grant)|code (was )?(not|in)valid|expired|try again|error/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Pull the link, the device code and the "paste the code" prompt out of what the CLI printed so far. */
export function parseLoginOutput(text: string): { url: string | null; userCode: string | null; needsCode: boolean } {
  const clean = stripAnsi(text);
  const urls = [...clean.matchAll(URL_RE)].map((m) => m[0].replace(/[).,]+$/, ''));
  // The authorize / device page, not a docs link: prefer the longest (OAuth URLs carry query strings).
  const url = urls.sort((a, b) => b.length - a.length)[0] ?? null;
  const afterCode = /one-time code[\s\S]{0,200}/i.exec(clean)?.[0] ?? '';
  const userCode = DEVICE_CODE_RE.exec(afterCode)?.[1] ?? null;
  return { url, userCode, needsCode: /paste (the )?code/i.test(clean) };
}

/** Last meaningful line of CLI output, safe to show: no URLs (they carry state), no emails, no secrets. */
export function safeTail(text: string, secrets: string[]): string {
  const lines = stripAnsi(text).split('\n').map((l) => l.trim()).filter((l) => l && !/^https?:\/\//.test(l) && !/paste code/i.test(l));
  const last = (lines[lines.length - 1] ?? '').replace(URL_RE, '<link>').replace(EMAIL_RE, '<account>');
  return redact(last, secrets).slice(0, 300);
}

/** One login in progress: owns the CLI process and its state. */
export class LoginRun {
  readonly session: LoginSession;
  private child: ChildProcess | null = null;
  private output = '';
  /** Output length when the last code was pasted: what the CLI says after it is its verdict on that code. */
  private submittedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly secrets: string[];
  private readonly onChange: (s: LoginSession) => void;
  /** Resolves when the CLI process has exited (or immediately for process-less methods). */
  readonly exited: Promise<number | null>;
  private resolveExit!: (code: number | null) => void;

  constructor(
    provider: CliProvider,
    method: LoginMethod,
    private readonly now: () => number,
    opts: { secrets?: string[]; onChange?: (s: LoginSession) => void } = {},
  ) {
    const t = now();
    this.session = {
      id: newId('loginSession'), provider, method, state: 'starting', url: null, userCode: null, needsCode: false,
      message: 'starting the login', startedAt: t, expiresAt: t + LOGIN_TTL_MS, endedAt: null, storedRef: null,
    };
    this.secrets = opts.secrets ?? [];
    this.onChange = opts.onChange ?? (() => {});
    this.exited = new Promise((r) => (this.resolveExit = r));
  }

  get done(): boolean {
    return ['succeeded', 'failed', 'cancelled', 'expired'].includes(this.session.state);
  }

  update(patch: Partial<LoginSession>): void {
    if (this.done) return;
    Object.assign(this.session, patch);
    if (this.done) {
      this.session.endedAt = this.now();
      if (this.timer) clearTimeout(this.timer);
      this.kill();
    }
    this.onChange(this.session);
  }

  /** Start the CLI. `stdin`, when given, is written and closed (credential logins). */
  spawn(args: string[], opts: { openBrowser: boolean; stdin?: string; command?: string; env?: Record<string, string> }): void {
    const env = minimalEnv({ ...(opts.openBrowser ? {} : { BROWSER: '/usr/bin/false' }), ...opts.env }, CLI_STATE_ENV);
    const child = spawn(opts.command ?? CLI_COMMAND[this.session.provider], args, { cwd: homedir(), env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child = child;
    const onData = (d: Buffer) => {
      if (this.output.length < OUTPUT_LIMIT) this.output += d.toString('utf8');
      const p = parseLoginOutput(this.output);
      if (this.session.state === 'starting' && (p.url || p.userCode)) {
        this.update({
          state: 'waiting', url: p.url, userCode: p.userCode, needsCode: p.needsCode,
          message: p.userCode ? 'open the link and enter the code' : p.needsCode ? 'open the link, sign in, then paste the code it shows' : 'finish signing in in the browser',
        });
      } else if (this.session.state === 'waiting') {
        // The CLI's output can arrive in pieces (a loaded machine splits its writes): a device code or prompt that
        // lands after the link must still reach the person, or they are left with a link and no code.
        const patch: Partial<LoginSession> = {};
        if (p.userCode && !this.session.userCode) Object.assign(patch, { userCode: p.userCode, message: 'open the link and enter the code' });
        if (p.url && !this.session.url) patch.url = p.url;
        if (p.needsCode && !this.session.needsCode) patch.needsCode = true;
        if (Object.keys(patch).length) this.update(patch);
      }
      else if (this.session.state === 'verifying' && this.submittedAt !== null) {
        // Claude Code rejects a bad paste ("Invalid code. Please make sure the full code was copied.") and keeps
        // waiting: hand the prompt back to the human instead of sitting in "verifying".
        const after = stripAnsi(this.output.slice(this.submittedAt));
        if (CODE_REJECTED_RE.test(after)) {
          this.submittedAt = null;
          this.update({ state: 'waiting', message: `the code was not accepted: ${safeTail(after, this.secrets) || 'try again'}` });
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.stdin?.on('error', () => {});
    child.on('error', (err) => {
      this.update({ state: 'failed', message: (err as NodeJS.ErrnoException).code === 'ENOENT' ? `${CLI_COMMAND[this.session.provider]} CLI is not installed` : `could not start the login: ${err.message}` });
      this.resolveExit(null);
    });
    child.on('exit', (code) => {
      this.child = null;
      this.resolveExit(code);
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    this.timer = setTimeout(() => this.update({ state: 'expired', message: 'the login was not finished in time' }), Math.max(0, this.session.expiresAt - this.now()));
    this.timer.unref?.();
  }

  /** Paste the code the sign-in page showed into the waiting CLI. */
  write(code: string): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) throw new Error('the login is not waiting for a code');
    this.submittedAt = this.output.length;
    this.child.stdin.write(`${code}\n`);
  }

  tail(): string {
    return safeTail(this.output, this.secrets);
  }

  /** Mark a process-less session as finished (stored tokens). */
  finishWithoutProcess(): void {
    this.resolveExit(0);
  }

  kill(): void {
    const c = this.child;
    if (!c?.pid) return;
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      c.kill('SIGTERM');
    }
    const pid = c.pid;
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, 2000).unref?.();
  }
}
