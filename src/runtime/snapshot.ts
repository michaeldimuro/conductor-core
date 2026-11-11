import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ResolvedSkillRef } from '../contracts/adapter.js';
import type { RuntimeDeps } from './types.js';

/** Deterministic sha256 of a skill folder (relative paths + bytes of its regular files). '' when unreadable. */
export function hashSkillFolder(dir: string): string {
  try {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const abs = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== '.git') walk(abs);
        } else if (e.isFile() && lstatSync(abs).isFile()) {
          files.push(relative(dir, abs).split(sep).join('/'));
        }
      }
    };
    walk(dir);
    const h = createHash('sha256');
    for (const rel of files.sort()) {
      const bytes = readFileSync(join(dir, rel));
      h.update(`${rel}\0${bytes.length}\0`);
      h.update(bytes);
    }
    return h.digest('hex');
  } catch {
    return '';
  }
}

/**
 * Content hash for the capability snapshot: what exactly the run was given.
 * The skill registry's recorded hash is used when it describes the same
 * version; otherwise (eval of an unpublished version, registry miss) the
 * folder handed to the run is hashed.
 */
export function skillContentHash(skills: RuntimeDeps['skills'], ref: ResolvedSkillRef): string {
  try {
    const row = skills.get(ref.id);
    if (row && row.version === ref.version && typeof row.contentHash === 'string' && row.contentHash) return row.contentHash;
  } catch {
    // not in the registry (ad-hoc eval skill): hash the folder
  }
  return hashSkillFolder(ref.path);
}
