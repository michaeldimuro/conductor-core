import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Organization } from '../lib/api.js';
import { useAgents } from '../lib/org.js';
import { setTheme, useTheme } from '../lib/theme.js';
import { Icon, type IconName } from './icons.js';
import { NAV_GROUPS } from './nav.js';

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: IconName;
  keywords?: string;
  run: () => void;
}

/** Subsequence match with a bonus for word starts and contiguous runs; 0 means no match. */
export function score(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q);
  let ti = 0;
  let total = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    run = at === ti ? run + 1 : 0;
    total += 1 + run + (at === 0 || t[at - 1] === ' ' ? 3 : 0);
    ti = at + 1;
  }
  return total;
}

export function CommandPalette({ open, onClose, orgs, org, onShortcuts }: {
  open: boolean; onClose: () => void; orgs: Organization[]; org: Organization | null; onShortcuts: () => void;
}) {
  const nav = useNavigate();
  const theme = useTheme();
  const agents = useAgents(open ? org?.id : null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const base = org ? `/o/${org.slug}` : null;

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      setActive(0);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => nav(to);
    const out: Command[] = [];
    if (base && org) {
      out.push(
        { id: 'new-issue', group: 'Create', label: 'New issue', icon: 'add', keywords: 'task ticket create', run: go(`${base}/issues?new=1`) },
        { id: 'hire', group: 'Create', label: 'Hire an agent', icon: 'hire', keywords: 'agent add staff', run: go(`${base}/chart?hire=1`) },
        { id: 'goal', group: 'Create', label: 'Set a goal', icon: 'goals', keywords: 'objective okr', run: go(`${base}/goals`) },
        { id: 'setup', group: 'Create', label: `Guided setup for ${org.name}`, icon: 'launch', keywords: 'onboarding interview wizard configure', run: go(`${base}/setup`) },
      );
      for (const g of NAV_GROUPS) for (const n of g.items) out.push({ id: `nav-${n.to}`, group: 'Go to', label: n.label, hint: g.label, icon: n.icon, keywords: n.keywords, run: go(base + n.to) });
      for (const s of ['providers', 'secrets', 'remote', 'gateways', 'webhooks', 'playbooks', 'data']) {
        out.push({ id: `settings-${s}`, group: 'Settings', label: `Settings: ${s === 'data' ? 'Import and export' : s === 'gateways' ? 'Messaging' : s === 'remote' ? 'Remote access' : s[0]!.toUpperCase() + s.slice(1)}`, icon: 'settings', run: go(`${base}/settings/${s}`) });
      }
      for (const a of agents.data ?? []) {
        if (a.status === 'terminated') continue;
        out.push({ id: `agent-${a.id}`, group: 'Agents', label: a.name, hint: a.role, icon: 'agent', keywords: `${a.role} ${a.slug}`, run: go(`${base}/agents/${a.slug}`) });
      }
    }
    out.push({ id: 'approvals', group: 'Go to', label: 'Approvals inbox', icon: 'approvals', keywords: 'decide review pending', run: go('/approvals') });
    for (const o of orgs) if (o.id !== org?.id) out.push({ id: `org-${o.id}`, group: 'Organizations', label: `Switch to ${o.name}`, icon: 'org', run: go(`/o/${o.slug}`) });
    out.push(
      { id: 'new-org', group: 'Organizations', label: 'New organization', icon: 'newOrg', keywords: 'create company', run: go('/new-org') },
      { id: 'theme', group: 'Preferences', label: theme === 'dark' ? 'Switch to light theme' : theme === 'light' ? 'Follow the system theme' : 'Switch to dark theme', icon: theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark', keywords: 'theme dark light appearance', run: () => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark') },
      { id: 'shortcuts', group: 'Preferences', label: 'Keyboard shortcuts', icon: 'shortcuts', keywords: 'keys help', run: onShortcuts },
    );
    return out;
  }, [base, org, orgs, agents.data, theme, nav, onShortcuts]);

  const results = useMemo(() => {
    if (!query.trim()) return commands.filter((c) => c.group !== 'Settings' && c.group !== 'Agents').concat(commands.filter((c) => c.group === 'Agents').slice(0, 5));
    const ranked = commands
      .map((c) => ({ c, s: Math.max(score(query, c.label), score(query, `${c.label} ${c.hint ?? ''} ${c.keywords ?? ''}`) * 0.8) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((x) => x.c);
    // Keep each group together, groups ordered by their best match.
    if (base) ranked.push({ id: 'search-issues', group: 'Search', label: `Search issues for “${query.trim()}”`, icon: 'search', run: () => nav(`${base}/issues?q=${encodeURIComponent(query.trim())}`) });
    const groups = new Map<string, Command[]>();
    for (const c of ranked) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
    return [...groups.values()].flat();
  }, [commands, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      choose(results[active]);
    }
  };

  // Results keep their order; a group heading appears where the group changes.
  let lastGroup = '';
  return (
    <dialog ref={dialog} className="palette" aria-label="Command palette" onClose={onClose} onMouseDown={(e) => { if (e.target === dialog.current) onClose(); }}>
      {open ? (
        <div className="palette-inner">
          <div className="palette-search">
            <Icon name="search" size={17} />
            <input
              autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
              placeholder={org ? `Search ${org.name}: pages, agents, actions…` : 'Search pages and actions…'}
              role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
              aria-autocomplete="list" autoCapitalize="none" spellCheck={false}
            />
            <kbd>esc</kbd>
          </div>
          <ul className="palette-list" role="listbox" id={listId} ref={list}>
            {results.length === 0 ? <li className="palette-empty">No matches for &ldquo;{query}&rdquo;</li> : null}
            {results.map((c, i) => {
              const heading = c.group !== lastGroup ? c.group : null;
              lastGroup = c.group;
              return (
                <li key={c.id} role="presentation">
                  {heading ? <span className="palette-group" role="presentation">{heading}</span> : null}
                  <div
                    id={`${listId}-${i}`} role="option" aria-selected={i === active} data-index={i}
                    className={`palette-item${i === active ? ' on' : ''}`}
                    onMouseMove={() => setActive(i)} onClick={() => choose(c)}
                  >
                    <Icon name={c.icon} size={16} />
                    <span className="grow truncate">{c.label}</span>
                    {c.hint ? <span className="muted truncate palette-hint">{c.hint}</span> : null}
                    {i === active ? <Icon name="right" size={14} /> : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="palette-foot muted"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>⌘</kbd><kbd>K</kbd> toggle</span></div>
        </div>
      ) : null}
    </dialog>
  );
}
