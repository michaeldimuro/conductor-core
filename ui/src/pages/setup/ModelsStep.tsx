import { useState } from 'react';
import { BindingEditor, cleanBinding, useAdapters } from '../../components/binding.js';
import { Icon } from '../../components/icons.js';
import { Button, Chip, ErrorNote, Panel, Status } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { AdapterHealth, ProviderBinding } from '../../lib/api.js';
import { k, useOrg } from '../../lib/org.js';
import { invalidate, useAction, useQuery } from '../../lib/query.js';
import { ProviderAccounts } from '../settings/Accounts.js';
import { StepActions, useSetup } from './Setup.js';

const UTILITY_LABEL: Record<string, string> = {
  claude_api: 'Claude API', openai_api: 'OpenAI API', claude_local: 'Claude Code on this Mac', codex_local: 'Codex on this Mac', offline: 'Offline heuristics',
};

function PluginsRow() {
  const adapters = useAdapters();
  const plugins = (adapters.data ?? []).filter((a) => !a.builtin);
  const rescan = useAction(() => api.rescanAdapters(), {
    invalidate: ['adapters'],
    success: (r) => (r.added.length ? `Loaded ${r.added.join(', ')}` : r.skipped.length ? `${r.skipped.length} plugin folders could not load` : 'No new plugins found'),
  });
  return (
    <div className="setup-row">
      <span className="setup-row-icon" aria-hidden="true"><Icon name="catalog" size={16} /></span>
      <div className="grow">
        <strong>Adapter plugins</strong>
        <p className="muted">{plugins.length ? `${plugins.length} loaded: ${plugins.map((p) => p.name).join(', ')}.` : 'Add other providers (Gemini, a local model server, an internal gateway) by dropping a plugin into the adapters folder.'}</p>
        {rescan.error ? <ErrorNote error={rescan.error} /> : null}
      </div>
      <Button small icon="refresh" busy={rescan.busy} onClick={() => void rescan.run()}>Rescan plugins</Button>
    </div>
  );
}

export function ModelsStep() {
  const { org } = useOrg();
  const setup = useSetup();
  const adapters = useAdapters();
  const [binding, setBinding] = useState<ProviderBinding | null>(org.defaultProvider ?? null);
  const [utility, setUtility] = useState<ProviderBinding | null>(org.utilityModel ?? null);
  const [health, setHealth] = useState<AdapterHealth | null>(null);
  const status = useQuery(k(org.id, 'utility-model'), () => api.utilityModelStatus(org.id), { orgId: org.id });
  const clean = cleanBinding(binding);
  const test = useAction(async () => {
    if (!clean) throw new Error('Choose an adapter first.');
    return api.testAdapter(clean.adapter, { model: clean.model ?? null, authRef: clean.authRef ?? null, config: clean.config, orgId: org.id });
  }, { quiet: true });
  const save = useAction(async () => {
    await api.updateOrg(org.id, { defaultProvider: clean, utilityModel: cleanBinding(utility) });
    invalidate('orgs', `${org.id}/`);
    await setup.next();
  });
  const pick = (adapter: string) => {
    setHealth(null);
    setBinding({ adapter });
  };
  const list = adapters.data ?? [];

  return (
    <div className="stack-lg">
      <Panel icon="model" title="Default model for every agent">
        <div className="stack">
          {list.length ? (
            <div className="adapter-cards" role="radiogroup" aria-label="Adapter">
              {list.map((a) => (
                <button key={a.id} type="button" role="radio" aria-checked={binding?.adapter === a.id} className={`adapter-card${binding?.adapter === a.id ? ' on' : ''}`} onClick={() => pick(a.id)}>
                  <span className="adapter-card-icon" aria-hidden="true"><Icon name={a.id.includes('local') ? 'disk' : 'server'} size={16} /></span>
                  <strong>{a.name}</strong>
                  <span className="muted mono">{a.id}</span>
                  {a.builtin ? null : <Chip tone="info">Plugin</Chip>}
                </button>
              ))}
            </div>
          ) : null}
          <BindingEditor legend="Provider details" value={binding} onChange={(b) => { setHealth(null); setBinding(b); }} inheritLabel="Decide later (agents cannot run until a provider is set)" />
          {clean ? (
            <div className="row">
              <Button icon="spark" busy={test.busy} onClick={() => { setHealth(null); void test.run().then((h) => h && setHealth(h)); }}>{test.busy ? 'Testing…' : 'Test connection'}</Button>
              <span aria-live="polite" className="row row-tight">
                {health ? <><Status value={health.ok ? 'ok' : 'failed'} label={health.ok ? 'Connected' : 'Failed'} />{health.detail ? <span className="dim">{health.detail}</span> : null}</> : null}
              </span>
            </div>
          ) : <p className="note note-warn"><Icon name="warn" className="note-icon" /><span>Without a default provider, only agents with their own binding can run. You can finish setup and add one later.</span></p>}
          <ErrorNote error={test.error} />
        </div>
      </Panel>
      <ProviderAccounts orgId={org.id} />
      <Panel icon="tune" title="Background intelligence">
        <div className="stack">
          <div className="setup-row">
            <span className="setup-row-icon" aria-hidden="true"><Icon name="memory" size={16} /></span>
            <div className="grow">
              <strong>Utility model</strong>
              <p className="muted">Writes reflections after runs, extracts memories, judges skill evaluations and powers this setup interview.</p>
              {status.data ? <p className="row row-tight"><Status value={status.data.backend === 'offline' ? 'paused' : 'ok'} label={UTILITY_LABEL[status.data.backend] ?? status.data.backend} />{status.data.model ? <Chip>{status.data.model}</Chip> : null}<span className="dim">{status.data.reason}</span></p> : null}
            </div>
          </div>
          <details>
            <summary>Choose a specific utility model</summary>
            <BindingEditor legend="Utility model" value={utility} onChange={setUtility} inheritLabel="Pick automatically (stored API key, then a signed-in CLI, then offline)" />
          </details>
          <PluginsRow />
        </div>
      </Panel>
      <ErrorNote error={save.error} />
      <StepActions busy={save.busy} onContinue={() => void save.run()} continueLabel={clean ? 'Save and continue' : 'Continue without a provider'} />
    </div>
  );
}
