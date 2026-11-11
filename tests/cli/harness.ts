import { vi, type Mock } from 'vitest';
import type { ConductorClient, ClientOptions } from '../../src/api/client.js';
import type { Agent, Approval, Connector, Department, Goal, Issue, Memory, Organization, Run, Skill } from '../../src/api/types.js';
import type { LaunchdStatus } from '../../src/daemon/launchd.js';
import { runCli, type CliDeps, type ExecResult } from '../../src/cli/index.js';

export const HOME = '/fake/home/.conductor';
export const LOGS = '/fake/home/Library/Logs/Conductor';
export const TOKEN = 'cnd_owner_test-token-0123456789abcdef';

type ClientMocks = Partial<Record<keyof ConductorClient, Mock>>;

/** A `ConductorClient` stand-in: only the stubbed methods answer, anything else fails loudly. */
export function fakeClient(mocks: ClientMocks): ConductorClient {
  const cache = new Map<string, Mock>(Object.entries(mocks) as Array<[string, Mock]>);
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      let fn = cache.get(prop);
      if (!fn) {
        fn = vi.fn(async () => {
          throw new Error(`unexpected client call: ${prop}`);
        });
        cache.set(prop, fn);
      }
      return fn;
    },
  }) as unknown as ConductorClient;
}

export interface HarnessOptions {
  client?: ClientMocks;
  files?: Record<string, string>;
  dirs?: string[];
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  stdinIsTTY?: boolean;
  stdin?: string;
  /** Answers for `prompt`, in order. */
  answers?: string[];
  exec?: (command: string, args: string[]) => ExecResult | undefined;
  launchdStatus?: Partial<LaunchdStatus>;
  token?: string | null;
  nodeVersion?: string;
  chromium?: string | null;
}

export interface Harness {
  deps: CliDeps;
  client: ConductorClient;
  files: Map<string, string>;
  dirs: Set<string>;
  clientOptions: ClientOptions[];
  prompts: Array<{ question: string; hidden: boolean }>;
  execCalls: Array<{ command: string; args: string[] }>;
  launchd: { install: Mock; uninstall: Mock; status: Mock; restart: Mock; headless: Mock };
  abort: AbortController;
  /** Runs the real CLI and returns what it wrote. */
  run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string; json: () => unknown }>;
}

const NOT_FOUND: ExecResult = { code: 127, stdout: '', stderr: 'not found' };

