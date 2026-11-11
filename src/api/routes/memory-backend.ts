import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Services } from '../../daemon/container.js';
import type { ExternalBackendConfig, ExternalBackendStatus } from '../../contracts/services.js';
import { OWNER } from '../../contracts/types.js';
import { settings } from '../../db/schema/index.js';
import { body, orgOf } from '../http.js';
import { memoryBackend } from '../schemas/capabilities.js';

/** Where the memory context reads the org's external backend from. */
export const memoryBackendKey = (orgId: string): string => `memory.backend.${orgId}`;

/**
 * Per-org external memory backend (Honcho, Mem0, Zep, Supermemory). The
 * memory service owns the setting; when a daemon build does not expose the
 * accessors the same `settings["memory.backend.<orgId>"]` row is used directly.
 * Only a secret *reference* is ever stored or returned.
 */
export function memoryBackendRoutes(app: FastifyInstance, s: Services): void {
  const { db, clock, audit, secrets } = s.kernel;
  const key = memoryBackendKey;

  async function read(orgId: string): Promise<ExternalBackendStatus | null> {
    if (s.memory.getExternalBackend) return s.memory.getExternalBackend(orgId);
    const parsed = memoryBackend.safeParse(db.select().from(settings).where(eq(settings.key, key(orgId))).get()?.value);
    if (!parsed.success) return null;
    return { ...parsed.data, ready: await secrets.has(parsed.data.authRef).catch(() => false) };
  }

  async function write(orgId: string, config: ExternalBackendConfig | null): Promise<ExternalBackendStatus | null> {
    if (s.memory.setExternalBackend) return s.memory.setExternalBackend(orgId, config, OWNER);
    if (config === null) db.delete(settings).where(eq(settings.key, key(orgId))).run();
    else {
      const now = clock.now();
      db.insert(settings).values({ key: key(orgId), value: config, updatedAt: now }).onConflictDoUpdate({ target: settings.key, set: { value: config, updatedAt: now } }).run();
    }
    audit.record({
      orgId, actor: OWNER, action: 'config.changed', entityKind: 'setting', entityId: key(orgId),
      data: config ? { kind: config.kind, baseUrl: config.baseUrl ?? null, authRef: config.authRef } : { cleared: true },
    });
    return read(orgId);
  }

  app.get('/orgs/:orgId/memory-backend', async (req): Promise<{ backend: ExternalBackendStatus | null }> => ({ backend: await read(orgOf(s, req).id) }));
  app.put('/orgs/:orgId/memory-backend', async (req): Promise<{ backend: ExternalBackendStatus | null }> => {
    const orgId = orgOf(s, req).id;
    return { backend: await write(orgId, body(req, memoryBackend)) };
  });
  app.delete('/orgs/:orgId/memory-backend', async (req): Promise<{ backend: null }> => {
    await write(orgOf(s, req).id, null);
    return { backend: null };
  });
}
