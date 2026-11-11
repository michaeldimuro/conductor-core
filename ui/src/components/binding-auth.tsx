import { useId } from 'react';
import { api } from '../lib/api.js';
import type { BindingAuth, CliProvider, ProviderAuthStatus } from '../lib/api.js';
import { useQuery, type QueryResult } from '../lib/query.js';
import { Chip } from './ui.js';

/** Local CLI adapters and the login they use. */
export const CLI_OF_ADAPTER: Record<string, CliProvider> = { claude_local: 'claude', codex_local: 'codex' };

/** Status of the Claude Code / Codex logins; with an org, its org-scoped credential refs too. */
export function useProviders(orgId?: string | null, enabled = true): QueryResult<ProviderAuthStatus[]> {
  return useQuery(enabled ? `providers/${orgId ?? ''}` : null, () => api.listProviders(orgId ? { orgId } : {}));
}

export const AUTH_LABEL: Record<BindingAuth, string> = { login: "This Mac's CLI login", token: 'Long-lived token', api_key: 'API key (metered)' };

export function authModesFor(adapterId: string): BindingAuth[] {
  if (adapterId === 'claude_local') return ['login', 'token', 'api_key'];
  if (adapterId === 'codex_local') return ['login', 'api_key'];
  return [];
}

/** Presence lamp for one secret ref (shares the cache key with the Secrets page). */
function RefPresence({ secretRef }: { secretRef: string }) {
  const q = useQuery(`secret/${secretRef}`, () => api.secretExists(secretRef));
  if (!q.data) return q.error ? <Chip tone="warn">Could not check</Chip> : null;
  return <Chip tone={q.data.exists ? 'go' : 'stop'}>{q.data.exists ? '✓ Stored' : '✗ Missing'}</Chip>;
}

/**
 * How a local CLI binding authenticates, and which stored credential it will use.
 * `login` is the default and is omitted from the saved binding.
 */
export function AuthSelect({ adapterId, auth, authRef, orgId, onChange }: {
  adapterId: string; auth: BindingAuth | undefined; authRef: string; orgId?: string | null; onChange: (auth: BindingAuth) => void;
}) {
  const id = useId();
  const modes = authModesFor(adapterId);
  const mode = auth ?? 'login';
  const cli = CLI_OF_ADAPTER[adapterId];
  const providers = useProviders(orgId, mode !== 'login');
  if (!modes.length) return null;
  const status = providers.data?.find((p) => p.provider === cli);
  const creds = mode === 'login' ? [] : (status?.storedCredentials ?? []).filter((c) => c.auth === mode);
  const firstPresent = creds.find((c) => c.present);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>Authentication</label>
      <select id={id} value={mode} onChange={(e) => onChange(e.target.value as BindingAuth)}>
        {modes.map((m) => <option key={m} value={m}>{AUTH_LABEL[m]}</option>)}
        {!modes.includes(mode) ? <option value={mode}>{mode} (not supported by this adapter)</option> : null}
      </select>
      {mode === 'login' ? (
        <span className="field-hint">Runs use whatever account the {cli === 'claude' ? 'Claude Code' : 'Codex'} CLI is logged in with on this Mac (Settings, Providers).</span>
      ) : authRef.trim() ? (
        <span className="field-hint">Uses <code>{authRef.trim()}</code> <RefPresence secretRef={authRef.trim()} /></span>
      ) : (
        <span className="field-hint">
          {providers.loading ? 'Checking stored credentials…' : creds.length ? (
            <>
              {firstPresent ? <>Uses <code>{firstPresent.ref}</code>.</> : 'No credential is stored yet; add one under Settings, Providers.'}
              <ul className="cred-list">
                {creds.map((c) => <li key={c.ref}><code>{c.ref}</code><Chip tone={c.present ? 'go' : 'stop'}>{c.present ? '✓ Stored' : '✗ Missing'}</Chip></li>)}
              </ul>
            </>
          ) : 'Name the secret that holds the credential below.'}
        </span>
      )}
      {mode === 'api_key' ? <span className="field-hint">API-key runs are billed per token and count against budgets.</span> : null}
    </div>
  );
}
