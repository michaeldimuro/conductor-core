import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestKernel, seedAgent, seedDept, seedOrg, type TestKernel } from '../helpers/kernel.js';
import { createGovernance, GLOBAL_KILL_SWITCH_KEY, type GovernanceHandle } from '../../src/governance/index.js';
import { apiTokens, settings } from '../../src/db/schema/index.js';
import { OWNER } from '../../src/contracts/types.js';
import type { Agent, Organization } from '../../src/contracts/rows.js';
import { sha256 } from '../../src/shared/util.js';
import { captureEvents, codeOf, type Captured } from './fixtures.js';

describe('governance / kill switch', () => {
  let k: TestKernel;
  let gov: GovernanceHandle;
  let org: Organization;
  let other: Organization;
  let events: Captured;

  beforeEach(() => {
    k = createTestKernel();
    gov = createGovernance(k);
    org = seedOrg(k, 'Acme');
    other = seedOrg(k, 'Beta');
    events = captureEvents(k);
  });
  afterEach(() => {
    gov.dispose();
    k.dispose();
  });

  it('engages and releases per org', () => {
    expect(gov.killSwitch.isEngaged(org.id)).toBe(false);
    gov.killSwitch.engage(org.id, OWNER);
    expect(gov.killSwitch.isEngaged(org.id)).toBe(true);
    expect(gov.killSwitch.isEngaged(other.id)).toBe(false);
    expect(gov.killSwitch.globalEngaged()).toBe(false);
    gov.killSwitch.release(org.id, OWNER);
    expect(gov.killSwitch.isEngaged(org.id)).toBe(false);

    expect(events.of('org.kill_switch')).toEqual([
      { orgId: org.id, engaged: true },
      { orgId: org.id, engaged: false },
    ]);
    expect(k.audit.query({ orgId: org.id, action: 'kill_switch.engaged' })[0]).toMatchObject({ actor: { kind: 'human', id: 'owner' }, entityId: org.id });
    expect(k.audit.query({ orgId: org.id, action: 'kill_switch.released' })).toHaveLength(1);
  });

  it('global switch covers every org and is stored in settings', () => {
    gov.killSwitch.engage(null, OWNER);
    expect(gov.killSwitch.globalEngaged()).toBe(true);
    expect(gov.killSwitch.isEngaged(org.id)).toBe(true);
    expect(gov.killSwitch.isEngaged(other.id)).toBe(true);
    expect(k.db.select().from(settings).all().find((s) => s.key === GLOBAL_KILL_SWITCH_KEY)?.value).toBe(true);
    expect(GLOBAL_KILL_SWITCH_KEY).toBe('kill_switch.global');
    expect(events.of('org.kill_switch')).toEqual([{ orgId: null, engaged: true }]);
    expect(k.audit.query({ orgId: null, action: 'kill_switch.engaged' })).toHaveLength(1);

    gov.killSwitch.engage(org.id, OWNER);
    gov.killSwitch.release(null, OWNER);
    expect(gov.killSwitch.globalEngaged()).toBe(false);
    expect(gov.killSwitch.isEngaged(org.id)).toBe(true); // org switch still on
    expect(gov.killSwitch.isEngaged(other.id)).toBe(false);
  });

  it('rejects unknown orgs and agent releases', () => {
    expect(codeOf(() => gov.killSwitch.engage('org_nope', OWNER))).toBe('not_found');
    gov.killSwitch.engage(org.id, { kind: 'agent', id: 'agt_x' });
    expect(codeOf(() => gov.killSwitch.release(org.id, { kind: 'agent', id: 'agt_x' }))).toBe('forbidden');
    expect(gov.killSwitch.isEngaged(org.id)).toBe(true);
  });
});

