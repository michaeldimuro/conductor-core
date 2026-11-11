import { useContext } from 'react';
import { api } from '../lib/api.js';
import type { ProviderBinding } from '../lib/api.js';
import { OrgContext } from '../lib/org.js';
import { useQuery } from '../lib/query.js';
import { AuthSelect, CLI_OF_ADAPTER } from './binding-auth.js';
import { EffortSelect, ModelSelect, effortsFor, useModelCatalog } from './models.js';
import { Button, Check, Field, JsonField } from './ui.js';

type Link = Omit<ProviderBinding, 'fallback'>;

export const useAdapters = () => useQuery('adapters', () => api.listAdapters());

/** Drop empty optional fields so the strict API schema accepts the binding. */
export function cleanBinding(b: ProviderBinding | null): ProviderBinding | null {
  if (!b || !b.adapter) return null;
  const link = (l: Link): Link => ({
    adapter: l.adapter,
    ...(l.model?.trim() ? { model: l.model.trim() } : {}),
    ...(l.authRef?.trim() ? { authRef: l.authRef.trim() } : {}),
    ...(l.auth && l.auth !== 'login' ? { auth: l.auth } : {}),
    ...(l.config && Object.keys(l.config).length ? { config: l.config } : {}),
  });
  const fallback = (b.fallback ?? []).filter((f) => f.adapter).map(link);
  return { ...link(b), ...(fallback.length ? { fallback } : {}) };
}

export function describeBinding(b: ProviderBinding | null | undefined, model?: string | null): string {
  if (!b) return 'Organization default';
  const chain = [b, ...(b.fallback ?? [])].map((l, i) => `${l.adapter}${(i === 0 ? (model ?? l.model) : l.model) ? ` (${i === 0 ? (model ?? l.model) : l.model})` : ''}`);
  return chain.join(', then ');
}

const EFFORT_KEYS = ['effort', 'reasoningEffort'];

/** Remove keys from a config; an empty config becomes undefined so it is not saved. */
function withoutKeys(config: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> | undefined {
  if (!config) return undefined;
  const next = Object.fromEntries(Object.entries(config).filter(([key]) => !keys.includes(key)));
  return Object.keys(next).length ? next : undefined;
}

function LinkFields({ value, onChange, adapters, legend }: { value: Link; onChange: (v: Link) => void; adapters: Array<{ id: string; name: string }>; legend: string }) {
  const orgId = useContext(OrgContext)?.org.id ?? null;
  const known = adapters.some((a) => a.id === value.adapter);
  const cli = value.adapter in CLI_OF_ADAPTER;
  const auth = value.auth ?? 'login';
  // A token is not an API key: only hand the catalog a ref it can list models with.
  const catalogRef = !cli || auth === 'api_key' ? value.authRef : undefined;
  const catalog = useModelCatalog(value.adapter || null, orgId, catalogRef).data;
  const effortKey = catalog?.effortKey ?? null;
  const effort = effortKey && typeof value.config?.[effortKey] === 'string' ? (value.config[effortKey] as string) : '';
  const setModel = (model: string) => {
    const supported = effortsFor(catalog, model);
    const drop = effortKey && effort && supported.length && !supported.includes(effort);
    onChange({ ...value, model, config: drop ? withoutKeys(value.config, [effortKey]) : value.config });
  };
  const setEffort = (next: string) => {
    if (!effortKey) return;
    onChange({ ...value, config: next ? { ...value.config, [effortKey]: next } : withoutKeys(value.config, [effortKey]) });
  };
  const setAdapter = (adapter: string) => {
    if (adapter === value.adapter) return;
    onChange({ adapter, ...(value.authRef ? { authRef: value.authRef } : {}), ...(value.config ? { config: withoutKeys(value.config, EFFORT_KEYS) } : {}) });
  };
  const showRef = !cli || auth !== 'login' || !!value.authRef;
  const refLabel = !cli ? 'API key secret' : auth === 'login' ? 'API key secret (older bindings)' : 'Credential secret (optional override)';
  const refHint = !cli
    ? 'The name of a stored secret, never the key itself.'
    : auth === 'login'
      ? 'With the CLI login, a secret here makes runs use that API key instead. Prefer "API key (metered)", or clear it.'
      : 'Empty uses the stored credential shown above. Name a secret, never the value itself.';
  return (
    <div className="form-grid">
      <Field label={`${legend} adapter`}>
        <select value={value.adapter} onChange={(e) => setAdapter(e.target.value)} required>
          <option value="">Choose an adapter</option>
          {adapters.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
          {value.adapter && !known ? <option value={value.adapter}>{value.adapter} (not installed)</option> : null}
        </select>
      </Field>
      <ModelSelect label={`${legend} model`} adapterId={value.adapter || null} orgId={orgId} authRef={catalogRef} value={value.model ?? ''} onChange={setModel} />
      {effortKey ? <EffortSelect label={`${legend} effort`} catalog={catalog} model={value.model ?? ''} value={effort} onChange={setEffort} /> : null}
      {cli ? <AuthSelect adapterId={value.adapter} auth={value.auth} authRef={value.authRef ?? ''} orgId={orgId} onChange={(a) => onChange({ ...value, auth: a === 'login' ? undefined : a })} /> : null}
      {showRef ? (
        <Field label={refLabel} hint={refHint}>
          <input value={value.authRef ?? ''} onChange={(e) => onChange({ ...value, authRef: e.target.value })} placeholder={`org/acme/${cli && auth === 'token' ? 'claude-oauth-token' : /codex|openai/.test(value.adapter) ? 'openai-api-key' : 'anthropic-api-key'}`} autoCapitalize="none" spellCheck={false} />
        </Field>
      ) : null}
    </div>
  );
}

export function BindingEditor({ value, onChange, inheritLabel, legend = 'Model provider' }: {
  value: ProviderBinding | null; onChange: (v: ProviderBinding | null) => void; inheritLabel?: string; legend?: string;
}) {
  const adapters = useAdapters();
  const list = adapters.data ?? [];
  const fallback = value?.fallback ?? [];
  const setFallback = (next: Link[]) => value && onChange({ ...value, fallback: next });
  return (
    <fieldset>
      <legend>{legend}</legend>
      {inheritLabel ? <Check label={inheritLabel} checked={value === null} onChange={(inherit) => onChange(inherit ? null : { adapter: list[0]?.id ?? '' })} /> : null}
      {value ? (
        <>
          <LinkFields legend="Primary" value={value} adapters={list} onChange={(l) => onChange({ ...l, fallback: value.fallback })} />
          <details>
            <summary>Adapter settings (JSON)</summary>
            <JsonField key={`${value.adapter}|${EFFORT_KEYS.map((x) => String(value.config?.[x] ?? '')).join('|')}`} label="Non-secret adapter config" value={value.config ?? {}} onChange={(config) => onChange({ ...value, config })} rows={4} />
          </details>
          {fallback.map((f, i) => (
            <div key={i} className="fallback">
              <LinkFields legend={`Fallback ${i + 1}`} value={f} adapters={list} onChange={(l) => setFallback(fallback.map((x, j) => (j === i ? l : x)))} />
              <Button small variant="quiet" onClick={() => setFallback(fallback.filter((_, j) => j !== i))}>Remove fallback {i + 1}</Button>
            </div>
          ))}
          <div>
            <Button small onClick={() => setFallback([...fallback, { adapter: '' }])} disabled={fallback.length >= 10}>Add a fallback</Button>
            <span className="field-hint">Fallbacks are tried in order on a rate limit, auth failure or outage.</span>
          </div>
        </>
      ) : null}
    </fieldset>
  );
}
