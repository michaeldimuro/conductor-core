import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { browserProfiles } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { OrgService } from '../contracts/org-work.js';
import type { BrowserProfile } from '../contracts/rows.js';
import { SYSTEM, type Actor } from '../contracts/types.js';
import { ConductorError, conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import { newId, slugify } from '../shared/ids.js';
import { newKey } from './crypto.js';
import { normalizePatterns } from './domains.js';
import { readProfileRevision, recordProfileRevision } from './revisions.js';

export type OrgLookup = Pick<OrgService, 'getAgent' | 'getOrg' | 'getDept'>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Which browser backs a profile. `chromium` = Playwright-managed Chromium;
 * `channel` = the user's installed Chrome/Edge driven with the profile's own
 * user-data-dir; `cdp` = attach to an already running Chrome over CDP
 * (loopback only — the debugging port must never be reachable remotely).
 */
export const engineSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chromium') }),
  z.strictObject({ kind: z.literal('channel'), channel: z.enum(['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary', 'msedge']) }),
  z.strictObject({
    kind: z.literal('cdp'),
    endpoint: z.string().max(500).refine((v) => {
      try {
        const u = new URL(v);
        return ['http:', 'ws:'].includes(u.protocol) && LOOPBACK.has(u.hostname);
      } catch {
        return false;
      }
    }, 'CDP endpoint must be an http:// or ws:// URL on localhost'),
  }),
]);
export type EngineConfig = z.infer<typeof engineSchema>;

const patterns = z.array(z.string().max(253)).max(200);
/** 1Password vault names (or ids) whose items the profile's agent may fill by a direct `op://` reference. */
const vaults = z.array(z.string().trim().min(1).max(200).refine((v) => !v.includes('/'), 'a vault name must not contain "/"')).max(50);
const settingsFields = {
  engine: engineSchema.optional(),
  headed: z.boolean().nullable().optional(),
  onePasswordVaults: vaults.optional(),
};
const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  agentId: z.string().min(1).nullish(),
  deptId: z.string().min(1).nullish(),
  domainAllowlist: patterns.optional(),
  sensitiveDomains: patterns.optional(),
  ...settingsFields,
});
const updateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  domainAllowlist: patterns.optional(),
  sensitiveDomains: patterns.optional(),
  ...settingsFields,
});

export interface ProfileSettings {
  engine: EngineConfig;
  /** true = visible window, false = headless, null = follow the daemon default. */
  headed: boolean | null;
  onePasswordVaults: string[];
}

/** What `<profileDir>/conductor-engine.json` may hold: the vault allowlist, and the engine of profiles created before the `engine` column. */
const fileSchema = z.object({ engine: engineSchema.optional(), onePasswordVaults: vaults.optional() });

/** `browser_profiles.engine`: `bundled`, `channel:<name>` or `cdp:<endpoint>`. */
export function encodeEngine(e: EngineConfig): string {
  return e.kind === 'chromium' ? 'bundled' : e.kind === 'channel' ? `channel:${e.channel}` : `cdp:${e.endpoint}`;
}

export function decodeEngine(column: string): EngineConfig {
  if (column === 'bundled' || column === 'chromium' || column === '') return { kind: 'chromium' };
  const i = column.indexOf(':');
  const kind = i === -1 ? column : column.slice(0, i);
  const rest = i === -1 ? '' : column.slice(i + 1);
  return parse(engineSchema, kind === 'channel' ? { kind, channel: rest } : kind === 'cdp' ? { kind, endpoint: rest } : { kind }, 'browser engine');
}

export type CreateProfileInput = z.input<typeof createSchema>;
export type UpdateProfileInput = z.input<typeof updateSchema>;

