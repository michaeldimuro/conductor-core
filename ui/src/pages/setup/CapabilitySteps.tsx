import { useState } from 'react';
import { InstallConnector, useCatalog, useConnectors } from '../../components/connectors.js';
import { Icon } from '../../components/icons.js';
import { Button, Chip, Empty, Load, Modal, Status } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { ConnectorTemplate, Skill } from '../../lib/api.js';
import { humanize } from '../../lib/format.js';
import { k, useDirectory, useOrg } from '../../lib/org.js';
import { invalidate, useAction, useQuery } from '../../lib/query.js';
import { SkillForm } from '../Skills.js';
import { StepActions, useSetup } from './Setup.js';

/** A toggle switch: a checkbox styled as a switch, with its label beside it. */
export function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true"><span /></span>
      <span className="switch-label">{label}</span>
    </label>
  );
}

export function CatalogCard({ t, installed, recommended, onInstall }: { t: ConnectorTemplate; installed: boolean; recommended?: boolean; onInstall: () => void }) {
  return (
    <li className={`cat-card${recommended ? ' cat-card-rec' : ''}`}>
      <div className="row row-tight">
        <span className="tile-glyph" aria-hidden="true"><Icon name="connectors" size={15} /></span>
        <strong className="grow truncate">{t.name}</strong>
        {recommended ? <Chip tone="info">For you</Chip> : null}
      </div>
      <p className="muted cat-card-desc">{t.description}</p>
      <div className="row row-tight cat-card-foot">
        <Chip>{humanize(t.kind)}</Chip>
        {t.requiredSecrets.length ? <Chip><Icon name="key" size={11} />Needs a key</Chip> : null}
        <span className="grow" />
        {installed ? <span className="status status-go"><Icon name="check" size={14} />Installed</span> : <Button small icon="add" onClick={onInstall}>Install</Button>}
      </div>
    </li>
  );
}

export function ConnectorsStep() {
  const { org } = useOrg();
  const setup = useSetup();
  const catalog = useCatalog();
  const installed = useConnectors(org.id);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [install, setInstall] = useState<{ template: ConnectorTemplate | null } | null>(null);
  const [defaults, setDefaults] = useState<string[]>(org.defaultConnectors);
  const recommended = new Set(setup.draft?.connectors ?? []);
  const installedIds = new Set((installed.data ?? []).map((c) => c.templateId).filter(Boolean));
  const needle = search.trim().toLowerCase();
  const all = catalog.data ?? [];
  const categories = [...new Set(all.map((t) => t.category))];
  const shown = all.filter((t) => (!category || t.category === category) && (!needle || `${t.name} ${t.description} ${t.id}`.toLowerCase().includes(needle)));
  const recs = all.filter((t) => recommended.has(t.id));
  const save = useAction(async () => {
    if (defaults.join() !== org.defaultConnectors.join()) {
      await api.updateOrg(org.id, { defaultConnectors: defaults });
      invalidate('orgs');
    }
    await setup.next();
  });

  return (
    <div className="stack-lg">
      {recs.length ? (
        <section className="stack">
          <h2 className="section-title"><Icon name="spark" size={15} />Recommended from your interview</h2>
          <ul className="cat-grid">{recs.map((t) => <CatalogCard key={t.id} t={t} recommended installed={installedIds.has(t.id)} onInstall={() => setInstall({ template: t })} />)}</ul>
        </section>
      ) : null}

      {(installed.data ?? []).length ? (
        <section className="stack">
          <h2 className="section-title"><Icon name="installed" size={15} />Installed</h2>
          <ul className="setup-list">
            {installed.data!.map((c) => (
              <li key={c.id} className="setup-row">
                <span className="setup-row-icon" aria-hidden="true"><Icon name="connectors" size={16} /></span>
                <div className="grow"><strong>{c.name}</strong> <Status value={c.status} />{c.lastError ? <p className="muted">{c.lastError}</p> : null}</div>
                <Toggle label="Every agent" checked={defaults.includes(c.id)} onChange={(on) => setDefaults(on ? [...defaults, c.id] : defaults.filter((x) => x !== c.id))} />
              </li>
            ))}
          </ul>
          <p className="field-hint">Connectors not given to every agent can be granted one by one, tool by tool, from each agent&apos;s Connectors tab.</p>
        </section>
      ) : null}

      <section className="stack">
        <div className="setup-toolbar">
          <h2 className="section-title grow"><Icon name="catalog" size={15} />Catalog</h2>
          <input className="toolbar-search" type="search" data-search placeholder="Search connectors" aria-label="Search connectors" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Button icon="add" variant="quiet" onClick={() => setInstall({ template: null })}>Custom MCP server</Button>
        </div>
        {categories.length > 1 ? (
          <div className="filter-chips" role="group" aria-label="Category">
            <button type="button" aria-pressed={!category} onClick={() => setCategory('')}>All</button>
            {categories.map((c) => <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(category === c ? '' : c)}>{humanize(c)}</button>)}
          </div>
        ) : null}
        <Load q={catalog} empty={<Empty icon="catalog" title="The catalog is empty"><p>Add a custom MCP server instead.</p></Empty>}>
          {() => (shown.length ? <ul className="cat-grid">{shown.map((t) => <CatalogCard key={t.id} t={t} recommended={recommended.has(t.id)} installed={installedIds.has(t.id)} onInstall={() => setInstall({ template: t })} />)}</ul> : <Empty icon="search" title="Nothing matches" />)}
        </Load>
      </section>
      <InstallConnector open={install !== null} onClose={() => { setInstall(null); invalidate(k(org.id, 'connector')); }} template={install?.template} />
      <StepActions skip busy={save.busy} onContinue={() => void save.run()} />
    </div>
  );
}

