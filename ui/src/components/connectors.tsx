import { useState } from 'react';
import { api } from '../lib/api.js';
import type { Connector, ConnectorTemplate } from '../lib/api.js';
import { humanize } from '../lib/format.js';
import { k, useDirectory, useOrg } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';
import { toast } from '../lib/toast.js';
import { Button, Chip, Empty, Field, FormShell, JsonField, Load, Modal, Segmented } from './ui.js';

export const useConnectors = (orgId: string) => useQuery(k(orgId, 'connectors'), () => api.listConnectors(orgId));
export const useCatalog = () => useQuery('connector-catalog', () => api.connectorCatalog());
const KINDS = ['mcp_http', 'mcp_stdio', 'openapi', 'composio', 'arcade'] as const;
export const RISK_TONE = { read: undefined, write: 'info', external_read: 'info', external_write: 'warn', high: 'stop' } as const;

/** Install from the catalog (secrets go to the write-only secret store) or define a custom connector. */
export function InstallConnector({ open, onClose, template }: { open: boolean; onClose: () => void; template?: ConnectorTemplate | null }) {
  return (
    <Modal open={open} onClose={onClose} title={template ? `Install ${template.name}` : 'Add a custom connector'} wide>
      {open ? <InstallBody key={template?.id ?? 'custom'} onClose={onClose} template={template ?? null} /> : null}
    </Modal>
  );
}

