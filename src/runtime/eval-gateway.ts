import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpEndpoint, ResolvedSkillRef } from '../contracts/adapter.js';
import type { Kernel } from '../contracts/kernel.js';
import type { TokenService } from '../contracts/services.js';
import type { BuiltinToolProvider, ToolCallContext, ToolDef } from '../contracts/tools.js';
import { confine, createFilesToolProvider } from '../connectors/files/provider.js';
import { runSandboxed, sandboxAvailable } from '../connectors/files/sandbox.js';
import { errorMessage } from '../shared/errors.js';
import { resolveInside } from '../shared/paths.js';
import type { Logger } from '../shared/util.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_FILES_LISTED = 200;
const NS = 'conductor-skills__';
/** Same qualified names as the real gateway, so a skill that says "use conductor-files__write_file" replays as written. */
const FILES_NS = 'conductor-files__';
const RUN_COMMAND = 'run_command';
const MAX_COMMAND_MS = 120_000;
const MAX_COMMAND_OUTPUT = 64_000;

/** The throwaway workspace of one eval run; the file tools see nothing else. */
export interface EvalSandbox {
  workspacePath: string;
  orgId: string;
  agentId: string;
  deptId: string;
}

const commandArgs = z.object({
  command: z.string().min(1).max(20_000),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(100).max(MAX_COMMAND_MS).optional(),
});
const RUN_COMMAND_DEF = {
  name: `${FILES_NS}${RUN_COMMAND}`,
  description:
    'Run a shell command in your workspace inside a sandbox: it can read and write only the workspace and a temp dir, and has NO network access. Returns exit code, stdout and stderr.',
  inputSchema: { type: 'object' as const, properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 100, maximum: MAX_COMMAND_MS } }, required: ['command'] },
};

const nameProp = { type: 'string', description: 'Skill name.' } as const;
const TOOLS = [
  {
    name: `${NS}list_skills`,
    description: 'List the skills available to you (name and one-line description only). Call load_skill to read the instructions of one that applies to your task.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: `${NS}load_skill`,
    description: 'Load the full instructions (SKILL.md body) and the file list of one of your skills. Do this only when the skill applies to the task at hand.',
    inputSchema: { type: 'object' as const, properties: { name: nameProp }, required: ['name'], additionalProperties: false },
  },
  {
    name: `${NS}read_skill_file`,
    description: 'Read a supporting file (scripts/, references/, assets/) of one of your skills, by the relative path shown in load_skill.',
    inputSchema: { type: 'object' as const, properties: { name: nameProp, path: { type: 'string' } }, required: ['name', 'path'], additionalProperties: false },
  },
];

type ToolOut = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const text = (t: string, isError = false): ToolOut => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function stripFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body.trim();
  const end = body.indexOf('\n---', 3);
  if (end < 0) return body.trim();
  const after = body.indexOf('\n', end + 1);
  return (after < 0 ? '' : body.slice(after + 1)).trim();
}

/** Regular files of a skill folder, relative, forward-slashed. Symlinks and dot-directories are never listed. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FILES_LISTED) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) walk(abs);
      } else if (e.isFile()) {
        out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** The read-only skill tools, served from the exact skill folders an eval run was given. */
