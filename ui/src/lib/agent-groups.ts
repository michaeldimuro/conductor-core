import type { Agent, Department } from '../../../src/contracts/rows.js';

export interface AgentNode {
  agent: Agent;
  children: AgentNode[];
}

export interface AgentGroup {
  id: string;
  name: string;
  roots: AgentNode[];
  size: number;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * Agents grouped by department, each department ordered as its reporting
 * tree: the lead (or whoever reports outside the department) at the top,
 * their reports nested under them. Departments closest to the top of the
 * org come first (the CEO's), then alphabetically.
 */
export function buildAgentGroups(agents: Agent[], departments: Department[]): AgentGroup[] {
  const groups = new Map<string, { dept: Department | null; members: Agent[] }>();
  const known = new Map(departments.map((d) => [d.id, d]));
  for (const a of agents) {
    const key = known.has(a.deptId) ? a.deptId : '';
    const g = groups.get(key) ?? { dept: known.get(a.deptId) ?? null, members: [] };
    g.members.push(a);
    groups.set(key, g);
  }
  // How far each agent is from the top of the org; a department ranks by its most senior member.
  const all = new Map(agents.map((x) => [x.id, x]));
  const depthOf = (x: Agent): number => {
    let d = 0;
    for (let cur = x, seen = new Set<string>(); cur.reportsTo && all.has(cur.reportsTo) && !seen.has(cur.id); d++) {
      seen.add(cur.id);
      cur = all.get(cur.reportsTo)!;
    }
    return d;
  };
  const out: Array<AgentGroup & { rank: number }> = [];
  for (const [id, { dept, members }] of groups) {
    const ids = new Set(members.map((m) => m.id));
    const kids = new Map<string, Agent[]>();
    const roots: Agent[] = [];
    for (const m of members) {
      // Reporting to someone outside the department (or to you) makes it a root here.
      if (m.reportsTo && ids.has(m.reportsTo) && m.reportsTo !== m.id) kids.set(m.reportsTo, [...(kids.get(m.reportsTo) ?? []), m]);
      else roots.push(m);
    }
    const lead = dept?.leadAgentId;
    const order = (list: Agent[]) => [...list].sort((a, b) => Number(b.id === lead) - Number(a.id === lead) || byName(a, b));
    const seen = new Set<string>();
    const grow = (a: Agent): AgentNode => {
      seen.add(a.id);
      return { agent: a, children: order(kids.get(a.id) ?? []).filter((c) => !seen.has(c.id)).map(grow) };
    };
    const tree = order(roots).map(grow);
    // A reporting cycle leaves members unreached; show them at the top level rather than hiding them.
    for (const m of order(members)) if (!seen.has(m.id)) tree.push(grow(m));
    out.push({ id: id || 'none', name: dept?.name ?? 'No department', roots: tree, size: members.length, rank: Math.min(...members.map(depthOf)) });
  }
  return out
    .sort((a, b) => Number(a.id === 'none') - Number(b.id === 'none') || a.rank - b.rank || byName(a, b))
    .map(({ rank: _rank, ...g }) => g);
}
