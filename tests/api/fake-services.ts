import type { AddressInfo } from 'node:net';
import { vi, type Mock } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createGovernance } from '../../src/governance/index.js';
import { createApiServer, type ApiServer, type ApiServerOptions } from '../../src/api/index.js';
import type { Services } from '../../src/daemon/container.js';
import type { OrgService, WorkService } from '../../src/contracts/org-work.js';
import type { BrowserInputEvent, BrowserService, ConnectorGateway, MemoryService, SkillService } from '../../src/contracts/services.js';
import type { AdapterRegistry, AgentAdapter } from '../../src/contracts/adapter.js';
import type { ToolCallContext } from '../../src/contracts/tools.js';
import type { Agent, BrowserSession, Department, Issue, Job, Organization, Run, Skill } from '../../src/contracts/rows.js';
import type { Runtime } from '../../src/runtime/index.js';
import type { EnqueueInput } from '../../src/runtime/jobs.js';
import { agents, organizations } from '../../src/db/schema/index.js';
import { conflict, forbidden, notFound } from '../../src/shared/errors.js';
import { newId } from '../../src/shared/ids.js';

type AnyFn = (...args: never[]) => unknown;
/** Every method of T as a vitest mock; methods without an implementation are created on first use. */
export type Stub<T> = { [K in keyof T]: T[K] extends AnyFn ? Mock<T[K]> : T[K] };

/** London-style collaborator: implemented methods are spies, everything else is a lazily created `vi.fn()`. */
export function stub<T extends object>(impl: Partial<T> = {}): Stub<T> {
  const target: Record<string | symbol, unknown> = {};
  for (const [k, v] of Object.entries(impl)) target[k] = typeof v === 'function' ? vi.fn(v as AnyFn) : v;
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return undefined;
      if (!(prop in t)) t[prop] = vi.fn();
      return t[prop];
    },
  }) as Stub<T>;
}

export interface FakeTakeover {
  session: BrowserSession;
  token: string;
  io: Parameters<BrowserService['attachViewer']>[2] | null;
  inputs: BrowserInputEvent[];
  detached: number;
}

export interface Fake {
  services: Services;
  kernel: TestKernel;
  org: Stub<OrgService>;
  work: Stub<WorkService>;
  skills: Stub<SkillService>;
  memory: Stub<MemoryService>;
  connectors: Stub<ConnectorGateway>;
  browser: Stub<BrowserService>;
  runtime: Stub<Runtime>;
  ownerToken: string;
  orgA: Organization;
  orgB: Organization;
  dept: Department;
  agent: Agent;
  agentB: Agent;
  issues: Issue[];
  skillRows: Map<string, Skill>;
  runs: Map<string, Run>;
  liveRuns: Map<string, ToolCallContext>;
  jobs: EnqueueInput[];
  jobHandlers: Map<string, (job: Job) => Promise<void>>;
  takeovers: Map<string, FakeTakeover>;
  /** Start a live run for the seeded agent and return its run token. */
  startRun(opts?: { issueId?: string | null }): { runId: string; token: string; ctx: ToolCallContext };
  addTakeover(token: string, reason?: string): FakeTakeover;
  config: { publicUrl: string; baseUrl: string };
  dispose(): void;
}

