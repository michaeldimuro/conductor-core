import { useEffect, useId, useRef, useState } from 'react';
import { Button, Chip, ErrorNote, Field } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { LoginMethod, LoginSession, ProviderAuthStatus, StartLoginBody } from '../../lib/api.js';
import { invalidate, useAction } from '../../lib/query.js';
import { toast } from '../../lib/toast.js';

const POLL_MS = 1500;
const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const STATE_TONE = { starting: 'info', waiting: 'warn', verifying: 'info', succeeded: 'go', failed: 'stop', cancelled: 'idle', expired: 'stop' } as const;
const STATE_TEXT: Record<LoginSession['state'], string> = {
  starting: 'Starting', waiting: 'Waiting for you', verifying: 'Checking', succeeded: 'Logged in', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired',
};

export const copyText = (text: string, what = 'Copied'): Promise<void> =>
  navigator.clipboard.writeText(text).then(() => toast(what, 'ok'), () => toast('Copy failed. Select the text and copy it by hand.', 'error'));

/** Refresh every view of provider status (Settings and binding editors). */
export const refreshProviders = (): void => invalidate('providers/', 'models/', 'secret/');

/** One login in progress: link, device code, code paste, live state, cancel. Polls until it ends. */
export function SessionView({ initial, label, onDone, onRetry }: { initial: LoginSession; label: string; onDone: () => void; onRetry: () => void }) {
  const [session, setSession] = useState(initial);
  const [code, setCode] = useState('');
  const [pollError, setPollError] = useState<unknown>(undefined);
  const announced = useRef(false);
  const finished = FINISHED.has(session.state);

  useEffect(() => {
    if (finished) return;
    let stop = false;
    const t = window.setInterval(() => {
      api.getLoginSession(session.id).then((s) => !stop && (setSession(s), setPollError(undefined)), (e: unknown) => !stop && setPollError(e));
    }, POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [session.id, finished]);

  useEffect(() => {
    if (!finished || announced.current) return;
    announced.current = true;
    refreshProviders();
    if (session.state === 'succeeded') toast(`${label}: ${session.storedRef ? `stored as ${session.storedRef}` : 'logged in'}`, 'ok');
  }, [finished, session.state, session.storedRef, label]);

  const send = useAction(async () => {
    const c = code.trim();
    setCode('');
    setSession(await api.submitLoginCode(session.id, c));
  });
  const cancel = useAction(async () => setSession(await api.cancelLogin(session.id)));

  return (
    <div className="login-flow" aria-live="polite">
      <div className="row"><Chip tone={STATE_TONE[session.state]}>{STATE_TEXT[session.state]}</Chip><span className="dim">{session.message}</span></div>
      {session.url && !finished ? (
        <div className="stack">
          <span>{session.userCode ? 'Open this page on any device and enter the code below.' : session.needsCode ? 'Open this page, sign in, then paste the code it shows.' : 'Open this page and finish signing in.'}</span>
          <code className="pair-url">{session.url}</code>
          <div className="row">
            <a className="btn btn-primary btn-sm" href={session.url} target="_blank" rel="noopener noreferrer">Open the sign-in page</a>
            <Button small onClick={() => void copyText(session.url!, 'Link copied')}>Copy link</Button>
          </div>
        </div>
      ) : null}
      {session.userCode && !finished ? (
        <div className="stack">
          <p className="pair-code mono" aria-label="One-time code">{session.userCode}</p>
          <div><Button small onClick={() => void copyText(session.userCode!, 'Code copied')}>Copy code</Button></div>
        </div>
      ) : null}
      {session.needsCode && session.state === 'waiting' ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (code.trim()) void send.run(); }}>
          <input className="grow mono" aria-label="Paste the code" placeholder="Paste the code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} style={{ width: 'auto' }} />
          <Button small type="submit" variant="primary" busy={send.busy} disabled={!code.trim()}>Send code</Button>
        </form>
      ) : null}
      <ErrorNote error={pollError} />
      <div className="row">
        {!finished ? <Button small onClick={() => void cancel.run()} busy={cancel.busy}>Cancel</Button> : null}
        {finished && session.state !== 'succeeded' ? <Button small variant="primary" onClick={onRetry}>Try again</Button> : null}
        {finished ? <Button small onClick={onDone}>{session.state === 'succeeded' ? 'Done' : 'Close'}</Button> : null}
      </div>
    </div>
  );
}

