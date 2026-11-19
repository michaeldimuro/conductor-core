import { api } from './api.js';
import type { Approval, BrowserSessionDto, Issue, Run } from './api.js';
import { k } from './org.js';
import { useQuery, type QueryResult } from './query.js';
import { useOpenTakeovers } from '../components/takeover.js';
import { blockedOnOwner, chainSize } from './chain.js';

export { chainSize, holdingUp, plain } from './chain.js';

/**
 * The owner's view of work: what needs a decision, what is moving, what finished.
 * Shared by Today, the Needs-you inbox, the task list and the task summary, so
 * every screen ranks and words things the same way.
 */

export const OPEN_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'] as const;

/** Open issues of the organization, the base for "what is this holding up" and the mobile task list. */
export function useOpenIssues(orgId: string): QueryResult<Issue[]> {
  return useQuery(k(orgId, 'issues', 'open'), async () => (await api.listIssues(orgId, { status: [...OPEN_STATUSES], limit: 200 })).items, { orgId, events: ['issue.'] });
}

/** Issues closed in the last `days` days, newest first. */
export function useRecentlyDone(orgId: string, days = 7): QueryResult<Issue[]> {
  return useQuery(k(orgId, 'issues', 'done', days), async () => {
    const since = Date.now() - days * 86_400_000;
    const page = await api.listIssues(orgId, { status: ['done'], limit: 100 });
    return page.items.filter((i) => (i.closedAt ?? i.updatedAt) >= since).sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt));
  }, { orgId, events: ['issue.'] });
}

export function useLiveRuns(orgId: string): QueryResult<Run[]> {
  return useQuery(k(orgId, 'runs', 'live'), async () => {
    const [a, b, c] = await Promise.all([api.listRuns(orgId, { status: 'running', limit: 50 }), api.listRuns(orgId, { status: 'paused', limit: 50 }), api.listRuns(orgId, { status: 'queued', limit: 50 })]);
    return [...a, ...b, ...c];
  }, { orgId, events: ['run.started', 'run.finished', 'run.paused', 'run.resumed'], pollMs: 30_000 });
}

export type NeedKind = 'approval' | 'blocked' | 'review' | 'takeover';
export interface Need {
  key: string;
  kind: NeedKind;
  title: string;
  at: number;
  /** Open issues transitively waiting on this decision. */
  chain: number;
  issue?: Issue;
  approval?: Approval;
  takeover?: BrowserSessionDto;
  agentId: string | null;
}

/**
 * Everything waiting on the owner in one organization (blocked work only when the
 * next step is theirs, see `blockedOnOwner`), most consequential first:
 * live browser sign-ins (an agent is sitting idle), then whatever unblocks the
 * longest chain of work, then the oldest.
 */
export function useNeeds(orgId: string): { needs: Need[]; loading: boolean; open: Issue[] } {
  const approvals = useQuery(k(orgId, 'approvals', 'pending'), () => api.listApprovals(orgId, { status: 'pending', limit: 100 }), { orgId, events: ['approval.'] });
  const open = useOpenIssues(orgId);
  const takeovers = useOpenTakeovers(orgId);
  const list = open.data ?? [];
  const byId = new Map(list.map((i) => [i.id, i]));
  const needs: Need[] = [];
  for (const t of takeovers.data ?? []) needs.push({ key: `t-${t.id}`, kind: 'takeover', title: t.reason || 'An agent needs you to sign in', at: t.createdAt, chain: 0, takeover: t, agentId: t.agentId ?? null });
  for (const a of approvals.data ?? []) {
    const issue = a.issueId ? byId.get(a.issueId) : undefined;
    needs.push({ key: `a-${a.id}`, kind: 'approval', title: a.title, at: a.createdAt, chain: issue ? 1 + chainSize(issue.id, issue.parentIssueId, list) : 0, approval: a, issue, agentId: a.requesterAgentId });
  }
  const decided = {
    approvalIssues: new Set((approvals.data ?? []).flatMap((a) => (a.issueId ? [a.issueId] : []))),
    takeoverIssues: new Set((takeovers.data ?? []).flatMap((t) => (t.issueId ? [t.issueId] : []))),
  };
  for (const i of list) {
    if (i.status === 'blocked') {
      if (blockedOnOwner(i, list, decided)) needs.push({ key: `b-${i.id}`, kind: 'blocked', title: i.title, at: i.updatedAt, chain: chainSize(i.id, i.parentIssueId, list), issue: i, agentId: i.assigneeAgentId });
    } else if (i.status === 'in_review' && !i.reviewerAgentId) needs.push({ key: `r-${i.id}`, kind: 'review', title: i.title, at: i.updatedAt, chain: chainSize(i.id, i.parentIssueId, list), issue: i, agentId: i.assigneeAgentId });
  }
  const rank = (n: Need) => (n.kind === 'takeover' ? 1e6 : 0) + n.chain * 1000 + (n.issue ? (3 - n.issue.priority) * 100 : 50);
  needs.sort((a, b) => rank(b) - rank(a) || a.at - b.at);
  return { needs, loading: approvals.loading || open.loading, open: list };
}

/** When the owner last opened Today for this org, so new results can be marked; stored per browser. */
export function lastSeen(orgId: string): number {
  try {
    return Number(window.localStorage.getItem(`conductor.seen.${orgId}`)) || 0;
  } catch {
    return 0;
  }
}
export function markSeen(orgId: string): void {
  try {
    window.localStorage.setItem(`conductor.seen.${orgId}`, String(Date.now()));
  } catch {
    /* storage blocked: everything just reads as new */
  }
}
