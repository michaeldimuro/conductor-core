import { watch, type FSWatcher } from 'node:fs';
import type { AdapterRescanResult } from '../contracts/adapter.js';
import type { Logger } from '../shared/util.js';

/**
 * Watch the adapter plugin directory and rescan (debounced) when something
 * is dropped into or removed from it, so a third-party adapter installs
 * without restarting the daemon. Best effort: if watching is not possible,
 * `rescan` is still available through the API/CLI.
 */
export function watchAdapterPlugins(opts: {
  pluginDir: string;
  rescan: () => Promise<AdapterRescanResult>;
  log: Pick<Logger, 'info' | 'warn'>;
  debounceMs?: number;
}): { close(): void } {
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  let closed = false;
  const fire = (): void => {
    timer = null;
    if (closed) return;
    opts.rescan().then(
      (r) => {
        if (r.added.length > 0 || r.removed.length > 0) opts.log.info({ added: r.added, removed: r.removed, skipped: r.skipped.length }, 'adapter plugins changed');
      },
      (err: unknown) => opts.log.warn({ err }, 'adapter plugin rescan failed'),
    );
  };
  try {
    watcher = watch(opts.pluginDir, { recursive: true, persistent: false }, (_event, file) => {
      // Our own SDK symlink lives in node_modules; reacting to it would loop.
      if (closed || (typeof file === 'string' && file.split(/[\\/]/)[0] === 'node_modules')) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, opts.debounceMs ?? 750);
      timer.unref();
    });
    watcher.on('error', (err) => opts.log.warn({ err }, 'adapter plugin watcher failed'));
  } catch (err) {
    opts.log.warn({ err }, 'cannot watch the adapter plugin directory; use `conductor adapter rescan` after installing a plugin');
  }
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}
