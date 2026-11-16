import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { Organization, StatusResponse } from '../lib/api.js';
import { live, useLiveState } from '../lib/live.js';
import { AgentTree } from './agent-tree.js';
import { useAction, useQuery } from '../lib/query.js';
import { setTheme, useTheme, type Theme } from '../lib/theme.js';
import { Button, ConfirmButton, Lamp, Logo, Modal, Toasts } from './ui.js';
import { Icon } from './icons.js';
import { CommandPalette } from './command.js';
import { NAV_GROUPS, NAV_ITEMS } from './nav.js';
import { SETUP_STEPS, useOnboarding } from '../lib/setup.js';
import { k } from '../lib/org.js';
import { useNeeds } from '../lib/work.js';
import { monthStart } from '../lib/format.js';


export function useStatus() {
  return useQuery<StatusResponse>('status', () => api.status(), { events: ['run.', 'org.', 'approval.', 'agent.hired'], pollMs: 20_000 });
}

function OrgSwitcher({ orgs, current, killed }: { orgs: Organization[]; current: Organization | null; killed: Set<string> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="switcher" ref={ref}>
      <button type="button" className="switcher-btn" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="switcher-mark" aria-hidden="true">{(current?.name ?? 'C').slice(0, 1).toUpperCase()}</span>
        <span className="grow truncate">
          <span className="switcher-name truncate">{current?.name ?? 'Choose an organization'}</span>
          <span className="switcher-sub">{orgs.length === 1 ? '1 organization' : `${orgs.length} organizations`}</span>
        </span>
        <Icon name="down" size={14} />
      </button>
      {open ? (
        <div className="switcher-menu">
          <ul>
            {orgs.map((o) => (
              <li key={o.id}>
                <Link to={`/o/${o.slug}`} aria-current={o.id === current?.id ? 'true' : undefined}>
                  <Lamp tone={killed.has(o.id) ? 'stop' : 'go'} />
                  <span className="grow truncate">{o.name}</span>
                  {killed.has(o.id) ? <span className="muted">stopped</span> : null}
                </Link>
              </li>
            ))}
          </ul>
          <Link className="switcher-new" to="/new-org"><Icon name="add" size={14} />New organization</Link>
        </div>
      ) : null}
    </div>
  );
}

function KillSwitch({ status, org }: { status: StatusResponse; org: Organization | null }) {
  const [open, setOpen] = useState(false);
  const orgStopped = org ? status.killSwitch.orgs.includes(org.id) : false;
  const globalStopped = status.killSwitch.global;
  const act = useAction(async (fn: () => Promise<unknown>) => fn(), { invalidate: ['status', 'orgs'] });
  const label = globalStopped ? 'All runs stopped' : orgStopped ? `${org?.name} stopped` : 'Kill switch';
  return (
    <>
      <button type="button" className={`strip-btn${globalStopped || orgStopped ? ' strip-btn-stop' : ''}`} aria-label={label} onClick={() => setOpen(true)}>
        <Icon name="power" size={14} />
        <span>{label}</span>
        {/* Narrow screens hide the full label; a bare lamp does not say what the button is. */}
        {globalStopped || orgStopped ? null : <span className="strip-btn-short">Stop</span>}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Kill switch">
        <div className="stack">
          <p className="dim">Engaging the kill switch cancels in-flight runs and stops new ones from starting until you release it.</p>
          <div className="kill-row">
            <div>
              <h3>Every organization</h3>
              <p className="muted">{globalStopped ? 'Engaged. No agent can run anywhere.' : 'Not engaged.'}</p>
            </div>
            {globalStopped ? (
              <Button icon="power" busy={act.busy} onClick={() => void act.run(() => api.releaseKillSwitch())}>Release</Button>
            ) : (
              <ConfirmButton icon="power" label="Stop everything" danger title="Stop every organization" confirmLabel="Stop all runs" phrase="stop"
                message="This cancels every running agent in every organization. Work in progress is released back to the queue."
                onConfirm={() => act.run(() => api.engageKillSwitch())} />
            )}
          </div>
          {org ? (
            <div className="kill-row">
              <div>
                <h3>{org.name} only</h3>
                <p className="muted">{orgStopped ? 'Engaged. Agents in this organization cannot run.' : 'Not engaged.'}</p>
              </div>
              {orgStopped ? (
                <Button icon="power" busy={act.busy} onClick={() => void act.run(() => api.releaseOrgKillSwitch(org.id))}>Release</Button>
              ) : (
                <ConfirmButton label={`Stop ${org.name}`} danger title={`Stop ${org.name}`} confirmLabel="Stop this organization"
                  message={`This cancels every running agent in ${org.name}. Other organizations keep working.`}
                  onConfirm={() => act.run(() => api.engageOrgKillSwitch(org.id))} />
              )}
            </div>
          ) : null}
        </div>
      </Modal>
    </>
  );
}

