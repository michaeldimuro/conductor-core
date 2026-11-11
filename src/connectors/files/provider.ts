import { lstatSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Kernel } from '../../contracts/kernel.js';
import { jsonResult, textResult, type BuiltinToolProvider, type ToolCallContext, type ToolDef, type ToolResult } from '../../contracts/tools.js';
import { organizations } from '../../db/schema/index.js';
import { invalid, notFound } from '../../shared/errors.js';
import { resolveInside } from '../../shared/paths.js';
import { parseWith } from '../config.js';
import { runSandboxed } from './sandbox.js';

const MAX_READ_BYTES = 512_000;
const MAX_WRITE_BYTES = 5_000_000;
const MAX_LIST = 1000;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 64_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const inside = (root: string, p: string): boolean => p === root || p.startsWith(root + sep);

/** The real workspace root; every file tool is confined to it. */
function workspaceRoot(ctx: ToolCallContext): string {
  try {
    const root = realpathSync(ctx.workspacePath);
    if (!lstatSync(root).isDirectory()) throw new Error('not a directory');
    return root;
  } catch {
    throw invalid('this run has no workspace directory');
  }
}

/**
 * Resolve `p` inside the workspace. Lexical traversal is refused by
 * `resolveInside`; symlink escapes are refused by resolving the deepest
 * existing ancestor with realpath (a dangling symlink is refused outright).
 */
export function confine(root: string, raw: string, workspacePath?: string): string {
  let p = raw;
  if (isAbsolute(p) && workspacePath) {
    // Accept absolute paths spelled through the unresolved workspace path.
    const lexical = resolve(workspacePath);
    if (inside(lexical, resolve(p))) p = relative(lexical, resolve(p)) || '.';
  }
  const abs = resolveInside(root, p);
  let probe = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(probe);
      break;
    } catch {
      if (probe === root) break;
      tail.unshift(basename(probe));
      probe = dirname(probe);
    }
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    throw invalid(`path escapes workspace (broken symlink): ${raw}`);
  }
  if (!inside(root, real)) throw invalid(`path escapes workspace: ${raw}`);
  return join(real, ...tail);
}

const readArgs = z.object({ path: z.string().min(1), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(20_000).optional() });
const writeArgs = z.object({ path: z.string().min(1), content: z.string().max(MAX_WRITE_BYTES), append: z.boolean().optional() });
const listArgs = z.object({ path: z.string().min(1).optional() });
const searchArgs = z.object({
  query: z.string().min(1).max(500),
  path: z.string().min(1).optional(),
  regex: z.boolean().optional(),
  glob: z.string().min(1).max(200).optional(),
  maxResults: z.number().int().min(1).max(500).optional(),
});
const runArgs = z.object({ command: z.string().min(1).max(20_000), cwd: z.string().min(1).optional(), timeoutMs: z.number().int().min(100).max(600_000).optional() });

const TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a text file from your workspace. Optional 1-based line offset and line limit.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } }, required: ['path'] },
    risk: 'read',
  },
  {
    name: 'write_file',
    description: 'Create or overwrite (or append to) a file in your workspace. Parent directories are created.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] },
    risk: 'write',
  },
  {
    name: 'list_dir',
    description: 'List a directory in your workspace (default: the workspace root).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    risk: 'read',
  },
  {
    name: 'search_files',
    description: 'Search file contents in your workspace for a string (or regex). Optional sub-path and file-name glob such as "*.ts".',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, path: { type: 'string' }, regex: { type: 'boolean' }, glob: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: 500 } },
      required: ['query'],
    },
    risk: 'read',
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in your workspace inside a sandbox: it can read and write only the workspace and a temp dir, ' +
      'and has no network access unless the organization allows it. Returns exit code, stdout and stderr.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 } }, required: ['command'] },
    risk: 'high',
  },
];

async function readFileTool(ctx: ToolCallContext, raw: unknown): Promise<ToolResult> {
  const args = parseWith(readArgs, raw, 'read_file arguments');
  const file = confine(workspaceRoot(ctx), args.path, ctx.workspacePath);
  const info = await stat(file).catch(() => null);
  if (!info) throw notFound('file', args.path);
  if (!info.isFile()) throw invalid(`${args.path} is not a file`);
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const data = buf.subarray(0, bytesRead);
    if (data.includes(0)) return textResult(`[binary file, ${info.size} bytes]`);
    let text = data.toString('utf8');
    if (args.offset !== undefined || args.limit !== undefined) {
      const start = (args.offset ?? 1) - 1;
      text = text.split('\n').slice(start, args.limit !== undefined ? start + args.limit : undefined).join('\n');
    }
    return textResult(info.size > MAX_READ_BYTES ? `${text}\n[truncated: file is ${info.size} bytes, showing the first ${MAX_READ_BYTES}]` : text);
  } finally {
    await handle.close();
  }
}

async function writeFileTool(ctx: ToolCallContext, raw: unknown): Promise<ToolResult> {
  const args = parseWith(writeArgs, raw, 'write_file arguments');
  const root = workspaceRoot(ctx);
  const file = confine(root, args.path, ctx.workspacePath);
  if (file === root) throw invalid('path is the workspace root');
  await mkdir(dirname(file), { recursive: true });
  // Re-check after creating parents: nothing on the way may have become a link out of the workspace.
  const checked = confine(root, relative(root, file));
  if (args.append) await appendFile(checked, args.content, 'utf8');
  else await writeFile(checked, args.content, 'utf8');
  return textResult(`${args.append ? 'Appended' : 'Wrote'} ${Buffer.byteLength(args.content)} bytes to ${relative(root, checked)}`);
}

