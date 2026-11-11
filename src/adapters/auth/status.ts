import type { AuthMethodKind, CliProvider, LoginMethodInfo } from '../../contracts/providers.js';
import { stripAnsi, type CliExec, type CliExecResult } from '../shared/cli-exec.js';

/** What a CLI says about its own login. Account identifiers are dropped here and never leave this module. */
export interface CliLogin {
  installed: boolean;
  version: string | null;
  loggedIn: 'yes' | 'no' | 'unknown';
  method: AuthMethodKind;
  plan: string | null;
  expiresAt: number | null;
  detail: string;
}

export const CLI_COMMAND: Record<CliProvider, string> = { claude: 'claude', codex: 'codex' };
export const CLI_LABEL: Record<CliProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

export const LOGIN_METHODS: Record<CliProvider, LoginMethodInfo[]> = {
  claude: [
    { method: 'subscription', label: 'Claude subscription', description: 'Sign in with your Claude Pro/Max account, then paste the code the page shows.', input: 'none', remoteFriendly: true },
    { method: 'console', label: 'Anthropic Console', description: 'Sign in with an Anthropic Console account (API usage billing), then paste the code.', input: 'none', remoteFriendly: true },
    { method: 'token', label: 'Long-lived token', description: 'Run `claude setup-token` in Terminal and paste the token. It is kept in the Keychain for bindings that use auth "token"; the CLI login is not changed.', input: 'secret', remoteFriendly: true },
  ],
  codex: [
    { method: 'device', label: 'ChatGPT (device code)', description: 'Open the link on any device and enter the one-time code.', input: 'none', remoteFriendly: true },
    { method: 'browser', label: 'ChatGPT (browser on this Mac)', description: 'Opens a browser window on this Mac; finishes on a local callback, so it only works at the Mac.', input: 'none', remoteFriendly: false },
    { method: 'api_key', label: 'OpenAI API key', description: 'Log the Codex CLI in with an API key (read from stdin, never shown). Runs are billed to the key.', input: 'secret', remoteFriendly: true },
  ],
};

const UNKNOWN_COMMAND_RE = /unknown (command|option|argument)|unrecognized (sub)?command|unexpected argument|invalid (sub)?command/i;
const NEGATIVE_RE = /not (currently )?(logged|signed) in|logged out|no (stored )?credentials|not authenticated|login required/i;
const POSITIVE_RE = /(logged|signed) in|authenticated/i;

function methodOf(raw: unknown): AuthMethodKind {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (!s || s === 'none') return 'none';
  if (/chatgpt/.test(s)) return 'chatgpt';
  if (/oauth_token|setup.?token|long.?lived/.test(s)) return 'oauth_token';
  if (/api.?key|console/.test(s)) return 'api_key';
  if (/bedrock|vertex|foundry|third/.test(s)) return 'cloud';
  if (/claude\.?ai|oauth|subscription/.test(s)) return 'subscription';
  return 'unknown';
}

const METHOD_TEXT: Record<AuthMethodKind, string> = {
  subscription: 'Claude subscription login', chatgpt: 'ChatGPT account', api_key: 'API key', oauth_token: 'long-lived token',
  cloud: 'cloud provider credentials', none: 'nothing', unknown: 'an unrecognised method',
};

/** A plan tier is a short word ("max", "pro", "team"); anything else is dropped. */
const planOf = (raw: unknown): string | null => (typeof raw === 'string' && /^[a-z][a-z0-9_-]{1,20}$/i.test(raw) ? raw.toLowerCase() : null);

function expiryOf(raw: unknown): number | null {
  if (typeof raw === 'number' && raw > 1e12) return raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function fromText(r: CliExecResult): Pick<CliLogin, 'loggedIn' | 'method' | 'detail'> {
  const t = stripAnsi(`${r.stdout}\n${r.stderr}`);
  if (NEGATIVE_RE.test(t)) return { loggedIn: 'no', method: 'none', detail: 'not logged in' };
  if (r.code !== 0 && UNKNOWN_COMMAND_RE.test(t)) return { loggedIn: 'unknown', method: 'unknown', detail: 'this CLI version cannot report its login' };
  if (r.code === 0 && POSITIVE_RE.test(t)) {
    const method = methodOf(/using ([A-Za-z .]+)/i.exec(t)?.[1]);
    return { loggedIn: 'yes', method, detail: method === 'unknown' ? 'logged in' : `logged in with ${METHOD_TEXT[method]}` };
  }
  return { loggedIn: 'unknown', method: 'unknown', detail: r.timedOut ? 'the login check timed out' : 'login not verified' };
}

/**
 * Ask the CLI itself. Both checks read stored credentials only: no model call, no quota.
 * `extraEnv` lets a check run against a credential (e.g. CLAUDE_CODE_OAUTH_TOKEN) in an isolated config dir.
 */
export async function checkCliLogin(provider: CliProvider, exec: CliExec, extraEnv?: Record<string, string>, command?: string): Promise<CliLogin> {
  const cmd = command ?? CLI_COMMAND[provider];
  const env = extraEnv ? { env: extraEnv } : {};
  const ver = await exec(cmd, ['--version'], { timeoutMs: 10_000, ...env });
  if (ver.spawnError) return { installed: false, version: null, loggedIn: 'no', method: 'none', plan: null, expiresAt: null, detail: `${cmd} CLI is not installed (or not on the daemon's PATH)` };
  const version = stripAnsi(ver.stdout).split('\n')[0]?.trim() || null;

  if (provider === 'claude') {
    const r = await exec(cmd, ['auth', 'status', '--json'], { timeoutMs: 10_000, ...env });
    try {
      const j = JSON.parse(r.stdout) as Record<string, unknown>;
      if (typeof j.loggedIn === 'boolean') {
        const method = j.loggedIn ? methodOf(j.authMethod) : 'none';
        return {
          installed: true, version, loggedIn: j.loggedIn ? 'yes' : 'no', method,
          plan: j.loggedIn ? planOf(j.subscriptionType) : null,
          expiresAt: j.loggedIn ? expiryOf(j.loginExpiresAt) : null,
          detail: j.loggedIn ? `logged in with ${METHOD_TEXT[method]}` : 'not logged in',
        };
      }
    } catch {
      /* older versions print text */
    }
    return { installed: true, version, plan: null, expiresAt: null, ...fromText(r) };
  }
  const r = await exec(cmd, ['login', 'status'], { timeoutMs: 10_000, ...env });
  return { installed: true, version, plan: null, expiresAt: null, ...fromText(r) };
}

/** Shapes the CLIs' credentials take, used to refuse obvious paste mistakes before anything is stored. */
export function credentialLooksValid(provider: CliProvider, kind: 'token' | 'api_key', value: string): string | null {
  const v = value.trim();
  if (v.length < 20 || v.length > 4096 || /\s/.test(v)) return 'that does not look like a credential (no spaces, at least 20 characters)';
  if (provider === 'claude' && kind === 'token' && !/^sk-ant-/.test(v)) return 'a Claude Code token starts with "sk-ant-" (made by `claude setup-token`)';
  return null;
}
