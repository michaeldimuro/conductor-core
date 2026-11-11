import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Chip, Empty, Field, Load, Panel, Status, TagInput } from '../../components/ui.js';
import { TakeoverButton, isOpenTakeover } from '../../components/takeover.js';
import { api } from '../../lib/api.js';
import type { Agent, BrowserEngineConfig, BrowserProfileDto } from '../../lib/api.js';
import { ago, dateTime } from '../../lib/format.js';
import { k, useOrg } from '../../lib/org.js';
import { useAction, useQuery } from '../../lib/query.js';

const CHANNELS = ['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary', 'msedge'] as const;
type Channel = (typeof CHANNELS)[number];
const CHANNEL_LABEL: Record<Channel, string> = { chrome: 'Google Chrome', 'chrome-beta': 'Chrome Beta', 'chrome-dev': 'Chrome Dev', 'chrome-canary': 'Chrome Canary', msedge: 'Microsoft Edge' };
type EngineChoice = 'chromium' | Channel | 'cdp';
type WindowChoice = 'default' | 'headed' | 'headless';

const engineChoice = (e: BrowserEngineConfig): EngineChoice => (e.kind === 'channel' ? e.channel : e.kind);
const windowChoice = (headed: boolean | null): WindowChoice => (headed === null ? 'default' : headed ? 'headed' : 'headless');
const toEngine = (choice: EngineChoice, endpoint: string): BrowserEngineConfig => (choice === 'chromium' ? { kind: 'chromium' } : choice === 'cdp' ? { kind: 'cdp', endpoint: endpoint.trim() } : { kind: 'channel', channel: choice });

function ProfileEditor({ profile, own }: { profile: BrowserProfileDto; own: boolean }) {
  const { org, base } = useOrg();
  const [name, setName] = useState(profile.name);
  const [allow, setAllow] = useState(profile.domainAllowlist);
  const [sensitive, setSensitive] = useState(profile.sensitiveDomains);
  const [engine, setEngine] = useState<EngineChoice>(engineChoice(profile.engine));
  const [endpoint, setEndpoint] = useState(profile.engine.kind === 'cdp' ? profile.engine.endpoint : 'http://127.0.0.1:9222');
  const [win, setWin] = useState<WindowChoice>(windowChoice(profile.headed));
  const [vaults, setVaults] = useState(profile.onePasswordVaults);
  useEffect(() => {
    setName(profile.name);
    setAllow(profile.domainAllowlist);
    setSensitive(profile.sensitiveDomains);
    setEngine(engineChoice(profile.engine));
    if (profile.engine.kind === 'cdp') setEndpoint(profile.engine.endpoint);
    setWin(windowChoice(profile.headed));
    setVaults(profile.onePasswordVaults);
  }, [profile]);
  const nextEngine = toEngine(engine, endpoint);
  const save = useAction(() => api.updateBrowserProfile(org.id, profile.id, {
    name: name.trim(), domainAllowlist: allow, sensitiveDomains: sensitive,
    engine: nextEngine, headed: win === 'default' ? null : win === 'headed', onePasswordVaults: vaults,
  }), { invalidate: [k(org.id, 'browser')], success: 'Browser profile saved. It applies from the next run.' });
  const dirty = name !== profile.name || allow.join() !== profile.domainAllowlist.join() || sensitive.join() !== profile.sensitiveDomains.join()
    || JSON.stringify(nextEngine) !== JSON.stringify(profile.engine) || win !== windowChoice(profile.headed) || vaults.join() !== profile.onePasswordVaults.join();
  return (
    <Panel title={<>{profile.name} {own ? null : <Chip>Shared by the department</Chip>} {profile.leasedRunId ? <Chip tone="go">In use</Chip> : null}</>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        {profile.leasedRunId ? <p className="muted">Leased by <Link to={`${base}/runs/${profile.leasedRunId}`}>a live run</Link> since {dateTime(profile.leasedAt)}.</p> : null}
        <Field label="Profile name"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Allowed domains" hint="The agent may only navigate to these domains and their subdomains. Empty means any domain.">
          <TagInput label="Allowed domains" value={allow} onChange={setAllow} placeholder="example.com" />
        </Field>
        <Field label="Sensitive domains" hint="On these domains (banks, payment pages, admin consoles) the agent must hand control to you instead of typing or clicking.">
          <TagInput label="Sensitive domains" value={sensitive} onChange={setSensitive} placeholder="bank.example.com" />
        </Field>
        <Field label="Browser" hint="The bundled Chromium is isolated from your own browser. An installed browser uses the same profile folder with that browser's build. A running Chrome is your own window, driven over its debugging port.">
          <select value={engine} onChange={(e) => setEngine(e.target.value as EngineChoice)}>
            <option value="chromium">Bundled Chromium (recommended)</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]} installed on this Mac</option>)}
            <option value="cdp">A Chrome that is already running (CDP)</option>
          </select>
        </Field>
        {engine === 'cdp' ? (
          <Field label="Debugging endpoint" hint="Start Chrome with --remote-debugging-port=9222. Only a loopback address is accepted, and the agent then acts inside your real browser session.">
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://127.0.0.1:9222" inputMode="url" required />
          </Field>
        ) : (
          <Field label="Window" hint="Headed shows the browser window on this Mac while the agent works. Headless runs it out of sight; you can still take over from any device.">
            <select value={win} onChange={(e) => setWin(e.target.value as WindowChoice)}>
              <option value="default">Follow the daemon default</option>
              <option value="headed">Headed (visible window)</option>
              <option value="headless">Headless</option>
            </select>
          </Field>
        )}
        <Field label="1Password vaults" hint="The agent may fill fields from op:// references in these vaults using the 1Password CLI on this Mac. The value goes straight into the page and is never shown to the agent. Empty means no direct 1Password access.">
          <TagInput label="1Password vaults" value={vaults} onChange={setVaults} placeholder="Work" />
        </Field>
        <div className="form-actions"><Button type="submit" variant="primary" busy={save.busy} disabled={!dirty}>Save profile</Button></div>
      </form>
    </Panel>
  );
}

