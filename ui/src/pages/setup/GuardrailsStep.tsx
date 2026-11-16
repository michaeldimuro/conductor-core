import { useState } from 'react';
import { AutonomyPicker } from '../../components/AgentForm.js';
import { Icon } from '../../components/icons.js';
import { Check, ErrorNote, Field, Panel } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { UpdateOrgRequest } from '../../lib/api.js';
import { numOrNull } from '../../lib/format.js';
import { useDirectory, useOrg } from '../../lib/org.js';
import { invalidate, useAction } from '../../lib/query.js';
import { GATED } from '../settings/OrgSettings.js';
import { Toggle } from './CapabilitySteps.js';
import { StepActions, useSetup } from './Setup.js';

type Overrides = NonNullable<NonNullable<UpdateOrgRequest['policies']>['approvalOverrides']>;
type Gate = keyof Overrides;

const PRESETS: ReadonlyArray<{ id: string; name: string; blurb: string; autonomy: number; threshold: number; open: Gate[] }> = [
  { id: 'cautious', name: 'Cautious', blurb: 'Everything risky waits for you. Good for the first weeks.', autonomy: 1, threshold: 10, open: [] },
  { id: 'balanced', name: 'Balanced', blurb: 'Agents handle routine work; money, hiring and public posts still ask.', autonomy: 1, threshold: 50, open: ['grant_skill', 'promote_skill'] },
  { id: 'handsoff', name: 'Hands-off', blurb: 'Agents pursue goals on their own; only spending and staffing ask.', autonomy: 2, threshold: 200, open: ['grant_skill', 'promote_skill', 'grant_connector', 'external_send', 'publish'] },
];

export function GuardrailsStep() {
  const { org } = useOrg();
  const setup = useSetup();
  const dir = useDirectory(org.id);
  const suggested = setup.draft?.guardrails;
  const [budget, setBudget] = useState(String(org.budgetMonthlyUsd ?? suggested?.budgetMonthlyUsd ?? ''));
  const [threshold, setThreshold] = useState(String(org.policies.approvalSpendThresholdUsd ?? suggested?.approvalSpendThresholdUsd ?? ''));
  const [concurrent, setConcurrent] = useState(String(org.maxConcurrentRuns));
  const [overrides, setOverrides] = useState<Overrides>(org.policies.approvalOverrides ?? {});
  const [autonomy, setAutonomy] = useState(suggested?.autonomyLevel ?? 1);
  const [applyAutonomy, setApplyAutonomy] = useState(!!suggested);
  const [preset, setPreset] = useState('');
  const gated = (g: Gate) => overrides[g] !== false;

  const usePreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!;
    setPreset(id);
    setAutonomy(p.autonomy);
    setApplyAutonomy(true);
    // A threshold the owner named in the interview (or already saved) wins over the preset's.
    if (org.policies.approvalSpendThresholdUsd == null && suggested?.approvalSpendThresholdUsd == null) setThreshold(String(p.threshold));
    setOverrides(Object.fromEntries(p.open.map((g) => [g, false])) as Overrides);
  };

  const save = useAction(async () => {
    const spend = numOrNull(threshold);
    const { approvalSpendThresholdUsd: _drop, ...rest } = org.policies;
    await api.updateOrg(org.id, {
      budgetMonthlyUsd: numOrNull(budget),
      maxConcurrentRuns: Math.max(1, Number(concurrent) || org.maxConcurrentRuns),
      policies: { ...rest, approvalOverrides: overrides, ...(spend == null ? {} : { approvalSpendThresholdUsd: spend }) },
    });
    if (applyAutonomy) {
      for (const a of dir.staff.filter((x) => x.autonomyLevel !== autonomy)) await api.updateAgent(org.id, a.id, { autonomyLevel: autonomy });
    }
    invalidate('orgs', `${org.id}/`);
    await setup.next();
  });

  return (
    <div className="stack-lg">
      <div className="preset-cards" role="radiogroup" aria-label="Start from a preset">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} className={`preset-card${preset === p.id ? ' on' : ''}`} onClick={() => usePreset(p.id)}>
            <span className="row row-tight"><Icon name={p.id === 'cautious' ? 'lock' : p.id === 'balanced' ? 'policy' : 'launch'} size={16} /><strong>{p.name}</strong></span>
            <span className="muted">{p.blurb}</span>
          </button>
        ))}
      </div>

      <Panel icon="budget" title="Spending">
        <div className="form-grid">
          <Field label="Monthly budget (USD)" hint={suggested?.budgetMonthlyUsd != null && org.budgetMonthlyUsd == null ? 'From your interview. Alerts at 80%, stops at 100%.' : 'Alerts at 80%, hard stop at 100%. Empty means no cap.'}>
            <input type="number" min="0" step="0.01" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="No cap" />
          </Field>
          <Field label="Always ask above (USD, single action)" hint="Any one action costing more than this waits for you.">
            <input type="number" min="0" step="0.01" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="No threshold" />
          </Field>
          <Field label="Agents working at the same time" hint="Higher finishes more in parallel and spends faster.">
            <input type="number" min="1" max="64" value={concurrent} onChange={(e) => setConcurrent(e.target.value)} />
          </Field>
        </div>
      </Panel>

      <Panel icon="approvals" title="What needs your sign-off">
        <ul className="gate-list">
          {GATED.map((g) => (
            <li key={g.id}>
              <Toggle label={g.label} checked={gated(g.id as Gate)} onChange={(on) => {
                setPreset('');
                const next = { ...overrides };
                if (on) delete next[g.id as Gate];
                else next[g.id as Gate] = false;
                setOverrides(next);
              }} />
            </li>
          ))}
        </ul>
      </Panel>

      <Panel icon="agents" title="How independently the team works">
        <div className="stack">
          <AutonomyPicker value={autonomy} onChange={(v) => { setPreset(''); setAutonomy(v); }} />
          {dir.staff.length ? <Check label={`Apply this level to all ${dir.staff.length} agents`} checked={applyAutonomy} onChange={setApplyAutonomy} hint="You can still set each agent's level on its own page." /> : null}
        </div>
      </Panel>
      <ErrorNote error={save.error} />
      <StepActions busy={save.busy} onContinue={() => void save.run()} continueLabel="Save and continue" />
    </div>
  );
}
