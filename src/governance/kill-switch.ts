import { eq } from 'drizzle-orm';
import { organizations } from '../db/schema/index.js';
import type { Kernel } from '../contracts/kernel.js';
import type { KillSwitch } from '../contracts/services.js';
import type { Actor } from '../contracts/types.js';
import { forbidden, invalid } from '../shared/errors.js';
import { requireOrg, type SettingsStore } from './store.js';

export const GLOBAL_KILL_SWITCH_KEY = 'kill_switch.global';

/** Per-org (`organizations.kill_switch`) and global (`settings`) emergency stop. */
export class KillSwitchService implements KillSwitch {
  constructor(
    private readonly k: Kernel,
    private readonly settings: SettingsStore,
  ) {}

  engage(orgId: string | null, actor: Actor): void {
    this.set(orgId, true, actor);
  }

  release(orgId: string | null, actor: Actor): void {
    // Anyone may pull the brake; only the board (or the system on its behalf) may let go of it.
    if (actor?.kind === 'agent') throw forbidden('agents cannot release a kill switch');
    this.set(orgId, false, actor);
  }

  private set(orgId: string | null, engaged: boolean, actor: Actor): void {
    if (!actor || typeof actor.kind !== 'string') throw invalid('actor is required');
    if (orgId === null) {
      this.settings.set(GLOBAL_KILL_SWITCH_KEY, engaged);
    } else {
      requireOrg(this.k, orgId);
      this.k.db.update(organizations).set({ killSwitch: engaged }).where(eq(organizations.id, orgId)).run();
    }
    this.k.audit.record({
      orgId,
      actor,
      action: engaged ? 'kill_switch.engaged' : 'kill_switch.released',
      entityKind: orgId === null ? 'install' : 'org',
      entityId: orgId ?? 'global',
      data: { scope: orgId === null ? 'global' : 'org' },
    });
    this.k.bus.emit('org.kill_switch', { orgId, engaged });
  }

  isEngaged(orgId: string): boolean {
    if (this.globalEngaged()) return true;
    const row = this.k.db.select({ on: organizations.killSwitch }).from(organizations).where(eq(organizations.id, orgId)).get();
    return row?.on === true;
  }

  globalEngaged(): boolean {
    return this.settings.get<unknown>(GLOBAL_KILL_SWITCH_KEY) === true;
  }
}
