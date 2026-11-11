import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedSkillRef } from '../../contracts/adapter.js';
import { resolveInside } from '../../shared/paths.js';

const MARKER = '.conductor-managed';
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const AGENTS_BLOCK_BEGIN = '<!-- BEGIN CONDUCTOR MANAGED SKILLS — generated on every run, edits inside this block are overwritten -->';
export const AGENTS_BLOCK_END = '<!-- END CONDUCTOR MANAGED SKILLS -->';

function usable(skill: ResolvedSkillRef, warnings: string[]): boolean {
  if (!SAFE_NAME.test(skill.name) || skill.name.includes('..')) {
    warnings.push(`skill "${skill.name}" skipped: unsafe name`);
    return false;
  }
  try {
    if (statSync(skill.path).isDirectory()) return true;
  } catch {
    // reported below
  }
  warnings.push(`skill "${skill.name}" skipped: folder not found`);
  return false;
}

/**
 * Copy the run's skills into `<workspace>/.claude/skills/<name>/` so Claude
 * Code discovers them natively. Only folders Conductor created (marker file)
 * are replaced or pruned; a user's own skill of the same name is left alone.
 * Returns human-readable warnings.
 */
export function installClaudeSkills(workspace: string, skills: ResolvedSkillRef[]): string[] {
  const warnings: string[] = [];
  const root = resolveInside(workspace, join('.claude', 'skills'));
  mkdirSync(root, { recursive: true });
  const wanted = new Set<string>();

  for (const skill of skills) {
    if (!usable(skill, warnings)) continue;
    const dest = resolveInside(root, skill.name);
    if (existsSync(dest) && !existsSync(join(dest, MARKER))) {
      warnings.push(`skill "${skill.name}" not installed: ${dest} exists and is not managed by Conductor`);
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    cpSync(skill.path, dest, { recursive: true, dereference: false });
    writeFileSync(join(dest, MARKER), `${skill.id}@${skill.version}\n`);
    wanted.add(skill.name);
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || wanted.has(entry.name)) continue;
    const dir = join(root, entry.name);
    if (existsSync(join(dir, MARKER))) rmSync(dir, { recursive: true, force: true });
  }
  return warnings;
}

function stripFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body.trim();
  const end = body.indexOf('\n---', 3);
  if (end < 0) return body.trim();
  const after = body.indexOf('\n', end + 1);
  return (after < 0 ? '' : body.slice(after + 1)).trim();
}

/** The managed block: a skill index followed by each skill's instructions. */
export function renderAgentsSkillsBlock(skills: ResolvedSkillRef[], warnings: string[] = []): string {
  const usableSkills = skills.filter((s) => usable(s, warnings));
  const lines: string[] = [AGENTS_BLOCK_BEGIN, '', '## Conductor skills', ''];
  if (usableSkills.length === 0) {
    lines.push('No skills are assigned to this agent for this run.', '');
  } else {
    lines.push('Skills are reusable procedures. Use the index to decide which apply to the task, then follow that skill\'s section.', '', '### Index', '');
    for (const s of usableSkills) lines.push(`- **${s.name}** (${s.scope}, v${s.version}): ${s.description.replace(/\s+/g, ' ').trim()}`);
    lines.push('');
    for (const s of usableSkills) {
      let body = '';
      try {
        body = stripFrontmatter(readFileSync(join(s.path, 'SKILL.md'), 'utf8'));
      } catch {
        warnings.push(`skill "${s.name}": SKILL.md could not be read`);
      }
      lines.push(`### Skill: ${s.name}`, '');
      if (s.hasScripts) lines.push(`Supporting files for this skill are in \`${s.path}\`.`, '');
      lines.push(body || '_No instructions available._', '');
    }
  }
  lines.push(AGENTS_BLOCK_END);
  return lines.join('\n');
}

/**
 * Write the skills into `<workspace>/AGENTS.md` (what Codex reads). The block
 * between the markers is replaced on each run; everything else in the file is
 * preserved byte for byte.
 */
export function writeAgentsSkills(workspace: string, skills: ResolvedSkillRef[]): string[] {
  const warnings: string[] = [];
  const file = resolveInside(workspace, 'AGENTS.md');
  const block = renderAgentsSkillsBlock(skills, warnings);
  let existing = '';
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    // no AGENTS.md yet
  }
  const start = existing.indexOf(AGENTS_BLOCK_BEGIN);
  const end = start >= 0 ? existing.indexOf(AGENTS_BLOCK_END, start) : -1;
  let next: string;
  if (start >= 0 && end >= 0) {
    next = existing.slice(0, start) + block + existing.slice(end + AGENTS_BLOCK_END.length);
  } else if (existing.trim().length === 0) {
    next = `${block}\n`;
  } else {
    next = `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
  }
  if (next !== existing) writeFileSync(file, next);
  return warnings;
}
