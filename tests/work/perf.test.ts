import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkService } from '../../src/contracts/org-work.js';
import { OWNER } from '../../src/contracts/types.js';
import type { IssueStatus } from '../../src/db/schema/work.js';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { seedCompany, setup, type Fixture } from './helpers.js';

const TOTAL = 5000;
const BUDGET_MS = 200;

function medianMs(fn: () => unknown, rounds = 9): number {
  fn(); // warm the statement cache
  const samples: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

/** PRD performance NFR: boards up to 5k issues stay well under 200 ms. */
describe('work: performance on a 5,000-issue org', () => {
  let k: TestKernel;
  let work: WorkService;
  let f: Fixture;
  let goalId: string;

  beforeAll(() => {
    k = createTestKernel();
    ({ work, f } = setup(k));
    const noise = seedCompany(k, 'Noise');
    goalId = work.createGoal(f.org.id, { title: 'Throughput', deptId: f.eng.id }, OWNER).id;
    const assignees = [f.dev.id, f.junior.id, f.lead.id, f.marketer.id, null];
    const statuses: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'blocked'];
    // One outer transaction: the service's own transactions nest inside it as savepoints.
    k.sqlite.transaction(() => {
      for (let i = 0; i < TOTAL; i++) {
        work.createIssue(
          f.org.id,
          {
            title: `Issue ${i} ${i % 7 === 0 ? 'checkout flow' : 'general upkeep'}`,
            body: `Body of issue ${i}. ${i % 50 === 0 ? 'Mentions the invoice export.' : 'Routine.'}`,
            assigneeAgentId: assignees[i % assignees.length],
            status: statuses[i % statuses.length],
            priority: i % 4,
            labels: i % 10 === 0 ? ['bug', 'p1'] : ['chore'],
            goalId: i % 3 === 0 ? goalId : undefined,
          },
          OWNER,
        );
      }
      for (let i = 0; i < 500; i++) work.createIssue(noise.org.id, { title: `Noise ${i} checkout flow` }, OWNER);
    })();
  }, 120_000);
  afterAll(() => k.dispose());

  it('seeded 5,000 uniquely numbered issues', () => {
    const all = work.listIssues(f.org.id, { limit: 10_000 });
    expect(all).toHaveLength(TOTAL);
    expect(new Set(all.map((i) => i.number)).size).toBe(TOTAL);
  });

  const cases: Array<[string, () => unknown[], (n: number) => void]> = [
    ['default board page', () => work.listIssues(f.org.id), (n) => expect(n).toBe(500)],
    ['by status', () => work.listIssues(f.org.id, { status: 'in_progress', limit: 5000 }), (n) => expect(n).toBe(1250)],
    ['by several statuses', () => work.listIssues(f.org.id, { status: ['todo', 'blocked'], limit: 5000 }), (n) => expect(n).toBe(2500)],
    ['by assignee + status', () => work.listIssues(f.org.id, { assigneeAgentId: f.dev.id, status: 'todo' }), (n) => expect(n).toBeGreaterThan(0)],
    ['by goal', () => work.listIssues(f.org.id, { goalId, limit: 5000 }), (n) => expect(n).toBe(1667)],
    ['by label', () => work.listIssues(f.org.id, { label: 'bug', limit: 5000 }), (n) => expect(n).toBe(500)],
    ['text search', () => work.listIssues(f.org.id, { search: 'invoice export', limit: 5000 }), (n) => expect(n).toBe(100)],
    ['search + status + label', () => work.listIssues(f.org.id, { search: 'checkout', status: 'backlog', label: 'chore' }), (n) => expect(n).toBeGreaterThan(0)],
    ['the whole board', () => work.listIssues(f.org.id, { limit: 5000 }), (n) => expect(n).toBe(TOTAL)],
  ];

  it.each(cases)('listIssues %s stays under the budget (median)', (_name, query, check) => {
    check(query().length);
    expect(medianMs(query)).toBeLessThan(BUDGET_MS);
  });

  it('inbox and goalTree stay under the budget too', () => {
    expect(work.inbox(f.org.id, f.dev.id).issues.length).toBeGreaterThan(0);
    expect(medianMs(() => work.inbox(f.org.id, f.dev.id))).toBeLessThan(BUDGET_MS);
    expect(work.goalTree(f.org.id)[0]!.issueCounts.open).toBe(1667);
    expect(medianMs(() => work.goalTree(f.org.id))).toBeLessThan(BUDGET_MS);
  });
});
