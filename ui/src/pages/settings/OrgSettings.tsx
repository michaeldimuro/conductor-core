import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/icons.js';
import { SETUP_STEPS, useOnboarding } from '../../lib/setup.js';
import { BindingEditor, cleanBinding } from '../../components/binding.js';
import { useConnectors } from '../../components/connectors.js';
import { Button, Check, ConfirmButton, ErrorNote, Field, Panel, TagInput } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { ProviderBinding, UpdateOrgRequest } from '../../lib/api.js';
import { numOrNull } from '../../lib/format.js';
import { useOrg } from '../../lib/org.js';
import { useAction } from '../../lib/query.js';
import { ArchivedOrgs, MemoryBackendPanel } from './OrgExtras.js';

export const GATED: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'hire_agent', label: 'Hiring an agent' }, { id: 'terminate_agent', label: 'Terminating an agent' }, { id: 'budget_raise', label: 'Raising a budget' },
  { id: 'payment', label: 'Any payment or purchase' }, { id: 'external_send', label: 'First send to a new external recipient' }, { id: 'publish', label: 'Publishing public content' },
  { id: 'grant_connector', label: 'Granting a connector to an agent' }, { id: 'grant_skill', label: 'Granting a skill to an agent' }, { id: 'promote_skill', label: 'Promoting a skill to organization or global scope' },
];
type Policies = NonNullable<UpdateOrgRequest['policies']>;

/** Re-entry to guided setup: re-run the interview when how the organization operates changes, or revisit one step. */
function GuidedSetupPanel() {
  const { org, base } = useOrg();
  const q = useOnboarding(org.id);
  const state = q.data?.state;
  const done = new Set(state?.done ?? []);
  return (
    <Panel icon="launch" title="Guided setup" actions={<Link to={`${base}/setup/${state && state.status !== 'complete' ? state.step : 'interview'}`}>{state && state.status !== 'complete' ? 'Resume' : state ? 'Run again' : 'Start'}</Link>}>
      <div className="stack">
        <p className="dim">{state?.status === 'complete' ? 'Setup is complete. When the way this organization works changes, run the interview again: it drafts fresh prompts and guardrails for you to review.' : 'Walk through the interview, models, team prompts, tools and guardrails one step at a time.'}</p>
        <div className="setup-card-steps">
          {SETUP_STEPS.map((s) => (
            <span key={s.id} className={done.has(s.id) ? 'is-done' : ''}>
              <Link to={`${base}/setup/${s.id}`}><span className="check-dot" aria-hidden="true">{done.has(s.id) ? <Icon name="check" size={11} strokeWidth={3} /> : null}</span>{s.label}</Link>
            </span>
          ))}
        </div>
      </div>
    </Panel>
  );
}