export function harness(opts: HarnessOptions = {}): Harness {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const dirs = new Set<string>(opts.dirs ?? []);
  if (opts.token !== null) files.set(`${HOME}/owner.token`, `${opts.token ?? TOKEN}\n`);
  const client = fakeClient(opts.client ?? {});
  const clientOptions: ClientOptions[] = [];
  const prompts: Array<{ question: string; hidden: boolean }> = [];
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const answers = [...(opts.answers ?? [])];
  const abort = new AbortController();
  let out = '';
  let err = '';
  let now = 1_700_000_000_000;

  const launchd = {
    install: vi.fn(async (o: { home: string; load?: boolean; logDir?: string }) => ({
      plistPath: '/fake/home/Library/LaunchAgents/ai.conductor.daemon.plist', program: `${o.home}/bin/conductord`, wrapper: `${o.home}/bin/conductord`,
      logDir: o.logDir ?? LOGS, loaded: o.load !== false, linkedSystemBin: false,
    })),
    uninstall: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<LaunchdStatus> => ({ installed: true, loaded: true, pid: 4242, lastExitCode: 0, plistPath: '/fake/home/Library/LaunchAgents/ai.conductor.daemon.plist', ...opts.launchdStatus })),
    restart: vi.fn(async () => {}),
    headless: vi.fn((o: { program: string; home: string; vaultKeyFile: string }) => `<plist><!-- headless ${o.program} ${o.home} ${o.vaultKeyFile} --></plist>\n`),
  };

  const deps: CliDeps = {
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
    env: { ...opts.env },
    isTTY: opts.isTTY ?? false,
    stdinIsTTY: opts.stdinIsTTY ?? false,
    createClient: (o) => {
      clientOptions.push(o);
      return client;
    },
    fs: {
      exists: (p) => files.has(p) || dirs.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`)),
      readText: (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      writeText: (p, content) => void files.set(p, content),
      mkdirp: (p) => void dirs.add(p),
      readDir: (p) => [...files.keys()].filter((f) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes('/')).map((f) => f.slice(p.length + 1)),
      isWritableDir: (p) => dirs.has(p),
      size: (p) => Buffer.byteLength(files.get(p) ?? ''),
      readFrom: (p, offset) => Buffer.from(files.get(p) ?? '').subarray(offset).toString('utf8'),
    },
    launchd: {
      installLaunchAgent: launchd.install as unknown as CliDeps['launchd']['installLaunchAgent'],
      uninstallLaunchAgent: launchd.uninstall as unknown as CliDeps['launchd']['uninstallLaunchAgent'],
      launchdStatus: launchd.status as unknown as CliDeps['launchd']['launchdStatus'],
      restartLaunchAgent: launchd.restart as unknown as CliDeps['launchd']['restartLaunchAgent'],
      renderHeadlessDaemonPlist: launchd.headless as unknown as CliDeps['launchd']['renderHeadlessDaemonPlist'],
      renderWrapper: (node, entry) => `#!/bin/sh\nexec "${node}" "${entry}" "$@"\n`,
    },
    exec: async (command, args) => {
      execCalls.push({ command, args });
      return opts.exec?.(command, args) ?? NOT_FOUND;
    },
    prompt: async (question, o) => {
      prompts.push({ question, hidden: o?.hidden === true });
      return answers.shift() ?? '';
    },
    readStdin: async () => opts.stdin ?? '',
    editText: async (initial) => `${initial} (edited)`,
    chromiumPath: async () => (opts.chromium === undefined ? '/fake/chromium' : opts.chromium),
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    signal: abort.signal,
    projectRoot: '/fake/project',
    nodeVersion: opts.nodeVersion ?? '22.11.0',
    nodePath: '/fake/bin/node',
    homedir: '/fake/home',
    username: 'tester',
  };
  if (opts.chromium === undefined) files.set('/fake/chromium', '');

  return {
    deps, client, files, dirs, clientOptions, prompts, execCalls, launchd, abort,
    async run(...argv) {
      out = '';
      err = '';
      const code = await runCli(argv, deps);
      const stdout = out;
      return { code, stdout, stderr: err, json: () => JSON.parse(stdout) as unknown };
    },
  };
}