const ENGINE_FILE = 'conductor-engine.json';

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid(`${what}: ${r.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
  return r.data;
}

/** Browser profile rows, their on-disk directories and the one-run-at-a-time lease. Every lookup is org-scoped. */
export class ProfileStore {
  constructor(private readonly kernel: Kernel, private readonly org: OrgLookup) {}

  get(orgId: string, profileId: string): BrowserProfile {
    const row = this.kernel.db.select().from(browserProfiles)
      .where(and(eq(browserProfiles.orgId, orgId), eq(browserProfiles.id, profileId))).get();
    if (!row) throw notFound('browser profile', profileId);
    return row;
  }

  list(orgId: string): BrowserProfile[] {
    return this.kernel.db.select().from(browserProfiles)
      .where(eq(browserProfiles.orgId, orgId)).orderBy(asc(browserProfiles.createdAt), asc(browserProfiles.id)).all();
  }

  /** The agent's own profile, else its department's shared one, else a new one of its own. */
  ensure(orgId: string, agentId: string): BrowserProfile {
    const agent = this.org.getAgent(orgId, agentId);
    if (agent.orgId !== orgId) throw notFound('agent', agentId);
    const db = this.kernel.db;
    if (agent.browserProfileId) {
      const pinned = db.select().from(browserProfiles)
        .where(and(eq(browserProfiles.orgId, orgId), eq(browserProfiles.id, agent.browserProfileId))).get();
      // A pinned profile must be the agent's own or its department's — never someone else's.
      if (pinned && (pinned.agentId === agentId || (pinned.agentId === null && pinned.deptId === agent.deptId))) return pinned;
    }
    const own = db.select().from(browserProfiles)
      .where(and(eq(browserProfiles.orgId, orgId), eq(browserProfiles.agentId, agentId)))
      .orderBy(asc(browserProfiles.createdAt)).get();
    if (own) return own;
    const shared = db.select().from(browserProfiles)
      .where(and(eq(browserProfiles.orgId, orgId), eq(browserProfiles.deptId, agent.deptId), isNull(browserProfiles.agentId)))
      .orderBy(asc(browserProfiles.createdAt)).get();
    if (shared) return shared;
    const created = this.insert(orgId, { name: agent.name, agentId, deptId: null, slugBase: agent.slug, uniquify: true }, SYSTEM);
    this.revision(created, SYSTEM, 'created on first use');
    return created;
  }

  create(orgId: string, input: CreateProfileInput, actor: Actor): BrowserProfile {
    const v = parse(createSchema, input, 'browser profile');
    let agentId = v.agentId ?? null;
    let deptId = v.deptId ?? null;
    if (agentId) {
      const agent = this.org.getAgent(orgId, agentId);
      if (agent.orgId !== orgId) throw notFound('agent', agentId);
      agentId = agent.id;
    }
    if (deptId) {
      const dept = this.org.getDept(orgId, deptId);
      if (dept.orgId !== orgId) throw notFound('department', deptId);
      deptId = dept.id;
    }
    const profile = this.insert(orgId, {
      name: v.name, agentId, deptId, slugBase: slugify(v.name), uniquify: false,
      domainAllowlist: normalizePatterns(v.domainAllowlist ?? [], 'domainAllowlist'),
      sensitiveDomains: normalizePatterns(v.sensitiveDomains ?? [], 'sensitiveDomains'),
    }, actor);
    if (v.engine || v.headed !== undefined) {
      this.kernel.db.update(browserProfiles)
        .set({ ...(v.engine ? { engine: encodeEngine(v.engine) } : {}), ...(v.headed !== undefined ? { headed: v.headed } : {}) })
        .where(and(eq(browserProfiles.orgId, orgId), eq(browserProfiles.id, profile.id))).run();
    }
    this.writeFile(profile, v);
    const created = this.get(orgId, profile.id);
    this.revision(created, actor, 'created');
    return created;
  }

  /** Snapshot the profile's owner-editable config into `config_revisions`. */
  private revision(profile: BrowserProfile, actor: Actor, note: string): number {
    let settings: ProfileSettings;
    try {
      settings = this.settings(profile);
    } catch {
      settings = { engine: { kind: 'chromium' }, headed: profile.headed ?? null, onePasswordVaults: [] }; // unreadable side file: record the columns
    }
    return recordProfileRevision(this.kernel, profile.orgId, profile.id, {
      name: profile.name, slug: profile.slug, agentId: profile.agentId, deptId: profile.deptId,
      domainAllowlist: profile.domainAllowlist, sensitiveDomains: profile.sensitiveDomains,
      engine: { ...settings.engine }, headed: settings.headed, onePasswordVaults: settings.onePasswordVaults,
    }, actor, note);
  }

  /**
   * Restore the allowlists, engine, headed mode, vault allowlist and name
   * captured by `revision`. The restore is a new revision; the profile's
   * cookies, lease and on-disk directory are untouched.
   */
  rollback(orgId: string, profileId: string, revision: number, actor: Actor): BrowserProfile {
    if (actor.kind === 'agent') throw forbidden('agents may not roll back configuration; this is a board action');
    this.get(orgId, profileId);
    const { config } = readProfileRevision(this.kernel, orgId, profileId, revision);
    return this.update(orgId, profileId, {
      name: config.name, domainAllowlist: config.domainAllowlist, sensitiveDomains: config.sensitiveDomains,
      engine: parse(engineSchema, config.engine, 'browser engine'), headed: config.headed, onePasswordVaults: config.onePasswordVaults,
    }, actor, { rollbackTo: revision });
  }

  update(orgId: string, profileId: string, patch: UpdateProfileInput, actor: Actor, opts: { rollbackTo?: number } = {}): BrowserProfile {
    const v = parse(updateSchema, patch, 'browser profile');
    const before = this.get(orgId, profileId);
    const set: Partial<typeof browserProfiles.$inferInsert> = { updatedAt: this.kernel.clock.now() };
    if (v.name !== undefined) set.name = v.name;
    if (v.domainAllowlist !== undefined) set.domainAllowlist = normalizePatterns(v.domainAllowlist, 'domainAllowlist');
    if (v.sensitiveDomains !== undefined) set.sensitiveDomains = normalizePatterns(v.sensitiveDomains, 'sensitiveDomains');
    if (v.engine !== undefined) set.engine = encodeEngine(v.engine);
    if (v.headed !== undefined) set.headed = v.headed;
    this.kernel.db.update(browserProfiles).set(set)
      .where(and(eq(browserProfiles.orgId, orgId), eq(browserProfiles.id, profileId))).run();
    this.writeFile(before, v);
    const next = this.get(orgId, profileId);
    const revision = this.revision(next, actor, opts.rollbackTo ? `rollback to revision ${opts.rollbackTo}` : 'updated');
    this.kernel.audit.record({
      orgId, actor, action: opts.rollbackTo ? 'config.changed' : 'browser.profile_updated', entityKind: 'browser_profile', entityId: profileId,
      data: {
        changes: v, previous: { name: before.name, domainAllowlist: before.domainAllowlist, sensitiveDomains: before.sensitiveDomains }, revision,
        ...(opts.rollbackTo ? { change: 'rollback', rollbackTo: opts.rollbackTo } : {}),
      },
    });
    return next;
  }

  private insert(
    orgId: string,
    p: { name: string; agentId: string | null; deptId: string | null; slugBase: string; uniquify: boolean; domainAllowlist?: string[]; sensitiveDomains?: string[] },
    actor: Actor,
  ): BrowserProfile {
    const org = this.org.getOrg(orgId);
    const taken = new Set(this.list(orgId).map((r) => r.slug));
    let slug = p.slugBase;
    if (taken.has(slug)) {
      if (!p.uniquify) throw conflict(`a browser profile named "${slug}" already exists in this organization`);
      for (let n = 2; taken.has(slug); n++) slug = `${p.slugBase.slice(0, 58)}-${n}`;
    }
    const now = this.kernel.clock.now();
    const row: typeof browserProfiles.$inferInsert = {
      id: newId('browserProfile'), orgId, agentId: p.agentId, deptId: p.deptId, slug, name: p.name,
      userDataDir: this.kernel.paths.browserProfile(org.slug, slug),
      cookieVaultRef: `org/${org.slug}/browser/${slug}/cookie-key`,
      domainAllowlist: p.domainAllowlist ?? [], sensitiveDomains: p.sensitiveDomains ?? [],
      createdAt: now, updatedAt: now,
    };
    this.kernel.db.insert(browserProfiles).values(row).run();
    this.kernel.audit.record({
      orgId, actor, action: 'browser.profile_created', entityKind: 'browser_profile', entityId: row.id,
      data: { slug, name: p.name, agentId: p.agentId, deptId: p.deptId, domainAllowlist: row.domainAllowlist, sensitiveDomains: row.sensitiveDomains },
    });
    return this.get(orgId, row.id);
  }

  /** Profile directory, always re-derived from (org slug, profile slug) so a tampered row cannot point elsewhere. */
  dir(profile: BrowserProfile): string {
    const org = this.org.getOrg(profile.orgId);
    const dir = this.kernel.paths.browserProfile(org.slug, profile.slug);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  cookieVaultRef(profile: BrowserProfile): string {
    return `org/${this.org.getOrg(profile.orgId).slug}/browser/${profile.slug}/cookie-key`;
  }

  /** Per-profile cookie-jar key from the secret store. `create` mints it on first use. */
  async cookieKey(profile: BrowserProfile, create: boolean): Promise<string | null> {
    const ref = this.cookieVaultRef(profile);
    const existing = await this.kernel.secrets.get(ref);
    if (existing || !create) return existing;
    const key = newKey();
    await this.kernel.secrets.set(ref, key);
    return key;
  }

  private readFile(profile: BrowserProfile): z.infer<typeof fileSchema> {
    const file = join(this.dir(profile), ENGINE_FILE);
    if (!existsSync(file)) return {};
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      // The oldest files hold the bare engine object.
      return parse(fileSchema, raw && typeof raw === 'object' && 'kind' in raw ? { engine: raw } : raw, 'browser profile settings');
    } catch (e) {
      throw new ConductorError('validation', `browser profile ${profile.slug} has an invalid engine config: ${(e as Error).message}`);
    }
  }

  /**
   * Engine, headed mode and 1Password vault allowlist of a profile. Engine and
   * headed mode are columns; the vault allowlist (and the engine of profiles
   * that predate the column) sits in `<profileDir>/conductor-engine.json`.
   */
  settings(profile: BrowserProfile): ProfileSettings {
    const file = this.readFile(profile);
    let engine: EngineConfig;
    try {
      engine = decodeEngine(profile.engine);
    } catch (e) {
      throw new ConductorError('validation', `browser profile ${profile.slug} has an invalid engine config: ${(e as Error).message}`);
    }
    if (engine.kind === 'chromium' && file.engine) engine = file.engine;
    return { engine, headed: profile.headed ?? null, onePasswordVaults: file.onePasswordVaults ?? [] };
  }

  engine(profile: BrowserProfile): EngineConfig {
    return this.settings(profile).engine;
  }

  /** Keep the side file in step: vaults live there, and an engine written to the column supersedes a legacy one. */
  private writeFile(profile: BrowserProfile, patch: { engine?: EngineConfig; onePasswordVaults?: string[] }): void {
    if (patch.engine === undefined && patch.onePasswordVaults === undefined) return;
    let current: z.infer<typeof fileSchema>;
    try {
      current = this.readFile(profile);
    } catch {
      current = {}; // a corrupt file is replaced by the new, valid settings
    }
    const next = {
      ...(patch.engine === undefined && current.engine ? { engine: current.engine } : {}),
      onePasswordVaults: patch.onePasswordVaults ?? current.onePasswordVaults ?? [],
    };
    writeFileSync(join(this.dir(profile), ENGINE_FILE), JSON.stringify(next, null, 2), { mode: 0o600 });
  }

  /** Atomic conditional UPDATE: succeeds only when the profile is free or already leased to this run. */
  acquireLease(orgId: string, profileId: string, runId: string): void {
    const res = this.kernel.db.update(browserProfiles)
      .set({ leasedRunId: runId, leasedAt: this.kernel.clock.now() })
      .where(and(
        eq(browserProfiles.orgId, orgId), eq(browserProfiles.id, profileId),
        or(isNull(browserProfiles.leasedRunId), eq(browserProfiles.leasedRunId, runId)),
      )).run();
    if (res.changes === 1) return;
    const holder = this.get(orgId, profileId).leasedRunId;
    throw conflict(`browser profile in use by run ${holder ?? 'unknown'}; try again after that run finishes`, { profileId, leasedRunId: holder });
  }

  releaseLease(orgId: string, profileId: string, runId: string): void {
    this.kernel.db.update(browserProfiles).set({ leasedRunId: null, leasedAt: null })
      .where(and(eq(browserProfiles.orgId, orgId), eq(browserProfiles.id, profileId), eq(browserProfiles.leasedRunId, runId))).run();
  }

  /** Crash recovery across all orgs: clear leases whose run is no longer alive. Returns the dead run ids. */
  recoverLeases(liveRunIds: readonly string[]): string[] {
    const live = new Set(liveRunIds);
    const dead: string[] = [];
    const leased = this.kernel.db.select().from(browserProfiles).where(isNotNull(browserProfiles.leasedRunId)).all();
    for (const p of leased) {
      const runId = p.leasedRunId;
      if (!runId || live.has(runId)) continue;
      this.releaseLease(p.orgId, p.id, runId);
      this.kernel.audit.record({
        orgId: p.orgId, actor: SYSTEM, action: 'browser.lease_recovered', entityKind: 'browser_profile', entityId: p.id, data: { deadRunId: runId },
      });
      dead.push(runId);
    }
    return dead;
  }
}
