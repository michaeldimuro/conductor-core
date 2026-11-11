import { and, eq } from 'drizzle-orm';
import type { Services } from '../../src/daemon/container.js';
import type { Actor } from '../../src/contracts/types.js';
import type { Agent, Approval, Gateway, Issue, Organization } from '../../src/contracts/rows.js';
import type { CreateIssueInput } from '../../src/contracts/org-work.js';
import { agents, approvals, issues, organizations } from '../../src/db/schema/index.js';
import { gateways, gatewayChats, type GatewayKind } from '../../src/db/schema/reach.js';
import { ConductorError, conflict, notFound } from '../../src/shared/errors.js';
import { newId } from '../../src/shared/ids.js';
import type { AdapterFactory, GatewayAdapter, InboundMessage, OutboundMessage } from '../../src/gateways/index.js';
import type { AdapterContext } from '../../src/gateways/types.js';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';

export interface RecordedComment {
  orgId: string;
  issueId: string;
  body: string;
  actor: Actor;
  runId?: string;
}

export interface FakeServices {
  services: Services;
  k: TestKernel;
  comments: RecordedComment[];
  chats: Array<{ orgId: string; agentId: string; message: string; issueId: string | null }>;
  decisions: Array<{ orgId: string; approvalId: string; decision: string; by: Actor; note?: string }>;
  reviews: Array<{ orgId: string; issueId: string; outcome: string; note?: string }>;
  runNow: Array<{ orgId: string; agentId: string }>;
  killSwitch: Set<string>;
  /** What the agent answers; replace per test. */
  reply: (message: string) => string | Promise<string>;
  /** File an approval exactly like governance does: row + `notification` with Approve/Deny actions. */
  requestApproval(orgId: string, title: string): Approval;
  /** Create an issue waiting for review and announce it like the runtime does. */
  requestReview(orgId: string, title: string): Issue;
  dispose(): void;
}

/**
 * Small in-memory fakes of the `Services` members the gateways call, over a
 * real kernel (SQLite, bus, audit, secrets). Rows the gateways read directly
 * (approvals, issues, orgs, agents) live in the real tables.
 */
