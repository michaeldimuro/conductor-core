import type { Kernel } from '../../contracts/kernel.js';
import { ConductorError, errorMessage, isConductorError } from '../../shared/errors.js';
import { redact } from '../../shared/util.js';
import { AuthRequiredError, type CredentialContext, type UpstreamResult, type UpstreamTool } from '../types.js';
import { connectUpstream, credentialKey, type Connected } from './factory.js';

interface Entry {
  connectorId: string;
  /** connectors.updated_at at connect time; a config change recycles the client. */
  stamp: number;
  conn: Promise<Connected>;
  tools?: { at: number; list: UpstreamTool[] };
}

/**
 * Upstream clients pooled per (connector, credential ref): lazily connected,
 * reconnected after a failure or a config change, closed on `close()`.
 */
export class UpstreamPool {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly k: Kernel,
    private readonly opts: { toolCacheTtlMs: number; callTimeoutMs: number },
  ) {}

  private key(cred: CredentialContext): string {
    return `${cred.connector.id}::${credentialKey(cred)}`;
  }

  private async evict(key: string, entry: Entry): Promise<void> {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    await entry.conn.then((c) => c.client.close()).catch(() => undefined);
  }

  private async acquire(cred: CredentialContext): Promise<{ key: string; entry: Entry; conn: Connected }> {
    const key = this.key(cred);
    let entry = this.entries.get(key);
    if (entry && entry.stamp !== cred.connector.updatedAt) {
      await this.evict(key, entry);
      entry = undefined;
    }
    if (entry) {
      const conn = await entry.conn.catch(() => null);
      if (conn && !conn.client.closed) return { key, entry, conn };
      await this.evict(key, entry);
    }
    const fresh: Entry = { connectorId: cred.connector.id, stamp: cred.connector.updatedAt, conn: connectUpstream(this.k, cred, this.opts.callTimeoutMs) };
    this.entries.set(key, fresh);
    try {
      const conn = await fresh.conn;
      conn.client.onToolsChanged?.(() => {
        fresh.tools = undefined;
      });
      return { key, entry: fresh, conn };
    } catch (e) {
      if (this.entries.get(key) === fresh) this.entries.delete(key);
      throw this.sanitize(e, []);
    }
  }

  /** Never let a credential leak through an upstream error message. */
  private sanitize(e: unknown, secrets: string[]): Error {
    if (e instanceof AuthRequiredError) return e;
    const message = redact(errorMessage(e), secrets);
    if (isConductorError(e)) return new ConductorError(e.code, message, e.details);
    return new ConductorError('unavailable', `upstream connector failed: ${message}`);
  }

  /** The connector's tool list for these credentials (cached for the TTL). */
  async tools(cred: CredentialContext, opts: { refresh?: boolean } = {}): Promise<UpstreamTool[]> {
    for (let attempt = 0; ; attempt++) {
      const { key, entry, conn } = await this.acquire(cred);
      const now = this.k.clock.now();
      if (!opts.refresh && entry.tools && now - entry.tools.at < this.opts.toolCacheTtlMs) return entry.tools.list;
      try {
        const list = await conn.client.listTools();
        entry.tools = { at: now, list };
        return list;
      } catch (e) {
        await this.evict(key, entry);
        // Listing is idempotent, so one reconnect-and-retry is safe.
        if (attempt === 0 && !(e instanceof AuthRequiredError) && !isConductorError(e)) continue;
        throw this.sanitize(e, conn.resolver.used);
      }
    }
  }

  /**
   * Call a tool. A dead connection is replaced before the call, but a call that
   * fails mid-flight is never retried: it may already have had its effect.
   */
  async call(cred: CredentialContext, tool: string, args: Record<string, unknown>): Promise<UpstreamResult> {
    const { key, entry, conn } = await this.acquire(cred);
    try {
      return await conn.client.callTool(tool, args);
    } catch (e) {
      if (!isConductorError(e)) await this.evict(key, entry);
      throw this.sanitize(e, conn.resolver.used);
    }
  }

  async invalidate(connectorId: string): Promise<void> {
    const doomed = [...this.entries].filter(([, e]) => e.connectorId === connectorId);
    await Promise.all(doomed.map(([key, entry]) => this.evict(key, entry)));
  }

  async close(): Promise<void> {
    const all = [...this.entries];
    this.entries.clear();
    await Promise.all(all.map(([, entry]) => entry.conn.then((c) => c.client.close()).catch(() => undefined)));
  }
}