const THEME_NEXT: Record<Theme, Theme> = { dark: 'light', light: 'system', system: 'dark' };
const THEME_LABEL: Record<Theme, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };

function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts">
      <dl className="kv shortcuts">
        {NAV_ITEMS.map((n) => <div key={n.key}><dt><kbd>g</kbd> then <kbd>{n.key}</kbd></dt><dd>{n.label}</dd></div>)}
        <div><dt><kbd>g</kbd> then <kbd>a</kbd></dt><dd>Approvals</dd></div>
        <div><dt><kbd>⌘</kbd> <kbd>K</kbd></dt><dd>Search and jump anywhere</dd></div>
        <div><dt><kbd>/</kbd></dt><dd>Focus search on the current page</dd></div>
        <div><dt><kbd>c</kbd></dt><dd>Create an issue (on the board)</dd></div>
        <div><dt><kbd>?</kbd></dt><dd>Show this list</dd></div>
      </dl>
    </Modal>
  );
}

/**
 * Conditions that silently stop all work: a kill switch left engaged, or a monthly budget used up.
 * Shown on every page of the organization until resolved, each with the fix one tap away.
 */
function OrgAlerts({ org, base, status }: { org: Organization; base: string; status: StatusResponse }) {
  const spend = useQuery(k(org.id, 'budget', 'month'), () => api.budgetSummary(org.id, { since: monthStart() }), { orgId: org.id, events: ['run.finished', 'budget.'] });
  const release = useAction((global: boolean) => (global ? api.releaseKillSwitch() : api.releaseOrgKillSwitch(org.id)), { invalidate: ['status', 'orgs'], success: 'Agents can run again' });
  const global = status.killSwitch.global;
  const stopped = global || status.killSwitch.orgs.includes(org.id);
  const cap = org.budgetMonthlyUsd;
  const over = cap != null && cap > 0 && (spend.data?.totalUsd ?? 0) >= cap;
  if (!stopped && !over) return null;
  return (
    <div className="org-alerts">
      {stopped ? (
        <p className="org-alert org-alert-stop" role="alert">
          <Icon name="power" size={15} />
          <span className="grow"><strong className="org-alert-long">{global ? 'Every organization is stopped.' : `${org.name} is stopped.`}</strong><strong className="org-alert-short">Kill switch on</strong><span className="org-alert-long"> The kill switch is engaged, so no agent can start a run.</span></span>
          <Button small busy={release.busy} onClick={() => void release.run(global)}>Release</Button>
        </p>
      ) : null}
      {over ? (
        <p className="org-alert org-alert-warn" role="alert">
          <Icon name="budget" size={15} />
          <span className="grow"><strong className="org-alert-long">Monthly budget reached.</strong><strong className="org-alert-short">Budget reached · agents stopped</strong><span className="org-alert-long"> Agents in {org.name} have stopped spending until next month or until you raise the cap.</span></span>
          <Link className="btn btn-sm" to={`${base}/settings`}>Raise cap</Link>
        </p>
      ) : null}
    </div>
  );
}

/** How many decisions wait on the owner in this organization (approvals, blocked, reviews, sign-ins). */
function NeedsBadge({ orgId }: { orgId: string }) {
  const { needs } = useNeeds(orgId);
  return needs.length ? <span className="badge" aria-label={`${needs.length} waiting`}>{needs.length}</span> : null;
}