export function callEvalSkillTool(skills: ResolvedSkillRef[], tool: string, args: Record<string, unknown>): ToolOut {
  const find = (): ResolvedSkillRef | null => skills.find((s) => s.name === args.name) ?? null;
  try {
    switch (tool) {
      case `${NS}list_skills`:
        return text(JSON.stringify({ skills: skills.map((s) => ({ name: s.name, description: s.description.replace(/\s+/g, ' ').trim() })) }, null, 2));
      case `${NS}load_skill`: {
        const skill = find();
        if (!skill) return text(`Unknown skill: ${String(args.name).slice(0, 100)}`, true);
        const file = resolveInside(skill.path, 'SKILL.md');
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_BODY_BYTES) return text('SKILL.md is missing or too large', true);
        const body = stripFrontmatter(readFileSync(file, 'utf8'));
        const files = listFiles(skill.path).filter((f) => f !== 'SKILL.md');
        return text(JSON.stringify({ name: skill.name, description: skill.description, scope: skill.scope, version: skill.version, body, files }, null, 2));
      }
      case `${NS}read_skill_file`: {
        const skill = find();
        const path = typeof args.path === 'string' ? args.path : '';
        if (!skill) return text(`Unknown skill: ${String(args.name).slice(0, 100)}`, true);
        if (!path || path.includes('\0') || path.includes('\\')) return text('unsafe skill file path', true);
        const abs = resolveInside(skill.path, path);
        const rel = relative(skill.path, abs).split(sep).join('/');
        if (!listFiles(skill.path).includes(rel)) return text(`skill file not found: ${path.slice(0, 120)}`, true);
        if (lstatSync(abs).size > MAX_FILE_BYTES) return text('skill file is too large to read through this tool', true);
        const bytes = readFileSync(abs);
        if (bytes.subarray(0, 8000).includes(0)) return text('skill file is binary', true);
        return text(bytes.toString('utf8'));
      }
      default:
        return text(`Unknown tool: ${tool}`, true);
    }
  } catch (err) {
    return text(`Tool failed: ${errorMessage(err)}`, true);
  }
}

/**
 * The shell of an eval run: the same seatbelt confinement as the real `run_command` (reads and
 * writes only inside the eval workspace and a private temp dir) with the network always off —
 * the org's network allowlist is deliberately not applied, so a replay cannot reach anything.
 */
