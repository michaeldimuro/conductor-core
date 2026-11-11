import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretStore } from '../contracts/kernel.js';
import { invalid } from '../shared/errors.js';

const exec = promisify(execFile);
const SERVICE = 'ai.conductor';

function checkRef(ref: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,200}$/.test(ref)) throw invalid(`invalid secret ref: ${ref}`);
  return ref;
}

/** macOS Keychain via the `security` CLI (login keychain; needs the user's GUI session). */
export class KeychainSecretStore implements SecretStore {
  constructor(private readonly service = SERVICE) {}

  async get(ref: string): Promise<string | null> {
    try {
      const { stdout } = await exec('/usr/bin/security', ['find-generic-password', '-s', this.service, '-a', checkRef(ref), '-w']);
      const raw = stdout.replace(/\n$/, '');
      return Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  async set(ref: string, value: string): Promise<void> {
    // Stored base64-encoded so multi-line values round-trip through `security -w`.
    // -U updates in place. The value is passed as an argv element to a direct
    // execFile (no shell), which is the only non-interactive path `security` offers.
    await exec('/usr/bin/security', [
      'add-generic-password', '-U', '-s', this.service, '-a', checkRef(ref), '-w', Buffer.from(value, 'utf8').toString('base64'),
    ]);
  }

  async delete(ref: string): Promise<void> {
    try {
      await exec('/usr/bin/security', ['delete-generic-password', '-s', this.service, '-a', checkRef(ref)]);
    } catch {
      /* absent */
    }
  }

  async has(ref: string): Promise<boolean> {
    return (await this.get(ref)) !== null;
  }
}

/**
 * AES-256-GCM encrypted file vault for the headless LaunchDaemon profile
 * (no Keychain). The passphrase comes from CONDUCTOR_VAULT_KEY or a root-only
 * key file; it is stretched with scrypt and never stored alongside the vault.
 */
export class FileVaultSecretStore implements SecretStore {
  private cache: Record<string, string> | null = null;

  constructor(private readonly file: string, private readonly passphrase: string) {
    if (!passphrase) throw invalid('file vault requires a passphrase (CONDUCTOR_VAULT_KEY)');
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) return (this.cache = {});
    const buf = readFileSync(this.file);
    const salt = buf.subarray(0, 16);
    const iv = buf.subarray(16, 28);
    const tag = buf.subarray(28, 44);
    const key = scryptSync(this.passphrase, salt, 32);
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(buf.subarray(44)), d.final()]);
    return (this.cache = JSON.parse(plain.toString('utf8')) as Record<string, string>);
  }

  private save(): void {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(this.passphrase, salt, 32);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(this.cache ?? {}), 'utf8'), c.final()]);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, Buffer.concat([salt, iv, c.getAuthTag(), enc]), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  async get(ref: string): Promise<string | null> {
    return this.load()[checkRef(ref)] ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.load()[checkRef(ref)] = value;
    this.save();
  }
  async delete(ref: string): Promise<void> {
    delete this.load()[checkRef(ref)];
    this.save();
  }
  async has(ref: string): Promise<boolean> {
    return checkRef(ref) in this.load();
  }
}

/** In-memory store for tests. */
export class MemorySecretStore implements SecretStore {
  private m = new Map<string, string>();
  async get(ref: string) {
    return this.m.get(checkRef(ref)) ?? null;
  }
  async set(ref: string, value: string) {
    this.m.set(checkRef(ref), value);
  }
  async delete(ref: string) {
    this.m.delete(checkRef(ref));
  }
  async has(ref: string) {
    return this.m.has(checkRef(ref));
  }
}

/** Pick the store for this install: env override → file vault (headless) → Keychain (macOS) . */
export function createSecretStore(opts: { vaultFile: string; mode?: string }): SecretStore {
  const mode = opts.mode ?? process.env.CONDUCTOR_SECRETS ?? (process.platform === 'darwin' ? 'keychain' : 'vault');
  if (mode === 'memory') return new MemorySecretStore();
  if (mode === 'vault') return new FileVaultSecretStore(opts.vaultFile, process.env.CONDUCTOR_VAULT_KEY ?? '');
  return new KeychainSecretStore();
}
