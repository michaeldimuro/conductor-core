import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from '../helpers/kernel.js';
import { JobQueue } from '../../src/runtime/jobs.js';
import { nextCron } from '../../src/runtime/scheduler.js';

describe('JobQueue', () => {
  let k: TestKernel;
  let q: JobQueue;
  beforeEach(() => {
    k = createTestKernel();
    q = new JobQueue(k, 'test-worker');
  });
  afterEach(() => k.dispose());

  it('collapses duplicate pending jobs by dedupe key and pulls the earliest time', () => {
    const now = k.clock.now();
    const a = q.enqueue({ kind: 'heartbeat', agentId: 'agt_1', orgId: 'org_1', runAt: now + 60_000, dedupeKey: 'hb:agt_1' });
    const b = q.enqueue({ kind: 'heartbeat', agentId: 'agt_1', orgId: 'org_1', runAt: now + 10_000, dedupeKey: 'hb:agt_1' });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(q.due()).toHaveLength(0);
    k.clock.advance(10_000);
    expect(q.due().map((j) => j.id)).toEqual([a.id]);
  });

  it('claims a job exactly once', () => {
    const { id } = q.enqueue({ kind: 'event', agentId: 'agt_1', orgId: 'org_1' });
    const other = new JobQueue(k, 'other-worker');
    const wins = [q.claim(id), other.claim(id), q.claim(id)];
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(q.due()).toHaveLength(0);
  });

  it('allows a new job for the same key once the previous one is claimed', () => {
    const first = q.enqueue({ kind: 'event', dedupeKey: 'wake:a' });
    q.claim(first.id);
    const second = q.enqueue({ kind: 'event', dedupeKey: 'wake:a' });
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
  });

  it('retries with backoff then fails permanently', () => {
    const { id } = q.enqueue({ kind: 'reflect', maxAttempts: 2 });
    q.claim(id);
    q.fail(id, 'boom');
    expect(q.due()).toHaveLength(0); // backing off
    k.clock.advance(61_000);
    expect(q.due()).toHaveLength(1);
    q.claim(id);
    q.fail(id, 'boom again');
    k.clock.advance(3_600_000);
    expect(q.due()).toHaveLength(0);
    expect(q.counts()).toEqual({ pending: 0, running: 0 });
  });

  it('defer returns a claimed job without burning an attempt', () => {
    const { id } = q.enqueue({ kind: 'event', maxAttempts: 1 });
    q.claim(id);
    q.defer(id, k.clock.now() + 5_000);
    k.clock.advance(5_000);
    const [job] = q.due();
    expect(job?.id).toBe(id);
    expect(job?.attempts).toBe(0);
  });

  it('recovers jobs left running by a dead daemon', () => {
    const { id } = q.enqueue({ kind: 'event' });
    q.claim(id);
    expect(q.counts().running).toBe(1);
    expect(new JobQueue(k, 'restarted').recover()).toBe(1);
    expect(q.due().map((j) => j.id)).toEqual([id]);
  });

  it('cancels pending jobs by key and prunes finished ones', () => {
    q.enqueue({ kind: 'heartbeat', dedupeKey: 'hb:x' });
    expect(q.cancelPending({ dedupeKey: 'hb:x' })).toBe(1);
    expect(q.pendingByKey('hb:x')).toBeUndefined();
    k.clock.advance(8 * 86_400_000);
    expect(q.prune()).toBe(1);
  });
});

describe('nextCron', () => {
  it('computes the next occurrence strictly after the given time', () => {
    const from = new Date('2026-11-10T10:07:00').getTime();
    expect(new Date(nextCron('*/30 * * * *', from)!).getMinutes()).toBe(30);
    expect(nextCron('0 * * * *', from)! - from).toBe(53 * 60_000);
  });

  it('returns null for an invalid expression instead of throwing', () => {
    expect(nextCron('not a cron', Date.now())).toBeNull();
  });
});
