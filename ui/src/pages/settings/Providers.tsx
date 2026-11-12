import { useState } from 'react';
import { useAdapters } from '../../components/binding.js';
import { ModelSelect } from '../../components/models.js';
import { Button, Chip, ConfirmButton, Empty, ErrorNote, Field, Load, Panel, Status } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { AdapterHealth, AdapterInfo, LoginCodeResponse } from '../../lib/api.js';
import { dateTime } from '../../lib/format.js';
import { k, useAgents, useOrg } from '../../lib/org.js';
import { useAction, useQuery } from '../../lib/query.js';
import { toast } from '../../lib/toast.js';
import { ProviderAccounts } from './Accounts.js';

function Health({ health }: { health: AdapterHealth }) {
  return <span className="row row-tight"><Status value={health.ok ? 'ok' : 'failed'} label={health.ok ? 'Connected' : 'Failed'} />{health.version ? <Chip>{health.version}</Chip> : null}{health.detail ? <span className="dim">{health.detail}</span> : null}</span>;
}

function AdapterRow({ adapter, orgId }: { adapter: AdapterInfo; orgId: string }) {
  const [model, setModel] = useState('');
  const [authRef, setAuthRef] = useState('');
  const test = useAction(() => api.testAdapter(adapter.id, { model: model.trim() || null, authRef: authRef.trim() || null }), { quiet: true });
  const [result, setResult] = useState<AdapterHealth | null>(null);
  const caps = adapter.capabilities;
  return (
    <li className="connector">
      <div className="connector-head">
        <div className="grow">
          <div className="row"><strong>{adapter.name}</strong><code>{adapter.id}</code>{adapter.builtin ? null : <Chip tone="info">Plugin</Chip>}</div>
          <p className="row row-tight muted">
            {caps.tools ? <Chip>Tools</Chip> : null}{caps.mcp ? <Chip>MCP</Chip> : null}{caps.resume ? <Chip>Resumes sessions</Chip> : null}{caps.vision ? <Chip>Vision</Chip> : null}
            <Chip>Browser {caps.browser === 'native' ? 'built in' : 'through the gateway'}</Chip>
          </p>
        </div>
      </div>
      <form className="toolbar adapter-test" onSubmit={(e) => { e.preventDefault(); setResult(null); void test.run().then((h) => h && setResult(h)); }}>
        <ModelSelect hideLabel label={`Model to test with ${adapter.name}`} adapterId={adapter.id} orgId={orgId} value={model} onChange={setModel} />
        <input aria-label={`API key secret for ${adapter.name}`} placeholder="API key secret name (optional)" value={authRef} onChange={(e) => setAuthRef(e.target.value)} autoCapitalize="none" spellCheck={false} />
        <Button type="submit" busy={test.busy}>{test.busy ? 'Testing…' : 'Test connection'}</Button>
      </form>
      <div className="adapter-result" aria-live="polite">{result ? <Health health={result} /> : null}<ErrorNote error={test.error} /></div>
    </li>
  );
}

const EMBEDDING_KEYS = ['embeddings.provider', 'embeddings.authRef', 'embeddings.baseUrl'] as const;

