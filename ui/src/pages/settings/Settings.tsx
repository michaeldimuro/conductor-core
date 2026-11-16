import { Link, NavLink, useParams } from 'react-router-dom';
import { Empty, PageHead } from '../../components/ui.js';
import { Icon, type IconName } from '../../components/icons.js';
import { useOrg } from '../../lib/org.js';
import { OrgSettings } from './OrgSettings.js';
import { Playbooks, DataSettings } from './Playbooks.js';
import { Providers, RemoteAccess, Secrets } from './Providers.js';
import { Gateways, Webhooks } from './Reach.js';

const SECTIONS: ReadonlyArray<{ id: string; label: string; icon: IconName }> = [
  { id: 'organization', label: 'Organization', icon: 'org' }, { id: 'providers', label: 'Providers', icon: 'model' }, { id: 'secrets', label: 'Secrets', icon: 'lock' },
  { id: 'remote', label: 'Remote access', icon: 'phone' }, { id: 'gateways', label: 'Messaging', icon: 'mail' }, { id: 'webhooks', label: 'Webhooks', icon: 'webhook' },
  { id: 'playbooks', label: 'Playbooks', icon: 'playbook' }, { id: 'data', label: 'Import and export', icon: 'upload' },
];

const BLURB: Record<string, string> = {
  organization: 'Mission, budget, approvals, defaults', providers: 'Model sign-ins and adapters', secrets: 'API keys and tokens in the Keychain',
  remote: 'Reach this console from your phone', gateways: 'Telegram, Slack and other channels', webhooks: 'Events in and out',
  playbooks: 'Reusable multi-step processes', data: 'Export or import this organization',
};

export function Settings() {
  const { base, org } = useOrg();
  const { section: picked } = useParams();
  const section = picked ?? 'organization';
  // Phones get a list of sections first, then one section per screen.
  const phone = typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches;
  if (phone && !picked) {
    return (
      <div className="page page-narrow">
        <PageHead icon="settings" eyebrow="Configuration" title="Settings" sub={`${org.name}, and the daemon it runs on.`} />
        <ul className="settings-index">
          <li><Link to={`${base}/setup`}><span className="settings-index-icon"><Icon name="launch" size={17} /></span><span className="grow"><strong>Guided setup</strong><span className="muted">Re-run the interview, models, team and guardrails</span></span><Icon name="right" size={16} /></Link></li>
          {SECTIONS.map((s) => (
            <li key={s.id}><Link to={`${base}/settings/${s.id}`}><span className="settings-index-icon"><Icon name={s.icon} size={17} /></span><span className="grow"><strong>{s.label}</strong><span className="muted">{BLURB[s.id]}</span></span><Icon name="right" size={16} /></Link></li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="page">
      {phone ? <Link className="back-link" to={`${base}/settings`}><Icon name="left" size={16} />Settings</Link> : null}
      {phone ? <h1 className="section-screen-title">{SECTIONS.find((s) => s.id === section)?.label ?? 'Settings'}</h1> : <PageHead icon="settings" eyebrow="Configuration" title="Settings" sub={`${org.name}, and the daemon it runs on.`} />}
      <nav className="tabs settings-tabs" aria-label="Settings sections">
        {SECTIONS.map((s) => <NavLink key={s.id} to={s.id === 'organization' ? `${base}/settings` : `${base}/settings/${s.id}`} end><Icon name={s.icon} size={14} />{s.label}</NavLink>)}
      </nav>
      {section === 'organization' ? <OrgSettings key={org.id} /> : null}
      {section === 'providers' ? <Providers /> : null}
      {section === 'secrets' ? <Secrets /> : null}
      {section === 'remote' ? <RemoteAccess /> : null}
      {section === 'gateways' ? <Gateways /> : null}
      {section === 'webhooks' ? <Webhooks /> : null}
      {section === 'playbooks' ? <Playbooks /> : null}
      {section === 'data' ? <DataSettings /> : null}
      {!SECTIONS.some((s) => s.id === section) ? <Empty icon="search" title="No such settings section" /> : null}
    </div>
  );
}
