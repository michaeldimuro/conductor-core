import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedSkillRef, RunContext, RunEvent } from '../../../src/contracts/adapter.js';
import type { TestGateway } from './mcp-server.js';

export const RUN_TOKEN = 'run-token-7f3a9c1e5b2d4086a1c3e5f7092b4d6e';
export const REFERENCE_PROMPT = 'Call the lookup_code tool with key "alpha" and report the code it returns.';
export const REFERENCE_ANSWER = 'CODE-alpha-42';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

export interface Sandbox {
  root: string;
  workspace: string;
  /** Path of a JSON file a fake CLI writes its observations to. */
  recordFile: string;
  /** An executable that runs a fixture script under the current node binary. */
  bin(fixture: 'fake-claude.mjs' | 'fake-codex.mjs' | 'fake-agent.mjs'): string;
  readRecord<T = Record<string, unknown>>(): T;
  skill(name: string, body: string): ResolvedSkillRef;
  dispose(): void;
}

export function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'conductor-adapters-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const recordFile = join(root, 'record.json');
  return {
    root,
    workspace,
    recordFile,
    bin(fixture) {
      const path = join(root, fixture.replace('.mjs', ''));
      writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${join(FIXTURES, fixture)}" "$@"\n`);
      chmodSync(path, 0o755);
      return path;
    },
    readRecord<T>() {
      return JSON.parse(readFileSync(recordFile, 'utf8')) as T;
    },
    skill(name, body) {
      const path = join(root, 'skills', name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill ${name}\n---\n${body}\n`);
      return { id: `skill_${name}`, name, description: `test skill ${name}`, path, scope: 'agent', version: 1, hasScripts: false };
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let seq = 0;

export function makeCtx(gateway: TestGateway, sandbox: Sandbox, overrides: Partial<RunContext> = {}): RunContext {
  seq++;
  return {
    runId: `run_test_${seq}`,
    orgId: 'org_test',
    agentId: 'agent_test',
    issueId: 'iss_test',
    systemPrompt: 'You are Ada, a careful engineer. Use tools when asked.',
    prompt: REFERENCE_PROMPT,
    model: null,
    config: {},
    secrets: {},
    skills: [],
    mcpEndpoints: [{ name: 'conductor', url: gateway.url, headers: { Authorization: `Bearer ${gateway.token}` } }],
    workspacePath: sandbox.workspace,
    budgetCapUsd: null,
    maxSteps: 20,
    maxWallMs: 15_000,
    runToken: gateway.token,
    apiBaseUrl: 'http://127.0.0.1:1/api',
    ...overrides,
  };
}

export interface Collected {
  events: RunEvent[];
  onEvent: (e: RunEvent) => void;
  ofType<T extends RunEvent['type']>(type: T): Array<Extract<RunEvent, { type: T }>>;
  json(): string;
}

export function collect(): Collected {
  const events: RunEvent[] = [];
  return {
    events,
    onEvent: (e) => {
      events.push(e);
    },
    ofType: <T extends RunEvent['type']>(type: T) => events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type),
    json: () => JSON.stringify(events),
  };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Untyped JSON captured from fake CLIs / mock servers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = any;
