import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { createBrowserService } from '../../src/browser/index.js';
import { agents, departments, organizations } from '../../src/db/schema/index.js';
import type { Kernel } from '../../src/contracts/kernel.js';
import type { Agent, Approval } from '../../src/contracts/rows.js';
import type { ApprovalService, BrowserService, RunControl } from '../../src/contracts/services.js';
import type { ToolCallContext, ToolResult } from '../../src/contracts/tools.js';
import type { Actor } from '../../src/contracts/types.js';
import { notFound } from '../../src/shared/errors.js';
import { newId } from '../../src/shared/ids.js';

/** In-memory stand-in for the governance context's ApprovalService (same single-use semantics). */
export class FakeApprovals implements ApprovalService {
  readonly all: Approval[] = [];
  constructor(private readonly now: () => number) {}

  requiresApproval(): boolean {
    return true;
  }
  request(input: Parameters<ApprovalService['request']>[0]): Approval {
    const a: Approval = {
      id: newId('approval'), orgId: input.orgId, requesterAgentId: input.requesterAgentId ?? null, runId: input.runId ?? null,
      issueId: input.issueId ?? null, kind: input.kind, title: input.title, payload: input.payload ?? {}, status: 'pending',
      decidedBy: null, decisionNote: null, decidedAt: null, consumedAt: null, expiresAt: input.expiresAt ?? null, createdAt: this.now(),
    };
    this.all.push(a);
    return a;
  }
  decide(orgId: string, approvalId: string, decision: 'approved' | 'denied', by: Actor, note?: string): Approval {
    const a = this.get(orgId, approvalId);
    Object.assign(a, { status: decision, decidedBy: by.id ?? by.kind, decisionNote: note ?? null, decidedAt: this.now() });
    return a;
  }
  get(orgId: string, approvalId: string): Approval {
    const a = this.all.find((x) => x.orgId === orgId && x.id === approvalId);
    if (!a) throw notFound('approval', approvalId);
    return a;
  }
  list(orgId: string | null, filter?: { status?: Approval['status']; kind?: string; limit?: number }): Approval[] {
    return this.all.filter((a) => (orgId === null || a.orgId === orgId) && (!filter?.status || a.status === filter.status) && (!filter?.kind || a.kind === filter.kind));
  }
  consume(orgId: string, kind: Approval['kind'], matchKey: string): Approval | null {
    const a = this.all.find((x) => x.orgId === orgId && x.kind === kind && x.payload.matchKey === matchKey && x.status === 'approved' && x.consumedAt === null);
    if (!a) return null;
    a.consumedAt = this.now();
    return a;
  }
  findOpen(orgId: string, kind: Approval['kind'], matchKey: string): Approval | null {
    return this.all.find((x) => x.orgId === orgId && x.kind === kind && x.payload.matchKey === matchKey
      && (x.status === 'pending' || (x.status === 'approved' && x.consumedAt === null))) ?? null;
  }
  isKnownRecipient(): boolean {
    return false;
  }
  rememberRecipient(): void {}
}

export class FakeRunControl implements RunControl {
  readonly paused: Array<[string, string]> = [];
  readonly resumed: string[] = [];
  pauseRun(runId: string, reason: string): void {
    this.paused.push([runId, reason]);
  }
  resumeRun(runId: string): void {
    this.resumed.push(runId);
  }
  isAlive(): boolean {
    return true;
  }
}

/** Org lookups straight from the fixture rows, org-scoped like the real OrgService. */
export function orgLookup(k: Kernel) {
  return {
    getOrg(orgId: string) {
      const o = k.db.select().from(organizations).where(eq(organizations.id, orgId)).get();
      if (!o) throw notFound('organization', orgId);
      return o;
    },
    getDept(orgId: string, deptId: string) {
      const d = k.db.select().from(departments).where(and(eq(departments.orgId, orgId), eq(departments.id, deptId))).get();
      if (!d) throw notFound('department', deptId);
      return d;
    },
    getAgent(orgId: string, agentId: string) {
      const a = k.db.select().from(agents).where(and(eq(agents.orgId, orgId), eq(agents.id, agentId))).get();
      if (!a) throw notFound('agent', agentId);
      return a;
    },
  };
}

export const SHARE_BASE = 'https://conductor.tailnet.test';

export interface Harness {
  k: TestKernel;
  approvals: FakeApprovals;
  runControl: FakeRunControl;
  svc: BrowserService;
  /** A fresh service over the same kernel pieces (what a daemon restart builds). */
  newService(kernel?: Kernel, opts?: { opBin?: string; headless?: boolean }): BrowserService;
  ctx(agent: Agent, runId: string, over?: Partial<ToolCallContext>): ToolCallContext;
  call(ctx: ToolCallContext, tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  dispose(): Promise<void>;
}

export function createHarness(): Harness {
  const k = createTestKernel();
  const approvals = new FakeApprovals(() => k.clock.now());
  const runControl = new FakeRunControl();
  const services: BrowserService[] = [];
  const newService = (kernel: Kernel = k, opts: { opBin?: string; headless?: boolean } = {}): BrowserService => {
    const svc = createBrowserService(kernel, {
      approvals, runControl, org: orgLookup(kernel), shareBaseUrl: () => `${SHARE_BASE}/`, headless: opts.headless ?? true,
      // Never the real 1Password CLI in tests: an absent binary unless a fake is supplied.
      onePassword: { bin: opts.opBin ?? join(k.paths.home, 'no-such-op'), timeoutMs: 5000 },
    });
    services.push(svc);
    return svc;
  };
  const svc = newService();
  return {
    k, approvals, runControl, svc, newService,
    ctx(agent, runId, over = {}) {
      const workspacePath = join(k.paths.home, 'workspaces', runId);
      mkdirSync(workspacePath, { recursive: true });
      return { orgId: agent.orgId, agentId: agent.id, deptId: agent.deptId, runId, issueId: null, workspacePath, autonomyLevel: agent.autonomyLevel, ...over };
    },
    call: (ctx, tool, args = {}) => svc.toolProvider().call(ctx, tool, args),
    async dispose() {
      for (const s of services) await s.shutdown();
      k.dispose();
    },
  };
}

/** All text content of a tool result. */
export function text(r: ToolResult): string {
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

export const BROWSER_TEST_TIMEOUT = 90_000;
