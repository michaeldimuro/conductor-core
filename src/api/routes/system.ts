import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Services } from '../../daemon/container.js';
import type { Health } from '../../contracts/adapter.js';
import type { Organization } from '../../contracts/rows.js';
import { OWNER, type ProviderBinding } from '../../contracts/types.js';
import { settings } from '../../db/schema/index.js';
import { errorMessage, invalid, notFound } from '../../shared/errors.js';
import { body, param, parse, query, resolveOrg } from '../http.js';
import { secretRef as secretRefSchema } from '../schemas/common.js';
import * as q from '../schemas/capabilities.js';
import type { BindingCheck, DoctorResponse, KillSwitchResponse, SecretStatus, SettingDto, StatusResponse } from '../types.js';

const httpUrl = z.string().max(2000).refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an http(s) URL');

/** The only settings reachable over the API. Everything else in the table is internal. */
const SETTING_SCHEMAS: Record<string, z.ZodType> = {
  'daemon.public_url': httpUrl.nullable(),
  'embeddings.provider': z.enum(['local', 'openai']),
  'embeddings.authRef': secretRefSchema.nullable(),
  'embeddings.baseUrl': httpUrl.nullable(),
};

/** Conventional key refs the runtime tries when a binding names no `authRef` (mirrors runtime binding resolution). */
const DEFAULT_KEY_REFS: Record<string, (orgSlug: string) => string[]> = {
  claude_api: (o) => [`org/${o}/anthropic-api-key`, 'conductor/anthropic-api-key'],
  openai_api: (o) => [`org/${o}/openai-api-key`, 'conductor/openai-api-key'],
};
const TEST_TIMEOUT_MS = 20_000;