export function createFakeServices(): FakeServices {
  const k = createTestKernel();
  const fake = {
    k,
    comments: [] as RecordedComment[],
    chats: [] as FakeServices['chats'],
    decisions: [] as FakeServices['decisions'],
    reviews: [] as FakeServices['reviews'],
    runNow: [] as FakeServices['runNow'],
    killSwitch: new Set<string>(),
    reply: (message: string) => `echo: ${message}`,
  } as FakeServices;

  const getIssue = (orgId: string, id: string) => k.db.select().from(issues).where(and(eq(issues.orgId, orgId), eq(issues.id, id))).get() ?? null;
  const getApproval = (orgId: string, id: string) => k.db.select().from(approvals).where(and(eq(approvals.orgId, orgId), eq(approvals.id, id))).get() ?? null;

  const createIssue = (orgId: string, input: CreateIssueInput, actor: Actor): Issue => {
    const now = k.clock.now();
    const number = k.db.select().from(issues).where(eq(issues.orgId, orgId)).all().length + 1;
    const id = newId('issue');
    k.db.insert(issues).values({
      id, orgId, number, title: input.title, body: input.body ?? '', assigneeAgentId: input.assigneeAgentId ?? null,
      status: input.status ?? 'backlog', labels: input.labels ?? [], creatorKind: actor.kind, creatorId: actor.id ?? null, createdAt: now, updatedAt: now,
    }).run();
    return getIssue(orgId, id)!;
  };

  const org = {
    listOrgs: () => k.db.select().from(organizations).where(eq(organizations.status, 'active')).all(),
    getOrg: (orgId: string): Organization => {
      const row = k.db.select().from(organizations).where(eq(organizations.id, orgId)).get();
      if (!row) throw notFound('org', orgId);
      return row;
    },
    listAgents: (orgId: string) => k.db.select().from(agents).where(eq(agents.orgId, orgId)).all(),
    findAgent: (orgId: string, idOrSlug: string): Agent | null =>
      k.db.select().from(agents).where(eq(agents.orgId, orgId)).all().find((a) => a.id === idOrSlug || a.slug === idOrSlug) ?? null,
  };

  const work = {
    createIssue,
    findIssue: (orgId: string, ref: string | number) =>
      typeof ref === 'number'
        ? k.db.select().from(issues).where(and(eq(issues.orgId, orgId), eq(issues.number, ref))).get() ?? null
        : getIssue(orgId, ref),
    addComment: (orgId: string, issueId: string, input: { body: string; runId?: string }, actor: Actor) => {
      if (!getIssue(orgId, issueId)) throw notFound('issue', issueId);
      fake.comments.push({ orgId, issueId, body: input.body, actor, runId: input.runId });
      return { id: newId('comment') };
    },
    review: (orgId: string, issueId: string, outcome: 'accepted' | 'edited' | 'rejected', note: string | undefined, _actor: Actor) => {
      const issue = getIssue(orgId, issueId);
      if (!issue) throw notFound('issue', issueId);
      if (issue.status !== 'in_review') throw conflict('issue is not in review');
      k.db.update(issues).set({ status: outcome === 'rejected' ? 'todo' : 'done', reviewOutcome: outcome }).where(eq(issues.id, issueId)).run();
      fake.reviews.push({ orgId, issueId, outcome, note });
      return getIssue(orgId, issueId)!;
    },
  };

  const approvalService = {
    list: (orgId: string | null, filter: { status?: Approval['status'] } = {}) =>
      k.db.select().from(approvals).all().filter((a) => (orgId === null || a.orgId === orgId) && (!filter.status || a.status === filter.status)),
    decide: (orgId: string, approvalId: string, decision: 'approved' | 'denied', by: Actor, note?: string) => {
      const current = getApproval(orgId, approvalId);
      if (!current) throw notFound('approval', approvalId);
      if (current.status !== 'pending') throw conflict(`approval is already ${current.status}`, { status: current.status });
      k.db.update(approvals).set({ status: decision, decidedBy: by.id ?? by.kind, decisionNote: note ?? null, decidedAt: k.clock.now() }).where(eq(approvals.id, approvalId)).run();
      fake.decisions.push({ orgId, approvalId, decision, by, note });
      return getApproval(orgId, approvalId)!;
    },
  };

  const runtime = {
    chat: async (orgId: string, agentId: string, message: string, opts: { issueId?: string | null } = {}) => {
      fake.chats.push({ orgId, agentId, message, issueId: opts.issueId ?? null });
      return { reply: await fake.reply(message), runId: newId('run') };
    },
    runNow: async (orgId: string, agentId: string) => {
      fake.runNow.push({ orgId, agentId });
      return { jobId: newId('job') };
    },
    status: () => ({ running: 1, queued: 2, perOrg: {}, perProvider: {}, uptimeMs: 1000 }),
  };

  const governance = {
    approvals: approvalService,
    budgets: { summary: () => ({ totalUsd: 1.5, seatSeconds: 0, lines: [], byAgent: [], byDay: [] }) },
    killSwitch: {
      engage: (orgId: string | null) => void fake.killSwitch.add(orgId ?? '*'),
      isEngaged: (orgId: string) => fake.killSwitch.has(orgId) || fake.killSwitch.has('*'),
    },
  };

  fake.services = {
    kernel: k, org, work, governance, runtime,
    baseUrl: () => 'http://127.0.0.1:7420',
    publicUrl: () => 'https://conductor.example.ts.net',
    version: 'test',
  } as unknown as Services;

  fake.requestApproval = (orgId, title) => {
    const id = newId('approval');
    k.db.insert(approvals).values({ id, orgId, kind: 'external_send', title, createdAt: k.clock.now() }).run();
    k.bus.emit('notification', {
      orgId, kind: 'approval', title: `Approval needed: ${title}`, body: 'Requested: external_send',
      actions: [{ label: 'Approve', action: `approval:approve:${id}` }, { label: 'Deny', action: `approval:deny:${id}` }],
      data: { approvalId: id },
    });
    return getApproval(orgId, id)!;
  };

  fake.requestReview = (orgId, title) => {
    const issue = createIssue(orgId, { title, status: 'in_review' }, { kind: 'system' });
    k.bus.emit('notification', {
      orgId, kind: 'review', title: `Review needed: ${title}`, body: 'Waiting for your review.',
      actions: [{ label: 'Accept', action: `review:accepted:${issue.id}` }, { label: 'Reject', action: `review:rejected:${issue.id}` }],
      data: { issueId: issue.id },
    });
    return issue;
  };

  fake.dispose = () => k.dispose();
  return fake;
}

