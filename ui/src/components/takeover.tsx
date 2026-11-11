import { Button } from './ui.js';
import { api } from '../lib/api.js';
import type { BrowserSessionDto, Organization } from '../lib/api.js';
import { ago } from '../lib/format.js';
import { k, useAgents } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';

/** A takeover the owner can still join: waiting for them, or one they already opened and lost. */
export const isOpenTakeover = (s: BrowserSessionDto): boolean => (s.status === 'pending' || s.status === 'active') && s.expiresAt > Date.now();

/** Pending and active takeovers of one org, kept current by `browser.*` events. */
export function useOpenTakeovers(orgId: string | null) {
  return useQuery(orgId ? k(orgId, 'takeovers', 'open') : null, async () => {
    const [pending, active] = await Promise.all([api.listBrowserSessions(orgId!, { status: 'pending' }), api.listBrowserSessions(orgId!, { status: 'active' })]);
    return [...pending, ...active].filter(isOpenTakeover);
  }, { orgId, events: ['browser.'], pollMs: 30_000 });
}

/**
 * Mints a fresh one-time link for the signed-in owner and opens it here. The
 * link that went out by notification stops working, so a takeover never
 * depends on a messaging gateway being set up.
 */
export function TakeoverButton({ orgId, session, small }: { orgId: string; session: BrowserSessionDto; small?: boolean }) {
  const open = useAction(async () => {
    const link = await api.takeoverLink(orgId, session.id);
    window.location.assign(link.path);
  });
  return (
    <Button variant="primary" small={small} busy={open.busy} onClick={() => void open.run()}>
      {session.status === 'active' ? 'Rejoin takeover' : 'Take over'}
    </Button>
  );
}

/** One callout per open takeover, each with its own button. Renders nothing when there are none. */
export function TakeoverCallouts({ orgId, sessions, orgName }: { orgId: string; sessions: BrowserSessionDto[]; orgName?: string }) {
  const agents = useAgents(sessions.length ? orgId : null);
  const name = (id: string | null) => agents.data?.find((a) => a.id === id)?.name ?? 'An agent';
  return (
    <>
      {sessions.map((s) => (
        <div key={s.id} className="callout callout-stop takeover-callout" role="status">
          <span className="grow">
            <strong>{name(s.agentId)}</strong>{orgName ? ` (${orgName})` : ''} needs you in its browser: {s.reason || 'no reason given'}
            <span className="muted"> · asked {ago(s.createdAt)}</span>
          </span>
          <TakeoverButton orgId={orgId} session={s} small />
        </div>
      ))}
    </>
  );
}

/** The open takeovers of one org, optionally narrowed to a run or an agent. */
export function OrgTakeovers({ org, runId, agentId, showOrg }: { org: Pick<Organization, 'id' | 'name'>; runId?: string; agentId?: string; showOrg?: boolean }) {
  const q = useOpenTakeovers(org.id);
  const sessions = (q.data ?? []).filter((s) => (!runId || s.runId === runId) && (!agentId || s.agentId === agentId));
  if (sessions.length === 0) return null;
  return <TakeoverCallouts orgId={org.id} sessions={sessions} orgName={showOrg ? org.name : undefined} />;
}
