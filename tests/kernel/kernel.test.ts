import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, seedOrg, seedDept, seedAgent, type TestKernel } from '../helpers/kernel.js';
import { OWNER } from '../../src/contracts/types.js';
import { ConductorPaths, resolveInside } from '../../src/shared/paths.js';
import { redact, stableStringify } from '../../src/shared/util.js';
import { FileVaultSecretStore } from '../../src/kernel/secrets.js';
import { join } from 'node:path';

describe('kernel', () => {
  let k: TestKernel;
  beforeEach(() => {
    k = createTestKernel();
  });
  afterEach(() => k.dispose());

  it('migrates the schema and seeds fixtures', () => {
    const org = seedOrg(k);
    const dept = seedDept(k, org.id);
    const agent = seedAgent(k, org.id, dept.id);
    expect(agent.orgId).toBe(org.id);
    expect(agent.autonomyLevel).toBe(1);
    expect(org.policies).toEqual({});
  });

  it('loads FTS5 and sqlite-vec', () => {
    const v = k.sqlite.prepare('select vec_version() as v').get() as { v: string };
    expect(v.v).toMatch(/^v/);
    k.sqlite.exec('create virtual table t_fts using fts5(a)');
  });

  it('keeps the audit log append-only', () => {
    k.audit.record({ orgId: null, actor: OWNER, action: 'test.event', data: { token: 'sk-ant-abcdefghijklmnopqrstuvwxyz' } });
    const [rec] = k.audit.query({ action: 'test.event' });
    expect(rec?.data?.token).toBe('[REDACTED]');
    expect(() => k.sqlite.exec("update activity_log set action = 'x'")).toThrow(/append-only/);
    expect(() => k.sqlite.exec('delete from activity_log')).toThrow(/append-only/);
  });

  it('delivers events and isolates handler failures', async () => {
    const seen: string[] = [];
    k.bus.on('org.created', () => {
      throw new Error('boom');
    });
    k.bus.on('org.created', (p) => void seen.push(p.orgId));
    const waited = k.bus.once('org.created');
    k.bus.emit('org.created', { orgId: 'org_1' });
    expect(seen).toEqual(['org_1']);
    expect((await waited).orgId).toBe('org_1');
  });
});

describe('shared', () => {
  it('refuses path traversal', () => {
    const p = new ConductorPaths('/tmp/conductor-x');
    expect(() => p.org('../etc')).toThrow();
    expect(() => p.agentDir('acme', '..')).toThrow();
    expect(() => resolveInside('/tmp/a', '../b')).toThrow();
    expect(p.agentSkills('acme', 'ada')).toBe('/tmp/conductor-x/orgs/acme/agents/ada/skills');
    expect(p.deptSkills('acme', 'eng')).toBe('/tmp/conductor-x/orgs/acme/depts/eng/skills');
  });

  it('redacts credentials and hashes stably', () => {
    expect(redact('key sk-ant-REDACTME1234567890abcd here')).not.toContain('REDACTME');
    expect(redact('pw hunter2-long', ['hunter2-long'])).toBe('pw [REDACTED]');
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it('round-trips the encrypted file vault and rejects a wrong key', async () => {
    const k = createTestKernel();
    try {
      const file = join(k.paths.home, 'vault.enc');
      const v = new FileVaultSecretStore(file, 'correct horse');
      await v.set('openai/api-key', 'sk-test');
      expect(await new FileVaultSecretStore(file, 'correct horse').get('openai/api-key')).toBe('sk-test');
      await expect(new FileVaultSecretStore(file, 'wrong').get('openai/api-key')).rejects.toThrow();
    } finally {
      k.dispose();
    }
  });
});