function InstallBody({ onClose, template }: { onClose: () => void; template: ConnectorTemplate | null }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [name, setName] = useState(template?.name ?? '');
  const [scope, setScope] = useState<'org' | 'dept'>('org');
  const [deptId, setDeptId] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('mcp_http');
  const [config, setConfig] = useState<Record<string, unknown>>(template?.config ?? { url: '' });
  const [authRef, setAuthRef] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const install = useAction(async () => {
    const target = { scope, scopeId: scope === 'dept' ? deptId : null };
    if (!template) {
      await api.installConnector(org.id, { name: name.trim(), kind, config, authRef: authRef.trim() || null, ...target });
      return;
    }
    const connector = await api.installConnectorFromTemplate(org.id, { templateId: template.id, name: name.trim(), config, ...target });
    // Secret values travel only through the write-only secrets API, under the connector's own reference.
    const missing: string[] = [];
    for (const secret of template.requiredSecrets) {
      const value = secrets[secret]?.trim();
      if (value && connector.authRef) await api.putSecret(`${connector.authRef}/${secret}`, value);
      else missing.push(secret);
    }
    if (missing.length) toast(`Installed, but still missing: ${missing.join(', ')}. Add them from the connector's row.`, 'info');
  }, { invalidate: [k(org.id, 'connector')], success: 'Connector installed' });

  return (
    <FormShell onSubmit={() => void install.run().then((r) => r !== undefined && onClose())} onCancel={onClose} busy={install.busy} error={install.error} submitLabel="Install connector">
      {template ? <p className="dim">{template.description}{template.docsUrl ? <> <a href={template.docsUrl} target="_blank" rel="noreferrer noopener">Setup guide</a></> : null}</p> : null}
      <div className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></Field>
        {!template ? (
          <Field label="Kind"><select value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>{KINDS.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</select></Field>
        ) : null}
        <Field label="Installed for">
          <Segmented label="Scope" value={scope} onChange={setScope} options={[{ value: 'org', label: 'Whole organization' }, { value: 'dept', label: 'One department' }]} />
        </Field>
        {scope === 'dept' ? (
          <Field label="Department"><select value={deptId} onChange={(e) => setDeptId(e.target.value)} required><option value="">Choose</option>{dir.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        ) : null}
      </div>
      {template && template.requiredSecrets.length > 0 ? (
        <fieldset>
          <legend>Credentials</legend>
          <p className="muted">Stored in the Mac's secret store. They are write-only: this console can replace them but never read them back.</p>
          <div className="form-grid">
            {template.requiredSecrets.map((s) => (
              <Field key={s} label={s}><input type="password" autoComplete="off" value={secrets[s] ?? ''} onChange={(e) => setSecrets({ ...secrets, [s]: e.target.value })} /></Field>
            ))}
          </div>
        </fieldset>
      ) : null}
      {!template ? <Field label="Credential secret (optional)" hint="Name of a stored secret holding the API key or token."><input value={authRef} onChange={(e) => setAuthRef(e.target.value)} placeholder={`org/${org.slug}/connector/my-server`} autoCapitalize="none" spellCheck={false} /></Field> : null}
      <JsonField label="Configuration (non-secret)" value={config} onChange={setConfig} hint={template ? 'The template defaults are usually right.' : 'For example {"url": "https://mcp.example.com/mcp"} or {"command": "npx", "args": ["-y", "some-mcp-server"]}.'} />
      {template?.suggestedPolicies && Object.keys(template.suggestedPolicies).length ? (
        <p className="muted">Suggested tool policies when you grant it to an agent: {Object.entries(template.suggestedPolicies).map(([tool, p]) => `${tool} ${p === 'ask' ? 'asks first' : p}`).join(', ')}.</p>
      ) : null}
    </FormShell>
  );
}

/** Tools the connector exposes upstream. Changed schemas are quarantined until re-trusted. */
export function ConnectorTools({ connector }: { connector: Connector }) {
  const { org } = useOrg();
  const key = k(org.id, 'connector', connector.id, 'tools');
  const tools = useQuery(key, () => api.connectorTools(org.id, connector.id));
  const retrust = useAction((tool: string) => api.retrustTool(org.id, connector.id, tool), { invalidate: [key], success: 'Tool re-trusted' });
  return (
    <Load q={tools} lines={2} empty={<Empty title="This connector exposes no tools" />}>
      {(list) => (
        <ul className="tool-list">
          {list.map((t) => (
            <li key={t.name} className={t.quarantined ? 'tool-quarantined' : ''}>
              <div className="grow">
                <code>{t.name}</code> {RISK_TONE[t.risk] ? <Chip tone={RISK_TONE[t.risk]}>{humanize(t.risk)}</Chip> : <Chip>{humanize(t.risk)}</Chip>}
                {t.quarantined ? <Chip tone="stop">Changed upstream</Chip> : null}
                <span className="field-hint">{t.description}</span>
              </div>
              {t.quarantined ? <Button small busy={retrust.busy} onClick={() => void retrust.run(t.name)}>Re-trust</Button> : null}
            </li>
          ))}
        </ul>
      )}
    </Load>
  );
}

/** Presence of each credential a template-installed connector needs, with a write-only setter. */
export function ConnectorSecrets({ connector, template }: { connector: Connector; template: ConnectorTemplate }) {
  const { org } = useOrg();
  const refs = template.requiredSecrets.map((s) => ({ name: s, ref: `${connector.authRef}/${s}` }));
  const key = k(org.id, 'connector', connector.id, 'secrets');
  const status = useQuery(connector.authRef && refs.length ? key : null, () => Promise.all(refs.map((r) => api.secretExists(r.ref))));
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const save = useAction(async (ref: string) => {
    await api.putSecret(ref, value);
    setEditing(null);
    setValue('');
  }, { invalidate: [key], success: 'Credential stored' });
  if (!connector.authRef || refs.length === 0) return null;
  return (
    <ul className="tool-list">
      {refs.map((r, i) => (
        <li key={r.ref}>
          <div className="grow"><code>{r.name}</code> {status.data ? <Chip tone={status.data[i]?.exists ? 'go' : 'stop'}>{status.data[i]?.exists ? 'Stored' : 'Missing'}</Chip> : null}</div>
          {editing === r.ref ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); if (value) void save.run(r.ref); }}>
              <input type="password" aria-label={`New value for ${r.name}`} autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 180 }} autoFocus />
              <Button small type="submit" variant="primary" busy={save.busy} disabled={!value}>Store</Button>
              <Button small onClick={() => setEditing(null)}>Cancel</Button>
            </form>
          ) : <Button small onClick={() => { setEditing(r.ref); setValue(''); }}>{status.data?.[i]?.exists ? 'Replace' : 'Set'}</Button>}
        </li>
      ))}
    </ul>
  );
}
