import { useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, FormEvent, KeyboardEvent, ReactNode } from 'react';
import { errorText } from '../lib/api.js';
import { humanize } from '../lib/format.js';
import { STATUS_LABEL } from '../lib/org.js';
import type { QueryResult } from '../lib/query.js';
import { dismissToast, useToasts } from '../lib/toast.js';
import { Icon, type IconName } from './icons.js';

export type Tone = 'go' | 'warn' | 'stop' | 'info' | 'idle';

const TONES: Record<string, Tone> = {
  active: 'go', running: 'go', succeeded: 'go', done: 'go', approved: 'go', accepted: 'go', achieved: 'go', trusted: 'go', ok: 'go', completed: 'go',
  in_progress: 'go', handed_back: 'go',
  paused: 'warn', in_review: 'warn', pending: 'warn', draft: 'warn', review: 'warn', proposed: 'warn', edited: 'warn', soft: 'warn',
  blocked: 'stop', failed: 'stop', denied: 'stop', error: 'stop', quarantined: 'stop', rejected: 'stop', hard: 'stop',
  todo: 'info', queued: 'info',
};
const LIVE = new Set(['running', 'in_progress']);
export const toneOf = (status: string): Tone => TONES[status] ?? 'idle';

/** A signal lamp: the one status vocabulary used across the console. */
export function Lamp({ tone, live }: { tone: Tone; live?: boolean }) {
  return <span className={`lamp lamp-${tone}${live ? ' lamp-live' : ''}`} aria-hidden="true" />;
}

export function Status({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`status status-${toneOf(value)}`}>
      <Lamp tone={toneOf(value)} live={LIVE.has(value)} />
      {label === '' ? <span className="sr-only">{STATUS_LABEL[value] ?? humanize(value)}</span> : (label ?? STATUS_LABEL[value] ?? humanize(value))}
    </span>
  );
}

