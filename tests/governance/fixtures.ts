import { eq } from 'drizzle-orm';
import { agents, departments, organizations, projects } from '../../src/db/schema/index.js';
import type { OrgPolicies } from '../../src/contracts/types.js';
import type { Agent, Project } from '../../src/contracts/rows.js';
import type { DomainEvents, EventName } from '../../src/shared/events.js';
import { newId } from '../../src/shared/ids.js';
import type { TestKernel } from '../helpers/kernel.js';

export interface Captured {
  all: Array<{ name: EventName; payload: unknown }>;
  of<K extends EventName>(name: K): Array<DomainEvents[K]>;
  clear(): void;
}

export function captureEvents(k: TestKernel): Captured {
  const all: Captured['all'] = [];
  k.bus.onAny((name, payload) => void all.push({ name, payload }));
  return {
    all,
    of: <K extends EventName>(name: K) => all.filter((e) => e.name === name).map((e) => e.payload as DomainEvents[K]),
    clear: () => void (all.length = 0),
  };
}

export function setPolicies(k: TestKernel, orgId: string, policies: OrgPolicies): void {
  k.db.update(organizations).set({ policies }).where(eq(organizations.id, orgId)).run();
}

export function setOrgCaps(k: TestKernel, orgId: string, caps: { budgetMonthlyUsd?: number | null; seatSecondsMonthly?: number | null }): void {
  k.db.update(organizations).set(caps).where(eq(organizations.id, orgId)).run();
}

export function setDeptCap(k: TestKernel, deptId: string, budgetUsd: number | null): void {
  k.db.update(departments).set({ budgetUsd }).where(eq(departments.id, deptId)).run();
}

export function setAgentCap(k: TestKernel, agentId: string, budgetUsd: number | null): void {
  k.db.update(agents).set({ budgetUsd }).where(eq(agents.id, agentId)).run();
}

export function agentRow(k: TestKernel, agentId: string): Agent {
  return k.db.select().from(agents).where(eq(agents.id, agentId)).get()!;
}

export function seedProject(k: TestKernel, orgId: string, name = 'Launch', budgetUsd: number | null = null): Project {
  const now = k.clock.now();
  const id = newId('project');
  k.db.insert(projects).values({ id, orgId, name, budgetUsd, createdAt: now, updatedAt: now }).run();
  return k.db.select().from(projects).where(eq(projects.id, id)).get()!;
}

/** Runs `fn` and returns the ConductorError code it threw (or 'none'). */
export function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
  return 'none';
}
