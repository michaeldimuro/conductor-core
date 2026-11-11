import { execFile, spawn } from 'node:child_process';
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

/**
 * `security -i` reads one command per line into a 4096-byte buffer; a longer
 * line is split and its tail executed as a command. Lines are kept well under
 * that, and values that do not fit are stored in several items.
 */
const MAX_COMMAND_LINE = 4000;
/** Base64 characters per Keychain item. */
const CHUNK = 3000;
const CHUNKED = /^chunked:v1:(\d{1,4})$/;
const SAFE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,63}$/;
/** `~` is not a legal ref character, so part accounts can never collide with a real ref. */
const partAccount = (ref: string, i: number): string => `${ref}~part~${i}`;

/**
 * One `security -i` command line that stores `encoded` (base64) under
 * service/account. Every interpolated field is restricted to characters that
 * need no escaping inside double quotes, and the length is checked.
 */
export function keychainAddCommand(service: string, account: string, encoded: string): string {
  if (!SAFE_SERVICE.test(service)) throw invalid('invalid keychain service name');
  if (!/^[A-Za-z0-9._:/@~-]+$/.test(account)) throw invalid('invalid keychain account');
  if (!/^[A-Za-z0-9+/=:]*$/.test(encoded)) throw invalid('keychain value must be base64');
  const line = `add-generic-password -U -s "${service}" -a "${account}" -w "${encoded}"\n`;
  if (line.length > MAX_COMMAND_LINE) throw invalid('keychain command line too long');
  return line;
}

/**
 * macOS Keychain via the `security` CLI (login keychain; needs the user's GUI
 * session). Secret values never appear in any process's argv (visible to every
 * local user through `ps`): writes go to `security -i` over stdin.
 */
export class KeychainSecretStore implements SecretStore {
  constructor(
    private readonly service = SERVICE,
    /** The `security` binary (tests inject a fake). */
    private readonly bin = '/usr/bin/security',
  ) {
    if (!SAFE_SERVICE.test(service)) throw invalid('invalid keychain service name');
  }

  /** Raw stored string of one item, or null when absent. Only names travel in argv. */
  private async read(account: string): Promise<string | null> {
    try {
      const { stdout } = await exec(this.bin, ['find-generic-password', '-s', this.service, '-a', account, '-w'], { maxBuffer: 1024 * 1024 });
      return stdout.replace(/\n$/, '');
    } catch {
      return null;
    }
  }

  /** Feed command lines to `security -i` on stdin. Output is discarded: it can echo fragments of its input. */
  private interactive(commands: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', (e) => reject(new Error(`keychain write failed: ${e.message}`)));
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`keychain write failed (security exited with ${code ?? 'a signal'})`))));
      child.stdin.on('error', () => {
        /* reported through the exit code */
      });
      child.stdin.end(commands);
    });
  }

  private async remove(account: string): Promise<void> {
    try {
      await exec(this.bin, ['delete-generic-password', '-s', this.service, '-a', account]);
    } catch {
      /* absent */
    }
  }

  private async partCount(ref: string): Promise<number> {
    const m = CHUNKED.exec((await this.read(ref)) ?? '');
    return m ? Number(m[1]) : 0;
  }

  async get(ref: string): Promise<string | null> {
    const head = await this.read(checkRef(ref));
    if (head === null) return null;
    const m = CHUNKED.exec(head);
    if (!m) return Buffer.from(head, 'base64').toString('utf8');
    let encoded = '';
    for (let i = 0; i < Number(m[1]); i++) {
      const part = await this.read(partAccount(ref, i));
      if (part === null) return null; // incomplete write: treat as absent rather than return a truncated secret
      encoded += part;
    }
    return Buffer.from(encoded, 'base64').toString('utf8');
  }

  async set(ref: string, value: string): Promise<void> {
    checkRef(ref);
    // Stored base64-encoded so multi-line values round-trip through `security -w`
    // and nothing in the command line needs escaping. -U updates in place.
    const encoded = Buffer.from(value, 'utf8').toString('base64');
    const before = await this.partCount(ref);
    let parts = 0;
    if (encoded.length <= CHUNK) {
      await this.interactive(keychainAddCommand(this.service, ref, encoded));
    } else {
      parts = Math.ceil(encoded.length / CHUNK);
      // Parts first, the header last: a reader never sees a header whose parts are missing.
      for (let i = 0; i < parts; i++) {
        await this.interactive(keychainAddCommand(this.service, partAccount(ref, i), encoded.slice(i * CHUNK, (i + 1) * CHUNK)));
      }
      await this.interactive(keychainAddCommand(this.service, ref, `chunked:v1:${parts}`));
    }
    for (let i = parts; i < before; i++) await this.remove(partAccount(ref, i));
  }

  async delete(ref: string): Promise<void> {
    checkRef(ref);
    const parts = await this.partCount(ref);
    await this.remove(ref);
    for (let i = 0; i < parts; i++) await this.remove(partAccount(ref, i));
  }

  async has(ref: string): Promise<boolean> {
    return (await this.read(checkRef(ref))) !== null;
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