export function Chip({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return <span className={`chip${tone ? ` chip-${tone}` : ''}`}>{children}</span>;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'quiet';
  small?: boolean;
  busy?: boolean;
  /** Leading icon. */
  icon?: IconName;
}

export function Button({ variant = 'default', small, busy, className, children, disabled, type = 'button', icon, ...rest }: ButtonProps) {
  return (
    <button type={type} className={`btn btn-${variant}${small ? ' btn-sm' : ''}${icon ? ' btn-icon' : ''}${className ? ` ${className}` : ''}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {icon ? <Icon name={icon} size={small ? 14 : 15} /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field${wide ? ' field-wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint ? <span className="field-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return (
    <div className="note note-stop" role="alert">
      <Icon name="error" className="note-icon" />
      <span className="grow">{errorText(error)}</span>
      {retry ? <Button icon="refresh" small onClick={retry}>Try again</Button> : null}
    </div>
  );
}

export function Empty({ title, children, icon = 'empty' }: { title: string; children?: ReactNode; icon?: IconName }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} size={20} /></span>
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-body">{children}</div> : null}
    </div>
  );
}

export function Loading({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => <span key={i} style={{ width: `${88 - i * 17}%` }} />)}
    </div>
  );
}

/** Loading, error and empty states for one query, then the data. */
export function Load<T>({ q, children, empty, lines }: { q: QueryResult<T>; children: (data: T) => ReactNode; empty?: ReactNode; lines?: number }) {
  if (q.data === undefined) return q.error ? <ErrorNote error={q.error} retry={q.reload} /> : <Loading lines={lines} />;
  if (empty && Array.isArray(q.data) && q.data.length === 0) return <>{empty}</>;
  return (
    <>
      {q.error ? <ErrorNote error={q.error} retry={q.reload} /> : null}
      {children(q.data)}
    </>
  );
}

export function Panel({ title, actions, children, flush, className, icon }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string; icon?: IconName }) {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`}>
      {title || actions ? (
        <header className="panel-head">
          <h2>{icon ? <Icon name={icon} className="panel-icon" /> : null}{title}</h2>
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? 'panel-flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

/** The Conductor mark: the violet→blue→cyan gradient tile with a baton tip over three voices. */
export function Logo({ size = 24 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset=".5" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="34" height="34" rx="11" fill={`url(#${id})`} />
      <rect x="11" y="18" width="4" height="11" rx="2" fill="#0b0820" />
      <rect x="18" y="12.5" width="4" height="16.5" rx="2" fill="#0b0820" />
      <rect x="25" y="21" width="4" height="8" rx="2" fill="#0b0820" />
      <circle cx="28.5" cy="12.5" r="2.6" fill="#fff" />
    </svg>
  );
}

export function PageHead({ title, sub, actions, eyebrow, icon }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode; icon?: IconName }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1 className={icon ? 'page-title-icon' : undefined}>{icon ? <span className="page-icon"><Icon name={icon} size={20} /></span> : null}{title}</h1>
        {sub ? <p>{sub}</p> : null}
      </div>
      {actions ? <div className="row page-actions">{actions}</div> : null}
    </header>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' modal-wide' : ''}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <div className="modal-inner">
          <header className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
          </header>
          <div className="modal-body">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

/** Form chrome for modals: submit handler, inline error, cancel and save buttons. */
export function FormShell({ onSubmit, onCancel, busy, error, submitLabel, children, danger }: {
  onSubmit: () => void; onCancel?: () => void; busy?: boolean; error?: unknown; submitLabel: string; children: ReactNode; danger?: boolean;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSubmit();
  };
  return (
    <form onSubmit={submit} className="form">
      {children}
      <ErrorNote error={error} />
      <div className="form-actions">
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
        <Button type="submit" variant={danger ? 'danger' : 'primary'} busy={busy}>{busy ? 'Working…' : submitLabel}</Button>
      </div>
    </form>
  );
}

/** A button that asks before acting. `phrase` adds a typed confirmation for destructive actions. */
export function ConfirmButton({ label, title, message, confirmLabel, onConfirm, danger, small, phrase, disabled, variant, icon }: {
  label: ReactNode; title: string; message: ReactNode; confirmLabel: string; onConfirm: () => Promise<unknown> | void;
  danger?: boolean; small?: boolean; phrase?: string; disabled?: boolean; variant?: ButtonProps['variant']; icon?: IconName;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const close = () => {
    setOpen(false);
    setTyped('');
  };
  const go = async () => {
    setBusy(true);
    try {
      await onConfirm();
      close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button small={small} icon={icon} variant={variant ?? (danger ? 'danger' : 'default')} onClick={() => setOpen(true)} disabled={disabled}>{label}</Button>
      <Modal open={open} onClose={close} title={title}>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void go();
          }}
        >
          <div className="prose">{message}</div>
          {phrase ? (
            <Field label={`Type ${phrase} to confirm`}>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </Field>
          ) : null}
          <div className="form-actions">
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant={danger ? 'danger' : 'primary'} busy={busy} disabled={phrase ? typed.trim().toLowerCase() !== phrase.toLowerCase() : false}>{confirmLabel}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** Free-form list editor: Enter or comma adds, Backspace on an empty input removes the last. */
export function TagInput({ value, onChange, placeholder, label }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; label: string }) {
  const [draft, setDraft] = useState('');
  const commit = (raw: string) => {
    const parts = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (draft.trim()) {
        e.preventDefault();
        commit(draft);
      } else if (e.key === ',') e.preventDefault();
    } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="tags">
      {value.map((v) => (
        <span key={v} className="chip chip-removable">
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>×</button>
        </span>
      ))}
      <input
        aria-label={label}
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => draft.trim() && commit(draft)}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (/[,\n]/.test(text)) {
            e.preventDefault();
            commit(text);
          }
        }}
        autoCapitalize="none"
        spellCheck={false}
      />
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label, small }: {
  value: T; onChange: (v: T) => void; options: ReadonlyArray<{ value: T; label: string }>; label: string; small?: boolean;
}) {
  return (
    <div className={`segmented${small ? ' segmented-sm' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? `on seg-${o.value}` : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Meter({ value, cap, label }: { value: number; cap: number | null; label: string }) {
  const ratio = cap && cap > 0 ? value / cap : 0;
  const tone = !cap ? 'idle' : ratio >= 1 ? 'stop' : ratio >= 0.8 ? 'warn' : 'go';
  return (
    <div className={`meter meter-${tone}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={cap ?? undefined} aria-valuenow={value}>
      <span className="meter-fill" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      {cap ? <span className="meter-mark" style={{ left: '80%' }} title="Soft alert at 80%" /> : null}
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="code">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function KeyValues({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return <p className="muted">No details.</p>;
  return (
    <dl className="kv">
      {entries.map(([key, v]) => (
        <div key={key}>
          <dt>{humanize(key)}</dt>
          <dd>{v !== null && typeof v === 'object' ? <JsonView value={v} /> : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          <span>{t.text}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

/** JSON textarea that reports parse errors instead of silently dropping input. */
export function JsonField({ label, value, onChange, hint, rows = 6 }: { label: string; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; hint?: string; rows?: number }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [bad, setBad] = useState<string | null>(null);
  return (
    <Field label={label} hint={bad ?? hint} wide>
      <textarea
        className="mono"
        rows={rows}
        value={text}
        spellCheck={false}
        aria-invalid={bad ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed: unknown = JSON.parse(e.target.value || '{}');
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Must be a JSON object');
            setBad(null);
            onChange(parsed as Record<string, unknown>);
          } catch (err) {
            setBad(err instanceof Error ? err.message : 'Invalid JSON');
          }
        }}
      />
    </Field>
  );
}
