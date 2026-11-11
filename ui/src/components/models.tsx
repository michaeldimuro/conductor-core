import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { api, errorText } from '../lib/api.js';
import type { ModelCatalog, ModelOption } from '../lib/api.js';
import { setQueryData, useQuery, type QueryResult } from '../lib/query.js';
import { toast } from '../lib/toast.js';

const CUSTOM = '__custom__';

const catalogKey = (adapterId: string, orgId?: string | null, authRef?: string | null) => `models/${adapterId}/${orgId ?? ''}/${authRef ?? ''}`;

/** The model catalog of one adapter, cached per adapter, org and credential ref. */
export function useModelCatalog(adapterId: string | null | undefined, orgId?: string | null, authRef?: string | null): QueryResult<ModelCatalog> {
  const ref = authRef?.trim() || null;
  return useQuery(adapterId ? catalogKey(adapterId, orgId, ref) : null, () => api.listModels(adapterId!, { ...(orgId ? { orgId } : {}), ...(ref ? { authRef: ref } : {}) }));
}

/** Re-fetch a catalog from its sources (bypasses the daemon's cache). */
async function refreshCatalog(adapterId: string, orgId?: string | null, authRef?: string | null): Promise<void> {
  const ref = authRef?.trim() || null;
  try {
    const fresh = await api.listModels(adapterId, { ...(orgId ? { orgId } : {}), ...(ref ? { authRef: ref } : {}), refresh: true });
    setQueryData<ModelCatalog>(catalogKey(adapterId, orgId, ref), () => fresh);
    toast(`Model list refreshed (${fresh.models.length} models)`, 'ok');
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

const optionText = (m: ModelOption): string => (m.label && m.label !== m.id && !m.label.includes(m.id) && m.kind === 'model' ? `${m.label} (${m.id})` : m.label || m.id);

/** Effort levels a model accepts: its own list, the adapter list, else every level any model lists. */
export function effortsFor(catalog: ModelCatalog | undefined, modelId: string): string[] {
  if (!catalog?.effortKey) return [];
  const id = modelId || catalog.defaultModel || '';
  const own = catalog.models.find((m) => m.id === id)?.efforts;
  if (own?.length) return own;
  if (catalog.efforts.length) return catalog.efforts;
  return [...new Set(catalog.models.flatMap((m) => m.efforts ?? []))];
}

function FieldShell({ id, label, hideLabel, hint, children }: { id: string; label: string; hideLabel?: boolean; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label className={hideLabel ? 'sr-only' : 'field-label'} htmlFor={id}>{label}</label>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

/**
 * Model picker fed by the adapter's catalog: the adapter default, aliases that
 * always track the newest model, pinned models (hidden ones behind a toggle),
 * and a custom id. Falls back to a plain input when no list is available.
 */
export function ModelSelect({ adapterId, orgId, authRef, value, onChange, label = 'Model', emptyLabel, hint, hideLabel }: {
  adapterId: string | null | undefined; orgId?: string | null; authRef?: string | null; value: string; onChange: (v: string) => void;
  label?: string; emptyLabel?: string; hint?: ReactNode; hideLabel?: boolean;
}) {
  const id = useId();
  const q = useModelCatalog(adapterId, orgId, authRef);
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const cat = q.data;
  const notes = cat?.notes.length && !hideLabel ? cat.notes.map((n) => <span key={n} className="dim">{n}</span>) : null;
  const hints = hint || notes ? <>{hint}{hint && notes ? ' ' : null}{notes}</> : undefined;

  if (!adapterId || q.error || (cat && cat.models.length === 0)) {
    return (
      <FieldShell id={id} label={label} hideLabel={hideLabel} hint={hints ?? (q.error ? 'The model list could not be loaded; enter a model id.' : 'Leave empty for the adapter default.')}>
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={hideLabel ? `${label} (optional)` : undefined} autoCapitalize="none" spellCheck={false} />
      </FieldShell>
    );
  }

  const models = cat?.models ?? [];
  const known = models.some((m) => m.id === value);
  const aliases = models.filter((m) => m.kind === 'alias');
  const pinned = models.filter((m) => m.kind === 'model' && !m.hidden);
  const hidden = models.filter((m) => m.kind === 'model' && m.hidden);
  const hiddenShown = showAll ? hidden : hidden.filter((m) => m.id === value);
  const def = emptyLabel ?? (cat?.defaultModel ? `Adapter default (${cat.defaultModel})` : 'Adapter default');
  const selectValue = editing ? CUSTOM : value;
  const pick = (v: string) => {
    if (v === CUSTOM) {
      setEditing(true);
      return;
    }
    setEditing(false);
    onChange(v);
  };
  const reload = async () => {
    setRefreshing(true);
    await refreshCatalog(adapterId, orgId, authRef);
    setRefreshing(false);
  };

  return (
    <FieldShell id={id} label={label} hideLabel={hideLabel} hint={hints}>
      <div className="model-pick">
        <select id={id} value={selectValue} onChange={(e) => pick(e.target.value)} aria-busy={q.loading || undefined}>
          <option value="">{def}</option>
          {value && !known && !editing ? <option value={value}>{value} (custom)</option> : null}
          {aliases.length ? <optgroup label="Aliases (always latest)">{aliases.map((m) => <option key={m.id} value={m.id} title={m.description}>{optionText(m)}</option>)}</optgroup> : null}
          {pinned.length ? <optgroup label="Models">{pinned.map((m) => <option key={m.id} value={m.id} title={m.description}>{optionText(m)}</option>)}</optgroup> : null}
          {hiddenShown.length ? <optgroup label="Other models (not recommended)">{hiddenShown.map((m) => <option key={m.id} value={m.id} title={m.description}>{optionText(m)}</option>)}</optgroup> : null}
          {q.loading ? <option value="__loading__" disabled>Loading models…</option> : null}
          {cat?.allowCustom !== false ? <option value={CUSTOM}>Custom model id…</option> : null}
        </select>
        <button type="button" className="icon-btn" onClick={() => void reload()} disabled={refreshing} aria-label={`Refresh the ${label.toLowerCase()} list`} title="Refresh the model list">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className={refreshing ? 'spin' : undefined}><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      {editing ? (
        <input aria-label={`${label}: custom model id`} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Exact model id" autoCapitalize="none" spellCheck={false} autoFocus />
      ) : null}
      {hidden.length && !hideLabel ? (
        <button type="button" className="link-btn field-hint" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
          {showAll ? 'Hide models the provider does not recommend' : `Show all models (${hidden.length} more)`}
        </button>
      ) : null}
    </FieldShell>
  );
}

/** Reasoning effort for the chosen model; empty means the model's default. */
export function EffortSelect({ catalog, model, value, onChange, label = 'Effort' }: {
  catalog: ModelCatalog | undefined; model: string; value: string; onChange: (v: string) => void; label?: string;
}) {
  const id = useId();
  if (!catalog?.effortKey) return null;
  const options = effortsFor(catalog, model);
  const m = catalog.models.find((x) => x.id === (model || catalog.defaultModel || ''));
  const def = m?.defaultEffort ? `Default (${m.defaultEffort})` : 'Default';
  return (
    <FieldShell id={id} label={label} hint={options.length ? undefined : 'This model lists no effort levels.'}>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{def}</option>
        {value && !options.includes(value) ? <option value={value}>{value} (not listed)</option> : null}
        {options.map((e) => <option key={e} value={e}>{e}</option>)}
      </select>
    </FieldShell>
  );
}
