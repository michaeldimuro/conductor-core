import { useEffect, useState } from 'react';
import { Button, Chip, ConfirmButton, ErrorNote, Field, Load, Panel } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { ExternalBackendConfig } from '../../lib/api.js';
import { k, useOrg } from '../../lib/org.js';
import { useAction, useQuery } from '../../lib/query.js';

const BACKENDS: ReadonlyArray<{ kind: ExternalBackendConfig['kind']; label: string }> = [
  { kind: 'honcho', label: 'Honcho' }, { kind: 'mem0', label: 'Mem0' }, { kind: 'zep', label: 'Zep' }, { kind: 'supermemory', label: 'Supermemory' },
];
type Kind = ExternalBackendConfig['kind'] | '';

/** Optional external memory backend for this organization. Local memory always stays on. */
export function MemoryBackendPanel() {
  const { org } = useOrg();
  const q = useQuery(k(org.id, 'memory-backend'), () => api.getMemoryBackend(org.id));
  const current = q.data?.backend ?? null;
  const [kind, setKind] = useState<Kind>('');
  const [authRef, setAuthRef] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  useEffect(() => {
    setKind(current?.kind ?? '');
    setAuthRef(current?.authRef ?? '');
    setBaseUrl(current?.baseUrl ?? '');
    setKey('');
  }, [current?.kind, current?.authRef, current?.baseUrl]);
  const defaultRef = `org/${org.slug}/${kind || 'memory'}-api-key`;
  const save = useAction(async () => {
    if (kind === '') return api.clearMemoryBackend(org.id);
    const ref = authRef.trim() || defaultRef;
    // The key goes to the secret store; the setting only ever holds its name.
    if (key) await api.putSecret(ref, key);
    return api.putMemoryBackend(org.id, { kind, authRef: ref, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(current?.kind === kind && current.options ? { options: current.options } : {}) });
  }, { invalidate: [k(org.id, 'memory-backend'), 'secret/'], success: (r) => (r.backend ? `Memory backend set to ${BACKENDS.find((b) => b.kind === r.backend!.kind)?.label ?? r.backend.kind}` : 'Using local memory only') });
  const dirty = kind !== (current?.kind ?? '') || (kind !== '' && (authRef.trim() !== (current?.authRef ?? '') || baseUrl.trim() !== (current?.baseUrl ?? '') || key !== ''));
  return (
    <Panel title={<>External memory backend {current ? <Chip tone={current.ready ? 'go' : 'warn'}>{current.ready ? 'Connected' : 'Key missing'}</Chip> : <Chip>Local only</Chip>}</>}>
      <Load q={q} lines={2}>
        {() => (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
            <p className="dim">Conductor always keeps memory in its own local store. A backend adds a second place agents recall from and write to. Nothing is sent anywhere until you choose one.</p>
            {current && !current.ready ? <p className="note note-warn">No key is stored under <code>{current.authRef}</code>, so this backend is skipped. Enter the key below and save.</p> : null}
            <div className="form-grid">
              <Field label="Backend">
                <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  <option value="">None (local memory only)</option>
                  {BACKENDS.map((b) => <option key={b.kind} value={b.kind}>{b.label}</option>)}
                </select>
              </Field>
              {kind !== '' ? (
                <>
                  <Field label="Endpoint" hint="Only for a self-hosted server. Empty uses the vendor's cloud."><input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://memory.example.com" /></Field>
                  <Field label="Secret name" hint={`Left empty, the key is stored as ${defaultRef}.`}><input value={authRef} onChange={(e) => setAuthRef(e.target.value)} autoCapitalize="none" spellCheck={false} placeholder={defaultRef} /></Field>
                  <Field label={current?.ready ? 'Replace the API key' : 'API key'} hint="Write-only. Stored in the Keychain, never in the database."><input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></Field>
                </>
              ) : null}
            </div>
            <ErrorNote error={save.error} />
            <div className="form-actions"><Button icon="check" type="submit" variant="primary" busy={save.busy} disabled={!dirty}>Save memory backend</Button></div>
          </form>
        )}
      </Load>
    </Panel>
  );
}

/** Organizations that were archived, with a way back. Hidden while there are none. */
export function ArchivedOrgs() {
  const all = useQuery('orgs/with-archived', () => api.listOrgs({ includeArchived: true }), { events: ['org.'] });
  const restore = useAction((id: string) => api.unarchiveOrg(id), { invalidate: ['orgs', 'status'], success: (o) => `Restored ${o.name}` });
  const archived = (all.data ?? []).filter((o) => o.status === 'archived');
  if (archived.length === 0) return null;
  return (
    <Panel icon="archive" title="Archived organizations" flush>
      <ul className="lines">
        {archived.map((o) => (
          <li key={o.id} className="line">
            <span className="grow truncate"><strong>{o.name}</strong> <span className="muted">/o/{o.slug}</span></span>
            <ConfirmButton icon="refresh" small label="Restore" title={`Restore ${o.name}`} confirmLabel="Restore" message={`${o.name} returns to the switcher. Its agents can run again.`} onConfirm={() => restore.run(o.id)} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
