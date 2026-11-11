import type { CliDeps, ExecResult } from './deps.js';

export interface ProviderLogin {
  /** `yes` / `no` when the CLI answered; `unknown` when it has no status command or the answer was unreadable. */
  loggedIn: 'yes' | 'no' | 'unknown';
  /** Short, account-free description (never an email address or a token). */
  detail: string;
}

const UNKNOWN_COMMAND_RE = /unknown (command|option|argument)|unrecognized (sub)?command|unexpected argument|invalid (sub)?command|usage:/i;
const NEGATIVE_RE = /not (currently )?(logged|signed) in|logged out|no (stored )?credentials|not authenticated|login required/i;
const POSITIVE_RE = /(logged|signed) in|authenticated/i;

const text = (r: ExecResult): string => `${r.stdout}\n${r.stderr}`;
/** Only a fixed vocabulary is echoed, so account identifiers never reach the terminal or `--json` output. */
function method(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (/chatgpt/.test(s)) return 'ChatGPT account';
  if (/claude\.?ai|oauth|subscription|max|pro/.test(s)) return 'subscription login';
  if (/api.?key|console/.test(s)) return 'API key';
  if (/bedrock|vertex|foundry|third/.test(s)) return 'cloud provider credentials';
  return '';
}

function fromText(r: ExecResult): ProviderLogin {
  const t = text(r);
  if (NEGATIVE_RE.test(t)) return { loggedIn: 'no', detail: 'not logged in' };
  if (r.code !== 0 && UNKNOWN_COMMAND_RE.test(t)) return { loggedIn: 'unknown', detail: 'login not verified (this version has no status command)' };
  if (r.code === 0 && POSITIVE_RE.test(t)) {
    const how = method(/using ([A-Za-z .]+)/i.exec(t)?.[1]);
    return { loggedIn: 'yes', detail: how ? `logged in with ${how}` : 'logged in' };
  }
  if (r.code !== 0) return { loggedIn: 'no', detail: 'the login check failed; it is probably not logged in' };
  return { loggedIn: 'unknown', detail: 'login not verified' };
}

/**
 * `claude auth status --json`: reads the stored credentials and prints
 * `{ "loggedIn": boolean, "authMethod": … }`. No model call, no quota used.
 */
export async function claudeLogin(deps: Pick<CliDeps, 'exec'>): Promise<ProviderLogin> {
  const r = await deps.exec('claude', ['auth', 'status', '--json'], { timeoutMs: 10_000 });
  try {
    const j = JSON.parse(r.stdout) as { loggedIn?: unknown; authMethod?: unknown };
    if (j && typeof j === 'object' && typeof j.loggedIn === 'boolean') {
      if (!j.loggedIn) return { loggedIn: 'no', detail: 'not logged in' };
      const how = method(j.authMethod);
      return { loggedIn: 'yes', detail: how ? `logged in with ${how}` : 'logged in' };
    }
  } catch {
    /* older versions print text or do not know the command */
  }
  return fromText(r);
}

/** `codex login status`: prints the stored login and exits non-zero when there is none. No model call. */
export async function codexLogin(deps: Pick<CliDeps, 'exec'>): Promise<ProviderLogin> {
  return fromText(await deps.exec('codex', ['login', 'status'], { timeoutMs: 10_000 }));
}
