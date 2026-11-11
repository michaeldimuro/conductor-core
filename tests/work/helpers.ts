import { and, eq } from 'drizzle-orm';
import { vi } from 'vitest';
import type { OrgService, WorkService } from '../../src/contracts/org-work.js';
import type { ApprovalService } from '../../src/contracts/services.js';
import type { ToolCallContext, ToolResult } from '../../src/contracts/tools.js';
import type { Actor } from '../../src/contracts/types.js';
import type { Agent, Approval, Department, Organization } from '../../src/contracts/rows.js';
import { agents, departments } from '../../src/db/schema/index.js';
import type { DomainEvents, EventName } from '../../src/shared/events.js';
import { ConductorError, notFound } from '../../src/shared/errors.js';
import { createWorkService } from '../../src/work/index.js';
import { seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';

/**
 * Minimal OrgService over the real rows: just the reporting-line and lookup
 * methods the Work context consumes. Anything else throws, so an unexpected
 * dependency on the Org context fails loudly.
 */
export function createFakeOrg(k: TestKernel): OrgService {
  const all = (orgId: string): Agent[] => k.db.select().from(agents).where(eq(agents.orgId, orgId)).all();
  const find = (orgId: string, idOrSlug: string): Agent | null =>
    all(orgId).find((a) => a.id === idOrSlug || a.slug === idOrSlug) ?? null;
  const dept = (orgId: string, deptId: string): Department | null =>
    k.db.select().from(departments).where(and(eq(departments.orgId, orgId), eq(departments.id, deptId))).get() ?? null;

  const reportsOf = (orgId: string, agentId: string, opts?: { transitive?: boolean }): Agent[] => {
    const everyone = all(orgId);
    const direct = (id: string): Agent[] => everyone.filter((a) => a.reportsTo === id);
    if (!opts?.transitive) return direct(agentId);
    const out: Agent[] = [];
    const queue = direct(agentId);
    while (queue.length) {
      const next = queue.shift()!;
      if (out.some((a) => a.id === next.id)) continue;
      out.push(next);
      queue.push(...direct(next.id));
    }
    return out;
  };

  const impl: Partial<OrgService> = {
    getAgent(orgId, agentId) {
      const a = all(orgId).find((x) => x.id === agentId);
      if (!a) throw notFound('agent', agentId);
      return a;
    },
    findAgent: find,
    listAgents: (orgId, filter) =>
      all(orgId).filter((a) => (!filter?.deptId || a.deptId === filter.deptId) && (!filter?.status || a.status === filter.status)),
    managerOf(orgId, agentId) {
      const a = find(orgId, agentId);
      return a?.reportsTo ? find(orgId, a.reportsTo) : null;
    },
    reportsOf,
    leadOf(orgId, deptId) {
      const d = dept(orgId, deptId);
      return d?.leadAgentId ? find(orgId, d.leadAgentId) : null;
    },
    canAssign(orgId, fromId, toId) {
      const from = find(orgId, fromId);
      const to = find(orgId, toId);
      if (!from || !to) return false;
      if (from.id === to.id) return true;
      if (reportsOf(orgId, from.id, { transitive: true }).some((a) => a.id === to.id)) return true;
      // A peer through the lead: same manager, and the caller leads the peer's department.
      const samManager = from.reportsTo !== null && from.reportsTo === to.reportsTo;
      return samManager && dept(orgId, to.deptId)?.leadAgentId === from.id;
    },
  };
  return new Proxy(impl as OrgService, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      return () => {
        throw new Error(`FakeOrg: ${String(prop)} is not implemented`);
      };
    },
  });
}

export interface Fixture {
  org: Organization;
  eng: Department;
  mkt: Department;
  /** Root (reports to the owner), autonomy 3. */
  ceo: Agent;
  /** Engineering lead, reports to ceo, autonomy 3. */
  lead: Agent;
  /** Engineers reporting to lead. dev: autonomy 2, junior: autonomy 1, intern: autonomy 0. */
  dev: Agent;
  junior: Agent;
  intern: Agent;
  /** Marketing lead, reports to ceo, autonomy 2. */
  marketer: Agent;
}

/**
 * owner
 *  └ ceo (L3)
 *     ├ lead (L3, leads Engineering) ── dev (L2), junior (L1), intern (L0)
 *     └ marketer (L2, leads Marketing)
 */
