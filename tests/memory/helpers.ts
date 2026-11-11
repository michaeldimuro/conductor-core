import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import type { TestKernel } from '../helpers/kernel.js';
import type { RunEvent } from '../../src/contracts/adapter.js';
import type { Issue, Run, Skill } from '../../src/contracts/rows.js';
import type { SkillManageInput, SkillService } from '../../src/contracts/services.js';
import { issues, runEvents, runs } from '../../src/db/schema/index.js';
import { newId } from '../../src/shared/ids.js';
import { createMemoryService, createUtilityModel, LocalHashEmbedder, type BindableMemoryService, type MemoryOptionalDeps } from '../../src/memory/index.js';

export const DAY = 86_400_000;

export function makeService(k: TestKernel, deps: MemoryOptionalDeps = {}): BindableMemoryService {
  return createMemoryService(k, { utility: createUtilityModel(k), embedder: new LocalHashEmbedder(), ...deps });
}

let issueNumber = 0;

export function seedIssue(k: TestKernel, orgId: string, extra: Partial<typeof issues.$inferInsert> = {}): Issue {
  const now = k.clock.now();
  const row = { id: newId('issue'), orgId, number: ++issueNumber, title: 'Export the Stripe balance report', createdAt: now, updatedAt: now, ...extra };
  k.db.insert(issues).values(row).run();
  return k.db.query.issues.findFirst({ where: (i, { eq }) => eq(i.id, row.id) }).sync()!;
}

export function seedRun(k: TestKernel, orgId: string, agentId: string, extra: Partial<typeof runs.$inferInsert> = {}, events: RunEvent[] = []): Run {
  const now = k.clock.now();
  const row = { id: newId('run'), orgId, agentId, trigger: 'manual' as const, status: 'succeeded' as const, outcome: 'completed', createdAt: now, startedAt: now, endedAt: now, ...extra };
  k.db.insert(runs).values(row).run();
  events.forEach((event, seq) => {
    k.db.insert(runEvents).values({ runId: row.id, orgId, seq, type: event.type, payload: event, ts: now }).run();
  });
  return k.db.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, row.id) }).sync()!;
}

export const call = (id: string, name: string, input: unknown): RunEvent => ({ type: 'tool_call', id, name, input });
export const result = (id: string, name: string, output: string, isError = false): RunEvent => ({ type: 'tool_result', id, name, output, isError });
export const say = (text: string): RunEvent => ({ type: 'text', text });

/** London-style fake of the skills collaborator. */
export function fakeSkills(existing: string[] = []) {
  const created: Array<{ ctx: { orgId: string; agentId: string; runId?: string }; input: SkillManageInput }> = [];
  const names = new Set(existing);
  const manage = vi.fn(async (ctx: { orgId: string; agentId: string; runId?: string; issueId?: string | null }, input: SkillManageInput) => {
    created.push({ ctx, input });
    names.add(input.name);
    return { id: newId('skill'), name: input.name, status: 'draft' } as unknown as Skill;
  });
  const list = vi.fn((_filter: Parameters<SkillService['list']>[0]) => [...names].map((name) => ({ name }) as unknown as Skill));
  return { manage, list, created };
}

export interface MockServer {
  url: string;
  requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: unknown }>;
  close(): Promise<void>;
}

/** Local HTTP fake for provider / external-memory APIs. The handler returns [status, jsonBody]. */
export async function mockServer(handler: (req: { method: string; path: string; body: unknown }) => [number, unknown]): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const entry = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body };
      requests.push(entry);
      const [status, payload] = handler(entry);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload === null ? '' : JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
