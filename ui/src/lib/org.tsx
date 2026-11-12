import { createContext, useContext, useMemo } from 'react';
import { api } from './api.js';
import type { Agent, Department, Organization } from './api.js';
import { useQuery, type QueryResult } from './query.js';

export interface OrgContextValue {
  org: Organization;
  orgs: Organization[];
  /** URL prefix of the current org, e.g. `/o/acme`. */
  base: string;
}

export const OrgContext = createContext<OrgContextValue | null>(null);

export function useOrg(): OrgContextValue {
  const v = useContext(OrgContext);
  if (!v) throw new Error('useOrg outside an organization route');
  return v;
}

/** Cache key helpers: every org-scoped key starts with `<orgId>/`. */
export const k = (orgId: string, ...parts: Array<string | number | null | undefined>): string => `${orgId}/${parts.map((p) => p ?? '').join('/')}`;

export const useOrgs = (): QueryResult<Organization[]> => useQuery('orgs', () => api.listOrgs(), { events: ['org.'] });

export function useAgents(orgId: string | null | undefined): QueryResult<Agent[]> {
  return useQuery(orgId ? k(orgId, 'agents') : null, () => api.listAgents(orgId!), { events: ['agent.'], orgId });
}

export function useDepartments(orgId: string): QueryResult<Department[]> {
  return useQuery(k(orgId, 'departments'), () => api.listDepartments(orgId), { events: ['agent.', 'org.updated'], orgId });
}

export interface Directory {
  agents: Agent[];
  /** Agents that can still be given work (not terminated). */
  staff: Agent[];
  departments: Department[];
  agent: (id: string | null | undefined) => Agent | undefined;
  dept: (id: string | null | undefined) => Department | undefined;
  agentName: (id: string | null | undefined, fallback?: string) => string;
  loading: boolean;
  error: unknown;
}

export function useDirectory(orgId: string): Directory {
  const agents = useAgents(orgId);
  const departments = useDepartments(orgId);
  return useMemo(() => {
    const list = agents.data ?? [];
    const depts = departments.data ?? [];
    const byId = new Map(list.map((a) => [a.id, a]));
    const deptById = new Map(depts.map((d) => [d.id, d]));
    return {
      agents: list,
      staff: list.filter((a) => a.status !== 'terminated'),
      departments: depts,
      agent: (id) => (id ? byId.get(id) : undefined),
      dept: (id) => (id ? deptById.get(id) : undefined),
      agentName: (id, fallback = 'Unassigned') => (id ? (byId.get(id)?.name ?? id) : fallback),
      loading: agents.loading || departments.loading,
      error: agents.error ?? departments.error,
    };
  }, [agents.data, departments.data, agents.loading, departments.loading, agents.error, departments.error]);
}

export const AUTONOMY_LEVELS: ReadonlyArray<{ level: number; name: string; behavior: string }> = [
  { level: 0, name: 'Assist', behavior: 'Only acts on explicitly assigned issues; every external action needs approval.' },
  { level: 1, name: 'Supervised', behavior: 'Creates its own sub-issues; routine work runs on its own. Destructive actions, payments, publishing and first messages to new recipients need approval.' },
  { level: 2, name: 'Autonomous', behavior: 'Pursues goals proactively, creates issues, acts within budget and policy; only policy-flagged actions need approval.' },
  { level: 3, name: 'Lead', behavior: 'Autonomous, plus may propose hires, reassign work and set department goals. Hires still need your approval.' },
];
export const autonomyName = (level: number): string => AUTONOMY_LEVELS[level]?.name ?? `Level ${level}`;

export const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done', blocked: 'Blocked', cancelled: 'Cancelled',
};
export const PRIORITIES = ['Urgent', 'High', 'Normal', 'Low'] as const;
export const priorityName = (p: number): string => PRIORITIES[p] ?? `P${p}`;