export function createFake(): Fake {
  const kernel = createTestKernel();
  const governance = createGovernance(kernel);
  const orgA = seedOrg(kernel, 'Acme');
  const orgB = seedOrg(kernel, 'Globex');
  const dept = seedDept(kernel, orgA.id);
  const agent = seedAgent(kernel, orgA.id, dept.id, 'Ada');
  const agentB = seedAgent(kernel, orgB.id, seedDept(kernel, orgB.id).id, 'Bob');
  const config = { publicUrl: 'http://127.0.0.1:7420', baseUrl: 'http://127.0.0.1:7420' };

  const orgRow = (id: string): Organization => {
    const row = kernel.db.select().from(organizations).where(eq(organizations.id, id)).get();
    if (!row) throw notFound('organization', id);
    return row;
  };
  const agentRow = (orgId: string, id: string): Agent => {
    const row = kernel.db.select().from(agents).where(and(eq(agents.orgId, orgId), eq(agents.id, id))).get();
    if (!row) throw notFound('agent', id);
    return row;
  };

  const org = stub<OrgService>({
    listOrgs: () => kernel.db.select().from(organizations).all(),
    getOrg: orgRow,
    getOrgBySlug: (slug) => kernel.db.select().from(organizations).where(eq(organizations.slug, slug)).get() ?? null,
    createOrg: (input) => seedOrg(kernel, input.name),
    updateOrg: (orgId, patch) => ({ ...orgRow(orgId), ...(patch.mission !== undefined ? { mission: patch.mission } : {}) }),
    archiveOrg: (orgId) => ({ ...orgRow(orgId), status: 'archived' as const }),
    listTemplates: () => [{ id: 'startup', name: 'Startup', description: 'A small company', departments: [] }],
    createFromTemplate: (_templateId, input) => seedOrg(kernel, input.name),
    listDepts: (orgId) => (orgId === orgA.id ? [dept] : []),
    listAgents: (orgId) => kernel.db.select().from(agents).where(eq(agents.orgId, orgId)).all(),
    getAgent: agentRow,
    findAgent: (orgId, idOrSlug) =>
      kernel.db.select().from(agents).where(eq(agents.orgId, orgId)).all().find((a) => a.id === idOrSlug || a.slug === idOrSlug) ?? null,
    hireAgent: (orgId, input) => ({ agent: seedAgent(kernel, orgId, input.deptId, input.name, { role: input.role }) }),
    pauseAgent: (orgId, agentId) => ({ ...agentRow(orgId, agentId), status: 'paused' as const }),
    orgChart: () => [],
  });

  const issues: Issue[] = [];
  const work = stub<WorkService>({
    createIssue: (orgId, input) => {
      const now = kernel.clock.now();
      const issue = {
        id: newId('issue'), orgId, number: issues.filter((i) => i.orgId === orgId).length + 1, title: input.title, body: input.body ?? '',
        status: input.status ?? 'todo', assigneeAgentId: input.assigneeAgentId ?? null, priority: input.priority ?? 2,
        labels: input.labels ?? [], createdAt: now, updatedAt: now,
      } as unknown as Issue;
      issues.push(issue);
      return issue;
    },
    listIssues: (orgId, filter = {}) => {
      const statuses = filter.status === undefined ? null : Array.isArray(filter.status) ? filter.status : [filter.status];
      const rows = issues.filter((i) => i.orgId === orgId && (!statuses || statuses.includes(i.status)));
      return rows.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 500));
    },
    findIssue: (orgId, idOrNumber) => issues.find((i) => i.orgId === orgId && (i.id === idOrNumber || i.number === idOrNumber)) ?? null,
    updateIssue: (orgId, issueId, patch) => {
      const issue = issues.find((i) => i.orgId === orgId && i.id === issueId);
      if (!issue) throw notFound('issue', issueId);
      Object.assign(issue, patch);
      return issue;
    },
    listPlaybooks: () => [],
  });

  const skillRows = new Map<string, Skill>();
  const skills = stub<SkillService>({
    get: (id) => {
      const row = skillRows.get(id);
      if (!row) throw notFound('skill', id);
      return row;
    },
    read: (id) => ({ skill: skillRows.get(id)!, body: '# body', files: ['SKILL.md'] }),
    list: (f) => [...skillRows.values()].filter((sk) => sk.orgId === f.orgId || (f.includeGlobal && sk.orgId === null)),
    diff: async () => '--- a\n+++ b\n',
  });

  const memory = stub<MemoryService>({
    search: async () => [],
    getOwnerModel: () => 'owner model',
    getProfileDoc: () => '# MEMORY',
  });

  const connectors = stub<ConnectorGateway>({
    catalog: () => [],
    list: () => [],
    listTools: async () => [{ name: 'conductor-tasks__create_issue', description: 'Create an issue', inputSchema: { type: 'object' }, risk: 'write' as const }],
    callTool: async (ctx, name, args) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ name, args, agentId: ctx.agentId }) }] }),
    handleMcpRequest: async (ctx, req, res, parsedBody) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ runId: ctx.runId, n: 1 })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ runId: ctx.runId, n: 2 })}\n\n`);
          res.end();
        }, 30);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, ctx, body: parsedBody ?? null }));
    },
  });

  const takeovers = new Map<string, FakeTakeover>();
  const takeoverFor = (sessionId: string, viewerId: string): FakeTakeover => {
    const t = takeovers.get(sessionId);
    if (!t) throw notFound('takeover session', sessionId);
    if (t.session.viewerId !== viewerId) throw forbidden('not the viewer of this takeover session');
    return t;
  };
  const browser = stub<BrowserService>({
    listProfiles: () => [],
    listSessions: () => [...takeovers.values()].map((t) => t.session),
    claimShare: (token, viewerId) => {
      const t = [...takeovers.values()].find((x) => x.token === token);
      if (!t) throw forbidden('invalid or expired share link');
      if (t.session.viewerId && t.session.viewerId !== viewerId) throw forbidden('this link was already opened on another device');
      t.session = { ...t.session, viewerId, claimedAt: kernel.clock.now(), status: 'active' };
      return t.session;
    },
    attachViewer: async (sessionId, viewerId, io) => {
      const t = takeoverFor(sessionId, viewerId);
      t.io = io;
      io.onClose(() => {
        t.io = null;
      });
      return {
        input: async (event) => {
          t.inputs.push(event);
        },
        detach: async () => {
          t.detached += 1;
        },
      };
    },
    handBack: async (sessionId, viewerId) => {
      const t = takeoverFor(sessionId, viewerId);
      if (t.session.status !== 'active') throw conflict('session is not active');
      t.session = { ...t.session, status: 'handed_back', handedBackAt: kernel.clock.now() };
    },
  });

  const runs = new Map<string, Run>();
  const liveRuns = new Map<string, ToolCallContext>();
  const jobs: EnqueueInput[] = [];
  const jobHandlers = new Map<string, (job: Job) => Promise<void>>();
  const runtime = stub<Runtime>({
    status: () => ({ running: liveRuns.size, queued: jobs.length, perOrg: {}, perProvider: {}, uptimeMs: 1234 }),
    toolContext: (runId) => liveRuns.get(runId) ?? null,
    getRun: (orgId, runId) => {
      const run = runs.get(runId);
      if (!run || run.orgId !== orgId) throw notFound('run', runId);
      return run;
    },
    listRuns: (orgId) => [...runs.values()].filter((r) => r.orgId === orgId),
    transcript: (_orgId, _runId, opts) => [{ seq: (opts?.afterSeq ?? 0) + 1, ts: 1, event: { type: 'text' as const, text: 'hello' } }],
    runNow: async () => ({ jobId: 'job_1' }),
    chat: async (_orgId, _agentId, message) => ({ reply: `echo: ${message}`, runId: 'run_chat' }),
    cancelRun: async () => {},
    enqueue: (input) => {
      jobs.push(input);
      return { id: `job_${jobs.length}`, created: true };
    },
    registerJobHandler: (kind, handler) => {
      jobHandlers.set(kind, handler);
    },
    syncSchedules: () => {},
  });

  const fakeAdapter: AgentAdapter = {
    id: 'fake',
    capabilities: () => ({ tools: true, mcp: true, resume: false, vision: false, browser: 'via_mcp' }),
    testConnection: async (cfg) => ({ ok: cfg.secrets.apiKey === 'sk-test-key-value', detail: cfg.secrets.apiKey ? 'key present' : 'no key' }),
    run: async () => ({ outcome: 'completed', finalText: '', steps: 0, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, subscription: false, seatSeconds: 0 } }),
    cancel: async () => {},
  };
  const registry: AdapterRegistry = {
    get: (id) => (id === 'fake' ? fakeAdapter : undefined),
    list: () => [{ id: 'fake', name: 'Fake', capabilities: fakeAdapter.capabilities(), configSchema: {}, builtin: true }],
    loadPlugins: async () => {},
  };

  const services = {
    kernel, org, work, governance, skills, memory, connectors, browser, runtime, registry,
    utility: stub<Services['utility']>(),
    embedder: { id: 'fake', dims: 4, embed: async () => [] },
    baseUrl: () => config.baseUrl,
    publicUrl: () => config.publicUrl,
    version: '0.0.0-test',
  } as unknown as Services;

  return {
    services, kernel, org, work, skills, memory, connectors, browser, runtime, config,
    ownerToken: governance.tokens.issueOwnerToken('test'),
    orgA, orgB, dept, agent, agentB, issues, skillRows, runs, liveRuns, jobs, jobHandlers, takeovers,
    startRun(opts = {}) {
      const runId = newId('run');
      const ctx: ToolCallContext = {
        orgId: orgA.id, agentId: agent.id, deptId: dept.id, runId, issueId: opts.issueId ?? null, workspacePath: '/tmp/ws', autonomyLevel: 2,
      };
      liveRuns.set(runId, ctx);
      runs.set(runId, { id: runId, orgId: orgA.id, agentId: agent.id, status: 'running' } as unknown as Run);
      return { runId, ctx, token: governance.tokens.issueRunToken(orgA.id, agent.id, runId, 60_000) };
    },
    addTakeover(token, reason = 'MFA needed') {
      const id = newId('browserSession');
      const t: FakeTakeover = {
        token, io: null, inputs: [], detached: 0,
        session: {
          id, orgId: orgA.id, profileId: 'bp_1', runId: 'run_1', issueId: null, agentId: agent.id, reason, tokenHash: 'hash-of-token',
          expiresAt: kernel.clock.now() + 900_000, claimedAt: null, viewerId: null, status: 'pending', handedBackAt: null, createdAt: kernel.clock.now(),
        },
      };
      takeovers.set(id, t);
      return t;
    },
    dispose() {
      governance.dispose();
      kernel.dispose();
    },
  };
}

export interface Harness extends Fake {
  api: ApiServer;
  /** Authorization header for the owner token. */
  owner: { authorization: string };
  /** Start listening on an ephemeral loopback port; returns the base URL. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

export async function createHarness(opts: ApiServerOptions = {}): Promise<Harness> {
  const fake = createFake();
  const api = await createApiServer(fake.services, { uiDir: '/nonexistent/conductor-ui', ...opts });
  return {
    ...fake,
    api,
    owner: { authorization: `Bearer ${fake.ownerToken}` },
    async listen() {
      await api.listen('127.0.0.1', 0);
      const { port } = api.app.server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;
      fake.config.baseUrl = url;
      fake.config.publicUrl = url;
      return url;
    },
    async close() {
      await api.close();
      fake.dispose();
    },
  };
}
