import { useEffect, useState } from 'react';
import { Button, Chip, ConfirmButton, Empty, Field, FormShell, JsonField, Load, Modal, Panel, Segmented, Status, TagInput } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { CreateWebhookRequest, Gateway, GatewayStatusDto, WebhookDto, WebhookSource } from '../../lib/api.js';
import { humanize } from '../../lib/format.js';
import { k, useDirectory, useOrg } from '../../lib/org.js';
import { useAction, useQuery } from '../../lib/query.js';
import { toast } from '../../lib/toast.js';

const GATEWAY_KINDS = ['telegram', 'slack', 'discord', 'imessage', 'email'] as const;
const NOTIFY_KINDS = ['approval', 'review', 'digest', 'budget', 'takeover'];
/** Config keys the form edits directly; everything else stays in the advanced JSON. */
const FORM_KEYS = ['allowedChatIds', 'allowedUserIds', 'notify'];
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function GatewayForm({ onClose, gateway }: { onClose: () => void; gateway?: Gateway }) {
  const { org } = useOrg();
  const cfg = gateway?.config ?? {};
  const [kind, setKind] = useState<Gateway['kind']>(gateway?.kind ?? 'telegram');
  const [name, setName] = useState(gateway?.name ?? '');
  const [allOrgs, setAllOrgs] = useState(gateway ? gateway.orgId === null : false);
  const [chats, setChats] = useState(strings(cfg.allowedChatIds));
  const [users, setUsers] = useState(strings(cfg.allowedUserIds));
  const [notify, setNotify] = useState(strings(cfg.notify));
  const [extra, setExtra] = useState<Record<string, unknown>>(Object.fromEntries(Object.entries(cfg).filter(([key]) => !FORM_KEYS.includes(key))));
  const [authRef, setAuthRef] = useState(gateway?.authRef ?? '');
  const [token, setToken] = useState('');
  const defaultRef = `${allOrgs ? 'conductor' : `org/${org.slug}`}/gateway/${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || kind}`;
  const save = useAction(async () => {
    const ref = authRef.trim() || (token ? defaultRef : '');
    if (token && ref) await api.putSecret(ref, token);
    const config = { ...extra, allowedChatIds: chats, allowedUserIds: users, ...(notify.length ? { notify } : {}) };
    const input = { name: name.trim(), orgId: allOrgs ? null : org.id, config, authRef: ref || null };
    if (gateway) await api.updateGateway(gateway.id, input);
    else await api.createGateway({ ...input, kind });
    onClose();
  }, { invalidate: ['gateways', 'secret/'], success: gateway ? 'Gateway saved' : 'Gateway added' });
  return (
    <FormShell onSubmit={() => void save.run()} onCancel={onClose} busy={save.busy} error={save.error} submitLabel={gateway ? 'Save gateway' : 'Add gateway'}>
      <div className="form-grid">
        <Field label="Platform">
          <select value={kind} disabled={!!gateway} onChange={(e) => setKind(e.target.value as Gateway['kind'])}>{GATEWAY_KINDS.map((x) => <option key={x} value={x}>{x === 'imessage' ? 'iMessage' : humanize(x)}</option>)}</select>
        </Field>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="My Telegram" /></Field>
        <Field label="Serves">
          <Segmented label="Gateway scope" value={allOrgs ? 'all' : 'org'} onChange={(v) => setAllOrgs(v === 'all')} options={[{ value: 'org', label: org.name }, { value: 'all', label: 'Every organization' }]} />
        </Field>
      </div>
      <fieldset>
        <legend>Who may talk to it</legend>
        <p className="muted">Only allow-listed chats and users can chat with agents or approve actions. Everyone else is ignored.</p>
        <div className="form-grid">
          <Field label="Allowed chat ids"><TagInput label="Allowed chat ids" value={chats} onChange={setChats} placeholder="Paste a chat id and press Enter" /></Field>
          <Field label="Allowed user ids"><TagInput label="Allowed user ids" value={users} onChange={setUsers} placeholder="Paste a user id and press Enter" /></Field>
        </div>
      </fieldset>
      <fieldset>
        <legend>What it delivers</legend>
        <div className="row">
          {NOTIFY_KINDS.map((n) => (
            <label key={n} className="check"><input type="checkbox" checked={notify.length === 0 || notify.includes(n)} onChange={(e) => {
              const base = notify.length === 0 ? NOTIFY_KINDS : notify;
              const next = e.target.checked ? [...new Set([...base, n])] : base.filter((x) => x !== n);
              setNotify(next.length === NOTIFY_KINDS.length ? [] : next);
            }} /><span>{humanize(n)}</span></label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Credentials</legend>
        <div className="form-grid">
          <Field label="Secret name" hint={`Left empty, a new token is stored as ${defaultRef}.`}><input value={authRef} onChange={(e) => setAuthRef(e.target.value)} autoCapitalize="none" spellCheck={false} placeholder={defaultRef} /></Field>
          <Field label={gateway?.authRef ? 'Replace the token' : 'Bot token'} hint="Write-only. A bare token, or a JSON object of named credentials for platforms that need several.">
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
        </div>
      </fieldset>
      <details>
        <summary>Advanced platform settings (JSON)</summary>
        <JsonField label="Other non-secret config" value={extra} onChange={setExtra} hint='Platform-specific sections such as "smtp" and "imap" for email, or "secretRefs" naming extra secrets.' />
      </details>
    </FormShell>
  );
}

const PAIRING_TTL_MS = 10 * 60_000;
/** What the daemon reports for a gateway right now: `active` means its listener is running. */
const LIVE: Record<string, { tone: 'go' | 'warn' | 'stop' | 'idle'; label: string }> = {
  active: { tone: 'go', label: 'Connected' }, stopped: { tone: 'warn', label: 'Not connected' }, error: { tone: 'stop', label: 'Error' }, disabled: { tone: 'idle', label: 'Disabled' },
};
const liveLabel = (status: string) => LIVE[status] ?? { tone: 'idle' as const, label: humanize(status) };

/**
 * Pairing: mint a one-time code, show it, and watch the gateway's allow-list
 * until the chat that sent `/pair <code>` appears in it.
 */
function PairGateway({ gateway, live, onClose }: { gateway: Gateway; live: GatewayStatusDto | undefined; onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [mintedAt, setMintedAt] = useState(0);
  const [before, setBefore] = useState(0);
  const [now, setNow] = useState(Date.now());
  const allowed = strings(gateway.config.allowedChatIds).length;
  const mint = useAction(async () => {
    const r = await api.gatewayPairingCode(gateway.id);
    setBefore(allowed);
    setSawPending(false);
    setCode(r.code);
    setMintedAt(Date.now());
  });
  useEffect(() => {
    void mint.run();
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
    // Mint once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const left = Math.max(0, Math.ceil((mintedAt + PAIRING_TTL_MS - now) / 1000));
  // The daemon keeps only a hash of the code and drops it once the code is redeemed (or guessed wrong too often).
  const pendingOnServer = typeof gateway.config.pairingCodeHash === 'string';
  const [sawPending, setSawPending] = useState(false);
  useEffect(() => {
    if (code !== null && pendingOnServer) setSawPending(true);
  }, [code, pendingOnServer]);
  const paired = code !== null && allowed > before;
  const consumed = code !== null && sawPending && !pendingOnServer && !paired;
  const notRunning = !live || live.status !== 'active';
  return (
    <div className="stack">
      {notRunning ? <p className="note note-warn">This gateway is {live ? liveLabel(live.status).label.toLowerCase() : 'not running'}{live?.lastError ? `: ${live.lastError}` : ''}. It has to be connected before it can receive the code.</p> : null}
      {paired ? (
        <p className="note" role="status"><strong>Paired.</strong> That chat can now talk to your agents and receive approvals and takeover links.</p>
      ) : code === null ? (
        mint.error ? <p className="note note-stop">Could not create a pairing code. Close this dialog and try again.</p> : <p className="muted">Creating a pairing code</p>
      ) : consumed ? (
        <p className="note note-warn">This code is no longer valid. Either a chat that was already paired used it (nothing changed), or it was cancelled after too many wrong attempts. Create a new code to try again.</p>
      ) : left === 0 ? (
        <p className="note note-warn">This code has expired.</p>
      ) : (
        <>
          <p>From the chat you want to connect, send this message to the {gateway.kind === 'imessage' ? 'iMessage address' : 'bot'}:</p>
          <p className="pair-code" aria-label="Pairing command"><code>/pair {code}</code></p>
          <p className="muted" aria-live="polite">Works once. Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}. Waiting for the message…</p>
        </>
      )}
      <div className="form-actions">
        {!paired && code !== null ? <Button busy={mint.busy} onClick={() => void mint.run()}>New code</Button> : null}
        <Button variant="primary" onClick={onClose}>{paired ? 'Done' : 'Close'}</Button>
      </div>
    </div>
  );
}

export function Gateways() {
  const { org } = useOrg();
  const [pairing, setPairing] = useState<string | null>(null);
  // While a pairing dialog is open the allow-list is polled so the result shows up on its own.
  const gateways = useQuery('gateways', () => api.listGateways(), { pollMs: pairing ? 2000 : undefined });
  const liveQ = useQuery('gateways/status', () => api.gatewayStatus(), { pollMs: pairing ? 2000 : 5000 });
  const liveOf = (id: string) => liveQ.data?.find((s) => s.id === id);
  const pairingGateway = (gateways.data ?? []).find((g) => g.id === pairing);
  const [form, setForm] = useState<{ gateway?: Gateway } | null>(null);
  const inv = { invalidate: ['gateways'] };
  const setStatus = useAction((g: Gateway, status: 'active' | 'disabled') => api.updateGateway(g.id, { status }), inv);
  const remove = useAction((g: Gateway) => api.deleteGateway(g.id), { ...inv, success: 'Gateway removed' });
  const mine = (gateways.data ?? []).filter((g) => g.orgId === null || g.orgId === org.id);
  return (
    <div className="stack-lg">
      <Panel title="Messaging gateways" flush actions={<Button small variant="primary" onClick={() => setForm({})}>Add gateway</Button>}>
        <Load q={gateways} lines={2}>
          {() => (mine.length === 0 ? <Empty title="No messaging gateway is connected"><p>Connect Telegram, Slack, Discord, iMessage or email to chat with agents, approve actions and receive takeover links away from this console.</p></Empty> : (
            <ul className="connectors">
              {mine.map((g) => (
                <li key={g.id} className="connector">
                  <div className="connector-head">
                    <div className="grow">
                      <div className="row">
                        <strong>{g.name}</strong><Chip>{g.kind === 'imessage' ? 'iMessage' : humanize(g.kind)}</Chip>
                        {g.status === 'disabled' ? <Status value="disabled" /> : liveOf(g.id) ? <Chip tone={liveLabel(liveOf(g.id)!.status).tone}>{liveLabel(liveOf(g.id)!.status).label}</Chip> : <Chip tone="warn">{liveQ.loading ? 'Checking' : 'Not running'}</Chip>}
                        <Chip>{g.orgId ? org.name : 'Every organization'}</Chip>
                      </div>
                      {liveOf(g.id)?.lastError ?? g.lastError ? <p className="note note-stop">{liveOf(g.id)?.lastError ?? g.lastError}</p> : null}
                      <p className="muted">{strings(g.config.allowedChatIds).length} allowed chats, {strings(g.config.allowedUserIds).length} allowed users{g.authRef ? '' : ', no credentials set'}</p>
                    </div>
                    <div className="row row-tight">
                      <Button small variant="primary" disabled={g.status === 'disabled'} title={g.status === 'disabled' ? 'Enable the gateway first' : undefined} onClick={() => setPairing(g.id)}>Pair a chat</Button>
                      <Button small onClick={() => setForm({ gateway: g })}>Edit</Button>
                      <Button small busy={setStatus.busy} onClick={() => void setStatus.run(g, g.status === 'disabled' ? 'active' : 'disabled')}>{g.status === 'disabled' ? 'Enable' : 'Disable'}</Button>
                      <ConfirmButton small variant="quiet" danger label="Remove" title={`Remove ${g.name}`} confirmLabel="Remove gateway" message="Messages from this platform stop reaching your agents." onConfirm={() => remove.run(g)} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ))}
        </Load>
      </Panel>
      <Modal open={form !== null} onClose={() => setForm(null)} title={form?.gateway ? `Edit ${form.gateway.name}` : 'Add a messaging gateway'} wide>
        {form ? <GatewayForm key={form.gateway?.id ?? 'new'} onClose={() => setForm(null)} gateway={form.gateway} /> : null}
      </Modal>
      <Modal open={pairingGateway !== undefined} onClose={() => setPairing(null)} title={pairingGateway ? `Pair a chat with ${pairingGateway.name}` : 'Pair a chat'}>
        {pairingGateway ? <PairGateway key={pairingGateway.id} gateway={pairingGateway} live={liveOf(pairingGateway.id)} onClose={() => setPairing(null)} /> : null}
      </Modal>
    </div>
  );
}

const SOURCES: WebhookSource[] = ['generic', 'github', 'stripe', 'composio'];
const OUT_EVENTS = ['issue.created', 'issue.updated', 'issue.done', 'approval.requested', 'approval.decided', 'run.started', 'run.finished', 'budget.alert', 'agent.hired', 'agent.paused', 'browser.human_requested'];

function WebhookForm({ onClose, hook }: { onClose: () => void; hook?: WebhookDto }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [direction, setDirection] = useState<'in' | 'out'>(hook?.direction ?? 'in');
  const [name, setName] = useState(hook?.name ?? '');
  const [source, setSource] = useState<WebhookSource>((hook?.source as WebhookSource | undefined) ?? 'generic');
  const [agentId, setAgentId] = useState(hook?.agentId ?? '');
  const [url, setUrl] = useState(hook?.url ?? '');
  const [events, setEvents] = useState<string[]>(hook?.events ?? []);
  const [secretRef, setSecretRef] = useState(hook?.secretRef ?? '');
  const [secret, setSecret] = useState('');
  const defaultRef = `org/${org.slug}/webhook/${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'hook'}`;
  const save = useAction(async () => {
    const ref = secretRef.trim() || (secret ? defaultRef : '');
    if (secret && ref) await api.putSecret(ref, secret);
    const input: Omit<CreateWebhookRequest, 'direction'> = {
      name: name.trim(), secretRef: ref || null, events,
      ...(direction === 'in' ? { source, agentId: agentId || null } : { url: url.trim() }),
    };
    if (hook) await api.updateWebhook(org.id, hook.id, input);
    else await api.createWebhook(org.id, { ...input, direction });
    onClose();
  }, { invalidate: [k(org.id, 'webhooks'), 'secret/'], success: hook ? 'Webhook saved' : 'Webhook added' });
  return (
    <FormShell onSubmit={() => void save.run()} onCancel={onClose} busy={save.busy} error={save.error} submitLabel={hook ? 'Save webhook' : 'Add webhook'}>
      {!hook ? <Segmented label="Direction" value={direction} onChange={setDirection} options={[{ value: 'in', label: 'Inbound: wakes an agent' }, { value: 'out', label: 'Outbound: notifies a service' }]} /> : null}
      <div className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></Field>
        {direction === 'in' ? (
          <>
            <Field label="Sender" hint="Decides how the signature is verified."><select value={source} onChange={(e) => setSource(e.target.value as WebhookSource)}>{SOURCES.map((x) => <option key={x} value={x}>{x === 'github' ? 'GitHub' : humanize(x)}</option>)}</select></Field>
            <Field label="Agent to wake"><select value={agentId} onChange={(e) => setAgentId(e.target.value)}><option value="">None (record only)</option>{dir.staff.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          </>
        ) : <Field label="Destination URL" wide><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://example.com/hooks/conductor" /></Field>}
        <Field label={direction === 'in' ? 'Only these event types (optional)' : 'Events to send'} wide hint={direction === 'out' ? `For example ${OUT_EVENTS.slice(0, 4).join(', ')}. Empty sends every event.` : 'Sender-specific event names, such as push or invoice.paid.'}>
          <TagInput label="Events" value={events} onChange={setEvents} placeholder={direction === 'out' ? 'issue.done' : 'push'} />
        </Field>
        <Field label="Signing secret name" hint={`Left empty, a new secret is stored as ${defaultRef}.`}><input value={secretRef} onChange={(e) => setSecretRef(e.target.value)} autoCapitalize="none" spellCheck={false} placeholder={defaultRef} /></Field>
        <Field label={hook?.secretRef ? 'Replace the signing secret' : 'Signing secret'} hint="Write-only."><input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
      </div>
      {direction === 'out' ? <p className="muted">Common events: {OUT_EVENTS.map((e) => <button key={e} type="button" className="link-btn event-suggestion" onClick={() => !events.includes(e) && setEvents([...events, e])}>{e}</button>)}</p> : null}
    </FormShell>
  );
}

export function Webhooks() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const hooks = useQuery(k(org.id, 'webhooks'), () => api.listWebhooks(org.id));
  const [form, setForm] = useState<{ hook?: WebhookDto } | null>(null);
  const inv = { invalidate: [k(org.id, 'webhooks')] };
  const setStatus = useAction((h: WebhookDto, status: 'active' | 'disabled') => api.updateWebhook(org.id, h.id, { status }), inv);
  const remove = useAction((h: WebhookDto) => api.deleteWebhook(org.id, h.id), { ...inv, success: 'Webhook removed' });
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast('Copied', 'ok'), () => toast('Copy failed. Select the address and copy it by hand.', 'error'));
  return (
    <div className="stack-lg">
      <Panel title="Webhooks" flush actions={<Button small variant="primary" onClick={() => setForm({})}>Add webhook</Button>}>
        <Load q={hooks} empty={<Empty title="No webhooks yet"><p>Inbound webhooks let GitHub, Stripe or any service wake an agent. Outbound webhooks tell other systems when something happens here.</p></Empty>}>
          {(list) => (
            <ul className="connectors">
              {list.map((h) => (
                <li key={h.id} className="connector">
                  <div className="connector-head">
                    <div className="grow">
                      <div className="row"><strong>{h.name}</strong><Chip tone="info">{h.direction === 'in' ? 'Inbound' : 'Outbound'}</Chip>{h.direction === 'in' ? <Chip>{h.source === 'github' ? 'GitHub' : humanize(h.source)}</Chip> : null}<Status value={h.status} />{h.secretRef ? null : <Chip tone="warn">Unsigned</Chip>}</div>
                      {h.inboundUrl ? (
                        <p className="row row-tight"><span className="muted">POST to</span><code className="hook-url">{h.inboundUrl}</code><Button small onClick={() => void copy(h.inboundUrl!)}>Copy</Button></p>
                      ) : <p className="muted truncate">Sends to <code>{h.url}</code></p>}
                      <p className="muted">{h.direction === 'in' ? `Wakes ${dir.agentName(h.agentId, 'nobody')}` : ''}{h.events.length ? `${h.direction === 'in' ? ', on ' : 'On '}${h.events.join(', ')}` : h.direction === 'out' ? 'On every event' : ''}</p>
                    </div>
                    <div className="row row-tight">
                      <Button small onClick={() => setForm({ hook: h })}>Edit</Button>
                      <Button small busy={setStatus.busy} onClick={() => void setStatus.run(h, h.status === 'disabled' ? 'active' : 'disabled')}>{h.status === 'disabled' ? 'Enable' : 'Disable'}</Button>
                      <ConfirmButton small variant="quiet" danger label="Remove" title={`Remove ${h.name}`} confirmLabel="Remove webhook" message={h.direction === 'in' ? 'The inbound address stops working at once.' : 'Events are no longer sent to this destination.'} onConfirm={() => remove.run(h)} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Load>
      </Panel>
      <Modal open={form !== null} onClose={() => setForm(null)} title={form?.hook ? `Edit ${form.hook.name}` : 'Add a webhook'} wide>
        {form ? <WebhookForm key={form.hook?.id ?? 'new'} onClose={() => setForm(null)} hook={form.hook} /> : null}
      </Modal>
    </div>
  );
}