/** Pick a login method, enter a credential when it needs one, and start. */
export function LoginForm({ status, orgId, onStarted, onClose }: {
  status: ProviderAuthStatus; orgId: string | null; onStarted: (s: LoginSession) => void; onClose: () => void;
}) {
  const name = useId();
  const methods = status.loginMethods;
  const [method, setMethod] = useState<LoginMethod>(methods.find((m) => m.remoteFriendly)?.method ?? methods[0]?.method ?? 'device');
  const info = methods.find((m) => m.method === method);
  const [secret, setSecret] = useState('');
  const [secretRef, setSecretRef] = useState('');
  const kind = method === 'token' ? 'token' : method === 'api_key' ? 'api_key' : null;
  const refs = kind ? status.storedCredentials.filter((c) => c.auth === kind).map((c) => c.ref) : [];
  const [keep, setKeep] = useState(method === 'token');
  const [saveAs, setSaveAs] = useState('');
  const target = saveAs || refs[0] || '';

  const start = useAction(async () => {
    const body: StartLoginBody = { method, ...(orgId ? { orgId } : {}) };
    if (kind) {
      if (secretRef.trim()) body.secretRef = secretRef.trim();
      else body.secret = secret.trim();
      if ((kind === 'token' || keep) && target) body.saveAs = target;
    }
    // The pasted value leaves component state before the request is even sent.
    setSecret('');
    return api.startLogin(status.provider, body);
  });

  const submit = async () => {
    const s = await start.run();
    if (!s) return;
    if (s.state === 'succeeded' && kind === 'token') {
      refreshProviders();
      toast(`Token stored as ${s.storedRef ?? target}`, 'ok');
      onClose();
      return;
    }
    onStarted(s);
  };

  return (
    <form className="login-flow" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <fieldset>
        <legend>Log in to {status.label}</legend>
        <div className="choice-list">
          {methods.map((m) => (
            <label key={m.method} className={`choice${method === m.method ? ' on' : ''}`}>
              <input type="radio" name={name} checked={method === m.method} onChange={() => { setMethod(m.method); setKeep(m.method === 'token'); setSaveAs(''); }} />
              <span>
                <strong>{m.label}</strong> {m.remoteFriendly ? null : <Chip tone="warn">Only at the Mac</Chip>}
                <span className="field-hint">{m.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {kind ? (
        <div className="form-grid">
          <Field
            label={kind === 'token' ? 'Long-lived token' : 'API key'}
            hint={kind === 'token' ? <>In Terminal on any machine with Claude Code, run <code>claude setup-token</code>, sign in, and paste the token it prints (it starts with <code>sk-ant-</code>).</> : 'Create one at platform.openai.com. It is sent once and never shown again.'}
          >
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={!!secretRef.trim()} />
          </Field>
          <Field label="Or use a stored secret" hint="The name of a secret already in the Keychain.">
            <input value={secretRef} onChange={(e) => setSecretRef(e.target.value)} placeholder={refs[refs.length - 1] ?? ''} autoCapitalize="none" spellCheck={false} />
          </Field>
          {kind === 'api_key' ? (
            <div className="field-wide">
              <label className="check">
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
                <span>Also keep it for bindings that use "API key (metered)"</span>
              </label>
            </div>
          ) : null}
          {(kind === 'token' || keep) && refs.length ? (
            <Field label="Keep it as" hint="Org-scoped refs are tried before the shared conductor/ one.">
              <select value={target} onChange={(e) => setSaveAs(e.target.value)}>
                {refs.map((r) => <option key={r} value={r}>{r}{r.startsWith('org/') ? ' (this organization)' : ' (every organization)'}</option>)}
              </select>
            </Field>
          ) : null}
        </div>
      ) : null}
      {info && !info.remoteFriendly ? <p className="note note-warn">This opens a browser window on the Mac running Conductor. Use it only when you are sitting at that Mac.</p> : null}
      <ErrorNote error={start.error} />
      <div className="row">
        <Button type="submit" variant="primary" busy={start.busy} disabled={!!kind && !secret.trim() && !secretRef.trim()}>{kind === 'token' ? 'Store token' : 'Start login'}</Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}
