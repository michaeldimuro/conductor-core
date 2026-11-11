import { api } from '../lib/api.js';
import type { ProviderBinding } from '../lib/api.js';
import { useQuery } from '../lib/query.js';
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

function LinkFields({ value, onChange, adapters, legend }: { value: Link; onChange: (v: Link) => void; adapters: Array<{ id: string; name: string }>; legend: string }) {
  const known = adapters.some((a) => a.id === value.adapter);
  return (
    <div className="form-grid">
      <Field label={`${legend} adapter`}>
        <select value={value.adapter} onChange={(e) => onChange({ ...value, adapter: e.target.value })} required>
          <option value="">Choose an adapter</option>
          {adapters.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
          {value.adapter && !known ? <option value={value.adapter}>{value.adapter} (not installed)</option> : null}
        </select>
      </Field>
      <Field label="Model" hint="Leave empty for the adapter default.">
        <input value={value.model ?? ''} onChange={(e) => onChange({ ...value, model: e.target.value })} autoCapitalize="none" spellCheck={false} />
      </Field>
      <Field label="API key secret" hint="The name of a stored secret, never the key itself. Local CLI logins need none.">
        <input value={value.authRef ?? ''} onChange={(e) => onChange({ ...value, authRef: e.target.value })} placeholder="org/acme/anthropic-api-key" autoCapitalize="none" spellCheck={false} />
      </Field>
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
            <JsonField label="Non-secret adapter config" value={value.config ?? {}} onChange={(config) => onChange({ ...value, config })} rows={4} />
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