export function BrowserTab({ agent }: { agent: Agent }) {
  const { org } = useOrg();
  const profiles = useQuery(k(org.id, 'browser', 'profiles'), () => api.listBrowserProfiles(org.id), { events: ['run.finished', 'browser.'], orgId: org.id });
  const sessions = useQuery(k(org.id, 'browser', 'sessions'), () => api.listBrowserSessions(org.id), { events: ['browser.'], orgId: org.id });
  const create = useAction(() => api.createBrowserProfile(org.id, { name: `${agent.name} browser`, agentId: agent.id }), { invalidate: [k(org.id, 'browser')], success: 'Browser profile created' });
  const mine = (profiles.data ?? []).filter((p) => p.agentId === agent.id || p.id === agent.browserProfileId || (!p.agentId && p.deptId === agent.deptId));
  const takeovers = (sessions.data ?? []).filter((s) => s.agentId === agent.id);
  return (
    <div className="stack-lg">
      <Load q={profiles} lines={3}>
        {() => (mine.length === 0 ? (
          <Panel>
            <Empty title={`${agent.name} has no browser profile yet`}>
              <p>A profile keeps this agent's cookies and logins apart from every other agent. One is created automatically the first time it browses; create it now to set domain rules first.</p>
              <Button variant="primary" busy={create.busy} onClick={() => void create.run()}>Create browser profile</Button>
            </Empty>
          </Panel>
        ) : <>{mine.map((p) => <ProfileEditor key={p.id} profile={p} own={p.agentId === agent.id} />)}</>)}
      </Load>
      <Panel title="Human takeovers" flush>
        <Load q={sessions} lines={2}>
          {() => (takeovers.length === 0 ? <Empty title="This agent has never asked for a human"><p>When it hits a login, CAPTCHA or consent screen it pauses and sends you a one-time link to its browser.</p></Empty> : (
            <table className="table">
              <thead><tr><th>Status</th><th>Reason</th><th>Asked</th><th>Handed back</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {takeovers.map((s) => (
                  <tr key={s.id}>
                    <td data-label="Status"><Status value={s.status} /></td>
                    <td data-label="Reason">{s.reason || <span className="muted">Not given</span>}</td>
                    <td data-label="Asked" title={dateTime(s.createdAt)}>{ago(s.createdAt)}</td>
                    <td data-label="Handed back">{s.handedBackAt ? dateTime(s.handedBackAt) : s.status === 'pending' ? 'Waiting for you' : s.status === 'active' ? 'You have control' : 'No'}</td>
                    <td data-label="Actions">{isOpenTakeover(s) ? <TakeoverButton orgId={org.id} session={s} small /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </Load>
      </Panel>
    </div>
  );
}