function Embeddings() {
  const settings = useQuery('settings', () => api.listSettings());
  const value = (key: string): string => {
    const v = settings.data?.find((s) => s.key === key)?.value;
    return typeof v === 'string' ? v : '';
  };
  const [draft, setDraft] = useState<Record<string, string>>({});
  const current = (key: string) => draft[key] ?? value(key);
  const save = useAction(async () => {
    await api.putSetting('embeddings.provider', current('embeddings.provider') || 'local');
    await api.putSetting('embeddings.authRef', current('embeddings.authRef').trim() || null);
    await api.putSetting('embeddings.baseUrl', current('embeddings.baseUrl').trim() || null);
    setDraft({});
  }, { invalidate: ['settings'], success: 'Embedding settings saved' });
  return (
    <Panel icon="database" title="Memory embeddings">
      <Load q={settings} lines={2}>
        {() => (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
            <div className="form-grid">
              <Field label="Provider" hint="Local runs on this Mac and sends nothing out.">
                <select value={current('embeddings.provider') || 'local'} onChange={(e) => setDraft({ ...draft, 'embeddings.provider': e.target.value })}><option value="local">Local</option><option value="openai">OpenAI-compatible API</option></select>
              </Field>
              <Field label="API key secret"><input value={current('embeddings.authRef')} onChange={(e) => setDraft({ ...draft, 'embeddings.authRef': e.target.value })} placeholder="conductor/openai-api-key" autoCapitalize="none" spellCheck={false} /></Field>
              <Field label="API base URL"><input type="url" value={current('embeddings.baseUrl')} onChange={(e) => setDraft({ ...draft, 'embeddings.baseUrl': e.target.value })} placeholder="https://api.openai.com/v1" /></Field>
            </div>
            <ErrorNote error={save.error} />
            <div className="form-actions"><Button icon="check" type="submit" variant="primary" busy={save.busy} disabled={!EMBEDDING_KEYS.some((key) => draft[key] !== undefined)}>Save embedding settings</Button></div>
          </form>
        )}
      </Load>
    </Panel>
  );
}

export function Providers() {
  const { org } = useOrg();
  const adapters = useAdapters();
  const [checking, setChecking] = useState(false);
  const doctor = useQuery(checking ? k(org.id, 'doctor') : null, () => api.doctor({ orgId: org.id }));
  return (
    <div className="stack-lg">
      <ProviderAccounts orgId={org.id} />
      <Panel icon="link" title={`Bindings used by ${org.name}`} actions={<Button small busy={doctor.fetching} onClick={() => (checking ? doctor.reload() : setChecking(true))}>{doctor.fetching ? 'Testing…' : 'Test all bindings'}</Button>}>
        {!checking ? <p className="dim">Runs a live connection test for the organization default and every agent's own binding. This can take a few seconds per provider.</p> : (
          <Load q={doctor} lines={3}>
            {(d) => (d.bindings?.length ? (
              <table className="table">
                <thead><tr><th>Used by</th><th>Adapter</th><th>Model</th><th>Result</th></tr></thead>
                <tbody>
                  {d.bindings.map((b) => (
                    <tr key={`${b.source}-${b.adapter}-${b.model}`}>
                      <td data-label="Used by">{b.source === 'org-default' ? 'Organization default' : b.source.replace('agent:', '')}</td>
                      <td data-label="Adapter"><code>{b.adapter}</code></td><td data-label="Model">{b.model ?? 'Adapter default'}</td>
                      <td data-label="Result"><Health health={b.health} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty icon="model" title="No provider is bound yet"><p>Set a default provider under Organization.</p></Empty>)}
          </Load>
        )}
      </Panel>
      <Panel icon="model" title="Installed adapters" flush>
        <Load q={adapters} empty={<Empty icon="model" title="No adapters are installed" />}>
          {(list) => <ul className="connectors">{list.map((a) => <AdapterRow key={a.id} adapter={a} orgId={org.id} />)}</ul>}
        </Load>
      </Panel>
      <Embeddings />
    </div>
  );
}

function SecretRow({ secretRef, usedBy, onGone }: { secretRef: string; usedBy?: string; onGone?: () => void }) {
  const key = `secret/${secretRef}`;
  const status = useQuery(key, () => api.secretExists(secretRef));
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const save = useAction(async () => {
    await api.putSecret(secretRef, value);
    setValue('');
    setEditing(false);
  }, { invalidate: [key], success: 'Secret stored' });
  const remove = useAction(async () => {
    await api.deleteSecret(secretRef);
    onGone?.();
  }, { invalidate: [key], success: 'Secret deleted' });
  return (
    <li>
      <div className="grow">
        <code>{secretRef}</code> {status.data ? <Chip tone={status.data.exists ? 'go' : 'stop'}>{status.data.exists ? 'Stored' : 'Missing'}</Chip> : status.error ? <Chip tone="stop">Could not check</Chip> : null}
        {usedBy ? <span className="field-hint">{usedBy}</span> : null}
      </div>
      {editing ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (value) void save.run(); }}>
          <input type="password" aria-label={`New value for ${secretRef}`} autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 200 }} autoFocus />
          <Button icon="lock" small type="submit" variant="primary" busy={save.busy} disabled={!value}>Store</Button>
          <Button small onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      ) : (
        <div className="row row-tight">
          <Button small onClick={() => setEditing(true)}>{status.data?.exists ? 'Replace' : 'Set'}</Button>
          {status.data?.exists ? <ConfirmButton icon="remove" small variant="quiet" danger label="Delete" title="Delete this secret" confirmLabel="Delete secret" message={<>Anything that uses <code>{secretRef}</code> stops working until you set it again.</>} onConfirm={() => remove.run()} /> : null}
        </div>
      )}
    </li>
  );
}

