import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Kernel } from '../contracts/kernel.js';
import type { ConfigRevision } from '../contracts/rows.js';
import type { Actor } from '../contracts/types.js';
import { configRevisions } from '../db/schema/index.js';
import { invalid, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';

/** `config_revisions.entity_kind` of a browser profile. */
export const BROWSER_PROFILE_KIND = 'browser_profile';

/**
 * The owner-editable part of a browser profile: its name, where it may go
 * (domain allowlist), where clicks need approval (sensitive domains), which
 * browser backs it, headed mode and the 1Password vault allowlist. Never the
 * cookie-jar key or anything else from the secret store.
 */
export interface ProfileSnapshot {
  name: string;
  slug: string;
  agentId: string | null;
  deptId: string | null;
  domainAllowlist: string[];
  sensitiveDomains: string[];
  engine: Record<string, unknown>;
  headed: boolean | null;
  onePasswordVaults: string[];
}

const snapshotSchema = z.object({
  name: z.string().min(1),
  domainAllowlist: z.array(z.string()).default([]),
  sensitiveDomains: z.array(z.string()).default([]),
  engine: z.record(z.string(), z.unknown()).default({ kind: 'chromium' }),
  headed: z.boolean().nullish().transform((v) => v ?? null),
  onePasswordVaults: z.array(z.string()).default([]),
});
export type RestorableProfile = z.output<typeof snapshotSchema>;

/** Append a revision of a profile's config (monotonic per profile). Returns the revision number. */
export function recordProfileRevision(k: Kernel, orgId: string, profileId: string, snapshot: ProfileSnapshot, actor: Actor, note: string): number {
  const last = k.db.select({ revision: configRevisions.revision }).from(configRevisions)
    .where(and(eq(configRevisions.entityKind, BROWSER_PROFILE_KIND), eq(configRevisions.entityId, profileId)))
    .orderBy(desc(configRevisions.revision)).get();
  const revision = (last?.revision ?? 0) + 1;
  k.db.insert(configRevisions).values({
    id: newId('revision'), orgId, entityKind: BROWSER_PROFILE_KIND, entityId: profileId, revision,
    snapshot: { ...snapshot }, author: `${actor.kind}:${actor.id ?? ''}`, note, ts: k.clock.now(),
  }).run();
  return revision;
}

/** The config a stored revision restores. Unknown revision (or one of another org) → not_found. */
export function readProfileRevision(k: Kernel, orgId: string, profileId: string, revision: number): { rev: ConfigRevision; config: RestorableProfile } {
  const rev = k.db.select().from(configRevisions).where(and(
    eq(configRevisions.orgId, orgId), eq(configRevisions.entityKind, BROWSER_PROFILE_KIND),
    eq(configRevisions.entityId, profileId), eq(configRevisions.revision, revision),
  )).get();
  if (!rev) throw notFound('browser_profile revision', `${profileId}@${revision}`);
  const parsed = snapshotSchema.safeParse(rev.snapshot);
  if (!parsed.success) throw invalid(`revision ${revision} of browser profile ${profileId} cannot be restored: snapshot is malformed`);
  return { rev, config: parsed.data };
}