export function systemRoutes(app: FastifyInstance, s: Services): void {
  const k = s.kernel;
  const getSetting = (key: string): unknown => k.db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
  const settingSchema = (key: string): z.ZodType => {
    const schema = SETTING_SCHEMAS[key];
    if (!schema) throw notFound('setting', key);
    return schema;
  };

  async function testBinding(adapterId: string, cfg: { config?: Record<string, unknown>; authRef?: string | null; model?: string | null }, orgSlug?: string): Promise<Health> {
    const adapter = s.registry.get(adapterId);
    if (!adapter) return { ok: false, detail: 'adapter not installed' };
    const secrets: Record<string, string> = {};
    const refs = cfg.authRef ? [cfg.authRef] : orgSlug ? (DEFAULT_KEY_REFS[adapterId]?.(orgSlug) ?? []) : [];
    for (const ref of refs) {
      const v = await k.secrets.get(ref).catch(() => null);
      if (v) {
        secrets.apiKey = v;
        break;
      }
    }
    if (cfg.authRef && !secrets.apiKey) return { ok: false, detail: `no secret stored under ${cfg.authRef}` };
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<Health>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, detail: 'connection test timed out' }), TEST_TIMEOUT_MS);
      });
      return await Promise.race([adapter.testConnection({ config: cfg.config ?? {}, secrets, model: cfg.model ?? null }), timeout]);
    } catch (e) {
      // Never echo adapter errors verbatim beyond the message (secrets are redacted by the logger, not here).
      return { ok: false, detail: errorMessage(e).slice(0, 500) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function orgBindings(org: Organization): Promise<BindingCheck[]> {
    const seen = new Map<string, { source: string; binding: ProviderBinding }>();
    const add = (source: string, b: ProviderBinding | null | undefined, model?: string | null) => {
      if (!b) return;
      const binding = { ...b, model: model ?? b.model };
      const key = JSON.stringify([binding.adapter, binding.model ?? null, binding.authRef ?? null, binding.config ?? {}]);
      if (!seen.has(key)) seen.set(key, { source, binding });
    };
    add('org-default', org.defaultProvider);
    for (const a of s.org.listAgents(org.id, { status: 'active' })) add(`agent:${a.slug}`, a.providerBinding ?? org.defaultProvider, a.model);
    const entries = [...seen.values()].slice(0, 20);
    return Promise.all(entries.map(async ({ source, binding }) => ({
      source,
      adapter: binding.adapter,
      model: binding.model ?? null,
      health: await testBinding(binding.adapter, binding, org.slug),
    })));
  }

  app.get('/status', async (): Promise<StatusResponse> => {
    const orgs = s.org.listOrgs();
    return {
      version: s.version,
      publicUrl: s.publicUrl(),
      runtime: s.runtime.status(),
      killSwitch: { global: s.governance.killSwitch.globalEngaged(), orgs: orgs.filter((o) => o.killSwitch).map((o) => o.id) },
      counts: {
        orgs: orgs.length,
        agents: orgs.reduce((n, o) => n + s.org.listAgents(o.id).length, 0),
        pendingApprovals: s.governance.approvals.list(null, { status: 'pending', limit: 1000 }).length,
      },
    };
  });

  app.get('/doctor', async (req): Promise<DoctorResponse> => {
    const { orgId } = query(req, q.doctorQ);
    let secretStore: DoctorResponse['secretStore'];
    try {
      await k.secrets.has('conductor/doctor-probe');
      secretStore = { reachable: true };
    } catch (e) {
      secretStore = { reachable: false, detail: errorMessage(e).slice(0, 300) };
    }
    const publicUrl = s.publicUrl();
    return {
      version: s.version,
      home: k.paths.home,
      baseUrl: s.baseUrl(),
      publicUrl,
      publicUrlConfigured: publicUrl !== s.baseUrl().replace(/\/+$/, ''),
      secretStore,
      adapters: s.registry.list(),
      runtime: s.runtime.status(),
      killSwitch: { global: s.governance.killSwitch.globalEngaged() },
      ...(orgId ? { bindings: await orgBindings(resolveOrg(s, orgId)) } : {}),
    };
  });

  /* ── Settings (allow-list) ── */
  app.get('/settings', async (): Promise<SettingDto[]> => Object.keys(SETTING_SCHEMAS).map((key) => ({ key, value: getSetting(key) })));
  app.get('/settings/:key', async (req): Promise<SettingDto> => {
    const key = param(req, 'key');
    settingSchema(key);
    return { key, value: getSetting(key) };
  });
  app.put('/settings/:key', async (req): Promise<SettingDto> => {
    const key = param(req, 'key');
    const schema = settingSchema(key);
    const raw = body(req, q.settingValue).value;
    if (raw === undefined) throw invalid('value is required');
    const value = parse(schema, raw);
    const now = k.clock.now();
    k.db.insert(settings).values({ key, value, updatedAt: now }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } }).run();
    k.audit.record({ orgId: null, actor: OWNER, action: 'config.changed', entityKind: 'setting', entityId: key, data: { value } });
    return { key, value };
  });

  /* ── Global kill switch ── */
  app.post('/kill-switch', async (): Promise<KillSwitchResponse> => {
    s.governance.killSwitch.engage(null, OWNER);
    return { engaged: s.governance.killSwitch.globalEngaged() };
  });
  app.delete('/kill-switch', async (): Promise<KillSwitchResponse> => {
    s.governance.killSwitch.release(null, OWNER);
    return { engaged: s.governance.killSwitch.globalEngaged() };
  });

  /* ── Secrets: write-only. A value is never returned, logged or audited. ── */
  const refOf = (req: Parameters<typeof param>[0]): string => parse(secretRefSchema, param(req, '*'));
  app.get('/secrets/*', async (req): Promise<SecretStatus> => {
    const ref = refOf(req);
    return { ref, exists: await k.secrets.has(ref) };
  });
  app.put('/secrets/*', async (req): Promise<SecretStatus> => {
    const ref = refOf(req);
    await k.secrets.set(ref, body(req, q.secretValue).value);
    k.audit.record({ orgId: null, actor: OWNER, action: 'secret.set', entityKind: 'secret', entityId: ref });
    return { ref, exists: true };
  });
  app.delete('/secrets/*', async (req): Promise<SecretStatus> => {
    const ref = refOf(req);
    await k.secrets.delete(ref);
    k.audit.record({ orgId: null, actor: OWNER, action: 'secret.deleted', entityKind: 'secret', entityId: ref });
    return { ref, exists: false };
  });

  /* ── Adapters ── */
  app.get('/adapters', async () => s.registry.list());
  app.post('/adapters/:adapterId/test', async (req): Promise<Health> => {
    const id = param(req, 'adapterId');
    if (!s.registry.get(id)) throw notFound('adapter', id);
    return testBinding(id, body(req, q.testAdapter));
  });
}