export function Secrets() {
  const { org } = useOrg();
  const agents = useAgents(org.id);
  const gateways = useQuery('gateways', () => api.listGateways());
  const webhooks = useQuery(k(org.id, 'webhooks'), () => api.listWebhooks(org.id));
  const [extra, setExtra] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const refs = new Map<string, string>();
  const add = (ref: string | null | undefined, usedBy: string) => {
    if (ref && !refs.has(ref)) refs.set(ref, usedBy);
  };
  for (const b of [org.defaultProvider, ...(org.defaultProvider?.fallback ?? [])]) add(b?.authRef, 'Organization default provider');
  add(org.utilityModel?.authRef, 'Utility model');
  for (const a of agents.data ?? []) for (const b of [a.providerBinding, ...(a.providerBinding?.fallback ?? [])]) add(b?.authRef, `${a.name}'s provider`);
  for (const g of gateways.data ?? []) if (!g.orgId || g.orgId === org.id) add(g.authRef, `${g.name} messaging gateway`);
  for (const w of webhooks.data ?? []) add(w.secretRef, `${w.name} webhook`);
  add(`org/${org.slug}/anthropic-api-key`, 'Tried for Claude API bindings that name no secret');
  add(`org/${org.slug}/openai-api-key`, 'Tried for OpenAI API bindings that name no secret');
  add('conductor/anthropic-api-key', 'Fallback Claude API key for every organization');
  add('conductor/openai-api-key', 'Fallback OpenAI API key for every organization');
  for (const r of extra) add(r, 'Added here');
  const valid = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,200}$/.test(draft.trim()) && !draft.includes('..');
  return (
    <div className="stack-lg page-narrow">
      <Panel icon="lock" title="Secrets" flush>
        <p className="panel-body dim">Secrets live in the Mac's keychain, never in the database. They are write-only here: you can set, replace or delete a value, but nothing can read it back. Connector credentials are managed on the Connectors page.</p>
        <ul className="tool-list">{[...refs.entries()].map(([ref, usedBy]) => <SecretRow key={ref} secretRef={ref} usedBy={usedBy} onGone={() => setExtra((x) => x.filter((r) => r !== ref))} />)}</ul>
      </Panel>
      <Panel icon="key" title="Another secret">
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (valid) { setExtra([...extra, draft.trim()]); setDraft(''); } else toast('Secret names use letters, digits and . _ : / @ - only.', 'error'); }}>
          <input className="grow mono" aria-label="Secret name" placeholder={`org/${org.slug}/my-secret`} value={draft} onChange={(e) => setDraft(e.target.value)} autoCapitalize="none" spellCheck={false} style={{ width: 'auto' }} />
          <Button type="submit" disabled={!draft.trim()}>Check or set</Button>
        </form>
      </Panel>
    </div>
  );
}

