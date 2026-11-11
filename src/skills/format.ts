import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { invalid } from '../shared/errors.js';
import { resolveInside } from '../shared/paths.js';

/**
 * The open Agent Skills folder format (Claude Code / Codex / Hermes):
 *   <skill-name>/SKILL.md   YAML front matter (name, description, …) + instructions
 *   <skill-name>/scripts/ references/ assets/   optional supporting files
 */
export const SKILL_FILE = 'SKILL.md';
/** `evals/` holds the skill's explicit eval cases (`evals/cases.json|yaml`). */
export const SKILL_SUBDIRS = ['scripts', 'references', 'assets', 'evals'] as const;
export const MAX_NAME_LEN = 64;
export const MAX_DESCRIPTION_LEN = 1024;
export const MAX_BODY_CHARS = 100_000;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_FILES = 64;

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IGNORED_ENTRIES = new Set(['.git', '.DS_Store']);

export function assertSkillName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LEN || !NAME_RE.test(name)) {
    throw invalid(`invalid skill name: must be lowercase [a-z0-9-], at most ${MAX_NAME_LEN} chars`, { name: String(name).slice(0, 80) });
  }
  return name;
}

export function assertDescription(description: unknown): string {
  if (typeof description !== 'string' || description.trim().length === 0) throw invalid('skill description is required');
  const d = description.trim();
  if (d.length > MAX_DESCRIPTION_LEN) throw invalid(`skill description exceeds ${MAX_DESCRIPTION_LEN} chars`);
  return d;
}

/**
 * Validate a supporting-file key (relative path → content). Only files under
 * scripts/, references/, assets/ or evals/ are accepted; traversal is rejected.
 */
export function assertFileKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256 || key.includes('\\') || key.includes('\0') || key.startsWith('/')) {
    throw invalid(`unsafe skill file path: ${String(key).slice(0, 80)}`);
  }
  const segments = key.split('/');
  if (segments.length < 2 || segments.some((s) => !SEGMENT_RE.test(s) || s.includes('..'))) {
    throw invalid(`unsafe skill file path: ${key.slice(0, 80)}`);
  }
  if (!(SKILL_SUBDIRS as readonly string[]).includes(segments[0] ?? '')) {
    throw invalid(`skill files must live under ${SKILL_SUBDIRS.join('/, ')}/: ${key.slice(0, 80)}`);
  }
  return segments.join('/');
}

export function assertFiles(files: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!files) return out;
  const keys = Object.keys(files);
  if (keys.length > MAX_FILES) throw invalid(`too many skill files (max ${MAX_FILES})`);
  for (const key of keys) {
    const content = files[key];
    if (typeof content !== 'string') throw invalid(`skill file content must be a string: ${key.slice(0, 80)}`);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw invalid(`skill file too large: ${key.slice(0, 80)}`);
    out[assertFileKey(key)] = content;
  }
  return out;
}

export interface ParsedSkill {
  frontMatter: Record<string, unknown>;
  name: string | null;
  description: string | null;
  body: string;
}

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

export function parseSkillMd(text: string): ParsedSkill {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = FRONT_MATTER_RE.exec(src);
  if (!m) throw invalid('SKILL.md must start with YAML front matter (--- name / description ---)');
  let fm: unknown;
  try {
    fm = parseYaml(m[1] ?? '');
  } catch (e) {
    throw invalid(`SKILL.md front matter is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) throw invalid('SKILL.md front matter must be a YAML mapping');
  const frontMatter = fm as Record<string, unknown>;
  return {
    frontMatter,
    name: typeof frontMatter.name === 'string' ? frontMatter.name : null,
    description: typeof frontMatter.description === 'string' ? frontMatter.description.trim() : null,
    body: (m[2] ?? '').replace(/^\s*\n/, ''),
  };
}

/** Serialize SKILL.md; `name` and `description` always lead the front matter, other keys are preserved. */
export function renderSkillMd(input: { name: string; description: string; body: string; frontMatter?: Record<string, unknown> }): string {
  const { name: _n, description: _d, ...rest } = input.frontMatter ?? {};
  const fm = stringifyYaml({ name: input.name, description: input.description, ...rest }, { lineWidth: 0 });
  return `---\n${fm}---\n\n${input.body.trim()}\n`;
}

export function readSkillMd(dir: string): ParsedSkill {
  const file = join(dir, SKILL_FILE);
  if (!existsSync(file)) throw invalid(`${SKILL_FILE} not found in skill folder`);
  return parseSkillMd(readFileSync(file, 'utf8'));
}

/** Relative POSIX paths of every regular file in the folder (sorted; symlinks, .git and .DS_Store skipped). */
export function listSkillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORED_ENTRIES.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(join(abs, e.name), childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** Deterministic hash of the folder contents (paths + bytes). A missing folder hashes to "missing". */
export function hashSkillDir(dir: string): string {
  if (!existsSync(dir)) return 'missing';
  const h = createHash('sha256');
  for (const rel of listSkillFiles(dir)) {
    const bytes = readFileSync(join(dir, rel));
    h.update(`${rel}\0${bytes.length}\0`);
    h.update(bytes);
  }
  return h.digest('hex');
}

/** Write SKILL.md plus supporting files into the skill folder; every path goes through resolveInside. */
export function writeSkillFiles(dir: string, skillMd: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolveInside(dir, SKILL_FILE), skillMd, 'utf8');
  for (const [key, content] of Object.entries(files)) {
    const dest = resolveInside(dir, assertFileKey(key));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, 'utf8');
  }
}

/** Copy a skill folder (regular files only) into `destDir`, replacing whatever was there. */
export function copySkillDir(sourceDir: string, destDir: string, limits: { maxFiles: number; maxBytes: number }): void {
  const files = listSkillFiles(sourceDir);
  if (files.length > limits.maxFiles) throw invalid(`skill folder has too many files (max ${limits.maxFiles})`);
  let total = 0;
  for (const rel of files) total += lstatSync(join(sourceDir, rel)).size;
  if (total > limits.maxBytes) throw invalid(`skill folder is too large (max ${limits.maxBytes} bytes)`);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const rel of files) {
    const dest = resolveInside(destDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(sourceDir, rel), dest);
  }
}

export function oneLine(text: string, max = 200): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
