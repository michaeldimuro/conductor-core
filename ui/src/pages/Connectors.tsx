import { useState } from 'react';
import { ConnectorSecrets, ConnectorSettings, ConnectorTools, InstallConnector, useCatalog, useConnectors } from '../components/connectors.js';
import { Button, Chip, ConfirmButton, Empty, Load, PageHead, Panel, Status } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { Connector, ConnectorTemplate } from '../lib/api.js';
import { humanize } from '../lib/format.js';
import { CatalogCard } from './setup/CapabilitySteps.js';
import { k, useDirectory, useOrg } from '../lib/org.js';
import { Icon } from '../components/icons.js';
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
          <div className="row"><span className="tile-glyph" aria-hidden="true"><Icon name="connectors" size={15} /></span><strong>{connector.name}</strong><Status value={connector.status} /><Chip>{humanize(connector.kind)}</Chip><Chip>{connector.scope === 'dept' ? (dir.dept(connector.scopeId)?.name ?? 'Department') : 'Whole organization'}</Chip></div>
          {connector.lastError ? <p className="note note-stop">{connector.lastError}</p> : null}
          {connector.toolAllowlist ? <p className="muted">Limited to {connector.toolAllowlist.length} tools at install level.</p> : null}
        </div>
        <div className="row row-tight">
          <Button small onClick={onToggle} aria-expanded={expanded}>{expanded ? 'Hide tools' : 'Show tools'}</Button>
          {connector.status === 'disabled'
            ? <Button icon="check" small busy={setStatus.busy} onClick={() => void setStatus.run('active')}>Enable</Button>
            : <Button icon="pause" small busy={setStatus.busy} onClick={() => void setStatus.run('disabled')}>Disable</Button>}
          <ConfirmButton icon="remove" small variant="quiet" danger label="Remove" title={`Remove ${connector.name}`} confirmLabel="Remove connector" message="Every agent loses access to this connector and its grants are deleted." onConfirm={() => remove.run()} />
        </div>
      </div>
      {template ? <ConnectorSettings connector={connector} template={template} /> : null}
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
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
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
      <PageHead icon="connectors" eyebrow="Tool gateway" title="Connectors" sub="Tools agents reach through the Conductor gateway. Install here, then grant each agent only the tools it needs from its Connectors tab." actions={<Button icon="add" onClick={() => setInstall({ template: null })}>Add a custom connector</Button>} />
      <Panel icon="installed" title={(() => { const bad = (installed.data ?? []).filter((c) => c.status === 'error' || c.lastError).length; return bad ? `Installed · ${bad} need attention` : 'Installed'; })()} flush actions={installed.data?.length ? <Button icon="refresh" small onClick={() => setExpanded(new Set(installed.data!.map((c) => c.id)))}>Check all for changed tools</Button> : null}>
        <Load q={installed} empty={<p className="panel-body muted">Nothing installed yet. Pick a tool below; agents only get the tools you grant them.</p>}>
          {(list) => (
            <ul className="connectors">
              {[...list].sort((x, y) => Number(y.status === 'error' || !!y.lastError) - Number(x.status === 'error' || !!x.lastError)).map((c) => <ConnectorRow key={c.id} connector={c} template={catalog.data?.find((t) => t.id === c.templateId)} expanded={expanded.has(c.id)} onToggle={() => toggle(c.id)} />)}
            </ul>
          )}
        </Load>
      </Panel>
      <section className="stack">
        <div className="setup-toolbar">
          <h2 className="section-title grow"><Icon name="catalog" size={15} />Add a tool</h2>
          <input className="toolbar-search" type="search" data-search placeholder="Search the catalog" aria-label="Search the catalog" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {byCategory.size > 1 ? (
          <div className="filter-chips scroll-chips" role="group" aria-label="Category">
            <button type="button" aria-pressed={!category} onClick={() => setCategory('')}>All</button>
            {[...byCategory.keys()].map((c) => <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(category === c ? '' : c)}>{humanize(c)}</button>)}
          </div>
        ) : null}
        <Load q={catalog} empty={<Empty icon="catalog" title="The catalog is empty" />}>
          {(all) => {
            const needle = search.trim().toLowerCase();
            const shown = all.filter((t) => (!category || t.category === category) && (!needle || `${t.name} ${t.description}`.toLowerCase().includes(needle)));
            const have = new Set((installed.data ?? []).map((c) => c.templateId));
            return shown.length ? <ul className="cat-grid">{shown.map((t) => <CatalogCard key={t.id} t={t} installed={have.has(t.id)} onInstall={() => setInstall({ template: t })} />)}</ul> : <Empty icon="search" title="Nothing matches" />;
          }}
        </Load>
      </section>
      <InstallConnector open={install !== null} onClose={() => setInstall(null)} template={install?.template} />
    </div>
  );
}
