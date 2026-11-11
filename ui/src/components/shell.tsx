import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { Organization, StatusResponse } from '../lib/api.js';
import { live, useLiveState } from '../lib/live.js';
import { useAgents } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';
import { setTheme, useTheme, type Theme } from '../lib/theme.js';
import { Button, ConfirmButton, Lamp, Modal, Toasts, toneOf } from './ui.js';

const ORG_NAV: ReadonlyArray<{ to: string; label: string; key: string; end?: boolean }> = [
  { to: '', label: 'Overview', key: 'o', end: true },
  { to: '/issues', label: 'Issues', key: 'i' },
  { to: '/goals', label: 'Goals', key: 'g' },
  { to: '/chart', label: 'Org chart', key: 'c' },
  { to: '/costs', label: 'Costs', key: 'b' },
  { to: '/skills', label: 'Skills', key: 's' },
  { to: '/connectors', label: 'Connectors', key: 'n' },
  { to: '/activity', label: 'Activity', key: 'l' },
  { to: '/settings', label: 'Settings', key: 't' },
];

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
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
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
          <Link className="switcher-new" to="/new-org">New organization</Link>
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
      <button type="button" className={`strip-btn${globalStopped || orgStopped ? ' strip-btn-stop' : ''}`} onClick={() => setOpen(true)}>
        <Lamp tone={globalStopped || orgStopped ? 'stop' : 'idle'} />
        <span>{label}</span>
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
              <Button busy={act.busy} onClick={() => void act.run(() => api.releaseKillSwitch())}>Release</Button>
            ) : (
              <ConfirmButton label="Stop everything" danger title="Stop every organization" confirmLabel="Stop all runs" phrase="stop"
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
                <Button busy={act.busy} onClick={() => void act.run(() => api.releaseOrgKillSwitch(org.id))}>Release</Button>
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

const THEME_NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<Theme, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };

function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts">
      <dl className="kv shortcuts">
        {ORG_NAV.map((n) => <div key={n.key}><dt><kbd>g</kbd> then <kbd>{n.key}</kbd></dt><dd>{n.label}</dd></div>)}
        <div><dt><kbd>g</kbd> then <kbd>a</kbd></dt><dd>Approvals</dd></div>
        <div><dt><kbd>/</kbd></dt><dd>Focus search on the current page</dd></div>
        <div><dt><kbd>c</kbd></dt><dd>Create an issue (on the board)</dd></div>
        <div><dt><kbd>?</kbd></dt><dd>Show this list</dd></div>
      </dl>
    </Modal>
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
  const agents = useAgents(org?.id);
  const base = org ? `/o/${org.slug}` : null;
  const pending = status.data?.counts.pendingApprovals ?? 0;
  const killed = new Set(status.data?.killSwitch.orgs ?? []);

  useEffect(() => {
    live.start();
  }, []);
  useEffect(() => setDrawer(false), [loc.pathname]);
  useEffect(() => {
    let armed = 0;
    const onKey = (e: KeyboardEvent) => {
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
      const hit = ORG_NAV.find((n) => n.key === e.key);
      if (hit && base) nav(base + hit.to);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav, base]);

  const signOut = useAction(async () => {
    await api.deleteSession();
    live.stop();
    window.location.assign('/');
  });
  const staff = (agents.data ?? []).filter((a) => a.status !== 'terminated');

  return (
    <div className={`shell${drawer ? ' shell-drawer' : ''}`}>
      <a className="skip" href="#content">Skip to content</a>
      <aside className="rail" aria-label="Primary">
        <OrgSwitcher orgs={orgs} current={org} killed={killed} />
        <nav className="rail-nav">
          {base ? (
            <ul>
              {ORG_NAV.map((n) => <li key={n.to}><NavLink to={base + n.to} end={n.end}>{n.label}</NavLink></li>)}
            </ul>
          ) : null}
          <ul className="rail-global">
            <li>
              <NavLink to="/approvals">
                <span className="grow">Approvals</span>
                {pending > 0 ? <span className="badge" aria-label={`${pending} pending`}>{pending}</span> : null}
              </NavLink>
            </li>
          </ul>
          {base && staff.length > 0 ? (
            <>
              <h2 className="rail-title">Agents</h2>
              <ul className="rail-agents">
                {staff.map((a) => (
                  <li key={a.id}>
                    <NavLink to={`${base}/agents/${a.slug}`}>
                      <Lamp tone={toneOf(a.status)} />
                      <span className="grow truncate">{a.name}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </nav>
        <div className="rail-foot">
          <button type="button" className="rail-foot-btn" onClick={() => setTheme(THEME_NEXT[theme])}>{THEME_LABEL[theme]}</button>
          <button type="button" className="rail-foot-btn" onClick={() => setHelp(true)}>Shortcuts</button>
          <button type="button" className="rail-foot-btn" onClick={() => void signOut.run()} disabled={signOut.busy}>Sign out</button>
        </div>
      </aside>
      <button type="button" className="scrim" aria-label="Close menu" tabIndex={drawer ? 0 : -1} onClick={() => setDrawer(false)} />

      <div className="main">
        <header className="strip">
          <button type="button" className="icon-btn strip-menu" aria-label="Open menu" aria-expanded={drawer} onClick={() => setDrawer(true)}>
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path d="M2.5 4.5h13M2.5 9h13M2.5 13.5h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <span className="strip-org truncate">{org?.name ?? 'Conductor'}</span>
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
        <main id="content" tabIndex={-1}>{children}</main>
      </div>

      <nav className="tabbar" aria-label="Quick navigation">
        {base ? (
          <>
            <NavLink to={base} end>Overview</NavLink>
            <NavLink to={`${base}/issues`}>Issues</NavLink>
          </>
        ) : null}
        <NavLink to="/approvals">Approvals{pending > 0 ? <span className="badge">{pending}</span> : null}</NavLink>
        {base ? <NavLink to={`${base}/chart`}>Agents</NavLink> : null}
        <button type="button" onClick={() => setDrawer(true)}>More</button>
      </nav>
      <Shortcuts open={help} onClose={() => setHelp(false)} />
      <Toasts />
    </div>
  );
}
