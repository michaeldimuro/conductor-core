import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { RunContext, RunEvent, SandboxReport } from '../../contracts/adapter.js';
import { AdapterError } from './errors.js';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Prefix of the private temp dirs adapters create per run (they can hold a run token). */
export const RUN_TMP_PREFIX = 'conductor-run-';

export type SandboxNetwork = 'on' | 'local';

/** Hand this to `runProcess({ sandbox })`: the child is started through `sandbox-exec -p <profile>`. */
export interface SandboxSpec {
  profile: string;
  /** Override the sandbox-exec binary (tests). */
  exec?: string;
}

/** Everything the profile is built from. All paths are absolute. */
export interface SandboxProfileInput {
  workspace: string;
  /** Conductor homes (DB, vault, owner token, other orgs): no read, no write — except the workspace inside it. */
  conductorHomes: string[];
  /** Read+write: temp dirs and the provider CLI's own state. */
  writePaths: string[];
  /** Read+write for every path starting with one of these (e.g. `~/.claude.json` and its lock/backup files). */
  writePrefixes?: string[];
  /** Secret stores: no read. */
  denyReadPaths: string[];
  denyReadPrefixes?: string[];
  /** Read-only exceptions inside denied areas (skill folders). */
  readPaths?: string[];
  /** Read+write exceptions inside denied areas (this run's private temp dir, the Keychain for a CLI login). */
  reallowWritePaths?: string[];
  /** Temp roots in which other runs' `conductor-run-*` dirs are hidden. */
  tmpRoots?: string[];
  network: SandboxNetwork;
}

