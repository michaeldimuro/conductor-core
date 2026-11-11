import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kernel } from '../../contracts/kernel.js';
import {
  CLI_PROVIDER_ADAPTER, CLI_PROVIDERS, defaultCredentialRefs,
  type BindingAuth, type CliProvider, type ProviderAuthService, type ProviderAuthStatus, type StartLoginRequest,
} from '../../contracts/providers.js';
import { OWNER } from '../../contracts/types.js';
import { conflict, invalid, notFound } from '../../shared/errors.js';
import { execCli, type CliExec } from '../shared/cli-exec.js';
import { LoginRun, loginArgs } from './sessions.js';
import { checkCliLogin, CLI_COMMAND, CLI_LABEL, credentialLooksValid, LOGIN_METHODS, type CliLogin } from './status.js';

export interface ProviderAuthDeps {
  exec?: CliExec;
  /** Override the CLI binaries (tests point these at fakes). */
  commands?: Partial<Record<CliProvider, string>>;
  /** How long a status answer is reused (default 30 s). */
  statusTtlMs?: number;
  /** Called after a CLI's login changed (login succeeded, logout). */
  onAccountChange?: (provider: CliProvider) => void;
}

/** Finished sessions stay readable this long so a polling UI sees the outcome. */
const KEEP_FINISHED_MS = 10 * 60_000;
const STORED_KINDS: Record<CliProvider, Array<Exclude<BindingAuth, 'login'>>> = { claude: ['token', 'api_key'], codex: ['api_key'] };

/**
 * Provider accounts: how Conductor authenticates with the Claude Code and Codex CLIs.
 * Logins are the CLIs' own flows, driven from the UI/CLI over the API: Conductor shows the
 * link and code, relays the pasted code, and verifies with the CLI's status command.
 * Long-lived credentials for bindings (`auth: token | api_key`) live in the secret store.
 */
