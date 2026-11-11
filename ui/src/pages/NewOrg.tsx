import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BindingEditor, cleanBinding } from '../components/binding.js';
import { Button, ErrorNote, Field, Load, PageHead, Panel, Segmented } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { OrgBundle, Organization, ProviderBinding } from '../lib/api.js';
import { numOrNull } from '../lib/format.js';
import { useAction, useQuery } from '../lib/query.js';

type Mode = 'template' | 'blank' | 'import';

export function NewOrg() {
  const nav = useNavigate();
  const templates = useQuery('org-templates', () => api.listOrgTemplates());
  const [mode, setMode] = useState<Mode>('template');
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [mission, setMission] = useState('');
  const [budget, setBudget] = useState('');
  const [binding, setBinding] = useState<ProviderBinding | null>(null);
  const [bundle, setBundle] = useState<OrgBundle | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const selected = templates.data?.find((t) => t.id === templateId) ?? templates.data?.[0];

  const create = useAction(async (): Promise<Organization> => {
    const defaultProvider = cleanBinding(binding);
    if (mode === 'template') {
      if (!selected) throw new Error('Choose a template first.');
      return api.createOrgFromTemplate({ templateId: selected.id, name: name.trim(), mission: mission || undefined, defaultProvider });
    }
    if (mode === 'import') {
      if (!bundle) throw new Error('Choose a bundle file first.');
      return api.importOrg({ name: name.trim(), bundle });
    }
    return api.createOrg({ name: name.trim(), mission, budgetMonthlyUsd: numOrNull(budget), defaultProvider });
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

  return (
    <div className="page page-narrow">
      <PageHead title="New organization" sub="An organization is an isolated company of agents with its own goals, budget, memory and credentials." />
      <Segmented label="How to start" value={mode} onChange={setMode} options={[{ value: 'template', label: 'From a template' }, { value: 'blank', label: 'Blank' }, { value: 'import', label: 'Import a bundle' }]} />
      <form
        className="stack-lg"
        onSubmit={(e) => {
          e.preventDefault();
          void create.run().then((org) => org && nav(`/o/${org.slug}`));
        }}
      >
        {mode === 'template' ? (
          <Load q={templates} empty={<Panel><p className="muted">No templates are installed. Start from a blank organization instead.</p></Panel>}>
            {(list) => (
              <div className="choice-list" role="radiogroup" aria-label="Template">
                {list.map((t) => (
                  <label key={t.id} className={`choice${selected?.id === t.id ? ' on' : ''}`}>
                    <input type="radio" name="template" checked={selected?.id === t.id} onChange={() => setTemplateId(t.id)} />
                    <span className="grow">
                      <strong>{t.name}</strong>
                      <span className="field-hint">{t.description}</span>
                      <span className="template-depts">
                        {t.departments.map((d) => (
                          <span key={d.name}><b>{d.name}</b> {d.agents.map((a) => a.name).join(', ')}</span>
                        ))}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Load>
        ) : null}
        {mode === 'import' ? (
          <Panel title="Bundle file">
            <div className="stack">
              <Field label="Exported organization (.json)" hint="Bundles carry the org chart, agent configs, skills and sanitized memory. They never contain secrets.">
                <input type="file" accept="application/json,.json" onChange={(e) => void readBundle(e.target.files?.[0])} />
              </Field>
              {bundleError ? <ErrorNote error={new Error(bundleError)} /> : null}
              {bundle ? <p className="note note-go">{bundle.departments.length} departments, {bundle.agents.length} agents, {bundle.skills.length} skills, {bundle.memories.length} memories.</p> : null}
            </div>
          </Panel>
        ) : null}
        <Panel title="Details">
          <div className="form-grid">
            <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="Acme" /></Field>
            {mode === 'blank' ? <Field label="Monthly budget (USD)" hint="Empty means no cap."><input type="number" min="0" step="0.01" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field> : null}
            {mode !== 'import' ? <Field label="Mission" wide hint="One or two sentences every agent in this organization works toward."><textarea rows={2} value={mission} onChange={(e) => setMission(e.target.value)} /></Field> : null}
          </div>
        </Panel>
        {mode !== 'import' ? <BindingEditor legend="Default model provider" value={binding} onChange={setBinding} inheritLabel="Decide later (agents cannot run until a provider is set)" /> : null}
        <ErrorNote error={create.error} />
        <div className="form-actions"><Button type="submit" variant="primary" busy={create.busy} disabled={!name.trim()}>Create organization</Button></div>
      </form>
    </div>
  );
}
