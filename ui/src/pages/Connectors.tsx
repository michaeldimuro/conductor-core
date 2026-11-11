import { useState } from 'react';
import { ConnectorSecrets, ConnectorTools, InstallConnector, useCatalog, useConnectors } from '../components/connectors.js';
import { Button, Chip, ConfirmButton, Empty, Load, PageHead, Panel, Status } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { Connector, ConnectorTemplate } from '../lib/api.js';
import { humanize } from '../lib/format.js';
import { k, useDirectory, useOrg } from '../lib/org.js';
import { useAction } from '../lib/query.js';

function ConnectorRow({ connector, template, expanded, onToggle }: { connector: Connector; template?: ConnectorTemplate; expanded: boolean; onToggle: () => void }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const inv = { invalidate: [k(org.id, 'connector')] };
  const setStatus = useAction((status: 'active' | 'disabled') => api.updateConnector(org.id, connector.id, { status }), inv);
  const remove = useAction(() => api.removeConnector(org.id, connector.id), { ...inv, success: `Removed ${connector.name}` });
  return (
    <li className="connector">
      <div className="connector-head">
        <div className="grow">
          <div className="row"><strong>{connector.name}</strong><Status value={connector.status} /><Chip>{humanize(connector.kind)}</Chip><Chip>{connector.scope === 'dept' ? (dir.dept(connector.scopeId)?.name ?? 'Department') : 'Whole organization'}</Chip></div>
          {connector.lastError ? <p className="note note-stop">{connector.lastError}</p> : null}
          {connector.toolAllowlist ? <p className="muted">Limited to {connector.toolAllowlist.length} tools at install level.</p> : null}
        </div>
        <div className="row row-tight">
          <Button small onClick={onToggle} aria-expanded={expanded}>{expanded ? 'Hide tools' : 'Show tools'}</Button>
          {connector.status === 'disabled'
            ? <Button small busy={setStatus.busy} onClick={() => void setStatus.run('active')}>Enable</Button>
            : <Button small busy={setStatus.busy} onClick={() => void setStatus.run('disabled')}>Disable</Button>}
          <ConfirmButton small variant="quiet" danger label="Remove" title={`Remove ${connector.name}`} confirmLabel="Remove connector" message="Every agent loses access to this connector and its grants are deleted." onConfirm={() => remove.run()} />
        </div>
      </div>
      {template ? <ConnectorSecrets connector={connector} template={template} /> : null}
      {expanded ? <ConnectorTools connector={connector} /> : null}
    </li>
  );
}

export function Connectors() {
  const { org } = useOrg();
  const installed = useConnectors(org.id);
  const catalog = useCatalog();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [install, setInstall] = useState<{ template: ConnectorTemplate | null } | null>(null);
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const byCategory = new Map<string, ConnectorTemplate[]>();
  for (const t of catalog.data ?? []) byCategory.set(t.category, [...(byCategory.get(t.category) ?? []), t]);
  return (
    <div className="page">
      <PageHead title="Connectors" sub="Tools agents reach through the Conductor gateway. Install here, then grant each agent only the tools it needs from its Connectors tab." actions={<Button onClick={() => setInstall({ template: null })}>Add a custom connector</Button>} />
      <Panel title="Installed" flush actions={installed.data?.length ? <Button small onClick={() => setExpanded(new Set(installed.data!.map((c) => c.id)))}>Check all for changed tools</Button> : null}>
        <Load q={installed} empty={<Empty title="No connectors installed"><p>Pick one from the catalog below.</p></Empty>}>
          {(list) => (
            <ul className="connectors">
              {list.map((c) => <ConnectorRow key={c.id} connector={c} template={catalog.data?.find((t) => t.id === c.templateId)} expanded={expanded.has(c.id)} onToggle={() => toggle(c.id)} />)}
            </ul>
          )}
        </Load>
      </Panel>
      <Panel title="Catalog">
        <Load q={catalog} empty={<Empty title="The catalog is empty" />}>
          {() => (
            <div className="stack-lg">
              {[...byCategory.entries()].map(([category, templates]) => (
                <section key={category} className="stack">
                  <h3>{humanize(category)}</h3>
                  <ul className="catalog">
                    {templates.map((t) => (
                      <li key={t.id}>
                        <div className="grow">
                          <strong>{t.name}</strong> <Chip>{humanize(t.kind)}</Chip>
                          <span className="field-hint">{t.description}</span>
                        </div>
                        <Button small onClick={() => setInstall({ template: t })}>Install</Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Load>
      </Panel>
      <InstallConnector open={install !== null} onClose={() => setInstall(null)} template={install?.template} />
    </div>
  );
}
