import { join, resolve } from 'node:path';
import type { ConductorClient } from '../api/client.js';
import type { Organization } from '../api/types.js';
import type { CliDeps } from './deps.js';
import { CliError, EXIT, UsageError } from './errors.js';
import { colourEnabled, fields, makeStyle, table, type Cell, type Style } from './output.js';

export const DEFAULT_PORT = 7420;

export interface GlobalOptions {
  json?: boolean;
  home?: string;
  url?: string;
  org?: string;
}

/** `<home>/cli.json`: per-install CLI preferences. Never holds secrets. */
export interface CliConfig {
  defaultOrg?: string;
  /** Base URL remembered by `conductor install --port`. */
  url?: string;
}

/** Per-invocation state: global flags, config, the API client, and output. */
export class Ctx {
  readonly style: Style;
  private cachedClient: ConductorClient | null = null;
  private cachedConfig: CliConfig | null = null;

  constructor(readonly deps: CliDeps, readonly globals: GlobalOptions) {
    this.style = makeStyle(colourEnabled(deps.isTTY, deps.env) && !globals.json);
  }

  get json(): boolean {
    return this.globals.json === true;
  }

  get home(): string {
    return resolve(this.globals.home ?? this.deps.env.CONDUCTOR_HOME ?? join(this.deps.homedir, '.conductor'));
  }

  get logDir(): string {
    return this.deps.env.CONDUCTOR_LOG_DIR ?? join(this.deps.homedir, 'Library', 'Logs', 'Conductor');
  }

  get configFile(): string {
    return join(this.home, 'cli.json');
  }

  get tokenFile(): string {
    return join(this.home, 'owner.token');
  }

  get baseUrl(): string {
    const env = this.deps.env;
    const url = this.globals.url ?? env.CONDUCTOR_URL ?? (env.CONDUCTOR_PORT ? `http://127.0.0.1:${env.CONDUCTOR_PORT}` : undefined) ?? this.config().url ?? `http://127.0.0.1:${DEFAULT_PORT}`;
    return url.replace(/\/+$/, '');
  }

  get port(): number {
    try {
      const u = new URL(this.baseUrl);
      return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    } catch {
      throw new UsageError(`invalid --url: ${this.baseUrl}`);
    }
  }

  config(): CliConfig {
    if (this.cachedConfig) return this.cachedConfig;
    let cfg: CliConfig = {};
    try {
      if (this.deps.fs.exists(this.configFile)) {
        const raw: unknown = JSON.parse(this.deps.fs.readText(this.configFile));
        if (raw && typeof raw === 'object') {
          const r = raw as Record<string, unknown>;
          cfg = { ...(typeof r.defaultOrg === 'string' ? { defaultOrg: r.defaultOrg } : {}), ...(typeof r.url === 'string' ? { url: r.url } : {}) };
        }
      }
    } catch {
      cfg = {}; // a corrupt preferences file must never block the CLI
    }
    this.cachedConfig = cfg;
    return cfg;
  }

  saveConfig(patch: Partial<CliConfig>): CliConfig {
    const next: CliConfig = { ...this.config(), ...patch };
    for (const k of Object.keys(next) as Array<keyof CliConfig>) if (next[k] === undefined) delete next[k];
    this.deps.fs.mkdirp(this.home);
    this.deps.fs.writeText(this.configFile, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    this.cachedConfig = next;
    return next;
  }

  /** The owner token, or null when the daemon has not written it yet. Never printed. */
  readToken(): string | null {
    const fromEnv = this.deps.env.CONDUCTOR_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    try {
      if (!this.deps.fs.exists(this.tokenFile)) return null;
      return this.deps.fs.readText(this.tokenFile).trim() || null;
    } catch {
      return null;
    }
  }

  /** Authenticated client (owner token from `<home>/owner.token`). */
  client(): ConductorClient {
    if (this.cachedClient) return this.cachedClient;
    const token = this.readToken();
    if (!token) {
      throw new CliError(`No owner token found at ${this.tokenFile}.`, EXIT.failure, [
        'the daemon writes it on first start — install and start it: conductor install',
        'using a non-default home? pass --home <dir> or set CONDUCTOR_HOME',
        'check the install: conductor doctor',
      ], 'no_token');
    }
    this.cachedClient = this.deps.createClient({ baseUrl: this.baseUrl, token });
    return this.cachedClient;
  }

  /** Unauthenticated client: only `/healthz` works without a token. */
  anonymous(): ConductorClient {
    return this.deps.createClient({ baseUrl: this.baseUrl, token: null });
  }

  /** The org explicitly chosen by flag, environment or `org use` (no API call). */
  chosenOrg(): string | undefined {
    return this.globals.org ?? this.deps.env.CONDUCTOR_ORG ?? this.config().defaultOrg;
  }

  /** Org slug or id for API paths; falls back to the only org when there is exactly one. */
  async org(): Promise<string> {
    const chosen = this.chosenOrg();
    if (chosen) return chosen;
    const orgs = await this.client().listOrgs();
    if (orgs.length === 1) return orgs[0]!.slug;
    if (orgs.length === 0) {
      throw new CliError('No organizations yet.', EXIT.failure, ['create one: conductor org create "Acme" --template saas-startup', 'or run the guided setup: conductor quickstart']);
    }
    throw new UsageError(`Several organizations exist (${orgs.map((o) => o.slug).join(', ')}); choose one.`, ['pass --org <slug>', 'or set the default: conductor org use <slug>']);
  }

  orgRow(): Promise<Organization> {
    return this.org().then((o) => this.client().getOrg(o));
  }

  /* ── output ── */
  line(text = ''): void {
    this.deps.stdout(`${text}\n`);
  }

  lines(lines: string[]): void {
    for (const l of lines) this.line(l);
  }

  /** Notes, warnings and progress go to stderr so stdout stays parseable. */
  note(text: string): void {
    this.deps.stderr(`${text}\n`);
  }

  warn(text: string): void {
    this.note(`${this.style.yellow('warning:')} ${text}`);
  }

  printJson(data: unknown): void {
    this.line(JSON.stringify(data ?? null, null, 2));
  }

  /** `--json` prints the data; otherwise the human renderer runs. */
  emit(data: unknown, human: () => void): void {
    if (this.json) this.printJson(data);
    else human();
  }

  table(headers: string[], rows: Cell[][], empty = 'nothing to show'): void {
    if (rows.length === 0) this.line(this.style.dim(empty));
    else this.lines(table(headers, rows, this.style));
  }

  fields(pairs: Array<[string, Cell]>): void {
    this.lines(fields(pairs, this.style));
  }

  ok(text: string): void {
    this.line(`${this.style.green('✓')} ${text}`);
  }
}
