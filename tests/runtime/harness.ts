import { vi } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { createGovernance } from '../../src/governance/index.js';
import { createOrgService } from '../../src/org/index.js';
import { createWorkService } from '../../src/work/index.js';
import { createRuntime, InProcessSupervisor, type Runtime } from '../../src/runtime/index.js';
import type { AdapterRegistry, AgentAdapter, ResolvedSkillRef, RunContext, RunEvent, RunResult } from '../../src/contracts/adapter.js';
import type { MemoryService, SkillService, ConnectorGateway, Governance, WorkerJob } from '../../src/contracts/services.js';
import type { OrgService, WorkService } from '../../src/contracts/org-work.js';
import type { Agent, Department, Organization } from '../../src/contracts/rows.js';
import { OWNER } from '../../src/contracts/types.js';
import type { RuntimeOptions } from '../../src/runtime/types.js';

export type Script = (ctx: RunContext, emit: (e: RunEvent) => void, h: Harness) => Promise<Partial<RunResult> | void> | Partial<RunResult> | void;

export interface Harness {
  k: TestKernel;
  governance: Governance;
  org: OrgService;
  work: WorkService;
  runtime: Runtime;
  memory: { recall: ReturnType<typeof vi.fn>; reflect: ReturnType<typeof vi.fn>; consolidate: ReturnType<typeof vi.fn> };
  skills: { recordUsage: ReturnType<typeof vi.fn> };
  /** Skills the fake skill service resolves for every agent, and the registry rows behind them. */
  skillRefs: ResolvedSkillRef[];
  skillRows: Map<string, { version: number; contentHash: string }>;
  /** Contexts seen by the fake adapter, in order. */
  calls: RunContext[];
  /** What the fake adapter does on its next runs (default: complete with "done"). */
  script: Script;
  acme: Organization;
  dept: Department;
  /** Level-3 lead, heartbeat every 30 minutes. */
  lead: Agent;
  /** Level-1 specialist reporting to the lead, hourly heartbeat. */
  ada: Agent;
  /** tick → wait for dispatched jobs → repeat until nothing is due. */
  drain(): Promise<void>;
  dispose(): Promise<void>;
}

const usage = (costUsd = 0.01) => ({ tokensIn: 100, tokensOut: 50, costUsd, subscription: false, seatSeconds: 0 });

export async function createHarness(opts: { runtime?: RuntimeOptions; resume?: boolean; start?: boolean } = {}): Promise<Harness> {
  const k = createTestKernel();
  const governance = createGovernance(k);
  const org = createOrgService(k, { approvals: governance.approvals });
  const work = createWorkService(k, { org });

  const h = { k, governance, org, work, calls: [] as RunContext[] } as unknown as Harness;
  h.script = () => {};
  h.skillRefs = [];
  h.skillRows = new Map();

  const cancelled = new Map<string, () => void>();
  const adapter: AgentAdapter = {
    id: 'fake',
    capabilities: () => ({ tools: true, mcp: true, resume: opts.resume ?? false, vision: false, browser: 'via_mcp' }),
    testConnection: async () => ({ ok: true }),
    async run(ctx, onEvent) {
      h.calls.push(ctx);
      const cancel = new Promise<Partial<RunResult>>((res) => cancelled.set(ctx.runId, () => res({ outcome: 'cancelled' })));
      const out = (await Promise.race([Promise.resolve(h.script(ctx, onEvent, h)), cancel])) ?? {};
      return { outcome: 'completed', finalText: 'done', steps: 3, usage: usage(), ...out };
    },
    cancel: async (runId) => cancelled.get(runId)?.(),
  };
  const registry: AdapterRegistry = {
    get: (id) => (id === 'fake' ? adapter : undefined),
    list: () => [],
    loadPlugins: async () => {},
  };
  const chain = async (r: AdapterRegistry, job: WorkerJob, onEvent: (e: RunEvent) => void) => {
    const res = await r.get(job.adapterId)!.run(job.ctx, onEvent);
    return { ...res, adapterId: job.adapterId, model: job.ctx.model };
  };

  h.memory = {
    recall: vi.fn(async () => ({ profile: '', ownerModel: '', memories: [] })),
    reflect: vi.fn(async () => ({ grade: { issueClosed: true, reviewOutcome: null, costVsMedian: null, success: true }, memoriesWritten: [], memoriesQueued: [], skillCandidate: null, summary: '' })),
    consolidate: vi.fn(async () => ({ merged: 0, decayed: 0, promotedToSkillDrafts: 0, profileTokens: 0 })),
  };
  h.skills = { recordUsage: vi.fn(async () => {}) };
  const skills = {
    resolveForAgent: () => h.skillRefs, loadedSkills: () => [], retireStale: async () => [],
    get: (id: string) => ({ status: 'active', author: 'human', ...h.skillRows.get(id) }),
    ...h.skills,
  } as unknown as SkillService;
  const connectors = { snapshot: async () => [], endRun: async () => {} } as Pick<ConnectorGateway, 'snapshot' | 'endRun'>;

  h.runtime = createRuntime(k, {
    org, work, governance, skills, memory: h.memory as unknown as MemoryService, connectors, registry,
    baseUrl: () => 'http://127.0.0.1:7420',
    supervisor: new InProcessSupervisor(registry, chain, async (r, id) => r.get('fake')!.cancel(id)),
    options: { tickMs: 0, systemJobs: false, powerAssertion: false, ...opts.runtime },
  });

  h.acme = org.createOrg({ name: 'Acme', defaultProvider: { adapter: 'fake', model: 'fake-1' }, budgetMonthlyUsd: 100 }, OWNER);
  h.dept = org.createDept(h.acme.id, { name: 'Engineering' }, OWNER);
  h.lead = org.hireAgent(h.acme.id, { deptId: h.dept.id, name: 'Lena', role: 'Engineering Lead', autonomyLevel: 3, isLead: true, heartbeatCron: '*/30 * * * *' }, OWNER).agent!;
  h.ada = org.hireAgent(h.acme.id, { deptId: h.dept.id, name: 'Ada', role: 'Engineer', autonomyLevel: 1, reportsTo: h.lead.id, heartbeatCron: '0 * * * *' }, OWNER).agent!;

  if (opts.start !== false) await h.runtime.start();

  const dueCount = () => (k.sqlite.prepare("select count(*) as n from jobs where status = 'pending' and run_at <= ?").get(k.clock.now()) as { n: number }).n;
  h.drain = async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setImmediate(r));
      await h.runtime.tick();
      await h.runtime.idle();
      await new Promise((r) => setImmediate(r));
      if (dueCount() === 0) return;
    }
    throw new Error('scheduler did not drain');
  };
  h.dispose = async () => {
    await h.runtime.stop();
    k.dispose();
  };
  return h;
}

export { usage };