/** Until guided setup is finished, the rail keeps a way back to it. Organizations that never started it see nothing. */
function SetupNudge({ org, base }: { org: Organization; base: string }) {
  const q = useOnboarding(org.id);
  const loc = useLocation();
  const state = q.data?.state;
  if (!state || state.status === 'complete' || loc.pathname.startsWith(`${base}/setup`)) return null;
  const done = state.done.length;
  const next = SETUP_STEPS.find((s) => !state.done.includes(s.id)) ?? SETUP_STEPS[0]!;
  return (
    <Link className="setup-nudge" to={`${base}/setup/${next.id}`}>
      <span className="row row-tight"><Icon name="launch" size={14} /><strong className="grow">Finish setting up</strong><span className="rail-count">{done}/{SETUP_STEPS.length}</span></span>
      <span className="setup-nudge-bar" aria-hidden="true"><span style={{ width: `${(done / SETUP_STEPS.length) * 100}%` }} /></span>
      <span className="muted">Next: {next.label}</span>
    </Link>
  );
}

const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export function Shell({ orgs, org, children }: { orgs: Organization[]; org: Organization | null; children: ReactNode }) {
  const status = useStatus();
  const liveState = useLiveState();
  const theme = useTheme();
  const nav = useNavigate();
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [help, setHelp] = useState(false);
  const [palette, setPalette] = useState(false);
  const base = org ? `/o/${org.slug}` : null;
  const pending = status.data?.counts.pendingApprovals ?? 0;
  const killed = new Set(status.data?.killSwitch.orgs ?? []);

  useEffect(() => {
    live.start();
  }, []);
  useEffect(() => {
    setDrawer(false);
    setPalette(false);
  }, [loc.pathname]);
  useEffect(() => {
    let armed = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('dialog[open]')) return;
      if (e.key === '?') return setHelp(true);
      if (e.key === '/') {
        const el = document.querySelector<HTMLElement>('[data-search]');
        if (el) {
          e.preventDefault();
          el.focus();
        }
        return;
      }
      if (e.key === 'g') return void (armed = Date.now());
      if (Date.now() - armed > 1200) return;
      armed = 0;
      if (e.key === 'a') return nav('/approvals');
      const hit = NAV_ITEMS.find((n) => n.key === e.key);
      if (hit && base) nav(base + hit.to);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav, base]);

  const openHelp = useCallback(() => setHelp(true), []);
  const signOut = useAction(async () => {
    await api.deleteSession();
    live.stop();
    window.location.assign('/');
  });

  return (
    <div className={`shell${drawer ? ' shell-drawer' : ''}`}>
      <a className="skip" href="#content">Skip to content</a>
      <aside className="rail" aria-label="Primary">
        <Link className="brand" to={base ?? '/'}><Logo />conductor<span className="brand-tag">local</span></Link>
        <OrgSwitcher orgs={orgs} current={org} killed={killed} />
        <nav className="rail-nav">
          {base && org ? <SetupNudge org={org} base={base} /> : null}
          {base ? NAV_GROUPS.map((g) => (
            <div key={g.label} className="rail-group">
              <h2 className="rail-title">{g.label}</h2>
              <ul className="rail-main">
                {g.items.map((n) => <li key={n.to}><NavLink to={base + n.to} end={n.end}><Icon name={n.icon} className="nav-icon" /><span className="grow">{n.label}</span>{n.to === '/inbox' && org ? <NeedsBadge orgId={org.id} /> : <kbd className="rail-key" aria-hidden="true">{n.key}</kbd>}</NavLink></li>)}
              </ul>
            </div>
          )) : null}
          <ul className="rail-global">
            <li>
              <NavLink to="/approvals">
                <Icon name="approvals" className="nav-icon" />
                <span className="grow">Approvals</span>
                {pending > 0 ? <span className="badge" aria-label={`${pending} pending`}>{pending}</span> : null}
              </NavLink>
            </li>
          </ul>
          {base && org ? <AgentTree orgId={org.id} base={base} /> : null}
        </nav>
        <div className="rail-foot">
          <button type="button" className="rail-foot-btn" onClick={() => setTheme(THEME_NEXT[theme])}><Icon name={theme} size={14} />{THEME_LABEL[theme]}</button>
          <button type="button" className="rail-foot-btn" onClick={() => setHelp(true)}><Icon name="shortcuts" size={14} />Shortcuts</button>
          <button type="button" className="rail-foot-btn" onClick={() => void signOut.run()} disabled={signOut.busy}><Icon name="signOut" size={14} />Sign out</button>
        </div>
      </aside>
      <button type="button" className="scrim" aria-label="Close menu" tabIndex={drawer ? 0 : -1} onClick={() => setDrawer(false)} />

      <div className="main">
        <header className="strip">
          <button type="button" className="icon-btn strip-menu" aria-label="Open menu" aria-expanded={drawer} onClick={() => setDrawer(true)}>
            <Icon name="menu" size={18} />
          </button>
          <span className="strip-org truncate">{org?.name ?? 'Conductor'}</span>
          <button type="button" className="strip-search" onClick={() => setPalette(true)} aria-label="Search and jump (Command K)">
            <Icon name="search" size={15} />
            <span className="strip-search-text">Search or jump to…</span>
            <span className="strip-search-keys" aria-hidden="true"><kbd>⌘</kbd><kbd>K</kbd></span>
          </button>
          <div className="strip-lamps" aria-live="polite">
            {status.data ? (
              <>
                <span className="status"><Lamp tone={status.data.runtime.running > 0 ? 'go' : 'idle'} live={status.data.runtime.running > 0} />{status.data.runtime.running} running</span>
                <span className="status strip-queued"><Lamp tone={status.data.runtime.queued > 0 ? 'info' : 'idle'} />{status.data.runtime.queued} queued</span>
              </>
            ) : null}
            {liveState === 'reconnecting' ? <span className="status status-warn"><Lamp tone="warn" />Reconnecting</span> : null}
          </div>
          {status.data ? <KillSwitch status={status.data} org={org} /> : null}
          <Link className="strip-btn strip-approvals" to="/approvals">
            <Icon name="approvals" size={14} />
            <span>Approvals</span>
            <span className={`badge${pending === 0 ? ' badge-zero' : ''}`}>{pending}</span>
          </Link>
        </header>
        {status.data?.bind && !status.data.bind.loopback ? (
          <p className="exposure-banner" role="alert">
            <strong>Conductor is exposed to your network.</strong> The daemon is listening on {status.data.bind.host}, so any device that can reach this Mac can reach the API.
            Bind it to 127.0.0.1 and use Tailscale or a Cloudflare Tunnel for remote access, then restart the daemon.
          </p>
        ) : null}
        {org && base && status.data ? <OrgAlerts org={org} base={base} status={status.data} /> : null}
        <main id="content" tabIndex={-1}>{children}</main>
      </div>

      <nav className="tabbar" aria-label="Quick navigation">
        {base && org ? (
          <>
            <NavLink to={base} end><Icon name="overview" size={20} />Today</NavLink>
            <NavLink to={`${base}/inbox`}><Icon name="notify" size={20} />Needs you<NeedsBadge orgId={org.id} /></NavLink>
            <NavLink to={`${base}/issues`}><Icon name="issues" size={20} />Issues</NavLink>
            <NavLink to={`${base}/team`}><Icon name="agents" size={20} />Team</NavLink>
          </>
        ) : <NavLink to="/approvals"><Icon name="approvals" size={20} />Approvals{pending > 0 ? <span className="badge">{pending}</span> : null}</NavLink>}
        <button type="button" onClick={() => setDrawer(true)}><Icon name="menu" size={20} />More</button>
      </nav>
      <Shortcuts open={help} onClose={() => setHelp(false)} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} orgs={orgs} org={org} onShortcuts={openHelp} />
      <Toasts />
    </div>
  );
}