async function listDirTool(ctx: ToolCallContext, raw: unknown): Promise<ToolResult> {
  const args = parseWith(listArgs, raw ?? {}, 'list_dir arguments');
  const root = workspaceRoot(ctx);
  const dir = confine(root, args.path ?? '.', ctx.workspacePath);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) throw notFound('directory', args.path ?? '.');
  const rows = await Promise.all(
    entries.slice(0, MAX_LIST).map(async (e) => {
      const type = e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : e.isFile() ? 'file' : 'other';
      const size = type === 'file' ? ((await stat(join(dir, e.name)).catch(() => null))?.size ?? 0) : undefined;
      return { name: e.name, type, ...(size !== undefined ? { size } : {}) };
    }),
  );
  return jsonResult({ path: relative(root, dir) || '.', entries: rows.sort((a, b) => a.name.localeCompare(b.name)), truncated: entries.length > MAX_LIST });
}

function globMatcher(glob: string | undefined): (name: string) => boolean {
  if (!glob) return () => true;
  const re = new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return (name) => re.test(name);
}

async function searchFilesTool(ctx: ToolCallContext, raw: unknown): Promise<ToolResult> {
  const args = parseWith(searchArgs, raw, 'search_files arguments');
  const root = workspaceRoot(ctx);
  const start = confine(root, args.path ?? '.', ctx.workspacePath);
  let test: (line: string) => boolean;
  if (args.regex) {
    let re: RegExp;
    try {
      re = new RegExp(args.query);
    } catch {
      throw invalid('query is not a valid regular expression');
    }
    test = (line) => re.test(line);
  } else {
    const needle = args.query.toLowerCase();
    test = (line) => line.toLowerCase().includes(needle);
  }
  const nameOk = globMatcher(args.glob);
  const max = args.maxResults ?? 100;
  const matches: string[] = [];
  let scanned = 0;
  // Symlinks are never followed, so the walk cannot leave the workspace.
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (matches.length >= max || scanned >= MAX_SEARCH_FILES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile() && nameOk(e.name)) {
        scanned++;
        const info = await stat(full).catch(() => null);
        if (!info || info.size > MAX_SEARCH_FILE_BYTES) continue;
        const handle = await open(full, 'r').catch(() => null);
        if (!handle) continue;
        const data = await handle.readFile().finally(() => handle.close());
        if (data.includes(0)) continue;
        const lines = data.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && matches.length < max; i++) {
          const line = lines[i]!.slice(0, 2000);
          if (test(line)) matches.push(`${relative(root, full)}:${i + 1}: ${line.trim().slice(0, 300)}`);
        }
      }
    }
  };
  const info = await stat(start).catch(() => null);
  if (!info?.isDirectory()) throw notFound('directory', args.path ?? '.');
  await walk(start);
  return textResult(matches.length ? matches.join('\n') : 'No matches.');
}

async function runCommandTool(k: Kernel, ctx: ToolCallContext, raw: unknown): Promise<ToolResult> {
  const args = parseWith(runArgs, raw, 'run_command arguments');
  const root = workspaceRoot(ctx);
  const cwd = confine(root, args.cwd ?? '.', ctx.workspacePath);
  if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw notFound('directory', args.cwd ?? '.');
  const org = k.db.select({ policies: organizations.policies }).from(organizations).where(eq(organizations.id, ctx.orgId)).get();
  // Org policy: no entry = no network; otherwise only these hosts, enforced by the sandbox's egress proxy.
  const networkAllowlist = Array.isArray(org?.policies?.networkAllowlist) ? org.policies.networkAllowlist.filter((h): h is string => typeof h === 'string') : [];
  const r = await runSandboxed({ command: args.command, workspace: root, cwd, networkAllowlist, timeoutMs: args.timeoutMs ?? 60_000, maxOutputBytes: MAX_OUTPUT_BYTES });
  const parts = [
    r.timedOut ? `timed out after ${args.timeoutMs ?? 60_000} ms (killed)` : `exit code: ${r.exitCode ?? `signal ${r.signal}`}`,
    r.stdout ? `stdout:\n${r.stdout}` : 'stdout: (empty)',
    r.stderr ? `stderr:\n${r.stderr}` : '',
    r.truncated ? `[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : '',
    r.blockedHosts.length ? `[network blocked by the organization's allowlist: ${r.blockedHosts.join(', ')}]` : '',
  ].filter(Boolean);
  return textResult(parts.join('\n'), { isError: r.timedOut || r.exitCode !== 0 });
}

/** `conductor-files`: workspace-confined file tools and a sandboxed shell. */
export function createFilesToolProvider(kernel: Kernel): BuiltinToolProvider {
  return {
    id: 'conductor-files',
    description: 'Read, write, list and search files in the run\'s workspace, and run sandboxed shell commands there.',
    tools: () => TOOLS.map((t) => ({ ...t })),
    async call(ctx, tool, args) {
      switch (tool) {
        case 'read_file': return readFileTool(ctx, args);
        case 'write_file': return writeFileTool(ctx, args);
        case 'list_dir': return listDirTool(ctx, args);
        case 'search_files': return searchFilesTool(ctx, args);
        case 'run_command': return runCommandTool(kernel, ctx, args);
        default: throw notFound('tool', tool);
      }
    },
  };
}
