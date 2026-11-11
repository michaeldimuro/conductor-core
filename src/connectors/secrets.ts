import type { SecretStore } from '../contracts/kernel.js';
import { ConductorError } from '../shared/errors.js';

export interface SecretRefValue {
  secretRef: string;
}

export function isSecretRef(v: unknown): v is SecretRefValue {
  return typeof v === 'object' && v !== null && typeof (v as { secretRef?: unknown }).secretRef === 'string';
}

/**
 * Resolves `{ secretRef }` values at the last moment. A ref is looked up
 * relative to each auth prefix in order (grant authRef first, then the
 * connector's), then as an absolute ref. Absolute refs in the `org/<slug>/`
 * namespace must belong to the caller's org.
 */
export class SecretResolver {
  /** Every secret value handed out, so callers can scrub them from error text. */
  readonly used: string[] = [];

  constructor(
    private readonly secrets: SecretStore,
    private readonly authRefs: string[],
    private readonly orgSlug: string,
  ) {}

  private allowed(ref: string): boolean {
    if (ref.includes('..')) return false;
    if (ref.startsWith('org/')) return ref.startsWith(`org/${this.orgSlug}/`);
    return true;
  }

  private async read(ref: string): Promise<string | null> {
    if (!this.allowed(ref)) return null;
    try {
      const v = await this.secrets.get(ref);
      if (v !== null && v !== '') this.used.push(v);
      return v === '' ? null : v;
    } catch {
      return null; // malformed ref
    }
  }

  /** Look up a named secret; null when absent everywhere. */
  async lookup(name: string): Promise<string | null> {
    for (const prefix of this.authRefs) {
      const v = await this.read(`${prefix}/${name}`);
      if (v !== null) return v;
    }
    return this.read(name);
  }

  /** A secret stored directly at an auth ref (single-credential connectors). */
  async direct(): Promise<string | null> {
    for (const ref of this.authRefs) {
      const v = await this.read(ref);
      if (v !== null) return v;
    }
    return null;
  }

  /** Literal string, or a `{ secretRef }` that must resolve. */
  async value(v: unknown, what: string): Promise<string> {
    if (typeof v === 'string') return v;
    if (isSecretRef(v)) {
      const s = await this.lookup(v.secretRef);
      if (s === null) throw new ConductorError('unavailable', `missing secret "${v.secretRef}" for ${what}`);
      return s;
    }
    throw new ConductorError('validation', `${what} must be a string or { secretRef }`);
  }

  async map(input: Record<string, unknown> | undefined, what: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(input ?? {})) out[k] = await this.value(v, `${what}.${k}`);
    return out;
  }
}
