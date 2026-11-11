import type { Services } from '../daemon/container.js';
import type { SecretStore } from '../contracts/kernel.js';
import type { Gateway } from '../contracts/rows.js';
import { SYSTEM } from '../contracts/types.js';
import type { GatewayKind } from '../db/schema/reach.js';
import { errorMessage } from '../shared/errors.js';
import { redact, stableStringify } from '../shared/util.js';
import type { GatewayRouter } from './router.js';
import type { GatewayStore } from './store.js';
import {
  VOLATILE_CONFIG_KEYS, parseGatewayConfig, type AdapterContext, type AdapterFactory, type GatewayAdapter, type GatewayConfig,
} from './types.js';

const RETRY_FAILED_MS = 5 * 60_000;

/**
 * Credentials come only from the secret store. The secret at `authRef` is
 * either a bare token or a JSON object of named credentials
 * (`{"token":"xoxb-…","signingSecret":"…","appToken":"xapp-…"}`); extra
 * refs can be named in `config.secretRefs`.
 */
export async function resolveCredentials(secrets: SecretStore, gateway: Gateway, config: GatewayConfig): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (gateway.authRef) {
    const raw = (await secrets.get(gateway.authRef))?.trim();
    if (raw) {
      let parsed: unknown = null;
      if (raw.startsWith('{')) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
      }
      if (parsed && typeof parsed === 'object') {
        for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string' && value) out[name] = value;
        }
      } else {
        out.token = raw;
      }
    }
  }
  for (const [name, ref] of Object.entries(config.secretRefs ?? {})) {
    const value = (await secrets.get(ref))?.trim();
    if (value) out[name] = value;
  }
  return out;
}

/** What makes an adapter need a restart: connection-relevant config, not allow-lists or poll offsets. */
function fingerprint(gateway: Gateway): string {
  const config: Record<string, unknown> = { ...(gateway.config ?? {}) };
  for (const key of VOLATILE_CONFIG_KEYS) if (key !== 'state') delete config[key];
  delete config.state;
  return stableStringify({ kind: gateway.kind, authRef: gateway.authRef, config });
}

interface Running {
  adapter: GatewayAdapter;
  kind: GatewayKind;
  fingerprint: string;
}

export interface GatewayStatus {
  id: string;
  kind: string;
  status: string;
  lastError: string | null;
}

