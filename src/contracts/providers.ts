/**
 * Provider accounts and model catalogs (adapters context).
 *
 * - `ProviderAuthService`: how Conductor authenticates with the local agent
 *   CLIs (Claude Code, Codex): status, interactive login sessions driven from
 *   the UI/CLI, logout, and long-lived tokens kept in the secret store.
 * - `ModelCatalogService`: the models an adapter can run, for dropdowns.
 *
 * Nothing here ever returns a credential, an email address or an account id.
 */

/** Local agent CLIs Conductor can authenticate with. */
export type CliProvider = 'claude' | 'codex';
export const CLI_PROVIDERS: readonly CliProvider[] = ['claude', 'codex'];
export const CLI_PROVIDER_ADAPTER: Record<CliProvider, string> = { claude: 'claude_local', codex: 'codex_local' };

/**
 * How a binding of a local CLI adapter authenticates (`ProviderBinding.auth`):
 * - `login`: the CLI's own stored login on this Mac (default).
 * - `token`: a long-lived Claude subscription token (`claude setup-token`) from the secret store.
 * - `api_key`: an API key from the secret store; runs are metered against budgets.
 */
export type BindingAuth = 'login' | 'token' | 'api_key';
export const BINDING_AUTH_MODES: readonly BindingAuth[] = ['login', 'token', 'api_key'];

/** Conventional secret refs for credentials of local CLI bindings (the org-scoped one is tried first). */
export function defaultCredentialRefs(adapterId: string, auth: BindingAuth, orgSlug: string | null): string[] {
  const scoped = (name: string) => [...(orgSlug ? [`org/${orgSlug}/${name}`] : []), `conductor/${name}`];
  if (auth === 'token' && adapterId === 'claude_local') return scoped('claude-oauth-token');
  if (auth === 'api_key' && (adapterId === 'claude_local' || adapterId === 'claude_api')) return scoped('anthropic-api-key');
  if (auth === 'api_key' && (adapterId === 'codex_local' || adapterId === 'openai_api')) return scoped('openai-api-key');
  return [];
}

/** Login methods a provider offers. */
export type LoginMethod =
  /** Claude subscription (claude.ai) OAuth: open the link, paste the code it shows. */
  | 'subscription'
  /** Anthropic Console OAuth (API billing): open the link, paste the code. */
  | 'console'
  /** Store a long-lived token made with `claude setup-token` (no CLI login change). */
  | 'token'
  /** ChatGPT device code: open the link on any device and enter the code. */
  | 'device'
  /** ChatGPT browser login on this Mac (local callback; only works at the Mac). */
  | 'browser'
  /** Codex API-key login from a stored secret or a pasted key (stdin, never argv). */
  | 'api_key';

export interface LoginMethodInfo {
  method: LoginMethod;
  label: string;
  description: string;
  /** What the request must carry: a pasted secret value, a secret ref, or nothing. */
  input: 'none' | 'secret';
  /** Works from a phone or another machine (no callback to this Mac's localhost). */
  remoteFriendly: boolean;
}

export type AuthMethodKind = 'subscription' | 'chatgpt' | 'api_key' | 'oauth_token' | 'cloud' | 'none' | 'unknown';

export interface ProviderAuthStatus {
  provider: CliProvider;
  adapterId: string;
  label: string;
  installed: boolean;
  version: string | null;
  /** The CLI's own login on this Mac. */
  loggedIn: 'yes' | 'no' | 'unknown';
  method: AuthMethodKind;
  /** Plan tier when the CLI reports one (`pro`, `max`, …). Never an account identifier. */
  plan: string | null;
  /** Epoch ms when the stored login expires, when reported. */
  expiresAt: number | null;
  /** Short, account-free description. */
  detail: string;
  loginMethods: LoginMethodInfo[];
  /** Long-lived credentials in Conductor's secret store that bindings with `auth: token | api_key` use. */
  storedCredentials: Array<{ auth: Exclude<BindingAuth, 'login'>; ref: string; present: boolean }>;
  /** A login session currently in progress, if any. */
  activeSession: string | null;
  checkedAt: number;
}