const quote = (p: string): string => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const subpaths = (paths: string[]): string => paths.map((p) => `(subpath ${quote(p)})`).join(' ');
/** A raw SBPL regex matching every path that starts with `prefix`. */
const prefixRegex = (prefix: string): string => `(regex #"^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")`;
const usablePrefix = (p: string): boolean => !p.includes('"');

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** `p` as given plus its symlink-resolved form (the sandbox matches real paths: /tmp is /private/tmp). */
export function pathVariants(p: string): string[] {
  const abs = resolve(p);
  const out = new Set<string>([abs]);
  // Resolve the nearest existing ancestor so not-yet-created paths are covered too.
  let cur = abs;
  let rest = '';
  for (;;) {
    if (existsSync(cur)) {
      try {
        out.add(rest ? join(realpathSync(cur), rest) : realpathSync(cur));
      } catch {
        // unreadable: keep the lexical form
      }
      break;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    rest = rest ? join(basename(cur), rest) : basename(cur);
    cur = parent;
  }
  return [...out];
}

const allVariants = (paths: string[]): string[] => [...new Set(paths.filter(Boolean).flatMap(pathVariants))];

/**
 * Seatbelt profile for a provider process (PRD "Agent escaping its scope").
 *
 * Agent CLIs are full programs (Node, Rust) that need the dynamic loader,
 * system frameworks and Mach services, so the base is `allow default` and the
 * confinement is expressed as denials, last match wins:
 *   1. no writes anywhere, except workspace + temp + the CLI's own state;
 *   2. no reads (or writes) of Conductor's home and of secret stores;
 *   3. the workspace, which normally lives inside Conductor's home, is re-allowed;
 *   4. network on, or loopback only.
 */
export function buildAgentSandboxProfile(input: SandboxProfileInput): string {
  const workspace = allVariants([input.workspace]);
  const homes = allVariants(input.conductorHomes);
  const write = allVariants(input.writePaths);
  const denyRead = allVariants(input.denyReadPaths);
  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${subpaths([...workspace, ...write, '/dev'])})`,
  ];
  const writePrefixes = allVariants(input.writePrefixes ?? []).filter(usablePrefix);
  if (writePrefixes.length > 0) lines.push(`(allow file-write* ${writePrefixes.map(prefixRegex).join(' ')})`);

  if (homes.length > 0) lines.push(`(deny file-read* file-write* ${subpaths(homes)})`);
  if (denyRead.length > 0) lines.push(`(deny file-read* file-write* ${subpaths(denyRead)})`);
  const denyPrefixes = allVariants(input.denyReadPrefixes ?? []).filter(usablePrefix);
  if (denyPrefixes.length > 0) lines.push(`(deny file-read* file-write* ${denyPrefixes.map(prefixRegex).join(' ')})`);
  // Other runs' private temp dirs (MCP configs carrying their run tokens).
  const tmpRoots = allVariants(input.tmpRoots ?? []).filter(usablePrefix);
  if (tmpRoots.length > 0) lines.push(`(deny file-read* file-write* ${tmpRoots.map((t) => prefixRegex(join(t, RUN_TMP_PREFIX))).join(' ')})`);

  // Exceptions. A workspace is only re-allowed when it sits INSIDE a denied
  // root; a workspace that contains one (e.g. the user's home) never unlocks it.
  const denied = [...homes, ...denyRead];
  const nested = workspace.filter((w) => denied.some((d) => inside(w, d)) && !denied.some((d) => inside(d, w)));
  if (nested.length > 0) {
    lines.push(`(allow file-read* file-write* ${subpaths(nested)})`);
    // Path resolution (realpath, getcwd) needs to stat the directories above the workspace — existence only.
    const ancestors = new Set<string>();
    for (const w of nested) {
      for (let dir = dirname(w); denied.some((d) => inside(dir, d)); dir = dirname(dir)) {
        ancestors.add(dir);
        if (dirname(dir) === dir) break;
      }
    }
    if (ancestors.size > 0) lines.push(`(allow file-read-metadata ${[...ancestors].map((a) => `(literal ${quote(a)})`).join(' ')})`);
  }
  const reallow = allVariants(input.reallowWritePaths ?? []);
  if (reallow.length > 0) lines.push(`(allow file-read* file-write* ${subpaths(reallow)})`);
  const read = allVariants(input.readPaths ?? []);
  if (read.length > 0) lines.push(`(allow file-read* ${subpaths(read)})`);

  if (input.network === 'local') {
    // Loopback only: enough for the Conductor API / MCP gateway, nothing leaves the machine.
    lines.push(
      '(deny network*)',
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-bind (local ip "localhost:*"))',
    );
  }
  return lines.join('\n');
}

const PROBE_PROFILE = '(version 1)(allow default)(deny file-write* (subpath "/nonexistent-conductor-probe"))';
let availability: { ok: boolean; reason?: string } | null = null;

/**
 * Whether children can be sandboxed here. Besides the binary existing this
 * runs it once: applying a profile fails when the daemon itself is already
 * sandboxed (seatbelt profiles do not nest).
 */
export function sandboxAvailability(exec: string = SANDBOX_EXEC): { ok: boolean; reason?: string } {
  const cached = exec === SANDBOX_EXEC ? availability : null;
  if (cached) return cached;
  let result: { ok: boolean; reason?: string };
  if (process.platform !== 'darwin') result = { ok: false, reason: `sandbox-exec is macOS-only (platform ${process.platform})` };
  else if (!existsSync(exec)) result = { ok: false, reason: `${exec} not found` };
  else {
    try {
      execFileSync(exec, ['-p', PROBE_PROFILE, '/usr/bin/true'], { stdio: 'ignore', timeout: 5000 });
      result = { ok: true };
    } catch (e) {
      result = { ok: false, reason: `sandbox-exec cannot apply a profile here (${e instanceof Error ? e.message.split('\n')[0] : String(e)})` };
    }
  }
  if (exec === SANDBOX_EXEC) availability = result;
  return result;
}

/** Forget the cached availability probe (tests). */
export function resetSandboxAvailability(): void {
  availability = null;
}

/** `config.sandbox` on a provider binding: `false` opts out, an object tunes the default. */
const bindingSandboxSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean().default(true),
    network: z.enum(['on', 'local']).optional(),
    /** Extra read+write paths (e.g. a package-manager cache). Never inside Conductor's home. */
    allowWrite: z.array(z.string().min(1)).max(50).default([]),
    /** Lift a default read denial (e.g. "~/.ssh" for git over ssh). Never inside Conductor's home. */
    allowRead: z.array(z.string().min(1)).max(50).default([]),
  }),
]);

/** JSON Schema fragment for the `sandbox` key every process-spawning adapter accepts. */
export const sandboxConfigJsonSchema: Record<string, unknown> = {
  description: 'macOS sandbox for the spawned process. On by default; `false` runs it with full user privileges.',
  oneOf: [
    { type: 'boolean', default: true },
    {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: true },
        network: { type: 'string', enum: ['on', 'local'], description: '`local` = loopback only.' },
        allowWrite: { type: 'array', items: { type: 'string' }, description: 'Extra writable paths.' },
        allowRead: { type: 'array', items: { type: 'string' }, description: 'Lift a default read denial, e.g. "~/.ssh".' },
      },
    },
  ],
};

export interface SandboxRequest {
  /** Which provider CLI is being spawned: decides the state dirs it may touch. Omit for arbitrary commands. */
  cli?: 'claude' | 'codex';
  /** The child's environment (CLAUDE_CONFIG_DIR / CODEX_HOME relocate CLI state). */
  env?: Record<string, string | undefined>;
  /** This run's own private temp dirs (stay accessible while other runs' are hidden). */
  privateTmp?: string[];
  /** Override the sandbox-exec binary (tests). */
  exec?: string;
  /**
   * The binding's sandbox setting when it does not live at `config.sandbox`
   * (codex_local uses that key for Codex's own mode and reads `config.processSandbox`).
   */
  binding?: { value: unknown };
  /** Where the fallback warning is logged (default: stderr of the worker, which the supervisor captures). */
  warn?: (message: string) => void;
}

export interface SandboxPlan {
  /** Null when the child runs unsandboxed (opt-out or unavailable). */
  spec: SandboxSpec | null;
  report: SandboxReport;
  warnings: string[];
}

/** Home-relative secret stores no agent process reads by default. */
const SECRET_STORES = [
  '.ssh', '.aws', '.gnupg', '.kube', '.netrc', '.git-credentials', '.azure', '.password-store',
  '.config/gcloud', '.config/gh', '.config/op',
  'Library/Cookies', 'Library/Safari', 'Library/Mail', 'Library/Messages',
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox', 'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge', 'Library/Application Support/1Password', 'Library/Group Containers/2BUA8C4S2C.com.1password',
  'Library/Logs/Conductor',
];

const expandHome = (p: string, home: string): string => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);

/** `<home>/orgs/<org>/agents/<agent>/workspace` → `<home>` (the PRD on-disk layout). */
export function inferConductorHome(workspace: string): string | null {
  const m = /^(.+)\/orgs\/[^/]+\/agents\/[^/]+\/workspace(?:\/.*)?$/.exec(resolve(workspace));
  return m?.[1] ?? null;
}

function parseBinding(raw: unknown): { enabled: boolean; network?: SandboxNetwork; allowWrite: string[]; allowRead: string[] } {
  if (raw === undefined || raw === null) return { enabled: true, allowWrite: [], allowRead: [] };
  const r = bindingSandboxSchema.safeParse(raw);
  // Fail closed: a typo must not silently turn the sandbox off (or on with the wrong policy).
  if (!r.success) throw new AdapterError('invalid_request', `config.sandbox invalid: ${r.error.issues[0]?.message ?? 'expected a boolean or an object'}`);
  if (typeof r.data === 'boolean') return { enabled: r.data, allowWrite: [], allowRead: [] };
  return r.data;
}

/**
 * Decide how the provider process of a run is confined. On by default;
 * `config.sandbox: false` opts a binding out; when `sandbox-exec` cannot be
 * used the plan falls back to no sandbox and says so in `report`.
 */
export function planSandbox(ctx: Pick<RunContext, 'config' | 'workspacePath' | 'skills' | 'sandbox'>, req: SandboxRequest = {}): SandboxPlan {
  const binding = parseBinding(req.binding ? req.binding.value : ctx.config.sandbox);
  if (!binding.enabled) {
    return { spec: null, report: { enabled: false, reason: 'disabled on the provider binding (sandbox = false)' }, warnings: [] };
  }
  const avail = sandboxAvailability(req.exec);
  if (!avail.ok) return { spec: null, report: { enabled: false, fallback: true, reason: avail.reason ?? 'sandbox-exec unavailable' }, warnings: [] };

  const env = req.env ?? {};
  const home = env.HOME ?? process.env.HOME ?? homedir();
  const at = (rel: string): string => join(home, rel);
  const warnings: string[] = [];

  const conductorHomes = [
    ...new Set(
      [ctx.sandbox?.conductorHome, process.env.CONDUCTOR_HOME, inferConductorHome(ctx.workspacePath), at('.conductor')]
        .filter((p): p is string => typeof p === 'string' && isAbsolute(p))
        .map((p) => resolve(p)),
    ),
  ];
  const insideConductor = (p: string): boolean => pathVariants(p).some((v) => allVariants(conductorHomes).some((h) => inside(v, h)));

  // Temp: the per-user temp dir (and its sibling cache dir on macOS) plus the classic shared ones.
  const tmp = realpathOr(env.TMPDIR ?? tmpdir());
  const tmpRoots = [tmp, '/private/tmp', '/private/var/tmp'];
  const writePaths = [...tmpRoots];
  if (/^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(tmp)) writePaths.push(join(dirname(tmp), 'C'));

  const writePrefixes: string[] = [];
  const reallowWritePaths = [...(req.privateTmp ?? [])];
  const denyReadPaths = SECRET_STORES.map(at);
  const denyReadPrefixes: string[] = [];
  const claudeState = [env.CLAUDE_CONFIG_DIR ?? at('.claude'), at('.local/share/claude'), at('.local/state/claude'), at('.cache/claude'), at('Library/Caches/claude-cli-nodejs')];
  const codexState = [env.CODEX_HOME ?? at('.codex')];
  const keychain = at('Library/Keychains');

  // Each CLI gets its own state and login; everything else (the other CLI's credentials, the Keychain) stays hidden.
  if (req.cli === 'claude') {
    writePaths.push(...claudeState);
    writePrefixes.push(at('.claude.json'));
    denyReadPaths.push(...codexState);
  } else if (req.cli === 'codex') {
    writePaths.push(...codexState);
    denyReadPaths.push(...claudeState);
    denyReadPrefixes.push(at('.claude.json'));
  } else {
    denyReadPaths.push(...claudeState, ...codexState);
    denyReadPrefixes.push(at('.claude.json'));
  }
  // The CLIs keep the user's login in the login keychain (and refresh it there).
  if (req.cli) writePaths.push(keychain);
  else denyReadPaths.push(keychain);

  const lifted = new Set<string>();
  for (const raw of binding.allowRead) {
    const p = resolve(expandHome(raw, home));
    if (insideConductor(p)) warnings.push(`sandbox.allowRead ignored (inside Conductor's home): ${raw}`);
    else lifted.add(p);
  }
  for (const raw of binding.allowWrite) {
    const p = resolve(expandHome(raw, home));
    if (insideConductor(p)) warnings.push(`sandbox.allowWrite ignored (inside Conductor's home): ${raw}`);
    else {
      writePaths.push(p);
      lifted.add(p);
    }
  }
  // Exceptions are emitted after the denials, so a lifted path wins without dropping the rest of a denied store.
  const readPaths = [...ctx.skills.map((s) => s.path), ...lifted];

  const network: SandboxNetwork = ctx.sandbox?.network === 'local' || binding.network === 'local' ? 'local' : 'on';
  const profile = buildAgentSandboxProfile({
    workspace: ctx.workspacePath, conductorHomes, writePaths, writePrefixes, denyReadPaths, denyReadPrefixes,
    readPaths, reallowWritePaths, tmpRoots, network,
  });
  return {
    spec: { profile, ...(req.exec ? { exec: req.exec } : {}) },
    report: { enabled: true, network, writable: [resolve(ctx.workspacePath), ...writePaths, ...writePrefixes.map((p) => `${p}*`)] },
    warnings,
  };
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const stderrWarn = (message: string): void => {
  if (!process.env.VITEST) process.stderr.write(`[conductor] WARNING: ${message}\n`);
};

/**
 * The one call adapters make: plan the sandbox, record it in the run's events
 * (a `status` event carrying `sandbox`), log a warning on fallback, and
 * return what to pass to `runProcess({ sandbox })` (undefined = unsandboxed).
 */
export function agentSandbox(ctx: RunContext, emit: (e: RunEvent) => void, req: SandboxRequest = {}): SandboxSpec | undefined {
  return announceSandbox(ctx, emit, planSandbox(ctx, req), req);
}

/** Record a plan in the run's events (and warn on fallback); returns the spec to spawn with. */
export function announceSandbox(ctx: Pick<RunContext, 'runId'>, emit: (e: RunEvent) => void, plan: SandboxPlan, req: Pick<SandboxRequest, 'warn'> = {}): SandboxSpec | undefined {
  for (const w of plan.warnings) emit({ type: 'status', status: w });
  const r = plan.report;
  if (r.enabled) {
    emit({ type: 'status', status: `sandbox: on (writes confined to the workspace; network ${r.network ?? 'on'})`, sandbox: r });
  } else if (r.fallback) {
    const message = `sandbox unavailable — run ${ctx.runId} executes UNSANDBOXED with full user privileges: ${r.reason ?? ''}`;
    (req.warn ?? stderrWarn)(message);
    emit({ type: 'status', status: `sandbox: OFF (fallback) — ${r.reason ?? 'unavailable'}`, sandbox: r });
  } else {
    emit({ type: 'status', status: `sandbox: off — ${r.reason ?? 'disabled'}`, sandbox: r });
  }
  return plan.spec ?? undefined;
}
