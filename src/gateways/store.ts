import { randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Kernel } from '../contracts/kernel.js';
import type { Gateway } from '../contracts/rows.js';
import { OWNER } from '../contracts/types.js';
import { gateways, gatewayChats } from '../db/schema/reach.js';
import { invalid, notFound } from '../shared/errors.js';
import { safeEqual, sha256 } from '../shared/util.js';
import { recordGatewayRevision } from './revisions.js';
import { parseGatewayConfig, type GatewayConfig } from './types.js';

export type GatewayChat = typeof gatewayChats.$inferSelect;

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_MAX_ATTEMPTS = 5;
export const PAIRING_CODE_RE = /^[A-Z2-9]{8}$/;

function hashPairingCode(gatewayId: string, code: string): string {
  return sha256(`conductor-gateway-pairing:${gatewayId}:${code}`);
}

/** Persistence for the two tables this context owns: `gateways` (config/status) and `gateway_chats`. */
export class GatewayStore {
  constructor(private readonly k: Kernel) {}

  list(): Gateway[] {
    return this.k.db.select().from(gateways).all();
  }

  get(id: string): Gateway | null {
    return this.k.db.select().from(gateways).where(eq(gateways.id, id)).get() ?? null;
  }

  config(id: string): GatewayConfig {
    return parseGatewayConfig(this.get(id)?.config);
  }

  /** Atomic read-modify-write of the config JSON (the API context may edit the same row). */
  patchConfig(id: string, mutate: (config: Record<string, unknown>) => void): void {
    this.k.sqlite.transaction(() => {
      const row = this.get(id);
      if (!row) return;
      const config = { ...(row.config ?? {}) };
      mutate(config);
      this.k.db.update(gateways).set({ config }).where(eq(gateways.id, id)).run();
    })();
  }

  getState(id: string, key: string): unknown {
    return this.config(id).state?.[key];
  }

  setState(id: string, key: string, value: unknown): void {
    this.patchConfig(id, (config) => {
      const state = config.state && typeof config.state === 'object' ? { ...(config.state as Record<string, unknown>) } : {};
      state[key] = value;
      config.state = state;
    });
  }

  setStatus(id: string, status: 'active' | 'error', lastError: string | null): void {
    // Never resurrect a gateway the owner disabled in the meantime.
    this.k.sqlite.transaction(() => {
      const row = this.get(id);
      if (!row || row.status === 'disabled') return;
      if (row.status === status && row.lastError === lastError) return;
      this.k.db.update(gateways).set({ status, lastError, updatedAt: this.k.clock.now() }).where(eq(gateways.id, id)).run();
    })();
  }

  /* ── chats ── */

  getChat(gatewayId: string, chatId: string): GatewayChat | null {
    return this.k.db.select().from(gatewayChats)
      .where(and(eq(gatewayChats.gatewayId, gatewayId), eq(gatewayChats.chatId, chatId))).get() ?? null;
  }

  saveChat(gatewayId: string, chatId: string, patch: { orgId?: string | null; agentId?: string | null; issueId?: string | null }): GatewayChat {
    const now = this.k.clock.now();
    this.k.db.insert(gatewayChats)
      .values({ gatewayId, chatId, orgId: patch.orgId ?? null, agentId: patch.agentId ?? null, issueId: patch.issueId ?? null, updatedAt: now })
      .onConflictDoUpdate({ target: [gatewayChats.gatewayId, gatewayChats.chatId], set: { ...patch, updatedAt: now } })
      .run();
    return this.getChat(gatewayId, chatId)!;
  }

  /* ── pairing ── */

  mintPairingCode(gatewayId: string, ttlMs = PAIRING_TTL_MS): string {
    const row = this.get(gatewayId);
    if (!row) throw notFound('gateway', gatewayId);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 3_600_000) throw invalid('pairing ttl must be between 1 ms and 24 h');
    let code = '';
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
    const expiresAt = this.k.clock.now() + ttlMs;
    this.patchConfig(gatewayId, (config) => {
      config.pairingCodeHash = hashPairingCode(gatewayId, code);
      config.pairingExpiresAt = expiresAt;
      config.pairingAttempts = 0;
    });
    this.k.audit.record({
      orgId: row.orgId, actor: OWNER, action: 'gateway.pairing_code_minted', entityKind: 'gateway', entityId: gatewayId, data: { expiresAt },
    });
    return code;
  }

  /**
   * Redeem a pairing code for a chat. One-time: success consumes the code and
   * allow-lists the chat; too many wrong guesses burn it.
   */
  redeemPairingCode(gatewayId: string, chatId: string, userId: string, code: string, isGroup = false): 'paired' | 'invalid' | 'expired' | 'none' {
    let result: 'paired' | 'invalid' | 'expired' | 'none' = 'none';
    const candidate = code.trim().toUpperCase();
    this.patchConfig(gatewayId, (config) => {
      const hash = typeof config.pairingCodeHash === 'string' ? config.pairingCodeHash : null;
      const expiresAt = typeof config.pairingExpiresAt === 'number' ? config.pairingExpiresAt : 0;
      const clear = () => {
        delete config.pairingCodeHash;
        delete config.pairingExpiresAt;
        delete config.pairingAttempts;
      };
      if (!hash) return;
      if (expiresAt <= this.k.clock.now()) {
        clear();
        result = 'expired';
        return;
      }
      if (!PAIRING_CODE_RE.test(candidate) || !safeEqual(hashPairingCode(gatewayId, candidate), hash)) {
        const attempts = (typeof config.pairingAttempts === 'number' ? config.pairingAttempts : 0) + 1;
        if (attempts >= PAIRING_MAX_ATTEMPTS) clear();
        else config.pairingAttempts = attempts;
        result = 'invalid';
        return;
      }
      clear();
      const current = parseGatewayConfig(config);
      config.allowedChatIds = [...new Set([...current.allowedChatIds, chatId])];
      // When a user allow-list is also in force, the pairing user must pass it too.
      if (current.allowedUserIds.length > 0) config.allowedUserIds = [...new Set([...current.allowedUserIds, userId])];
      // Whoever held the owner's code is the owner: in a group, only they (not every member) may decide approvals.
      if (isGroup && userId) config.approverUserIds = [...new Set([...current.approverUserIds, userId])];
      result = 'paired';
    });
    // Pairing changed who may talk to (and decide through) this gateway: that is config, so it is revisioned.
    const paired = (result as string) === 'paired' ? this.get(gatewayId) : null;
    if (paired) recordGatewayRevision(this.k, paired, OWNER, `paired chat ${chatId}`.slice(0, 200));
    return result;
  }
}

/**
 * Mint a one-time pairing code for a gateway (owner action; call from the API/CLI).
 * Only its hash and expiry are stored (`config.pairingCodeHash` / `pairingExpiresAt`);
 * the plain code is returned exactly once. The first chat to send `/pair <code>`
 * before it expires is added to the gateway's allow-list.
 */
export function mintPairingCode(kernel: Kernel, gatewayId: string, ttlMs: number = PAIRING_TTL_MS): string {
  return new GatewayStore(kernel).mintPairingCode(gatewayId, ttlMs);
}
