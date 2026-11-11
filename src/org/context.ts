import type { Kernel } from '../contracts/kernel.js';
import type { Actor } from '../contracts/types.js';
import type { ApprovalService, MemoryService, SkillService } from '../contracts/services.js';
import { forbidden } from '../shared/errors.js';

export interface OrgImportDeps {
  skills?: Pick<SkillService, 'upsert'>;
  memory?: Pick<MemoryService, 'write'>;
}

export interface OrgDeps extends OrgImportDeps {
  approvals: ApprovalService;
}

/**
 * Unit-of-work shared by the org modules. `mutate` runs a function in one
 * SQLite transaction; `after` defers side effects (bus events, mkdir) until the
 * transaction has committed so subscribers never observe uncommitted state.
 */
export interface Ctx {
  kernel: Kernel;
  deps: OrgDeps;
  mutate<T>(fn: () => T): T;
  after(fn: () => void): void;
}

export function createCtx(kernel: Kernel, deps: OrgDeps): Ctx {
  let pending: Array<() => void> = [];
  let depth = 0;

  const flush = (): void => {
    const effects = pending;
    pending = [];
    for (const effect of effects) {
      try {
        effect();
      } catch (err) {
        kernel.log.error({ err }, 'org post-commit effect failed');
      }
    }
  };

  return {
    kernel,
    deps,
    mutate<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      let result: T;
      try {
        // A caller may already hold a transaction on the shared connection.
        result = kernel.sqlite.inTransaction ? fn() : kernel.db.transaction(() => fn());
      } catch (e) {
        pending = [];
        throw e;
      } finally {
        depth--;
      }
      flush();
      return result;
    },
    after(fn: () => void): void {
      if (depth > 0) pending.push(fn);
      else fn();
    },
  };
}

/** "human:owner", "agent:agt_…", "system:conductor" — the revision author label. */
export function actorLabel(actor: Actor): string {
  return `${actor.kind}:${actor.id ?? ''}`;
}

/** Org structure and config are board-controlled: only the owner (or the system) may change them. */
export function assertBoard(actor: Actor, what: string): void {
  if (actor.kind === 'agent') {
    throw forbidden(`agents may not ${what}; this is a board action`, { actor: actor.id });
  }
}
