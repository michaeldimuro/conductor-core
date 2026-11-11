import type { Actor } from './types.js';

/**
 * Optional capability of a context whose owner-editable config is revisioned
 * in `config_revisions` (PRD "Governance": config changes are revisioned with
 * rollback). The org context implements the same idea through
 * `OrgService.rollback`; contexts added later (connectors, browser) expose it
 * through this interface, which the API detects at runtime with
 * `isRevisionedConfig` so older daemon builds keep working.
 */
export interface RevisionedConfig {
  /** `config_revisions.entity_kind` values this context can roll back. */
  readonly revisionKinds: readonly string[];
  /**
   * Restore the config captured by revision `revision` of the entity. The
   * restore is itself recorded as a new revision and audited as
   * `config.changed`; history is never rewritten. Board (owner) action only.
   * Unknown revision / entity of another org → `not_found`.
   */
  rollbackRevision(orgId: string, entityKind: string, entityId: string, revision: number, actor: Actor): Promise<void>;
}

export function isRevisionedConfig(value: unknown): value is RevisionedConfig {
  const v = value as Partial<RevisionedConfig> | null;
  return !!v && Array.isArray(v.revisionKinds) && typeof v.rollbackRevision === 'function';
}