export function insertGateway(
  k: TestKernel,
  input: { kind: GatewayKind; orgId?: string | null; name?: string; config?: Record<string, unknown>; authRef?: string | null; status?: Gateway['status'] },
): Gateway {
  const now = k.clock.now();
  const id = newId('gateway');
  k.db.insert(gateways).values({
    id, orgId: input.orgId ?? null, kind: input.kind, name: input.name ?? `${input.kind} test`, config: input.config ?? {},
    authRef: input.authRef ?? null, status: input.status ?? 'active', createdAt: now, updatedAt: now,
  }).run();
  return getGateway(k, id);
}

export function getGateway(k: TestKernel, id: string): Gateway {
  return k.db.select().from(gateways).where(eq(gateways.id, id)).get()!;
}

export function updateGateway(k: TestKernel, id: string, patch: Partial<Pick<Gateway, 'status' | 'config' | 'authRef'>>): void {
  k.db.update(gateways).set(patch).where(eq(gateways.id, id)).run();
}

export function getChatRow(k: TestKernel, gatewayId: string, chatId: string) {
  return k.db.select().from(gatewayChats).where(and(eq(gatewayChats.gatewayId, gatewayId), eq(gatewayChats.chatId, chatId))).get() ?? null;
}

/** An in-memory platform: records what is sent, lets a test inject inbound messages. */
export interface MemoryPlatform {
  factory: AdapterFactory;
  sent: Array<{ gatewayId: string; chatId: string; message: OutboundMessage }>;
  contexts: Map<string, AdapterContext>;
  stopped: string[];
  /** Deliver an inbound message to a gateway and wait until the router is done with it. A 1:1 chat unless `isGroup` is set. */
  receive(gatewayId: string, message: InboundMessage): Promise<void>;
  texts(chatId?: string): string[];
}

export function createMemoryPlatform(opts: { kind?: GatewayKind; maxLength?: number; buttons?: boolean; quietRefusals?: boolean; failStart?: (ctx: AdapterContext) => boolean } = {}): MemoryPlatform {
  const platform: MemoryPlatform = {
    sent: [],
    contexts: new Map(),
    stopped: [],
    factory: (ctx): GatewayAdapter => ({
      kind: opts.kind ?? 'telegram',
      maxLength: opts.maxLength ?? 4096,
      buttons: opts.buttons ?? true,
      quietRefusals: opts.quietRefusals,
      async start() {
        if (opts.failStart?.(ctx)) throw new ConductorError('unavailable', `boom with ${ctx.credentials.token ?? 'no token'}`);
        platform.contexts.set(ctx.gatewayId, ctx);
      },
      async stop() {
        platform.contexts.delete(ctx.gatewayId);
        platform.stopped.push(ctx.gatewayId);
      },
      async send(chatId, message) {
        platform.sent.push({ gatewayId: ctx.gatewayId, chatId, message });
      },
    }),
    receive: (gatewayId, message) => {
      const ctx = platform.contexts.get(gatewayId);
      if (!ctx) throw new Error(`gateway ${gatewayId} is not running`);
      return ctx.emit({ isGroup: false, ...message });
    },
    texts: (chatId) => platform.sent.filter((s) => chatId === undefined || s.chatId === chatId).map((s) => s.message.text),
  };
  return platform;
}

export async function waitFor<T>(probe: () => T | undefined | null | false, what = 'condition', timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
