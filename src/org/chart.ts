import type { Kernel } from '../contracts/kernel.js';
import type { Agent, Department } from '../contracts/rows.js';
import type { CapabilityRefs, OrgChartNode } from '../contracts/org-work.js';
import { invalid } from '../shared/errors.js';
import { findAgentRow, findDept, listAgentRows, listDeptRows, requireAgent, requireDept, requireOrg } from './repo.js';

/** manager id → direct reports, over the org's non-terminated agents. */
function reportIndex(live: Agent[]): Map<string, Agent[]> {
  const byManager = new Map<string, Agent[]>();
  for (const a of live) {
    if (!a.reportsTo) continue;
    const list = byManager.get(a.reportsTo);
    if (list) list.push(a);
    else byManager.set(a.reportsTo, [a]);
  }
  return byManager;
}

function descendants(byManager: Map<string, Agent[]>, rootId: string): Agent[] {
  const out: Agent[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const child of byManager.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/**
 * The reporting forest. Roots report to the Owner (`reports_to` NULL, or a
 * manager that no longer exists). Terminated agents are not part of the chart.
 */
export function orgChart(k: Kernel, orgId: string): OrgChartNode[] {
  requireOrg(k, orgId);
  const live = listAgentRows(k, orgId, { excludeTerminated: true });
  const depts = new Map<string, Department>(listDeptRows(k, orgId).map((d) => [d.id, d]));
  const liveIds = new Set(live.map((a) => a.id));
  const byManager = reportIndex(live);
  const visited = new Set<string>();

  const build = (agent: Agent): OrgChartNode | null => {
    const department = depts.get(agent.deptId);
    if (!department || visited.has(agent.id)) return null;
    visited.add(agent.id);
    const reports = (byManager.get(agent.id) ?? [])
      .map(build)
      .filter((n): n is OrgChartNode => n !== null);
    return { agent, department, isLead: department.leadAgentId === agent.id, reports };
  };

  return live
    .filter((a) => !a.reportsTo || !liveIds.has(a.reportsTo))
    .map(build)
    .filter((n): n is OrgChartNode => n !== null);
}

export function managerOf(k: Kernel, orgId: string, agentId: string): Agent | null {
  const agent = requireAgent(k, orgId, agentId);
  if (!agent.reportsTo) return null;
  const manager = findAgentRow(k, orgId, agent.reportsTo);
  return manager && manager.status !== 'terminated' ? manager : null;
}

export function reportsOf(k: Kernel, orgId: string, agentId: string, opts: { transitive?: boolean } = {}): Agent[] {
  requireAgent(k, orgId, agentId);
  const byManager = reportIndex(listAgentRows(k, orgId, { excludeTerminated: true }));
  return opts.transitive ? descendants(byManager, agentId) : [...(byManager.get(agentId) ?? [])];
}

export function leadOf(k: Kernel, orgId: string, deptId: string): Agent | null {
  const dept = requireDept(k, orgId, deptId);
  if (!dept.leadAgentId) return null;
  const lead = findAgentRow(k, orgId, dept.leadAgentId);
  return lead && lead.status !== 'terminated' ? lead : null;
}

/**
 * Reporting-line rule. Allowed: self; any transitive report; a peer (same
 * manager) when the caller is its department's lead. Everything else is
 * false — the caller must route the work via its lead.
 */
export function canAssign(k: Kernel, orgId: string, fromAgentId: string, toAgentId: string): boolean {
  const from = requireAgent(k, orgId, fromAgentId);
  const to = requireAgent(k, orgId, toAgentId);
  if (from.status === 'terminated' || to.status === 'terminated') return false;
  if (from.id === to.id) return true;
  if (reportsOf(k, orgId, from.id, { transitive: true }).some((a) => a.id === to.id)) return true;
  const sameManager = (from.reportsTo ?? null) === (to.reportsTo ?? null);
  if (!sameManager) return false;
  return findDept(k, orgId, from.deptId)?.leadAgentId === from.id;
}

/** True when `managerId` sits above `agentId` at any depth. */
export function isAbove(k: Kernel, orgId: string, managerId: string, agentId: string): boolean {
  return reportsOf(k, orgId, managerId, { transitive: true }).some((a) => a.id === agentId);
}

/** Reject self-reports and cycles before `agentId` is made to report to `managerId`. */
export function assertNoCycle(k: Kernel, orgId: string, agentId: string, managerId: string): void {
  if (agentId === managerId) throw invalid('an agent cannot report to itself');
  const seen = new Set<string>();
  let cursor: string | null = managerId;
  while (cursor && !seen.has(cursor)) {
    if (cursor === agentId) throw invalid('reporting cycle: the proposed manager already reports (transitively) to this agent');
    seen.add(cursor);
    cursor = findAgentRow(k, orgId, cursor)?.reportsTo ?? null;
  }
}

const union = (...lists: string[][]): string[] => [...new Set(lists.flat())];

/** `org defaults ∪ department shared ∪ agent own`, minus the agent's deny lists. */
export function resolveCapabilityRefs(k: Kernel, orgId: string, agentId: string): CapabilityRefs {
  const org = requireOrg(k, orgId);
  const agent = requireAgent(k, orgId, agentId);
  const dept = findDept(k, orgId, agent.deptId);
  const denySkills = [...new Set(agent.denySkills)];
  const denyConnectors = [...new Set(agent.denyConnectors)];
  return {
    skillNames: union(org.defaultSkills, dept?.sharedSkills ?? [], agent.skills).filter((s) => !denySkills.includes(s)),
    connectorIds: union(org.defaultConnectors, dept?.sharedConnectors ?? [], agent.connectors).filter((c) => !denyConnectors.includes(c)),
    denySkills,
    denyConnectors,
  };
}
