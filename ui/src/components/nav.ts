import type { IconName } from './icons.js';

export interface NavItem { to: string; label: string; key: string; icon: IconName; end?: boolean; keywords?: string }

/** The organization's places, grouped by what the owner is doing: directing work, shaping the team, or checking results. */
export const NAV_GROUPS: ReadonlyArray<{ label: string; items: ReadonlyArray<NavItem> }> = [
  {
    label: 'Work',
    items: [
      { to: '', label: 'Today', key: 'o', icon: 'overview', end: true, keywords: 'home dashboard overview summary' },
      { to: '/inbox', label: 'Needs you', key: 'y', icon: 'notify', keywords: 'inbox approvals blocked review decisions' },
      { to: '/issues', label: 'Issues', key: 'i', icon: 'issues', keywords: 'board tasks tickets list' },
      { to: '/goals', label: 'Goals', key: 'g', icon: 'goals', keywords: 'objectives okr' },
      { to: '/artifacts', label: 'Artifacts', key: 'f', icon: 'artifacts', keywords: 'files outputs documents' },
    ],
  },
  {
    label: 'Team',
    items: [
      { to: '/team', label: 'Team', key: 'm', icon: 'agents', keywords: 'agents people working status' },
      { to: '/chart', label: 'Org chart', key: 'c', icon: 'chart', keywords: 'departments hire reporting' },
      { to: '/skills', label: 'Skills', key: 's', icon: 'skills', keywords: 'procedures playbook' },
      { to: '/connectors', label: 'Connectors', key: 'n', icon: 'connectors', keywords: 'tools mcp integrations' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { to: '/costs', label: 'Costs', key: 'b', icon: 'costs', keywords: 'budget spend money' },
      { to: '/activity', label: 'Activity', key: 'l', icon: 'activity', keywords: 'log audit history' },
      { to: '/settings', label: 'Settings', key: 't', icon: 'settings', keywords: 'configure policies providers' },
    ],
  },
];

export const NAV_ITEMS: ReadonlyArray<NavItem> = NAV_GROUPS.flatMap((g) => g.items);
