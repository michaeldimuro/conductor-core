import { useState } from 'react';
import { useProviders } from '../../components/binding-auth.js';
import { Button, Chip, ConfirmButton, ErrorNote, Load, Panel } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { LoginSession, ProviderAuthStatus } from '../../lib/api.js';
import { ago, dateTime } from '../../lib/format.js';
import { setQueryData, useAction } from '../../lib/query.js';
import { LoginForm, SessionView } from './LoginFlow.js';

const METHOD_TEXT: Record<ProviderAuthStatus['method'], string> = {
  subscription: 'Claude subscription', chatgpt: 'ChatGPT account', api_key: 'API key', oauth_token: 'long-lived token',
  cloud: 'cloud provider credentials', none: '', unknown: '',
};
const CRED_TEXT = { token: 'Long-lived token', api_key: 'API key' } as const;

function LoginChip({ s }: { s: ProviderAuthStatus }) {
  if (!s.installed) return <Chip tone="stop">Not installed</Chip>;
  if (s.loggedIn === 'yes') return <Chip tone="go">Logged in{METHOD_TEXT[s.method] ? ` with ${METHOD_TEXT[s.method]}` : ''}</Chip>;
  if (s.loggedIn === 'no') return <Chip tone="stop">Not logged in</Chip>;
  return <Chip tone="warn">Login unknown</Chip>;
}

function AccountCard({ status, orgId }: { status: ProviderAuthStatus; orgId: string | null }) {
  const [mode, setMode] = useState<'idle' | 'form' | 'session'>('idle');
  const [session, setSession] = useState<LoginSession | null>(null);
  const key = `providers/${orgId ?? ''}`;
  const put = (next: ProviderAuthStatus) => setQueryData<ProviderAuthStatus[]>(key, (prev) => prev?.map((p) => (p.provider === next.provider ? next : p)));
  const refresh = useAction(async () => put(await api.getProvider(status.provider, { ...(orgId ? { orgId } : {}), refresh: true })));
  const logout = useAction(async () => put(await api.logoutProvider(status.provider)), { success: `${status.label} CLI logged out`, invalidate: ['providers/'] });
  const forget = useAction(async (auth: 'token' | 'api_key', ref: string) => put(await api.forgetProviderCredential(status.provider, { auth, ref, ...(orgId ? { orgId } : {}) })), {
    success: 'Credential removed', invalidate: ['secret/', 'providers/'],
  });
  const resume = useAction(async (id: string) => {
    setSession(await api.getLoginSession(id));
    setMode('session');
  });
  const s = status;
  return (
    <section className="account" aria-label={`${s.label} account`}>
      <div className="row">
        <strong>{s.label}</strong>
        {s.version ? <Chip>{s.version}</Chip> : null}
        <LoginChip s={s} />
        {s.loggedIn === 'yes' && s.plan ? <Chip tone="info">{s.plan}</Chip> : null}
      </div>
      <p className="dim">
        {s.loggedIn === 'yes' && METHOD_TEXT[s.method] ? null : <>{s.detail[0]?.toUpperCase()}{s.detail.slice(1)}. </>}
        {s.expiresAt ? <>Expires {dateTime(s.expiresAt)}. </> : null}
        Checked {ago(s.checkedAt)}.
      </p>
      {s.storedCredentials.length ? (
        <div className="stack" style={{ gap: 4 }}>
          <span className="field-label">Stored for bindings</span>
          <ul className="cred-list">
            {s.storedCredentials.map((c) => (
              <li key={c.ref}>
                <span className="dim">{CRED_TEXT[c.auth]}</span>
                <code>{c.ref}</code>
                <Chip tone={c.present ? 'go' : 'idle'}>{c.present ? '✓ Stored' : '✗ Missing'}</Chip>
                {c.present ? (
                  <ConfirmButton icon="remove" small variant="quiet" danger label="Remove" title={`Remove ${c.ref}`} confirmLabel="Remove credential"
                    message={<>Bindings that use <code>{c.ref}</code> stop working until you store a credential again. The {s.label} CLI login on this Mac is not changed.</>}
                    onConfirm={() => forget.run(c.auth, c.ref)} />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {mode === 'idle' && s.activeSession ? (
        <div className="note note-info"><span>A login is in progress.</span><Button icon="view" small onClick={() => void resume.run(s.activeSession!)} busy={resume.busy}>Show it</Button></div>
      ) : null}
      {mode === 'form' ? <LoginForm status={s} orgId={orgId} onClose={() => setMode('idle')} onStarted={(x) => { setSession(x); setMode('session'); }} /> : null}
      {mode === 'session' && session ? (
        <SessionView key={session.id} initial={session} label={s.label} onDone={() => { setMode('idle'); setSession(null); }} onRetry={() => { setSession(null); setMode('form'); }} />
      ) : null}
      <ErrorNote error={refresh.error ?? logout.error} />
      <div className="row">
        {mode === 'idle' && s.installed ? <Button small variant={s.loggedIn === 'yes' ? 'default' : 'primary'} onClick={() => setMode('form')}>{s.loggedIn === 'yes' ? 'Log in again or add a credential' : 'Log in'}</Button> : null}
        <Button icon="refresh" small onClick={() => void refresh.run()} busy={refresh.busy}>Refresh</Button>
        {s.installed && s.loggedIn !== 'no' ? (
          <ConfirmButton icon="signOut" small variant="quiet" danger label="Log out of the CLI" title={`Log out of ${s.label}`} confirmLabel="Log out"
            message={<>This logs the {s.label} CLI out on this Mac for everything that uses it: your own terminal sessions, editors, and every Conductor agent bound with the CLI login. Stored long-lived credentials are kept.</>}
            onConfirm={() => logout.run()} />
        ) : null}
      </div>
    </section>
  );
}

/** Claude Code and Codex logins on this Mac, and the long-lived credentials bindings use. */
export function ProviderAccounts({ orgId }: { orgId: string | null }) {
  const q = useProviders(orgId);
  const recheck = useAction(async () => {
    const fresh = await api.listProviders({ ...(orgId ? { orgId } : {}), refresh: true });
    setQueryData<ProviderAuthStatus[]>(`providers/${orgId ?? ''}`, () => fresh);
  });
  return (
    <Panel icon="key" title="Provider accounts" actions={<Button icon="refresh" small busy={recheck.busy} onClick={() => void recheck.run()}>Check all again</Button>}>
      <p className="dim">How Conductor signs in to the agent CLIs on this Mac. Bindings with "This Mac's CLI login" use these logins; long-lived tokens and API keys are kept in the Keychain.</p>
      <Load q={q} lines={3}>
        {(list) => <div className="accounts">{list.map((s) => <AccountCard key={s.provider} status={s} orgId={orgId} />)}</div>}
      </Load>
    </Panel>
  );
}