async function evalRunCommand(sandbox: EvalSandbox, raw: Record<string, unknown>): Promise<ToolOut> {
  const parsed = commandArgs.safeParse(raw);
  if (!parsed.success) return text(`invalid run_command arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, true);
  const root = realpathSync(sandbox.workspacePath);
  const cwd = confine(root, parsed.data.cwd ?? '.', sandbox.workspacePath);
  if (!lstatSync(cwd).isDirectory()) return text(`not a directory: ${String(parsed.data.cwd).slice(0, 120)}`, true);
  const timeoutMs = parsed.data.timeoutMs ?? 60_000;
  const r = await runSandboxed({ command: parsed.data.command, workspace: root, cwd, networkAllowlist: [], timeoutMs, maxOutputBytes: MAX_COMMAND_OUTPUT });
  const parts = [
    r.timedOut ? `timed out after ${timeoutMs} ms (killed)` : `exit code: ${r.exitCode ?? `signal ${r.signal}`}`,
    r.stdout ? `stdout:\n${r.stdout}` : 'stdout: (empty)',
    r.stderr ? `stderr:\n${r.stderr}` : '',
    r.truncated ? `[output truncated at ${MAX_COMMAND_OUTPUT} bytes]` : '',
  ].filter(Boolean);
  return text(parts.join('\n'), r.timedOut || r.exitCode !== 0);
}

interface EvalRun {
  skills: ResolvedSkillRef[];
  sandbox: EvalSandbox | null;
}

/**
 * Sandboxed tool gateway for skill-eval runs. Eval runs must not reach
 * connectors, the browser, tasks or memory, but API / process / http adapters
 * have no tools of their own — so the runtime serves an MCP endpoint on a
 * loopback port, authenticated with the eval run's own run token, that exposes
 * exactly two things: the skills under evaluation (read-only) and file tools
 * confined to the run's throwaway eval workspace (read / write / list / search,
 * plus a network-less sandboxed shell where the macOS sandbox is available).
 * Nothing here has an effect outside that workspace.
 */
export class EvalGateway {
  private server: HttpServer | null = null;
  private starting: Promise<number> | null = null;
  private readonly runs = new Map<string, EvalRun>();
  private readonly files: BuiltinToolProvider | null;

  constructor(
    private readonly tokens: Pick<TokenService, 'verify'>,
    private readonly log: Logger,
    /** Enables the workspace file tools (the files provider is built on the kernel). */
    kernel?: Kernel,
  ) {
    this.files = kernel ? createFilesToolProvider(kernel) : null;
  }

  /** Register an eval run and return the endpoint its adapter should use. `sandbox` = the run's throwaway workspace. */
  async open(runId: string, skills: ResolvedSkillRef[], runToken: string, sandbox?: EvalSandbox): Promise<{ endpoint: McpEndpoint; baseUrl: string }> {
    const port = await this.listen();
    this.runs.set(runId, { skills, sandbox: sandbox ?? null });
    const baseUrl = `http://127.0.0.1:${port}`;
    return { baseUrl, endpoint: { name: 'conductor', url: `${baseUrl}/mcp`, headers: { Authorization: `Bearer ${runToken}` } } };
  }

  /** Forget a run: its token no longer opens the endpoint. */
  closeRun(runId: string): void {
    this.runs.delete(runId);
  }

  private listen(): Promise<number> {
    if (this.starting) return this.starting;
    this.starting = new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        server.unref();
        resolve((server.address() as AddressInfo).port);
      });
    });
    this.starting.catch(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private authorize(req: IncomingMessage): (EvalRun & { runId: string }) | null {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const principal = m?.[1] ? this.tokens.verify(m[1].trim()) : null;
    if (!principal || principal.kind !== 'run') return null;
    const run = this.runs.get(principal.runId);
    return run ? { ...run, runId: principal.runId } : null;
  }

  private fileContext(run: EvalRun & { runId: string }): ToolCallContext | null {
    if (!this.files || !run.sandbox) return null;
    return { orgId: run.sandbox.orgId, agentId: run.sandbox.agentId, deptId: run.sandbox.deptId, runId: run.runId, issueId: null, workspacePath: run.sandbox.workspacePath, autonomyLevel: 0 };
  }

  /** The tools one eval run sees: its skills, and — when it has a workspace — the confined file tools. */
  async toolsFor(run: EvalRun & { runId: string }): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }>> {
    const out = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, readOnly: true }));
    const ctx = this.fileContext(run);
    if (!ctx || !this.files) return out;
    // The provider's own shell honours the org's network allowlist; eval runs get the network-less one below instead.
    const defs: ToolDef[] = (await this.files.tools(ctx)).filter((t) => t.name !== RUN_COMMAND);
    for (const t of defs) out.push({ name: `${FILES_NS}${t.name}`, description: t.description, inputSchema: t.inputSchema, readOnly: t.risk === 'read' });
    if (sandboxAvailable()) out.push({ ...RUN_COMMAND_DEF, readOnly: false });
    return out;
  }

  /** Dispatch one tool call of an eval run. Never throws: failures come back as tool errors. */
  async callTool(run: EvalRun & { runId: string }, name: string, args: Record<string, unknown>): Promise<ToolOut> {
    if (!name.startsWith(FILES_NS)) return callEvalSkillTool(run.skills, name, args);
    const ctx = this.fileContext(run);
    if (!ctx || !this.files || !run.sandbox) return text(`Unknown tool: ${name}`, true);
    const tool = name.slice(FILES_NS.length);
    try {
      if (tool === RUN_COMMAND) return await evalRunCommand(run.sandbox, args);
      const result = await this.files.call(ctx, tool, args);
      const body = result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type} content]`)).join('\n');
      return text(body, result.isError === true);
    } catch (err) {
      return text(`Tool failed: ${errorMessage(err)}`, true);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reject = (status: number, message: string): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
    };
    try {
      if ((req.url ?? '').split('?')[0] !== '/mcp') return reject(404, 'Not found');
      const who = this.authorize(req);
      if (!who) return reject(401, 'a live eval run token is required');
      // Stateless: there is no session to resume or stream from.
      if (req.method !== 'POST') return reject(405, 'Method not allowed');

      const server = new Server({ name: 'conductor-eval-gateway', version: '0.1.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (await this.toolsFor(who)).map(({ readOnly, ...t }) => ({ ...t, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        return this.callTool(who, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      this.log.warn({ err }, 'eval gateway request failed');
      if (!res.headersSent) reject(500, 'internal error');
      else if (!res.writableEnded) res.end();
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.starting = null;
    this.runs.clear();
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