const SCOPE_LABEL: Record<Skill['scope'], string> = { global: 'Every organization', org: 'Organization', dept: 'Department', agent: 'One agent' };

export function SkillsStep() {
  const { org } = useOrg();
  const setup = useSetup();
  const dir = useDirectory(org.id);
  const skills = useQuery(k(org.id, 'skills'), () => api.listSkills(org.id), { events: ['skill.'], orgId: org.id });
  const [defaults, setDefaults] = useState<string[]>(org.defaultSkills);
  const [creating, setCreating] = useState(false);
  const activate = useAction((id: string) => api.activateSkill(org.id, id), { invalidate: [k(org.id, 'skill')], success: 'Skill activated' });
  const save = useAction(async () => {
    if (defaults.join() !== org.defaultSkills.join()) {
      await api.updateOrg(org.id, { defaultSkills: defaults });
      invalidate('orgs');
    }
    await setup.next();
  });
  return (
    <div className="stack-lg">
      <div className="setup-toolbar">
        <p className="dim grow">Turn a skill on for every agent, or leave it for agents to load when a task calls for it. Agents also write their own skills after repeated work; those arrive as drafts for you to review.</p>
        <Button icon="add" onClick={() => setCreating(true)}>Write or import a skill</Button>
      </div>
      <Load q={skills} empty={(
        <Empty icon="skills" title="No skills yet">
          <p>That&apos;s fine to start. Write one for a procedure you repeat often, import a folder with a SKILL.md, or skip and let agents distill their own.</p>
        </Empty>
      )}>
        {(list) => (
          <ul className="setup-list">
            {list.map((s) => (
              <li key={s.id} className="setup-row">
                <span className="setup-row-icon" aria-hidden="true"><Icon name="skills" size={16} /></span>
                <div className="grow">
                  <div className="row row-tight"><strong>{s.name}</strong><Status value={s.status} /><Chip>{SCOPE_LABEL[s.scope]}</Chip>{s.author !== 'human' ? <Chip tone="info">By an agent</Chip> : null}</div>
                  <p className="muted">{s.description}</p>
                </div>
                {s.status === 'draft' ? <Button small busy={activate.busy} onClick={() => void activate.run(s.id)}>Activate</Button> : null}
                <Toggle label="Every agent" disabled={s.status !== 'active'} checked={defaults.includes(s.name)} onChange={(on) => setDefaults(on ? [...defaults, s.name] : defaults.filter((x) => x !== s.name))} />
              </li>
            ))}
          </ul>
        )}
      </Load>
      <Modal open={creating} onClose={() => setCreating(false)} title="New skill" wide>{creating ? <SkillForm onClose={() => setCreating(false)} dir={dir} /> : null}</Modal>
      <StepActions skip busy={save.busy} onContinue={() => void save.run()} />
    </div>
  );
}