export type LoginSessionState = 'starting' | 'waiting' | 'verifying' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface LoginSession {
  id: string;
  provider: CliProvider;
  method: LoginMethod;
  state: LoginSessionState;
  /** Link the human opens (authorize page or device page). */
  url: string | null;
  /** One-time code to enter on the device page (device flow). */
  userCode: string | null;
  /** The CLI waits for the code shown after signing in (paste it with `input`). */
  needsCode: boolean;
  /** Human-readable progress or failure reason (account-free, redacted). */
  message: string;
  startedAt: number;
  expiresAt: number;
  endedAt: number | null;
  /** Secret ref written by the session (`token` / `api_key` with `saveAs`). */
  storedRef: string | null;
}

export interface StartLoginRequest {
  method: LoginMethod;
  /** `token` / `api_key`: the pasted credential (written to the secret store or stdin, never logged or echoed). */
  secret?: string;
  /** `token` / `api_key`: read the credential from this existing secret ref instead of `secret`. */
  secretRef?: string;
  /** Where to store a pasted credential (default: the conventional `conductor/…` ref, or `org/<slug>/…` with `orgSlug`). */
  saveAs?: string;
  orgSlug?: string;
  /** Let the CLI open a browser window on this Mac (default false: the UI shows the link instead). */
  openBrowser?: boolean;
}

export interface ProviderAuthService {
  status(provider: CliProvider, opts?: { orgSlug?: string; refresh?: boolean }): Promise<ProviderAuthStatus>;
  statusAll(opts?: { orgSlug?: string; refresh?: boolean }): Promise<ProviderAuthStatus[]>;
  startLogin(provider: CliProvider, req: StartLoginRequest): Promise<LoginSession>;
  getSession(sessionId: string): LoginSession;
  /** Send the code shown after signing in (Claude) to the waiting CLI. */
  submitCode(sessionId: string, code: string): LoginSession;
  cancelSession(sessionId: string): LoginSession;
  /** Log the CLI itself out on this Mac (`claude auth logout` / `codex logout`). */
  logout(provider: CliProvider): Promise<ProviderAuthStatus>;
  /** Remove a long-lived credential Conductor stored for bindings. */
  forgetCredential(provider: CliProvider, auth: Exclude<BindingAuth, 'login'>, ref?: string, orgSlug?: string): Promise<ProviderAuthStatus>;
  dispose(): void;
}

/* ── Model catalog ─────────────────────────────────────────────────────── */

export interface ModelOption {
  /** Value passed to the adapter (`--model` / `-m` / API model id). */
  id: string;
  label: string;
  description?: string;
  /** `alias` tracks the latest model of a family (e.g. `sonnet`); `model` is a pinned id. */
  kind: 'alias' | 'model';
  /** Reasoning/effort levels this model accepts (empty: the adapter-level list applies). */
  efforts?: string[];
  defaultEffort?: string;
  contextWindow?: number;
  /** Listed by the provider but not recommended for new bindings. */
  hidden?: boolean;
}

export type ModelCatalogSource = 'cli' | 'api' | 'adapter' | 'builtin' | 'none';

export interface ModelCatalog {
  adapterId: string;
  models: ModelOption[];
  /** Adapter-level effort levels (used when a model lists none). */
  efforts: string[];
  /** Key of the adapter config that carries the effort (`effort`, `reasoningEffort`), or null when unsupported. */
  effortKey: string | null;
  /** Free-text model ids are still accepted (the dropdown offers "Custom…"). */
  allowCustom: boolean;
  /** The adapter's own default when no model is set, when known. */
  defaultModel: string | null;
  sources: ModelCatalogSource[];
  /** Why the list is partial (CLI missing, no API key, provider error…). */
  notes: string[];
  fetchedAt: number;
}

export interface ModelCatalogService {
  list(adapterId: string, opts?: { orgSlug?: string; authRef?: string; refresh?: boolean }): Promise<ModelCatalog>;
  /** Drop cached lists (all, or one adapter's): a CLI's catalog depends on the account it is logged in with. */
  invalidate(adapterId?: string): void;
}
