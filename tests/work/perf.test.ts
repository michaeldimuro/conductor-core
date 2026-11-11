import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkService } from '../../src/contracts/org-work.js';
import { OWNER } from '../../src/contracts/types.js';
import type { IssueStatus } from '../../src/db/schema/work.js';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { seedCompany, setup, type Fixture } from './helpers.js';

const TOTAL = 5000;
const BUDGET_MS = 200;

const SAMPLES = 40;

/**
 * p95 latency of what a board request costs the daemon in-process: the Work
 * query plus encoding the response body. (Loopback HTTP and the browser's
 * render are outside what a unit test can measure.) With 40 samples the 95th
 * percentile is the 38th fastest — the two slowest runs are the only ones ignored.
 */
function p95Ms(fn: () => unknown): number {
  JSON.stringify(fn()); // warm the statement cache
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    JSON.stringify(fn());
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.ceil(SAMPLES * 0.95) - 1]!;
}

/** PRD performance NFR: "UI p95 < 200 ms for boards up to 5k issues". */
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

  // Retried: the budget is a latency bound, and the suite shares the machine with other test workers.
  it.each(cases)('listIssues %s: p95 under 200 ms', { retry: 3 }, (_name, query, check) => {
    check(query().length);
    expect(p95Ms(query)).toBeLessThan(BUDGET_MS);
  });

  it('inbox, goalTree and a full issue page (issue + comments + timeline): p95 under 200 ms', { retry: 3 }, () => {
    expect(work.inbox(f.org.id, f.dev.id).issues.length).toBeGreaterThan(0);
    expect(p95Ms(() => work.inbox(f.org.id, f.dev.id))).toBeLessThan(BUDGET_MS);
    expect(work.goalTree(f.org.id)[0]!.issueCounts.open).toBe(1667);
    expect(p95Ms(() => work.goalTree(f.org.id))).toBeLessThan(BUDGET_MS);
    const issue = work.listIssues(f.org.id, { limit: 1 })[0]!;
    for (let i = 0; i < 30; i++) work.addComment(f.org.id, issue.id, { body: `Update ${i}` }, OWNER);
    expect(p95Ms(() => [work.getIssue(f.org.id, issue.id), work.listComments(f.org.id, issue.id), work.timeline(f.org.id, issue.id)])).toBeLessThan(BUDGET_MS);
  });
});
