import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mkdirSync } from 'node:fs';
import { invalid } from './errors.js';

/**
 * On-disk layout (PRD "On-disk layout"). Everything hangs off CONDUCTOR_HOME
 * (default ~/.conductor) so tests and headless installs can relocate it.
 */
export class ConductorPaths {
  readonly home: string;

  constructor(home?: string) {
    this.home = resolve(home ?? process.env.CONDUCTOR_HOME ?? join(homedir(), '.conductor'));
  }

  get db(): string {
    return join(this.home, 'conductor.db');
  }
  get adapters(): string {
    return join(this.home, 'adapters');
  }
  /**
   * Root of the git repo that versions every skill scope. The PRD places skill
   * scopes at different depths under ~/.conductor, so the repo is rooted at
   * home with a whitelist .gitignore that tracks only `skills/` directories.
   */
  get skillsRepoRoot(): string {
    return this.home;
  }
  get globalSkills(): string {
    return join(this.home, 'skills', 'global');
  }
  get backups(): string {
    return join(this.home, 'backups');
  }
  get vault(): string {
    return join(this.home, 'vault.enc');
  }
  get runDir(): string {
    return join(this.home, 'run');
  }
  get logs(): string {
    return process.env.CONDUCTOR_LOG_DIR ?? join(homedir(), 'Library', 'Logs', 'Conductor');
  }

  org(orgSlug: string): string {
    return this.safe(join(this.home, 'orgs', seg(orgSlug)));
  }
  orgSkills(orgSlug: string): string {
    return join(this.org(orgSlug), 'skills');
  }
  deptSkills(orgSlug: string, deptSlug: string): string {
    return this.safe(join(this.org(orgSlug), 'depts', seg(deptSlug), 'skills'));
  }
  agentSkills(orgSlug: string, agentSlug: string): string {
    return join(this.agentDir(orgSlug, agentSlug), 'skills');
  }
  agentDir(orgSlug: string, agentSlug: string): string {
    return this.safe(join(this.org(orgSlug), 'agents', seg(agentSlug)));
  }
  agentMemoryFile(orgSlug: string, agentSlug: string): string {
    return join(this.agentDir(orgSlug, agentSlug), 'MEMORY.md');
  }
  ownerModelFile(orgSlug: string): string {
    return join(this.org(orgSlug), 'USER.md');
  }
  agentWorkspace(orgSlug: string, agentSlug: string): string {
    return join(this.agentDir(orgSlug, agentSlug), 'workspace');
  }
  browserProfile(orgSlug: string, profileSlug: string): string {
    return this.safe(join(this.org(orgSlug), 'browser-profiles', seg(profileSlug)));
  }
  artifacts(orgSlug: string): string {
    return join(this.org(orgSlug), 'artifacts');
  }
  transcripts(orgSlug: string): string {
    return join(this.org(orgSlug), 'transcripts');
  }
  transcript(orgSlug: string, runId: string): string {
    return join(this.transcripts(orgSlug), `${seg(runId)}.jsonl`);
  }

  ensure(dir: string): string {
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Throws unless `p` resolves inside CONDUCTOR_HOME. */
  safe(p: string): string {
    const r = resolve(p);
    if (r !== this.home && !r.startsWith(this.home + sep)) {
      throw invalid(`path escapes conductor home: ${p}`);
    }
    return r;
  }
}

function seg(s: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) || s.includes('..')) {
    throw invalid(`unsafe path segment: ${s}`);
  }
  return s;
}

/** Resolve `child` under `root`, refusing traversal outside it. */
export function resolveInside(root: string, child: string): string {
  const base = resolve(root);
  const r = resolve(base, child);
  if (r !== base && !r.startsWith(base + sep)) {
    throw invalid(`path escapes root: ${child}`);
  }
  return r;
}
