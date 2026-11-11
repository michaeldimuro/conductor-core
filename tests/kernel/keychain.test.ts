import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeychainSecretStore, keychainAddCommand } from '../../src/kernel/index.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-security.mjs', import.meta.url));

interface Call {
  argv: string[];
  stdin: string;
}

describe('KeychainSecretStore keeps secret values out of argv', () => {
  let dir: string;
  let bin: string;
  let store: KeychainSecretStore;
  const calls = (): Call[] => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call);
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conductor-keychain-'));
    bin = join(dir, 'security');
    writeFileSync(bin, `#!/bin/sh\nFAKE_SECURITY_DIR='${dir}' exec '${process.execPath}' '${FAKE}' "$@"\n`);
    chmodSync(bin, 0o755);
    store = new KeychainSecretStore('ai.conductor.test', bin);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes through `security -i` on stdin: the value is in no argv, plain or encoded', async () => {
    const secret = 'sk-live-TOP-SECRET-value-1234567890';
    await store.set('org_1/openai', secret);

    const all = calls();
    const write = all.filter((c) => c.argv[0] === '-i');
    expect(write).toHaveLength(1);
    expect(write[0]?.argv).toEqual(['-i']);
    expect(write[0]?.stdin).toBe(`add-generic-password -U -s "ai.conductor.test" -a "org_1/openai" -w "${b64(secret)}"\n`);
    for (const c of all) {
      const argv = c.argv.join(' ');
      expect(argv).not.toContain(secret);
      expect(argv).not.toContain(b64(secret));
    }
    expect(await store.get('org_1/openai')).toBe(secret);
    expect(await store.has('org_1/openai')).toBe(true);
  });

  it('round-trips values that need care: multi-line, quotes, shell and unicode characters', async () => {
    const tricky = 'line one\nline "two" with \'quotes\' $(rm -rf /) `x` \\ ; | & é中\n-----END-----\n';
    await store.set('weird', tricky);
    expect(await store.get('weird')).toBe(tricky);
    // Whatever the value, the command line only ever carries base64.
    expect(calls().find((c) => c.argv[0] === '-i')?.stdin).toMatch(/^add-generic-password -U -s "ai\.conductor\.test" -a "weird" -w "[A-Za-z0-9+/=]+"\n$/);
  });

  it('splits a value that would overflow the 4096-byte command line, and reads it back whole', async () => {
    const big = randomBytes(9000).toString('hex'); // 18 kB, e.g. a service-account key
    await store.set('big', big);
    const lines = calls().filter((c) => c.argv[0] === '-i').map((c) => c.stdin);
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(4000);
    expect(lines.at(-1)).toContain('-a "big" -w "chunked:v1:');
    expect(await store.get('big')).toBe(big);

    // Shrinking it removes the stale parts; deleting removes everything.
    await store.set('big', 'small');
    expect(await store.get('big')).toBe('small');
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')) as object)).toHaveLength(1);
    await store.set('big', big);
    await store.delete('big');
    expect(await store.get('big')).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'))).toEqual({});
  });

  it('treats a chunked value with a missing part as absent, never as a truncated secret', async () => {
    const big = 'x'.repeat(10_000);
    await store.set('big', big);
    const file = join(dir, 'store.json');
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    delete data['ai.conductor.test\u0000big~part~1'];
    writeFileSync(file, JSON.stringify(data));
    expect(await store.get('big')).toBeNull();
  });

  it('reports a failed write without leaking the value', async () => {
    const broken = new KeychainSecretStore('ai.conductor.test', '/usr/bin/false');
    await expect(broken.set('k', 'super-secret-value')).rejects.toThrow(/keychain write failed/);
    await expect(broken.set('k', 'super-secret-value')).rejects.not.toThrow(/super-secret-value/);
    expect(await broken.get('k')).toBeNull();
  });

  it('refuses refs, services and values that could break out of the command line', async () => {
    await expect(store.set('bad"ref', 'v')).rejects.toThrow(/invalid secret ref/);
    await expect(store.set('bad ref\nadd-generic-password', 'v')).rejects.toThrow(/invalid secret ref/);
    expect(() => new KeychainSecretStore('svc" -a "x')).toThrow(/invalid keychain service/);
    expect(() => keychainAddCommand('svc', 'acct', 'not base64 "quoted"')).toThrow(/base64/);
    expect(() => keychainAddCommand('svc', 'acct', 'A'.repeat(5000))).toThrow(/too long/);
    expect(() => keychainAddCommand('svc', 'a b', 'QQ==')).toThrow(/account/);
  });

  // Opt-in: one real round trip against a throwaway service, deleted afterwards.
  it.skipIf(process.platform !== 'darwin' || process.env.CONDUCTOR_KEYCHAIN_TEST !== '1')('round-trips through the real macOS Keychain', async () => {
    const real = new KeychainSecretStore(`ai.conductor.throwaway-test-${process.pid}`);
    const value = `multi\nline "value" ${randomBytes(4000).toString('hex')}`;
    try {
      await real.set('throwaway', value);
      expect(await real.get('throwaway')).toBe(value);
    } finally {
      await real.delete('throwaway');
    }
    expect(await real.get('throwaway')).toBeNull();
  });
});