export function OrgSettings() {
  const { org } = useOrg();
  const nav = useNavigate();
  const connectors = useConnectors(org.id);
  const [name, setName] = useState(org.name);
  const [mission, setMission] = useState(org.mission);
  const [budget, setBudget] = useState(org.budgetMonthlyUsd == null ? '' : String(org.budgetMonthlyUsd));
  const [seatHours, setSeatHours] = useState(org.seatSecondsMonthly == null ? '' : String(org.seatSecondsMonthly / 3600));
  const [maxRuns, setMaxRuns] = useState(String(org.maxConcurrentRuns));
  const [provider, setProvider] = useState<ProviderBinding | null>(org.defaultProvider);
  const [utility, setUtility] = useState<ProviderBinding | null>(org.utilityModel);
  const [policies, setPolicies] = useState<Policies>(org.policies);
  const [threshold, setThreshold] = useState(org.policies.approvalSpendThresholdUsd == null ? '' : String(org.policies.approvalSpendThresholdUsd));
  const [skills, setSkills] = useState(org.defaultSkills);
  const [defaultConnectors, setDefaultConnectors] = useState(org.defaultConnectors);
  const overrides = policies.approvalOverrides ?? {};

  const save = useAction(() => {
    const seat = numOrNull(seatHours);
    const spend = numOrNull(threshold);
    const { approvalSpendThresholdUsd: _drop, ...rest } = policies;
    return api.updateOrg(org.id, {
      name: name.trim(), mission, budgetMonthlyUsd: numOrNull(budget), seatSecondsMonthly: seat == null ? null : Math.round(seat * 3600),
      maxConcurrentRuns: Number(maxRuns), defaultProvider: cleanBinding(provider), utilityModel: cleanBinding(utility),
      policies: { ...rest, ...(spend == null ? {} : { approvalSpendThresholdUsd: spend }) }, defaultSkills: skills, defaultConnectors,
    });
  }, { invalidate: ['orgs', `${org.id}/`], success: 'Organization saved' });
  const archive = useAction(async () => {
    await api.archiveOrg(org.id);
    nav('/');
  }, { invalidate: ['orgs', 'status'], success: `Archived ${org.name}` });

  return (
    <div className="stack-lg page-narrow">
    <GuidedSetupPanel />
    <form className="stack-lg" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <Panel icon="org" title="Identity and limits">
        <div className="form-grid">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></Field>
          <Field label="Address"><input value={`/o/${org.slug}`} readOnly className="mono" /></Field>
          <Field label="Mission" wide><textarea rows={2} value={mission} onChange={(e) => setMission(e.target.value)} /></Field>
          <Field label="Monthly budget (USD)" hint="Soft alert at 80%, hard stop at 100%. Empty means no cap."><input type="number" min="0" step="0.01" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
          <Field label="Monthly seat time (hours)" hint="Quota for runs on a local subscription login. Empty means no quota."><input type="number" min="0" step="0.5" inputMode="decimal" value={seatHours} onChange={(e) => setSeatHours(e.target.value)} /></Field>
          <Field label="Runs at the same time"><input type="number" min="1" max="64" value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} required /></Field>
        </div>
      </Panel>
      <BindingEditor legend="Default model provider" value={provider} onChange={setProvider} inheritLabel="None set (agents need their own binding to run)" />
      <BindingEditor legend="Utility model (reflection, summaries, memory extraction)" value={utility} onChange={setUtility} inheritLabel="Use the built-in offline heuristics" />
      <Panel icon="agents" title="Inherited by every agent">
        <div className="form-grid">
          <Field label="Default skills" wide hint="Skill names every agent in this organization loads."><TagInput label="Default skills" value={skills} onChange={setSkills} placeholder="Type a skill name and press Enter" /></Field>
          <fieldset className="field-wide">
            <legend>Default connectors</legend>
            {(connectors.data ?? []).length === 0 ? <p className="muted">No connectors are installed yet.</p> : null}
            {(connectors.data ?? []).map((c) => (
              <Check key={c.id} label={c.name} checked={defaultConnectors.includes(c.id)} onChange={(on) => setDefaultConnectors(on ? [...defaultConnectors, c.id] : defaultConnectors.filter((x) => x !== c.id))} />
            ))}
          </fieldset>
        </div>
      </Panel>
      <Panel icon="policy" title="What needs your approval">
        <div className="stack">
          <p className="dim">These actions wait for you by default. Unticking one lets agents do it without asking.</p>
          {GATED.map((g) => (
            <Check key={g.id} label={g.label} checked={overrides[g.id as keyof typeof overrides] !== false}
              onChange={(on) => {
                const next = { ...overrides };
                if (on) delete next[g.id as keyof typeof overrides];
                else next[g.id as keyof typeof overrides] = false;
                setPolicies({ ...policies, approvalOverrides: next });
              }} />
          ))}
          <div className="form-grid">
            <Field label="Also require approval for" hint="Extra action kinds to gate in this organization."><TagInput label="Extra gated actions" value={policies.extraGated ?? []} onChange={(extraGated) => setPolicies({ ...policies, extraGated })} placeholder="tool_call" /></Field>
            <Field label="Always ask above (USD, single action)" hint="Empty means no spend threshold."><input type="number" min="0" step="0.01" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></Field>
            <Field label="Promoting a skill to a department">
              <select value={policies.deptSkillPromotion ?? 'lead'} onChange={(e) => setPolicies({ ...policies, deptSkillPromotion: e.target.value as 'lead' | 'auto' })}>
                <option value="lead">The department lead reviews it</option><option value="auto">Automatic when it beats the baseline eval</option>
              </select>
            </Field>
            <Field label="Preferred toolkit source">
              <select value={policies.toolkitDefault ?? ''} onChange={(e) => {
                const { toolkitDefault: _t, ...rest } = policies;
                setPolicies(e.target.value ? { ...rest, toolkitDefault: e.target.value as 'composio' | 'arcade' } : rest);
              }}>
                <option value="">No preference</option><option value="composio">Composio</option><option value="arcade">Arcade</option>
              </select>
            </Field>
            <Field label="Network allowlist for sandboxed shell tools" wide hint="Hosts agents' shell tools may reach."><TagInput label="Network allowlist" value={policies.networkAllowlist ?? []} onChange={(networkAllowlist) => setPolicies({ ...policies, networkAllowlist })} placeholder="api.github.com" /></Field>
          </div>
        </div>
      </Panel>
      <ErrorNote error={save.error} />
      <div className="form-actions"><Button icon="check" type="submit" variant="primary" busy={save.busy}>Save organization</Button></div>
    </form>
      <MemoryBackendPanel />
      <Panel icon="archive" title="Archive">
        <div className="spread">
          <p className="dim">Archiving stops every agent and hides the organization. Its data stays on disk.</p>
          <ConfirmButton icon="archive" label="Archive organization" danger title={`Archive ${org.name}`} confirmLabel="Archive" phrase={org.slug} message={`Every agent in ${org.name} stops and the organization disappears from the switcher.`} onConfirm={() => archive.run()} />
        </div>
      </Panel>
      <ArchivedOrgs />
    </div>
  );
}
