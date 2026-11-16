import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../components/icons.js';
import { Button, ErrorNote, Field, Load, Panel } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { OrgBundle, Organization } from '../lib/api.js';
import { setQueryData, useAction, useQuery } from '../lib/query.js';
import { useOrgs } from '../lib/org.js';
import { SETUP_STEPS, saveOnboarding } from '../lib/setup.js';
import { initials } from './setup/TeamStep.js';

type Mode = 'template' | 'blank' | 'import';

const MODES: ReadonlyArray<{ id: Mode; icon: IconName; title: string; blurb: string }> = [
  { id: 'template', icon: 'grid', title: 'From a template', blurb: 'A ready-made team with departments, roles and prompts you can tune.' },
  { id: 'blank', icon: 'add', title: 'From scratch', blurb: 'An empty organization. You design the team during setup.' },
  { id: 'import', icon: 'upload', title: 'Import a bundle', blurb: 'Bring over an organization exported from another Mac.' },
];

export function NewOrg() {
  const nav = useNavigate();
  const first = useOrgs().data?.length === 0;
  const templates = useQuery('org-templates', () => api.listOrgTemplates());
  const [mode, setMode] = useState<Mode>('template');
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [bundle, setBundle] = useState<OrgBundle | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const selected = templates.data?.find((t) => t.id === templateId) ?? templates.data?.[0];

  const create = useAction(async (): Promise<Organization> => {
    let org: Organization;
    if (mode === 'template') {
      if (!selected) throw new Error('Choose a template first.');
      org = await api.createOrgFromTemplate({ templateId: selected.id, name: name.trim() });
    } else if (mode === 'import') {
      if (!bundle) throw new Error('Choose a bundle file first.');
      org = await api.importOrg({ name: name.trim(), bundle });
    } else {
      org = await api.createOrg({ name: name.trim() });
    }
    // An imported organization already has its prompts and goals: setup starts at the models it needs.
    const step = mode === 'import' ? 'models' : 'interview';
    await saveOnboarding(org.id, null, { status: 'in_progress', step, done: mode === 'import' ? ['interview'] : [] }).catch(() => undefined);
    // Put the new organization in the cache before navigating, so its routes resolve at once.
    setQueryData<Organization[]>('orgs', (prev) => [...(prev ?? []).filter((o) => o.id !== org.id), org]);
    nav(`/o/${org.slug}/setup/${step}`);
    return org;
  }, { invalidate: ['orgs', 'status'] });

  const readBundle = async (file: File | undefined) => {
    setBundle(null);
    setBundleError(null);
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as OrgBundle;
      if (parsed.format !== 'conductor-org-bundle') throw new Error('This file is not a Conductor organization bundle.');
      setBundle(parsed);
      if (!name && typeof parsed.org.name === 'string') setName(parsed.org.name);
    } catch (e) {
      setBundleError(e instanceof Error ? e.message : 'Could not read the file.');
    }
  };

  const ready = !!name.trim() && (mode !== 'import' || !!bundle) && (mode !== 'template' || !!selected);

  return (
    <div className="page page-narrow new-org">
      <header className="new-org-hero">
        <span className="eyebrow">{first ? 'Welcome to Conductor' : 'New organization'}</span>
        <h1>Build a team of agents <em>around your goals</em></h1>
        <p>An organization is an isolated company of agents with its own mission, budget, memory and credentials. Pick a starting point; a short guided setup does the rest.</p>
      </header>

      <form className="stack-lg" onSubmit={(e) => { e.preventDefault(); if (ready) void create.run(); }}>
        <div className="mode-cards" role="radiogroup" aria-label="How to start">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={`mode-card${mode === m.id ? ' on' : ''}`} onClick={() => setMode(m.id)}>
              <span className="mode-card-icon" aria-hidden="true"><Icon name={m.icon} size={18} /></span>
              <strong>{m.title}</strong>
              <span className="muted">{m.blurb}</span>
            </button>
          ))}
        </div>

        {mode === 'template' ? (
          <Load q={templates} empty={<Panel><p className="muted">No templates are installed. Start from scratch instead.</p></Panel>}>
            {(list) => (
              <div className="template-grid" role="radiogroup" aria-label="Template">
                {list.map((t) => {
                  const agents = t.departments.flatMap((d) => d.agents);
                  const on = selected?.id === t.id;
                  return (
                    <button key={t.id} type="button" role="radio" aria-checked={on} className={`template-card${on ? ' on' : ''}`} onClick={() => setTemplateId(t.id)}>
                      <span className="row row-tight template-card-top">
                        <strong className="grow">{t.name}</strong>
                        {on ? <span className="template-check" aria-hidden="true"><Icon name="check" size={13} strokeWidth={2.5} /></span> : null}
                      </span>
                      <span className="muted template-card-desc">{t.description}</span>
                      <span className="avatar-stack" aria-label={`${agents.length} agents`}>
                        {agents.slice(0, 6).map((a) => <span key={a.name} className="avatar avatar-sm" title={`${a.name}, ${a.role}`}>{initials(a.name)}</span>)}
                        {agents.length > 6 ? <span className="avatar avatar-sm avatar-more">+{agents.length - 6}</span> : null}
                      </span>
                      <span className="template-depts">
                        {t.departments.map((d) => <span key={d.name} className="chip">{d.name} · {d.agents.length}</span>)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Load>
        ) : null}

        {mode === 'import' ? (
          <Panel icon="upload" title="Bundle file">
            <div className="stack">
              <Field label="Exported organization (.json)" hint="Bundles carry the org chart, agent configs, skills and sanitized memory. They never contain secrets.">
                <input type="file" accept="application/json,.json" onChange={(e) => void readBundle(e.target.files?.[0])} />
              </Field>
              {bundleError ? <ErrorNote error={new Error(bundleError)} /> : null}
              {bundle ? <p className="note note-go">{bundle.departments.length} departments, {bundle.agents.length} agents, {bundle.skills.length} skills, {bundle.memories.length} memories.</p> : null}
            </div>
          </Panel>
        ) : null}

        <div className="name-field">
          <label htmlFor="org-name" className="field-label">Name</label>
          <input id="org-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="Acme" autoComplete="off" />
        </div>

        <div className="setup-preview">
          <span className="mono-label">What happens next</span>
          <ol>
            {SETUP_STEPS.map((s) => <li key={s.id}><Icon name={s.icon} size={14} />{s.label}</li>)}
          </ol>
          <span className="muted">About five minutes. Every step can be skipped and revisited.</span>
        </div>

        <ErrorNote error={create.error} />
        <div className="form-actions">
          <Button type="submit" variant="primary" busy={create.busy} disabled={!ready}>Create and start setup<Icon name="right" size={15} /></Button>
        </div>
      </form>
    </div>
  );
}