export function RemoteAccess() {
  const doctor = useQuery('doctor', () => api.doctor());
  const setting = useQuery('setting/public-url', () => api.getSetting('daemon.public_url'));
  const [url, setUrl] = useState<string | null>(null);
  const [label, setLabel] = useState('phone');
  const [days, setDays] = useState('30');
  const [code, setCode] = useState<LoginCodeResponse | null>(null);
  const stored = typeof setting.data?.value === 'string' ? setting.data.value : '';
  const save = useAction(async () => {
    await api.putSetting('daemon.public_url', (url ?? stored).trim() || null);
    setUrl(null);
  }, { invalidate: ['doctor', 'setting/', 'status'], success: 'Public address saved. Run "conductor restart" to apply it.' });
  // The daemon reads this setting when it starts, so a saved value can differ from the one in use.
  const inUse = doctor.data ? (doctor.data.publicUrlConfigured ? doctor.data.publicUrl : '') : null;
  const pendingRestart = inUse !== null && setting.data !== undefined && stored.replace(/\/+$/, '') !== inUse.replace(/\/+$/, '');
  const pair = useAction(async () => setCode(await api.createLoginCode({ label: label.trim() || 'device', ttlMs: Math.round(Number(days) * 86_400_000) })));
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast('Copied', 'ok'), () => toast('Copy failed. Select the text and copy it by hand.', 'error'));
  return (
    <div className="stack-lg page-narrow">
      <Panel icon="server" title="Daemon">
        <Load q={doctor} lines={3}>
          {(d) => (
            <dl className="kv">
              <div><dt>Version</dt><dd>{d.version}</dd></div>
              <div><dt>Home</dt><dd><code>{d.home}</code></dd></div>
              <div><dt>Local address</dt><dd><code>{d.baseUrl}</code></dd></div>
              <div><dt>Public address</dt><dd><code>{d.publicUrl}</code> {d.publicUrlConfigured ? <Chip tone="go">Tunnel configured</Chip> : <Chip tone="warn">Local only</Chip>}</dd></div>
              <div><dt>Secret store</dt><dd><Status value={d.secretStore.reachable ? 'ok' : 'failed'} label={d.secretStore.reachable ? 'Reachable' : 'Unreachable'} />{d.secretStore.detail ? <span className="dim"> {d.secretStore.detail}</span> : null}</dd></div>
            </dl>
          )}
        </Load>
      </Panel>
      <Panel icon="link" title="Public address (tunnel)">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <p className="dim">The address your phone uses to reach this Mac, for example a Tailscale or Cloudflare Tunnel hostname. Takeover links, pairing links and inbound webhook addresses are built from it. Nothing is exposed on a public port by default.</p>
          <Field label="Public URL" hint="Empty means links use the local address and only work on this Mac. Changes apply when the daemon restarts.">
            <input type="url" value={url ?? stored} onChange={(e) => setUrl(e.target.value)} placeholder="https://my-mac.tailnet-name.ts.net" autoCapitalize="none" spellCheck={false} />
          </Field>
          <ErrorNote error={save.error ?? setting.error} />
          {pendingRestart ? <p className="note note-warn" role="status"><span>{stored ? <>Saved as <code>{stored}</code>, but the running daemon has not picked it up.</> : 'The public address was cleared, but the running daemon still uses the old one.'} Run <code>conductor restart</code> on the Mac to apply it.</span></p> : null}
          <div className="form-actions"><Button icon="check" type="submit" variant="primary" busy={save.busy} disabled={url === null || url === stored}>Save public address</Button></div>
        </form>
      </Panel>
      <Panel icon="phone" title="Pair a phone or another device">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void pair.run(); }}>
          <div className="form-grid">
            <Field label="Device name"><input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} /></Field>
            <Field label="Stays signed in for (days)"><input type="number" min="1" max="90" value={days} onChange={(e) => setDays(e.target.value)} required /></Field>
          </div>
          <div className="form-actions"><Button icon="link" type="submit" busy={pair.busy}>Create a one-time sign-in link</Button></div>
          {code ? (
            <div className="note note-info pair" aria-live="polite">
              <div className="stack grow">
                <span>Open this on the device before {dateTime(code.expiresAt)}. It works once.</span>
                <code className="pair-url">{code.remoteUrl}</code>
              </div>
              <Button icon="copy" small onClick={() => void copy(code.remoteUrl)}>Copy link</Button>
            </div>
          ) : null}
        </form>
      </Panel>
    </div>
  );
}
