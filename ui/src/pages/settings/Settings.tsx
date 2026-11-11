import { NavLink, useParams } from 'react-router-dom';
import { Empty, PageHead } from '../../components/ui.js';
import { useOrg } from '../../lib/org.js';
import { OrgSettings } from './OrgSettings.js';
import { Playbooks, DataSettings } from './Playbooks.js';
import { Providers, RemoteAccess, Secrets } from './Providers.js';
import { Gateways, Webhooks } from './Reach.js';

const SECTIONS = [
  { id: 'organization', label: 'Organization' }, { id: 'providers', label: 'Providers' }, { id: 'secrets', label: 'Secrets' }, { id: 'remote', label: 'Remote access' },
  { id: 'gateways', label: 'Messaging' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'playbooks', label: 'Playbooks' }, { id: 'data', label: 'Import and export' },
] as const;

export function Settings() {
  const { base, org } = useOrg();
  const { section = 'organization' } = useParams();
  return (
    <div className="page">
      <PageHead title="Settings" sub={`${org.name}, and the daemon it runs on.`} />
      <nav className="tabs" aria-label="Settings sections">
        {SECTIONS.map((s) => <NavLink key={s.id} to={s.id === 'organization' ? `${base}/settings` : `${base}/settings/${s.id}`} end>{s.label}</NavLink>)}
      </nav>
      {section === 'organization' ? <OrgSettings key={org.id} /> : null}
      {section === 'providers' ? <Providers /> : null}
      {section === 'secrets' ? <Secrets /> : null}
      {section === 'remote' ? <RemoteAccess /> : null}
      {section === 'gateways' ? <Gateways /> : null}
      {section === 'webhooks' ? <Webhooks /> : null}
      {section === 'playbooks' ? <Playbooks /> : null}
      {section === 'data' ? <DataSettings /> : null}
      {!SECTIONS.some((s) => s.id === section) ? <Empty title="No such settings section" /> : null}
    </div>
  );
}
