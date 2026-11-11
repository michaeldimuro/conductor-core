import { execFile, spawn } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ConductorClient, type ClientOptions } from '../api/client.js';
import * as launchd from '../daemon/launchd.js';

export interface ExecResult {
  /** Process exit code; 127 when the binary does not exist. */
  code: number;
  stdout: string;
  stderr: string;
}

/** The slice of the filesystem the CLI touches (config, token, logs, exports). */
export interface CliFs {
  exists(path: string): boolean;
  readText(path: string): string;
  writeText(path: string, content: string, mode?: number): void;
  mkdirp(path: string): void;
  readDir(path: string): string[];
  isWritableDir(path: string): boolean;
  size(path: string): number;
  /** UTF-8 content from byte `offset` to the end (log following). */
  readFrom(path: string, offset: number): string;
}

/** launchd helpers from `src/daemon/launchd.ts` (faked in tests). */
export interface LaunchdApi {
  installLaunchAgent: typeof launchd.installLaunchAgent;
  uninstallLaunchAgent: typeof launchd.uninstallLaunchAgent;
  launchdStatus: typeof launchd.launchdStatus;
  restartLaunchAgent: typeof launchd.restartLaunchAgent;
  renderHeadlessDaemonPlist: typeof launchd.renderHeadlessDaemonPlist;
  renderWrapper: typeof launchd.renderWrapper;
}

/** Everything the CLI needs from the outside world; tests inject fakes. */
export interface CliDeps {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  /** stdout is a terminal (colour, interactive prompts). */
  isTTY: boolean;
  stdinIsTTY: boolean;
  createClient(opts: ClientOptions): ConductorClient;
  fs: CliFs;
  launchd: LaunchdApi;
  exec(command: string, args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** Ask a question on the terminal; `hidden` does not echo the answer. */
  prompt(question: string, opts?: { hidden?: boolean }): Promise<string>;
  readStdin(): Promise<string>;
  /** Open `$EDITOR` on the text and return the edited result. */
  editText(initial: string, fileName?: string): Promise<string>;
  /** Path of the Playwright-managed Chromium binary, or null when unknown. */
  chromiumPath(): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Aborted on Ctrl-C: ends `logs -f` and other follow loops. */
  signal: AbortSignal;
  /** Checkout / package root (holds `dist/` and `bin/`). */
  projectRoot: string;
  nodeVersion: string;
  nodePath: string;
  homedir: string;
  username: string;
}

const nodeFs: CliFs = {
  exists: (p) => existsSync(p),
  readText: (p) => readFileSync(p, 'utf8'),
  writeText: (p, content, mode) => writeFileSync(p, content, mode === undefined ? {} : { mode }),
  mkdirp: (p) => void mkdirSync(p, { recursive: true }),
  readDir: (p) => readdirSync(p),
  isWritableDir: (p) => {
    try {
      if (!statSync(p).isDirectory()) return false;
      accessSync(p, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  size: (p) => statSync(p).size,
  readFrom: (p, offset) => {
    const size = statSync(p).size;
    if (offset >= size) return '';
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      const n = readSync(fd, buf, 0, buf.length, offset);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  },
};

function run(command: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: opts.timeoutMs ?? 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') return resolve({ code: 127, stdout: '', stderr: `${command}: not found` });
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr: stderr || err.message });
    });
  });
}

function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    // Questions go to stderr so stdout stays clean for pipes; a hidden answer is never echoed.
    const sink = new Writable({ write: (_chunk, _enc, cb) => cb() });
    const rl = createInterface({ input: process.stdin, output: opts.hidden ? sink : process.stderr, terminal: true });
    if (opts.hidden) process.stderr.write(question);
    rl.question(opts.hidden ? '' : question, (answer) => {
      rl.close();
      if (opts.hidden) process.stderr.write('\n');
      resolve(answer);
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

function editText(initial: string, fileName = 'conductor-edit.md'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-edit-'));
  const file = join(dir, fileName.replace(/[^A-Za-z0-9._-]/g, '_'));
  writeFileSync(file, initial, { mode: 0o600 });
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  return new Promise((resolve, reject) => {
    // The editor string may carry flags ("code -w"); the file is passed as a positional parameter, not interpolated.
    const child = spawn('/bin/sh', ['-c', `${editor} "$1"`, 'conductor-edit', file], { stdio: 'inherit' });
    const done = (fn: () => void) => {
      try {
        fn();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    child.on('error', (err) => done(() => reject(err)));
    child.on('exit', (code) => done(() => (code === 0 ? resolve(readFileSync(file, 'utf8')) : reject(new Error(`editor exited with code ${code ?? 'unknown'}`)))));
  });
}

async function chromiumPath(): Promise<string | null> {
  try {
    const { chromium } = await import('playwright');
    return chromium.executablePath() || null;
  } catch {
    return null;
  }
}

/** Real-world dependencies of the `conductor` binary. */
export function defaultDeps(): CliDeps {
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    createClient: (opts) => new ConductorClient(opts),
    fs: nodeFs,
    launchd,
    exec: run,
    prompt,
    readStdin,
    editText,
    chromiumPath,
    sleep: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(finish, ms);
        function finish() {
          clearTimeout(timer);
          abort.signal.removeEventListener('abort', finish);
          resolve();
        }
        abort.signal.addEventListener('abort', finish, { once: true });
      }),
    now: () => Date.now(),
    signal: abort.signal,
    // src/cli/deps.ts and dist/cli/deps.js both sit two levels below the root.
    projectRoot: fileURLToPath(new URL('../..', import.meta.url)).replace(/\/+$/, ''),
    nodeVersion: process.versions.node,
    nodePath: process.execPath,
    homedir: homedir(),
    username: userInfo().username,
  };
}
