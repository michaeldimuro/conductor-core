import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { buildAgentGroups, type AgentNode } from '../lib/agent-groups.js';
import { useDirectory } from '../lib/org.js';
import { Lamp, toneOf } from './ui.js';
import { Icon } from './icons.js';

const storeKey = (orgId: string) => `conductor.rail.collapsed.${orgId}`;

function readCollapsed(orgId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(storeKey(orgId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function Branch({ node, base, depth }: { node: AgentNode; base: string; depth: number }) {
  const a = node.agent;
  return (
    <li>
      <NavLink to={`${base}/agents/${a.slug}`} title={`${a.name}, ${a.role}`}>
        <span className="agent-glyph"><Icon name="agent" size={14} /><Lamp tone={toneOf(a.status)} /></span>
        <span className="grow truncate">{a.name}</span>
      </NavLink>
      {node.children.length ? (
        <ul className="tree-kids">
          {node.children.map((c) => <Branch key={c.agent.id} node={c} base={base} depth={depth + 1} />)}
        </ul>
      ) : null}
    </li>
  );
}

/** The sidebar's Agents section: departments you can fold, each with its reporting tree. */
export function AgentTree({ orgId, base }: { orgId: string; base: string }) {
  const dir = useDirectory(orgId);
  const loc = useLocation();
  const groups = useMemo(() => buildAgentGroups(dir.staff, dir.departments), [dir.staff, dir.departments]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(orgId));
  useEffect(() => setCollapsed(readCollapsed(orgId)), [orgId]);

  // Opening an agent from elsewhere unfolds its department so you can see where you are.
  const current = loc.pathname.match(/\/agents\/([^/]+)/)?.[1];
  const currentDept = current ? dir.staff.find((a) => a.slug === current || a.id === current)?.deptId : undefined;
  useEffect(() => {
    if (!currentDept) return;
    setCollapsed((c) => {
      if (!c.has(currentDept)) return c;
      const next = new Set(c);
      next.delete(currentDept);
      return next;
    });
  }, [currentDept]);

  const toggle = (id: string) => {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(storeKey(orgId), JSON.stringify([...next]));
      } catch {
        // Private mode or blocked storage: folding still works for this session.
      }
      return next;
    });
  };

  if (!dir.staff.length) return null;
  return (
    <>
      <h2 className="rail-title">Agents</h2>
      <ul className="rail-agents rail-tree">
        {groups.map((g) => {
          const open = !collapsed.has(g.id);
          return (
            <li key={g.id} className="rail-dept">
              <button type="button" className="rail-dept-btn" aria-expanded={open} onClick={() => toggle(g.id)}>
                <Icon name="right" size={12} className="rail-caret" />
                <Icon name="dept" size={14} className="rail-dept-icon" />
                <span className="grow truncate">{g.name}</span>
                <span className="rail-count">{g.size}</span>
              </button>
              {open ? (
                <ul className="tree-kids">
                  {g.roots.map((n) => <Branch key={n.agent.id} node={n} base={base} depth={1} />)}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
