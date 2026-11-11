import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, MemorySecretStore, type KernelHandle } from '../../src/kernel/index.js';
import { FakeClock } from '../../src/shared/util.js';
import { newId, slugify } from '../../src/shared/ids.js';
import { organizations, departments, agents } from '../../src/db/schema/index.js';
import type { Agent, Department, Organization } from '../../src/contracts/rows.js';

export interface TestKernel extends KernelHandle {
  clock: FakeClock;
  secrets: MemorySecretStore;
  /** Removes the temp home and closes the DB. */
  dispose(): void;
}

/**
 * Isolated kernel for tests: temp CONDUCTOR_HOME, real migrated SQLite file
 * (so WAL/concurrency behave as in production), fake clock, in-memory secrets.
 */
export function createTestKernel(): TestKernel {
  const home = mkdtempSync(join(tmpdir(), 'conductor-test-'));
  const clock = new FakeClock();
  const secrets = new MemorySecretStore();
  const k = createKernel({ home, clock, secrets });
  return Object.assign(k, {
    clock,
    secrets,
    dispose: () => {
      k.close();
      rmSync(home, { recursive: true, force: true });
    },
  });
}

/**
 * Raw fixture rows for contexts that only need an org/dept/agent to exist
 * (inserted directly, bypassing OrgService, so each context tests in isolation).
 */
export function seedOrg(k: TestKernel, name = 'Acme'): Organization {
  const now = k.clock.now();
  const row = { id: newId('org'), slug: slugify(name), name, createdAt: now, updatedAt: now };
  k.db.insert(organizations).values(row).run();
  return k.db.query.organizations.findFirst({ where: (o, { eq }) => eq(o.id, row.id) }).sync()!;
}

export function seedDept(k: TestKernel, orgId: string, name = 'Engineering'): Department {
  const now = k.clock.now();
  const row = { id: newId('dept'), orgId, slug: slugify(name), name, createdAt: now, updatedAt: now };
  k.db.insert(departments).values(row).run();
  return k.db.query.departments.findFirst({ where: (d, { eq }) => eq(d.id, row.id) }).sync()!;
}

export function seedAgent(
  k: TestKernel,
  orgId: string,
  deptId: string,
  name = 'Ada',
  extra: Partial<typeof agents.$inferInsert> = {},
): Agent {
  const now = k.clock.now();
  const row = { id: newId('agent'), orgId, deptId, slug: slugify(name), name, role: 'Engineer', createdAt: now, updatedAt: now, ...extra };
  k.db.insert(agents).values(row).run();
  return k.db.query.agents.findFirst({ where: (a, { eq }) => eq(a.id, row.id) }).sync()!;
}
