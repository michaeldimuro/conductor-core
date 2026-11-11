import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chromium keeps cookies, web storage, saved logins and cached page bodies in
 * the user-data-dir in the clear (Playwright runs it with a mock keychain).
 * While no session is live the only copy Conductor keeps is the AES-256-GCM
 * storage-state jar (`cookies.enc`), so these stores are removed on close and
 * rebuilt from the jar on the next launch.
 */
const PROFILE_STORES = [
  'Cookies', 'Cookies-journal', 'Extension Cookies', 'Extension Cookies-journal', 'Safe Browsing Cookies', 'Safe Browsing Cookies-journal',
  join('Network', 'Cookies'), join('Network', 'Cookies-journal'), join('Network', 'Trust Tokens'), join('Network', 'Trust Tokens-journal'),
  'Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'Service Worker', 'Sessions', 'File System', 'databases',
  'Login Data', 'Login Data-journal', 'Login Data For Account', 'Login Data For Account-journal', 'Web Data', 'Web Data-journal',
  'Cache', 'Code Cache',
] as const;

/** `Default`, `Profile N` … every Chromium profile directory inside a user-data-dir. */
function chromiumProfileDirs(userDataDir: string): string[] {
  if (!existsSync(userDataDir)) return [];
  return readdirSync(userDataDir)
    .filter((name) => name === 'Default' || /^Profile \d+$/.test(name) || name === 'Guest Profile')
    .map((name) => join(userDataDir, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

/** Paths of the plaintext credential stores that currently exist under a user-data-dir. */
export function plaintextStores(userDataDir: string): string[] {
  return chromiumProfileDirs(userDataDir).flatMap((dir) => PROFILE_STORES.map((s) => join(dir, s)).filter((p) => existsSync(p)));
}

/**
 * Remove every plaintext credential store. Call only after the browser has
 * exited and the encrypted jar was written. Returns what could not be removed.
 */
export function scrubPlaintextStores(userDataDir: string): { removed: number; failed: string[] } {
  let removed = 0;
  const failed: string[] = [];
  for (const path of plaintextStores(userDataDir)) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      removed += 1;
    } catch {
      failed.push(path);
    }
  }
  return { removed, failed };
}
