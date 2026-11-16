import { useEffect, useMemo } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useMatch, useParams } from 'react-router-dom';
import { Shell } from './components/shell.js';
import { Empty, ErrorNote, Loading } from './components/ui.js';
import { api, isUnauthorized } from './lib/api.js';
import type { Organization } from './lib/api.js';
import { OrgContext, useOrgs } from './lib/org.js';
import { ApprovalRefs } from './components/approvals.js';
import { useQuery } from './lib/query.js';
import { lastOrg, rememberOrg } from './lib/theme.js';
import { Activity } from './pages/Activity.js';
import { AgentPage } from './pages/agent/AgentPage.js';
import { Approvals } from './pages/Approvals.js';
import { Artifacts } from './pages/Artifacts.js';
import { Board } from './pages/Board.js';
import { Inbox } from './pages/Inbox.js';
import { Team } from './pages/Team.js';
import { Connectors } from './pages/Connectors.js';
import { Costs } from './pages/Costs.js';
import { Goals } from './pages/Goals.js';
import { IssueDetail } from './pages/IssueDetail.js';
import { NewOrg } from './pages/NewOrg.js';
import { OrgChart } from './pages/OrgChart.js';
import { Overview } from './pages/Overview.js';
import { RunView } from './pages/RunView.js';
import { Settings } from './pages/settings/Settings.js';
import { Setup } from './pages/setup/Setup.js';
import { SignIn } from './pages/SignIn.js';
import { Skills } from './pages/Skills.js';
import { Takeover } from './pages/Takeover.js';

function NotFound({ what }: { what: string }) {
  return (
    <div className="page page-narrow">
      <Empty icon="search" title={`${what} not found`}>
        <p>The link may be out of date, or it belongs to another organization.</p>
        <Link to="/">Go to the start page</Link>
      </Empty>
    </div>
  );
}

function Home({ orgs }: { orgs: Organization[] }) {
  if (orgs.length === 0) return <Navigate to="/new-org" replace />;
  const remembered = lastOrg();
  const target = orgs.find((o) => o.slug === remembered) ?? orgs[0]!;
  return <Navigate to={`/o/${target.slug}`} replace />;
}

function OrgRoutes({ orgs }: { orgs: Organization[] }) {
  const { org: slug } = useParams();
  const org = orgs.find((o) => o.slug === slug || o.id === slug);
  useEffect(() => {
    if (org) rememberOrg(org.slug);
  }, [org]);
  const value = useMemo(() => (org ? { org, orgs, base: `/o/${org.slug}` } : null), [org, orgs]);
  if (!value) return <NotFound what="Organization" />;
  return (
    <OrgContext.Provider value={value}>
      <ApprovalRefs org={value.org}>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="setup" element={<Setup />} />
        <Route path="setup/:step" element={<Setup />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="team" element={<Team />} />
        <Route path="issues" element={<Board />} />
        <Route path="issues/:issue" element={<IssueDetail />} />
        <Route path="goals" element={<Goals />} />
        <Route path="artifacts" element={<Artifacts />} />
        <Route path="chart" element={<OrgChart />} />
        <Route path="agents/:agent" element={<AgentPage />} />
        <Route path="agents/:agent/:tab" element={<AgentPage />} />
        <Route path="runs/:runId" element={<RunView />} />
        <Route path="costs" element={<Costs />} />
        <Route path="skills" element={<Skills />} />
        <Route path="connectors" element={<Connectors />} />
        <Route path="activity" element={<Activity />} />
        <Route path="settings" element={<Settings />} />
        <Route path="settings/:section" element={<Settings />} />
        <Route path="*" element={<NotFound what="Page" />} />
      </Routes>
      </ApprovalRefs>
    </OrgContext.Provider>
  );
}

function Console() {
  const orgs = useOrgs();
  const match = useMatch('/o/:org/*');
  const list = orgs.data;
  if (!list) {
    return <div className="center-screen">{orgs.error ? <ErrorNote error={orgs.error} retry={orgs.reload} /> : <Loading label="Loading organizations" />}</div>;
  }
  const slug = match?.params.org ?? lastOrg();
  const current = list.find((o) => o.slug === slug || o.id === slug) ?? null;
  return (
    <Shell orgs={list} org={current}>
      <Routes>
        <Route path="/" element={<Home orgs={list} />} />
        <Route path="/new-org" element={<NewOrg />} />
        <Route path="/approvals" element={<Approvals orgs={list} />} />
        <Route path="/o/:org/*" element={<OrgRoutes orgs={list} />} />
        <Route path="*" element={<NotFound what="Page" />} />
      </Routes>
    </Shell>
  );
}

function AuthGate() {
  const me = useQuery('me', () => api.me());
  if (me.data) return <Console />;
  if (me.loading) return <div className="center-screen"><Loading label="Checking your session" /></div>;
  if (isUnauthorized(me.error)) return <SignIn onSignedIn={me.reload} />;
  return <div className="center-screen"><div className="center-card"><ErrorNote error={me.error} retry={me.reload} /></div></div>;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/takeover/:token" element={<Takeover />} />
        <Route path="*" element={<AuthGate />} />
      </Routes>
    </BrowserRouter>
  );
}