/** Owns adapter lifecycles: starts/stops them to match the `gateways` table; one bad adapter never affects the rest. */
export class GatewayManager {
  private running = new Map<string, Running>();
  private failed = new Map<string, { fingerprint: string; at: number }>();
  private health = new Map<string, string | null>();
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly services: Services,
    private readonly store: GatewayStore,
    private readonly router: GatewayRouter,
    private readonly factories: Record<GatewayKind, AdapterFactory>,
  ) {}

  adapters(): Array<{ gatewayId: string; adapter: GatewayAdapter }> {
    return [...this.running.entries()].map(([gatewayId, r]) => ({ gatewayId, adapter: r.adapter }));
  }

  lookup(gatewayId: string): { kind: GatewayKind; adapter: GatewayAdapter } | null {
    const r = this.running.get(gatewayId);
    return r ? { kind: r.kind, adapter: r.adapter } : null;
  }

  /** Re-read the table and converge. `force` also retries adapters that recently failed to start. */
  reload(force = true): Promise<void> {
    const next = this.chain.then(() => this.converge(force));
    this.chain = next.catch((err) => {
      this.services.kernel.log.error({ err: errorMessage(err) }, 'gateway reload failed');
    });
    return this.chain;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.chain;
    await Promise.all([...this.running.keys()].map((id) => this.stopOne(id)));
  }

  status(): GatewayStatus[] {
    return this.store.list().map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status === 'active' && !this.running.has(row.id) ? 'stopped' : row.status,
      lastError: row.lastError,
    }));
  }

  private async converge(force: boolean): Promise<void> {
    if (this.stopped) return;
    const rows = this.store.list();
    const wanted = new Map(rows.filter((r) => r.status !== 'disabled').map((r) => [r.id, r] as const));

    for (const [id, r] of [...this.running.entries()]) {
      const row = wanted.get(id);
      if (!row || fingerprint(row) !== r.fingerprint) await this.stopOne(id);
    }
    for (const id of [...this.failed.keys()]) if (!wanted.has(id)) this.failed.delete(id);

    const now = this.services.kernel.clock.now();
    for (const row of wanted.values()) {
      if (this.running.has(row.id)) continue;
      const fp = fingerprint(row);
      const failure = this.failed.get(row.id);
      if (failure && failure.fingerprint === fp && !force && now - failure.at < RETRY_FAILED_MS) continue;
      await this.startOne(row, fp);
    }
  }

  private async startOne(row: Gateway, fp: string): Promise<void> {
    const { kernel } = this.services;
    let adapter: GatewayAdapter | null = null;
    let secretValues: string[] = [];
    try {
      const credentials = await resolveCredentials(kernel.secrets, row, parseGatewayConfig(row.config));
      secretValues = Object.values(credentials);
      const ctx: AdapterContext = {
        gatewayId: row.id,
        name: row.name,
        config: () => this.store.config(row.id),
        credentials,
        emit: (message) => {
          const current = this.running.get(row.id)?.adapter ?? adapter;
          return current ? this.router.handle(row.id, current, message) : Promise.resolve();
        },
        getState: (key) => this.store.getState(row.id, key),
        setState: (key, value) => this.store.setState(row.id, key, value),
        health: (error) => this.reportHealth(row.id, error === null ? null : redact(error, secretValues).slice(0, 500)),
        now: () => kernel.clock.now(),
        log: kernel.log,
      };
      const factory = this.factories[row.kind];
      if (!factory) throw new Error(`unsupported gateway kind: ${row.kind}`);
      adapter = factory(ctx);
      await adapter.start();
      this.running.set(row.id, { adapter, kind: row.kind, fingerprint: fp });
      this.failed.delete(row.id);
      this.health.set(row.id, null);
      this.store.setStatus(row.id, 'active', null);
      kernel.audit.record({ orgId: row.orgId, actor: SYSTEM, action: 'gateway.started', entityKind: 'gateway', entityId: row.id, data: { kind: row.kind } });
    } catch (err) {
      const message = redact(errorMessage(err), secretValues).slice(0, 500);
      this.failed.set(row.id, { fingerprint: fp, at: kernel.clock.now() });
      this.health.set(row.id, message);
      this.store.setStatus(row.id, 'error', message);
      kernel.log.warn({ gatewayId: row.id, kind: row.kind, error: message }, 'gateway failed to start');
      kernel.audit.record({ orgId: row.orgId, actor: SYSTEM, action: 'gateway.error', entityKind: 'gateway', entityId: row.id, data: { kind: row.kind, error: message } });
      if (adapter) await adapter.stop().catch(() => {});
    }
  }

  private async stopOne(id: string): Promise<void> {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    this.health.delete(id);
    try {
      await r.adapter.stop();
    } catch (err) {
      this.services.kernel.log.warn({ gatewayId: id, err: errorMessage(err) }, 'gateway failed to stop cleanly');
    }
  }

  /** Runtime failures (poll loop down, socket dropped) surface on the row; recovery clears them. */
  private reportHealth(id: string, error: string | null): void {
    if (this.stopped || !this.running.has(id)) return;
    if (this.health.get(id) === error) return;
    this.health.set(id, error);
    try {
      this.store.setStatus(id, error === null ? 'active' : 'error', error);
    } catch (err) {
      this.services.kernel.log.warn({ gatewayId: id, err: errorMessage(err) }, 'could not record gateway health');
    }
  }
}