export function seedCompany(k: TestKernel, name = 'Acme'): Fixture {
  const org = seedOrg(k, name);
  const eng = seedDept(k, org.id, 'Engineering');
  const mkt = seedDept(k, org.id, 'Marketing');
  const ceo = seedAgent(k, org.id, eng.id, 'Cleo', { role: 'CEO', autonomyLevel: 3 });
  const lead = seedAgent(k, org.id, eng.id, 'Lena', { role: 'Engineering Lead', autonomyLevel: 3, reportsTo: ceo.id });
  const dev = seedAgent(k, org.id, eng.id, 'Dev', { role: 'Engineer', autonomyLevel: 2, reportsTo: lead.id });
  const junior = seedAgent(k, org.id, eng.id, 'June', { role: 'QA Tester', autonomyLevel: 1, reportsTo: lead.id });
  const intern = seedAgent(k, org.id, eng.id, 'Ian', { role: 'Intern', autonomyLevel: 0, reportsTo: lead.id });
  const marketer = seedAgent(k, org.id, mkt.id, 'Mara', { role: 'Marketing Lead', autonomyLevel: 2, reportsTo: ceo.id });
  k.db.update(departments).set({ leadAgentId: lead.id }).where(eq(departments.id, eng.id)).run();
  k.db.update(departments).set({ leadAgentId: marketer.id }).where(eq(departments.id, mkt.id)).run();
  return { org, eng, mkt, ceo, lead, dev, junior, intern, marketer };
}

export function setup(k: TestKernel): { org: OrgService; work: WorkService; f: Fixture } {
  const org = createFakeOrg(k);
  return { org, work: createWorkService(k, { org }), f: seedCompany(k) };
}

export const as = (agent: Agent, runId?: string): Actor => ({ kind: 'agent', id: agent.id, ...(runId ? { runId } : {}) });

/** Records every bus event so tests can assert what was emitted. */
export function recordEvents(k: TestKernel): {
  all: Array<{ name: EventName; payload: unknown }>;
  of<K extends EventName>(name: K): Array<DomainEvents[K]>;
  clear(): void;
} {
  const all: Array<{ name: EventName; payload: unknown }> = [];
  k.bus.onAny((name, payload) => void all.push({ name, payload }));
  return {
    all,
    of: <K extends EventName>(name: K) => all.filter((e) => e.name === name).map((e) => e.payload as DomainEvents[K]),
    clear: () => void all.splice(0, all.length),
  };
}

/** Run `fn` and return the ConductorError code it throws (or 'no-error'). */
export function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConductorError) return e.code;
    throw e;
  }
  return 'no-error';
}

export function toolCtx(agent: Agent, extra: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    orgId: agent.orgId,
    agentId: agent.id,
    deptId: agent.deptId,
    runId: `run_${agent.slug}`,
    issueId: null,
    workspacePath: '/tmp/conductor-ws',
    autonomyLevel: agent.autonomyLevel,
    ...extra,
  };
}

export function payloadOf<T = Record<string, unknown>>(result: ToolResult): T {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text tool result');
  if (result.isError) throw new Error(`tool returned an error: ${first.text}`);
  return JSON.parse(first.text) as T;
}

export function errorOf(result: ToolResult): string {
  const first = result.content[0];
  if (!result.isError || !first || first.type !== 'text') throw new Error('expected an isError tool result');
  return first.text;
}

/** London-style ApprovalService double: `request` returns a pending approval row. */
export function mockApprovals(): ApprovalService & { request: ReturnType<typeof vi.fn<ApprovalService['request']>> } {
  const request = vi.fn<ApprovalService['request']>((input) => fakeApproval(input));
  const unexpected = (name: string) => () => {
    throw new Error(`ApprovalService.${name} was not expected`);
  };
  return {
    request,
    requiresApproval: unexpected('requiresApproval'),
    decide: unexpected('decide'),
    get: unexpected('get'),
    list: unexpected('list'),
    consume: unexpected('consume'),
    findOpen: unexpected('findOpen'),
    isKnownRecipient: unexpected('isKnownRecipient'),
    rememberRecipient: unexpected('rememberRecipient'),
  };
}

export function fakeApproval(input: Partial<Approval> & { orgId: string; title: string; kind: Approval['kind'] }): Approval {
  return {
    id: 'apr_test',
    requesterAgentId: null,
    runId: null,
    issueId: null,
    payload: {},
    status: 'pending',
    decidedBy: null,
    decisionNote: null,
    decidedAt: null,
    consumedAt: null,
    expiresAt: null,
    createdAt: 0,
    ...input,
  };
}
