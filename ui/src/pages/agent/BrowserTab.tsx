import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Chip, Empty, Field, Load, Panel, Status, TagInput } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { Agent, BrowserProfile } from '../../lib/api.js';
import { ago, dateTime } from '../../lib/format.js';
import { k, useOrg } from '../../lib/org.js';
import { useAction, useQuery } from '../../lib/query.js';

function ProfileEditor({ profile, own }: { profile: BrowserProfile; own: boolean }) {
  const { org, base } = useOrg();
  const [name, setName] = useState(profile.name);
  const [allow, setAllow] = useState(profile.domainAllowlist);
  const [sensitive, setSensitive] = useState(profile.sensitiveDomains);
  useEffect(() => {
    setName(profile.name);
    setAllow(profile.domainAllowlist);
    setSensitive(profile.sensitiveDomains);
  }, [profile]);
  const save = useAction(() => api.updateBrowserProfile(org.id, profile.id, { name: name.trim(), domainAllowlist: allow, sensitiveDomains: sensitive }), { invalidate: [k(org.id, 'browser')], success: 'Browser profile saved' });
  const dirty = name !== profile.name || allow.join() !== profile.domainAllowlist.join() || sensitive.join() !== profile.sensitiveDomains.join();
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
              <thead><tr><th>Status</th><th>Reason</th><th>Asked</th><th>Handed back</th></tr></thead>
              <tbody>
                {takeovers.map((s) => (
                  <tr key={s.id}>
                    <td data-label="Status"><Status value={s.status} /></td>
                    <td data-label="Reason">{s.reason || <span className="muted">Not given</span>}</td>
                    <td data-label="Asked" title={dateTime(s.createdAt)}>{ago(s.createdAt)}</td>
                    <td data-label="Handed back">{s.handedBackAt ? dateTime(s.handedBackAt) : s.status === 'pending' ? 'Waiting for you. Open the link in your notification.' : 'No'}</td>
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
