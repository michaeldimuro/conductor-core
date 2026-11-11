import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { ConductorError } from '../shared/errors.js';
import { resolveInside } from '../shared/paths.js';

/**
 * Whitelist: the repo is rooted at the conductor home, but ONLY skill
 * directories are tracked. The DB, transcripts, browser profiles, workspaces,
 * the vault, tokens, backups… all stay ignored.
 */
export const SKILLS_GITIGNORE = `# Managed by Conductor — only skill folders are versioned here.
/*
!/.gitignore
!/skills/
!/orgs/
/orgs/*/*
!/orgs/*/skills/
!/orgs/*/depts/
/orgs/*/depts/*/*
!/orgs/*/depts/*/skills/
!/orgs/*/agents/
/orgs/*/agents/*/*
!/orgs/*/agents/*/skills/
.DS_Store
`;

/** git's well-known empty tree, used to diff the first version against nothing. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface GitAuthor {
  name: string;
  email: string;
}

/** `human`, `agent:<id>` or `system` → commit identity (never touches global git config). */
export function gitAuthor(author: string): GitAuthor {
  const local = author.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  return { name: author, email: `${local}@conductor.local` };
}

export class SkillGit {
  private tail: Promise<unknown> = Promise.resolve();
  private ready = false;

  constructor(readonly root: string) {}

  /** Serialize operations so concurrent runs never collide on the index lock. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(
      () => fn(),
      () => fn(),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  rel(absPath: string): string {
    const abs = resolveInside(this.root, absPath);
    return relative(this.root, abs).split(sep).join('/');
  }

  /** Lazy init: create the repo and the whitelist .gitignore on first use. */
  async ensureRepo(): Promise<void> {
    if (this.ready && existsSync(join(this.root, '.git'))) return;
    mkdirSync(this.root, { recursive: true });
    if (!existsSync(join(this.root, '.git'))) {
      await this.run(['init', '-q']);
      await this.run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    const ignoreFile = join(this.root, '.gitignore');
    const current = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : null;
    if (current !== SKILLS_GITIGNORE) writeFileSync(ignoreFile, SKILLS_GITIGNORE, 'utf8');
    this.ready = true;
  }

  /** Stage the skill folder (and the .gitignore) and create exactly one commit. Returns its sha. */
  async commit(input: { dir: string; author: string; subject: string; body?: string; trailers: Record<string, string | null | undefined> }): Promise<string> {
    const rel = this.rel(input.dir);
    const id = gitAuthor(input.author);
    const trailers = Object.entries(input.trailers)
      .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0)
      .map(([k, v]) => `${k}: ${v.replace(/\s+/g, ' ')}`);
    const message = [input.subject.replace(/\s+/g, ' ').trim(), input.body?.trim(), trailers.join('\n')].filter((p) => p && p.length > 0).join('\n\n');
    await this.run(['add', '-A', '--', '.gitignore', rel]);
    await this.run(['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`, 'commit', '-q', '--allow-empty', '--no-verify', '--cleanup=verbatim', '-m', message]);
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  /** Unified diff between two commits, limited to the skill folder. `fromSha` null = empty tree. */
  async diff(fromSha: string | null, toSha: string, dir: string): Promise<string> {
    return this.run(['diff', '--no-color', '--no-ext-diff', fromSha ?? EMPTY_TREE, toSha, '--', this.rel(dir)]);
  }

  /** Replace the working copy of the skill folder with its tree at `sha` (history is not rewritten). */
  async restoreTree(sha: string, dir: string): Promise<void> {
    const rel = this.rel(dir);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    await this.run(['checkout', '-q', sha, '--', rel]);
  }

  /**
   * Write the skill folder as it was at `sha` into `dest` (a directory outside the working copy),
   * through a throwaway index: neither the repo's index nor the live folder is touched.
   */
  async exportTree(sha: string, dir: string, dest: string): Promise<void> {
    const rel = this.rel(dir);
    mkdirSync(dest, { recursive: true });
    const index = `${dest.replace(/\/+$/, '')}.index`;
    try {
      await this.run(['read-tree', `${sha}:${rel}`], { GIT_INDEX_FILE: index });
      await this.run(['checkout-index', '-a', '-f', `--prefix=${dest.replace(/\/+$/, '')}/`], { GIT_INDEX_FILE: index });
    } finally {
      rmSync(index, { force: true });
    }
  }

  /** Best effort: throw away uncommitted changes to the folder after a failed write. */
  async discard(dir: string, existedBefore: boolean): Promise<void> {
    try {
      const rel = this.rel(dir);
      if (!existedBefore) {
        rmSync(dir, { recursive: true, force: true });
        await this.run(['reset', '-q', '--', rel]).catch(() => undefined);
        return;
      }
      rmSync(dir, { recursive: true, force: true });
      await this.run(['reset', '-q', '--', rel]).catch(() => undefined);
      await this.run(['checkout', '-q', 'HEAD', '--', rel]);
    } catch {
      /* nothing more we can do; the next resolve detects drift */
    }
  }

  async log(dir: string, format: string, max = 50): Promise<string> {
    return this.run(['log', `-${max}`, `--format=${format}`, '--', this.rel(dir)]);
  }

  private run(args: string[], env: Record<string, string> = {}): Promise<string> {
    const full = ['-C', this.root, '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args];
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        full,
        {
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: dirname(this.root), GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, ...env },
        },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
          reject(
            new ConductorError(missing ? 'unavailable' : 'internal', missing ? 'git is not installed; skills versioning needs the git CLI' : `git ${args[0] === '-c' ? 'commit' : args[0]} failed: ${String(stderr || err.message).trim().slice(0, 500)}`),
          );
        },
      );
    });
  }
}