export function createProviderAuth(k: Kernel, deps: ProviderAuthDeps = {}): ProviderAuthService {
  const exec = deps.exec ?? execCli;
  const cmd = (p: CliProvider) => deps.commands?.[p] ?? CLI_COMMAND[p];
  const ttl = deps.statusTtlMs ?? 30_000;
  const now = () => k.clock.now();
  const cache = new Map<CliProvider, { at: number; login: CliLogin }>();
  const runs = new Map<string, LoginRun>();
  const activeFor = new Map<CliProvider, string>();

  const prune = () => {
    for (const [id, r] of runs) if (r.done && r.session.endedAt !== null && now() - r.session.endedAt > KEEP_FINISHED_MS) runs.delete(id);
  };
  const runOf = (id: string): LoginRun => {
    prune();
    const r = runs.get(id);
    if (!r) throw notFound('login session', id);
    return r;
  };
  const audit = (provider: CliProvider, action: string, data: Record<string, unknown>) =>
    k.audit.record({ orgId: null, actor: OWNER, action, entityKind: 'provider', entityId: provider, data });

  async function login(provider: CliProvider, refresh: boolean): Promise<CliLogin> {
    const hit = cache.get(provider);
    if (hit && !refresh && now() - hit.at < ttl) return hit.login;
    const fresh = await checkCliLogin(provider, exec, undefined, cmd(provider));
    cache.set(provider, { at: now(), login: fresh });
    return fresh;
  }

  async function status(provider: CliProvider, opts: { orgSlug?: string; refresh?: boolean } = {}): Promise<ProviderAuthStatus> {
    const l = await login(provider, !!opts.refresh);
    const adapterId = CLI_PROVIDER_ADAPTER[provider];
    const storedCredentials: ProviderAuthStatus['storedCredentials'] = [];
    for (const auth of STORED_KINDS[provider]) {
      for (const ref of defaultCredentialRefs(adapterId, auth, opts.orgSlug ?? null)) {
        storedCredentials.push({ auth, ref, present: await k.secrets.has(ref).catch(() => false) });
      }
    }
    const active = activeFor.get(provider);
    return {
      provider, adapterId, label: CLI_LABEL[provider], ...l,
      loginMethods: LOGIN_METHODS[provider], storedCredentials,
      activeSession: active && runs.get(active) && !runs.get(active)!.done ? active : null,
      checkedAt: cache.get(provider)?.at ?? now(),
    };
  }

  /** After the CLI exits: did the login take? The CLI's own status is the judge. */
  async function settle(run: LoginRun, code: number | null): Promise<void> {
    if (run.done) return;
    run.update({ state: 'verifying', message: 'checking the login' });
    const l = await login(run.session.provider, true);
    if (l.loggedIn === 'yes') {
      run.update({ state: 'succeeded', message: l.detail });
      audit(run.session.provider, 'provider.login_succeeded', { method: run.session.method, via: l.method });
      deps.onAccountChange?.(run.session.provider);
    } else {
      const tail = run.tail();
      run.update({ state: 'failed', message: tail || (code === 0 ? 'the CLI finished but reports no login' : `the login exited with code ${code ?? 'unknown'}`) });
      audit(run.session.provider, 'provider.login_failed', { method: run.session.method, exitCode: code });
    }
  }

  async function credentialFrom(req: StartLoginRequest): Promise<string> {
    if (req.secretRef) {
      const v = await k.secrets.get(req.secretRef);
      if (!v) throw invalid(`no secret stored at ${req.secretRef}`);
      return v;
    }
    if (!req.secret) throw invalid('paste the credential, or name a stored secret with secretRef');
    return req.secret.trim();
  }

  /** `claude setup-token` output → secret store, then confirm the CLI accepts it (isolated config dir, no model call). */
  async function storeClaudeToken(run: LoginRun, req: StartLoginRequest): Promise<void> {
    const token = await credentialFrom(req);
    const bad = credentialLooksValid('claude', 'token', token);
    if (bad) throw invalid(bad);
    const ref = req.saveAs ?? defaultCredentialRefs('claude_local', 'token', req.orgSlug ?? null)[0]!;
    const isolated = mkdtempSync(join(tmpdir(), 'conductor-auth-'));
    try {
      const check = await checkCliLogin('claude', exec, { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: isolated }, cmd('claude'));
      if (!check.installed) throw invalid('the claude CLI is not installed; install Claude Code first');
      if (check.loggedIn !== 'yes' || check.method !== 'oauth_token') throw invalid('the claude CLI did not accept this token');
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
    if (!req.secretRef || req.saveAs) await k.secrets.set(ref, token);
    run.update({ state: 'succeeded', storedRef: req.secretRef && !req.saveAs ? req.secretRef : ref, message: 'token stored; bindings with auth "token" use it' });
    run.finishWithoutProcess();
    audit('claude', 'provider.credential_stored', { auth: 'token', ref: run.session.storedRef });
  }

  return {
    status,
    statusAll: (opts) => Promise.all(CLI_PROVIDERS.map((p) => status(p, opts))),

    async startLogin(provider, req) {
      const methods = LOGIN_METHODS[provider].map((m) => m.method);
      if (!methods.includes(req.method)) throw invalid(`${CLI_LABEL[provider]} has no "${req.method}" login (choose ${methods.join(', ')})`);
      if (req.saveAs !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(req.saveAs)) throw invalid('saveAs must be a secret ref like conductor/claude-oauth-token');
      const current = activeFor.get(provider);
      // Storing a token never touches the CLI login, so it may run alongside an interactive one.
      if (req.method !== 'token' && current && runs.get(current) && !runs.get(current)!.done) {
        throw conflict(`a ${CLI_LABEL[provider]} login is already in progress (${current}); cancel it first`);
      }

      const secrets = req.secret ? [req.secret] : [];
      const run = new LoginRun(provider, req.method, now, { secrets });
      runs.set(run.session.id, run);
      audit(provider, 'provider.login_started', { method: req.method });

      if (req.method === 'token') {
        try {
          await storeClaudeToken(run, req);
        } catch (err) {
          run.update({ state: 'failed', message: err instanceof Error ? err.message : String(err) });
          throw err;
        }
        cache.delete(provider);
        return { ...run.session };
      }

      const args = loginArgs(provider, req.method)!;
      let stdin: string | undefined;
      if (req.method === 'api_key') {
        const key = await credentialFrom(req);
        const bad = credentialLooksValid(provider, 'api_key', key);
        if (bad) throw invalid(bad);
        stdin = key;
        secrets.push(key);
        if (req.saveAs) {
          await k.secrets.set(req.saveAs, key);
          run.session.storedRef = req.saveAs;
        }
      }
      if (req.method !== 'api_key') activeFor.set(provider, run.session.id);
      run.spawn(args, { openBrowser: req.method === 'browser' || !!req.openBrowser, command: cmd(provider), ...(stdin !== undefined ? { stdin } : {}) });
      if (req.method === 'api_key') run.update({ state: 'verifying', message: 'logging the CLI in with the key' });
      void run.exited.then((code) => settle(run, code)).finally(() => {
        if (activeFor.get(provider) === run.session.id) activeFor.delete(provider);
      });
      return { ...run.session };
    },

    getSession: (id) => ({ ...runOf(id).session }),

    submitCode(id, code) {
      const run = runOf(id);
      const c = code.trim();
      if (!c || c.length > 2000 || /[\r\n]/.test(c)) throw invalid('paste the code exactly as the sign-in page shows it');
      if (run.done || run.session.state !== 'waiting' || !run.session.needsCode) throw conflict('this login is not waiting for a code');
      run.write(c);
      run.update({ state: 'verifying', message: 'code sent; finishing the login' });
      return { ...run.session };
    },

    cancelSession(id) {
      const run = runOf(id);
      run.update({ state: 'cancelled', message: 'cancelled' });
      return { ...run.session };
    },

    async logout(provider) {
      for (const r of runs.values()) {
        if (r.session.provider === provider && !r.done) r.update({ state: 'cancelled', message: 'cancelled by logout' });
      }
      activeFor.delete(provider);
      cache.delete(provider);
      const r = await exec(cmd(provider), provider === 'claude' ? ['auth', 'logout'] : ['logout'], { timeoutMs: 20_000 });
      if (r.spawnError) throw invalid(`${CLI_LABEL[provider]} is not installed`);
      audit(provider, 'provider.logout', { exitCode: r.code });
      deps.onAccountChange?.(provider);
      return status(provider, { refresh: true });
    },

    async forgetCredential(provider, auth, ref, orgSlug) {
      const allowed = defaultCredentialRefs(CLI_PROVIDER_ADAPTER[provider], auth, orgSlug ?? null);
      const target = ref ?? allowed[allowed.length - 1];
      if (!target) throw invalid(`${CLI_LABEL[provider]} has no stored "${auth}" credential`);
      await k.secrets.delete(target);
      audit(provider, 'provider.credential_removed', { auth, ref: target });
      return status(provider, { ...(orgSlug ? { orgSlug } : {}) });
    },

    dispose() {
      for (const r of runs.values()) if (!r.done) r.update({ state: 'cancelled', message: 'daemon shutting down' });
      runs.clear();
    },
  };
}

export { parseLoginOutput, safeTail, loginArgs } from './sessions.js';
export { checkCliLogin, credentialLooksValid } from './status.js';
