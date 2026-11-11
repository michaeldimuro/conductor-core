import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createServices } from '../../src/daemon/compose.js';
import { MemorySecretStore } from '../../src/kernel/index.js';
import { settings } from '../../src/db/schema/index.js';

/** Links sent to a phone (pairing, takeover) must follow `daemon.public_url` as soon as it is set. */
describe('public URL', () => {
  const homes: string[] = [];
  const services: Array<Awaited<ReturnType<typeof createServices>>> = [];
  afterEach(async () => {
    for (const s of services.splice(0)) await s.close();
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
  const start = async (config: { port: number; publicUrl?: string }) => {
    const home = mkdtempSync(join(tmpdir(), 'conductor-public-url-'));
    homes.push(home);
    const s = await createServices({ home, secrets: new MemorySecretStore(), config, runtime: { powerAssertion: false, tickMs: 0, systemJobs: false } });
    services.push(s);
    return s;
  };
  // As the settings API does: a value is upserted, null clears the row.
  const set = (s: Awaited<ReturnType<typeof createServices>>, value: string | null) => {
    if (value === null) s.kernel.db.delete(settings).where(eq(settings.key, 'daemon.public_url')).run();
    else s.kernel.db.insert(settings).values({ key: 'daemon.public_url', value, updatedAt: 1 }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: 2 } }).run();
  };

  it('follows the stored setting without a restart', async () => {
    const s = await start({ port: 7999 });
    expect(s.publicUrl()).toBe('http://127.0.0.1:7999');
    set(s, 'https://mac.tailnet.ts.net/');
    expect(s.publicUrl()).toBe('https://mac.tailnet.ts.net');
    set(s, null);
    expect(s.publicUrl()).toBe('http://127.0.0.1:7999');
  });

  it('an explicit URL (option or CONDUCTOR_PUBLIC_URL) wins over the setting', async () => {
    const s = await start({ port: 7999, publicUrl: 'https://pinned.example' });
    set(s, 'https://mac.tailnet.ts.net');
    expect(s.publicUrl()).toBe('https://pinned.example');
  });
});
