import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { apiTokens } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { ApiToken } from '../contracts/rows.js';
import type { Principal, TokenService } from '../contracts/services.js';
import { SYSTEM } from '../contracts/types.js';
import { invalid } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { randomToken, sha256 } from '../shared/util.js';
import { requireAgent } from './store.js';

type TokenKind = ApiToken['kind'];

const TOKEN_RE = /^cnd_(owner|run|device)_[A-Za-z0-9_-]{20,}$/;
const OWNER_TOKEN_RE = /^cnd_owner_[A-Za-z0-9_-]{20,}$/;
const CLI_LABEL = 'local-cli';

interface NewToken {
  kind: TokenKind;
  label?: string | null;
  orgId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  expiresAt?: number | null;
}

/** Bearer tokens (`cnd_<kind>_<random>`). Only SHA-256 hashes ever reach the DB, audit log or logger. */
export class Tokens implements TokenService {
  constructor(private readonly k: Kernel) {}

  private register(token: string, t: NewToken): string {
    const id = newId('token');
    this.k.db
      .insert(apiTokens)
      .values({
        id,
        tokenHash: sha256(token),
        kind: t.kind,
        orgId: t.orgId ?? null,
        agentId: t.agentId ?? null,
        runId: t.runId ?? null,
        label: t.label ?? null,
        expiresAt: t.expiresAt ?? null,
        createdAt: this.k.clock.now(),
      })
      .run();
    this.k.audit.record({
      orgId: t.orgId ?? null,
      actor: SYSTEM,
      action: 'token.issued',
      entityKind: 'token',
      entityId: id,
      runId: t.runId ?? undefined,
      data: { tokenKind: t.kind, label: t.label ?? null, agentId: t.agentId ?? null, expiresAt: t.expiresAt ?? null },
    });
    return id;
  }

  private issue(t: NewToken): string {
    const token = `cnd_${t.kind}_${randomToken(32)}`;
    this.register(token, t);
    return token;
  }

  private ttl(ttlMs: number): number {
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) throw invalid('ttlMs must be a positive number');
    return this.k.clock.now() + Math.ceil(ttlMs);
  }

  issueOwnerToken(label?: string): string {
    if (label !== undefined && typeof label !== 'string') throw invalid('label must be a string');
    return this.issue({ kind: 'owner', label: label?.slice(0, 200) ?? 'owner' });
  }

  issueDeviceToken(label: string, ttlMs: number): string {
    if (typeof label !== 'string' || !label.trim()) throw invalid('label is required');
    return this.issue({ kind: 'device', label: label.trim().slice(0, 200), expiresAt: this.ttl(ttlMs) });
  }

  issueRunToken(orgId: string, agentId: string, runId: string, ttlMs: number): string {
    if (typeof runId !== 'string' || !runId) throw invalid('runId is required');
    const expiresAt = this.ttl(ttlMs);
    const agent = requireAgent(this.k, orgId, agentId);
    return this.issue({ kind: 'run', orgId: agent.orgId, agentId: agent.id, runId, expiresAt });
  }

  private lookup(token: string): ApiToken | undefined {
    return this.k.db.select().from(apiTokens).where(eq(apiTokens.tokenHash, sha256(token))).get();
  }

  private live(row: ApiToken | undefined): row is ApiToken {
    if (!row || row.revokedAt !== null) return false;
    return row.expiresAt === null || row.expiresAt > this.k.clock.now();
  }

  verify(token: string): Principal | null {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const row = this.lookup(token);
    if (!this.live(row)) return null;
    // The prefix is informational; the stored kind is authoritative and they must agree.
    if (!token.startsWith(`cnd_${row.kind}_`)) return null;
    if (row.kind === 'run') {
      if (!row.orgId || !row.agentId || !row.runId) return null;
      return { kind: 'run', tokenId: row.id, orgId: row.orgId, agentId: row.agentId, runId: row.runId };
    }
    return { kind: row.kind, tokenId: row.id };
  }

  revokeRunTokens(runId: string): void {
    const revoked = this.k.db
      .update(apiTokens)
      .set({ revokedAt: this.k.clock.now() })
      .where(and(eq(apiTokens.runId, runId), eq(apiTokens.kind, 'run'), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id, orgId: apiTokens.orgId })
      .all();
    for (const t of revoked) {
      this.k.audit.record({ orgId: t.orgId, actor: SYSTEM, action: 'token.revoked', entityKind: 'token', entityId: t.id, runId });
    }
  }

  /** Keep a paused run's token alive: its expiry becomes now + ttlMs. Revoked tokens stay revoked. */
  extendRunToken(runId: string, ttlMs: number): void {
    this.k.db
      .update(apiTokens)
      .set({ expiresAt: this.k.clock.now() + Math.max(0, ttlMs) })
      .where(and(eq(apiTokens.runId, runId), eq(apiTokens.kind, 'run'), isNull(apiTokens.revokedAt)))
      .run();
  }

  revoke(tokenId: string): void {
    const revoked = this.k.db
      .update(apiTokens)
      .set({ revokedAt: this.k.clock.now() })
      .where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id, orgId: apiTokens.orgId, runId: apiTokens.runId })
      .all();
    for (const t of revoked) {
      this.k.audit.record({
        orgId: t.orgId,
        actor: SYSTEM,
        action: 'token.revoked',
        entityKind: 'token',
        entityId: t.id,
        runId: t.runId ?? undefined,
      });
    }
  }

  /**
   * `<home>/owner.token` (0600), the CLI's credential. Created on first call;
   * if the file exists but the DB does not know its hash (fresh/restored DB)
   * the token is registered again; if its token was revoked or the file is
   * malformed a new token replaces it.
   */
  ownerTokenFile(): string {
    const file = this.k.paths.safe(join(this.k.paths.home, 'owner.token'));
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim();
      if (OWNER_TOKEN_RE.test(existing)) {
        const row = this.lookup(existing);
        if (!row) {
          this.register(existing, { kind: 'owner', label: CLI_LABEL });
          chmodSync(file, 0o600);
          return file;
        }
        if (row.kind === 'owner' && this.live(row)) {
          chmodSync(file, 0o600);
          return file;
        }
      }
    }
    const token = this.issue({ kind: 'owner', label: CLI_LABEL });
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return file;
  }
}