/* ── row fixtures (only the fields the CLI reads) ── */
const T0 = 1_699_999_000_000;
export const org = (p: Partial<Organization> = {}): Organization => ({
  id: 'org_1', slug: 'acme', name: 'Acme', mission: 'Ship', owner: 'owner', budgetMonthlyUsd: 100, seatSecondsMonthly: null, defaultProvider: { adapter: 'claude_local' },
  utilityModel: null, policies: {}, defaultSkills: [], defaultConnectors: [], maxConcurrentRuns: 4, status: 'active', killSwitch: false, createdAt: T0, updatedAt: T0, ...p,
});
export const dept = (p: Partial<Department> = {}): Department => ({
  id: 'dept_eng', orgId: 'org_1', slug: 'engineering', name: 'Engineering', charter: 'Build', leadAgentId: 'agt_riley', budgetUsd: null, sharedSkills: [], sharedConnectors: [], status: 'active', createdAt: T0, updatedAt: T0, ...p,
});
export const agent = (p: Partial<Agent> = {}): Agent => ({
  id: 'agt_riley', orgId: 'org_1', deptId: 'dept_eng', slug: 'riley', name: 'Riley', role: 'Head of Engineering', goal: 'Deliver', backstory: '', reportsTo: null, providerBinding: null, model: null,
  skills: [], connectors: [], denySkills: [], denyConnectors: [], browserProfileId: null, heartbeatCron: null, budgetUsd: null, autonomyLevel: 2, status: 'active', pausedReason: null,
  maxSteps: 50, maxWallMs: 600_000, maxRunsPerHour: 12, createdAt: T0, updatedAt: T0, ...p,
} as Agent);
export const issue = (p: Partial<Issue> = {}): Issue => ({
  id: 'iss_1', orgId: 'org_1', number: 12, goalId: null, projectId: null, title: 'Fix the login bug', body: 'It fails.', expectedOutput: '', taskType: null, assigneeAgentId: 'agt_riley', reviewerAgentId: null,
  creatorKind: 'human', creatorId: 'owner', status: 'todo', blockedReason: null, priority: 2, parentIssueId: null, blockedBy: [], checkoutLock: null, checkoutAt: null, labels: [], playbookId: null,
  reviewOutcome: null, reworkCount: 0, closedAt: null, createdAt: T0, updatedAt: T0, ...p,
} as Issue);
export const goal = (p: Partial<Goal> = {}): Goal => ({
  id: 'goal_1', orgId: 'org_1', parentGoalId: null, level: 'org', deptId: null, ownerAgentId: null, title: 'Reach 100 customers', description: '', successMetric: 'customers', target: '100', weight: 1, due: null, status: 'active', createdAt: T0, updatedAt: T0, ...p,
} as Goal);
export const run = (p: Partial<Run> = {}): Run => ({
  id: 'run_01HZZZZZZZZZZZZZZZZZZZZZZZ', orgId: 'org_1', agentId: 'agt_riley', issueId: 'iss_1', trigger: 'manual', provider: 'claude_local', model: null, status: 'succeeded', phase: null, startedAt: T0, endedAt: T0 + 65_000,
  tokensIn: 1200, tokensOut: 340, costUsd: 0.0421, subscription: false, seatSeconds: 0, steps: 7, outcome: 'completed', error: null, transcriptRef: null, sessionId: null, capabilitySnapshot: null, ingestedUntrusted: false, grade: null, pid: null, createdAt: T0, ...p,
} as Run);
export const approval = (p: Partial<Approval> = {}): Approval => ({
  id: 'apr_1', orgId: 'org_1', requesterAgentId: 'agt_riley', runId: null, issueId: null, kind: 'external_send', title: 'Send the launch email', payload: { to: 'a@b.c' }, status: 'pending', decidedBy: null, decisionNote: null,
  decidedAt: null, consumedAt: null, expiresAt: null, createdAt: T0, ...p,
} as Approval);
export const skill = (p: Partial<Skill> = {}): Skill => ({
  id: 'skl_1', orgId: 'org_1', scope: 'agent', scopeId: 'agt_riley', name: 'release-notes', description: 'Write release notes', version: 3, author: 'agent:riley', status: 'active', evalScore: 0.8, path: '/x', contentHash: 'h', pinnedHash: null,
  source: null, hasScripts: false, scanFindings: [], createdRunId: null, originIssueId: null, useCount: 10, successCount: 9, lastUsedAt: T0, createdAt: T0, updatedAt: T0, ...p,
} as Skill);
export const memory = (p: Partial<Memory> = {}): Memory => ({
  rowid: 1, id: 'mem_1', orgId: 'org_1', scope: 'agent', scopeId: 'agt_riley', kind: 'lesson', content: 'Always run the tests before pushing.', entity: null, taskType: null, importance: 0.7, confidence: 0.9, sourceRunId: null,
  author: 'agent:riley', status: 'active', supersededBy: null, pinned: false, useCount: 2, lastUsedAt: null, createdAt: T0, updatedAt: T0, ...p,
} as Memory);
export const connector = (p: Partial<Connector> = {}): Connector => ({
  id: 'con_1', orgId: 'org_1', scope: 'org', scopeId: 'org_1', kind: 'mcp_http', name: 'GitHub', templateId: 'github', config: {}, authRef: 'org/acme/github', toolAllowlist: null, status: 'active', lastError: null, createdAt: T0, updatedAt: T0, ...p,
} as Connector);