describe('governance / tokens', () => {
  let k: TestKernel;
  let gov: GovernanceHandle;
  let org: Organization;
  let agent: Agent;

  beforeEach(() => {
    k = createTestKernel();
    gov = createGovernance(k);
    org = seedOrg(k, 'Acme');
    agent = seedAgent(k, org.id, seedDept(k, org.id).id);
  });
  afterEach(() => {
    gov.dispose();
    k.dispose();
  });

  const rows = () => k.db.select().from(apiTokens).all();

  it('issues cnd_<kind>_ tokens and stores only their hash', () => {
    const token = gov.tokens.issueOwnerToken('laptop');
    expect(token).toMatch(/^cnd_owner_[A-Za-z0-9_-]{40,}$/);
    const [row] = rows();
    expect(row).toMatchObject({ kind: 'owner', label: 'laptop', tokenHash: sha256(token), expiresAt: null, revokedAt: null });
    expect(JSON.stringify(rows())).not.toContain(token);
    expect(JSON.stringify(k.audit.query({}))).not.toContain(token);
    expect(k.audit.query({ action: 'token.issued' })[0]).toMatchObject({ entityId: row!.id, data: { tokenKind: 'owner' } });
    expect(gov.tokens.verify(token)).toEqual({ kind: 'owner', tokenId: row!.id });
  });

  it('rejects unknown, malformed and wrong-kind tokens', () => {
    const token = gov.tokens.issueOwnerToken();
    expect(gov.tokens.verify('')).toBeNull();
    expect(gov.tokens.verify('nope')).toBeNull();
    expect(gov.tokens.verify(undefined as unknown as string)).toBeNull();
    expect(gov.tokens.verify(`${token}x`)).toBeNull();
    expect(gov.tokens.verify(token.replace('cnd_owner_', 'cnd_run_'))).toBeNull();
    expect(gov.tokens.verify('cnd_owner_' + 'a'.repeat(43))).toBeNull();
  });

  it('scopes run tokens to one org/agent/run and expires them', () => {
    const token = gov.tokens.issueRunToken(org.id, agent.id, 'run_1', 60_000);
    expect(token).toMatch(/^cnd_run_/);
    const p = gov.tokens.verify(token);
    expect(p).toMatchObject({ kind: 'run', orgId: org.id, agentId: agent.id, runId: 'run_1' });
    k.clock.advance(59_999);
    expect(gov.tokens.verify(token)).not.toBeNull();
    k.clock.advance(1);
    expect(gov.tokens.verify(token)).toBeNull();
  });

  it('refuses run tokens for agents outside the org and bad TTLs', () => {
    const other = seedOrg(k, 'Beta');
    expect(codeOf(() => gov.tokens.issueRunToken(other.id, agent.id, 'run_1', 1000))).toBe('not_found');
    expect(codeOf(() => gov.tokens.issueRunToken(org.id, agent.id, 'run_1', 0))).toBe('validation');
    expect(codeOf(() => gov.tokens.issueRunToken(org.id, agent.id, '', 1000))).toBe('validation');
    expect(codeOf(() => gov.tokens.issueDeviceToken('phone', -1))).toBe('validation');
    expect(codeOf(() => gov.tokens.issueDeviceToken(' ', 1000))).toBe('validation');
    expect(rows()).toHaveLength(0);
  });

  it('revokes all tokens of a run and nothing else', () => {
    const a1 = gov.tokens.issueRunToken(org.id, agent.id, 'run_1', 60_000);
    const a2 = gov.tokens.issueRunToken(org.id, agent.id, 'run_1', 60_000);
    const b = gov.tokens.issueRunToken(org.id, agent.id, 'run_2', 60_000);
    gov.tokens.revokeRunTokens('run_1');
    expect(gov.tokens.verify(a1)).toBeNull();
    expect(gov.tokens.verify(a2)).toBeNull();
    expect(gov.tokens.verify(b)).not.toBeNull();
    expect(k.audit.query({ orgId: org.id, action: 'token.revoked', runId: 'run_1' })).toHaveLength(2);
  });

  it('issues expiring device tokens and revokes by id', () => {
    const token = gov.tokens.issueDeviceToken('phone', 1000);
    const p = gov.tokens.verify(token);
    expect(p).toMatchObject({ kind: 'device' });
    gov.tokens.revoke(p!.tokenId);
    expect(gov.tokens.verify(token)).toBeNull();
    gov.tokens.revoke(p!.tokenId); // idempotent
    gov.tokens.revoke('tok_missing');
    expect(k.audit.query({ action: 'token.revoked' })).toHaveLength(1);

    const short = gov.tokens.issueDeviceToken('tablet', 1000);
    k.clock.advance(1000);
    expect(gov.tokens.verify(short)).toBeNull();
  });

  describe('ownerTokenFile', () => {
    it('creates <home>/owner.token (0600) once and keeps it stable', () => {
      const file = gov.tokens.ownerTokenFile();
      expect(file).toBe(join(k.paths.home, 'owner.token'));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const token = readFileSync(file, 'utf8').trim();
      expect(gov.tokens.verify(token)).toMatchObject({ kind: 'owner' });

      expect(gov.tokens.ownerTokenFile()).toBe(file);
      expect(readFileSync(file, 'utf8').trim()).toBe(token);
      expect(rows()).toHaveLength(1);
    });

    it('re-registers an existing file whose hash the DB does not know', () => {
      const file = join(k.paths.home, 'owner.token');
      const token = `cnd_owner_${'Z'.repeat(43)}`;
      writeFileSync(file, `${token}\n`, { mode: 0o644 });
      expect(gov.tokens.verify(token)).toBeNull();
      expect(gov.tokens.ownerTokenFile()).toBe(file);
      expect(readFileSync(file, 'utf8').trim()).toBe(token);
      expect(gov.tokens.verify(token)).toMatchObject({ kind: 'owner' });
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('replaces a malformed or revoked file token', () => {
      const file = join(k.paths.home, 'owner.token');
      writeFileSync(file, 'garbage');
      gov.tokens.ownerTokenFile();
      const first = readFileSync(file, 'utf8').trim();
      const principal = gov.tokens.verify(first);
      expect(principal).not.toBeNull();

      gov.tokens.revoke(principal!.tokenId);
      gov.tokens.ownerTokenFile();
      const second = readFileSync(file, 'utf8').trim();
      expect(second).not.toBe(first);
      expect(gov.tokens.verify(first)).toBeNull();
      expect(gov.tokens.verify(second)).toMatchObject({ kind: 'owner' });
    });
  });
});
