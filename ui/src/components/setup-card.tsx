import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { Organization } from '../lib/api.js';
import { k } from '../lib/org.js';
import { useQuery } from '../lib/query.js';
import { useChecklist, useOnboarding } from '../lib/setup.js';
import { useConnectors } from './connectors.js';
import { Icon } from './icons.js';

function Ring({ value, total }: { value: number; total: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
      <defs>
        <linearGradient id="ring-grad" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a78bfa" /><stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <circle cx="28" cy="28" r={r} className="ring-track" />
      <circle cx="28" cy="28" r={r} className="ring-fill" stroke="url(#ring-grad)" strokeDasharray={c} strokeDashoffset={c * (1 - (total ? value / total : 0))} />
      <text x="28" y="32" textAnchor="middle">{value}/{total}</text>
    </svg>
  );
}

/**
 * The overview's "get ready" card: shown while guided setup is unfinished, or
 * while something an organization needs to run (a provider, a team) is missing.
 */
export function SetupCard({ org, base, goals }: { org: Organization; base: string; goals: number | undefined }) {
  const onboarding = useOnboarding(org.id);
  const connectors = useConnectors(org.id);
  const skills = useQuery(k(org.id, 'skills'), () => api.listSkills(org.id), { orgId: org.id, events: ['skill.'] });
  const list = useChecklist(org, { goals, connectors: connectors.data?.length, skills: skills.data?.filter((s) => s.status === 'active').length });
  const state = onboarding.data?.state ?? null;
  if (!onboarding.data || goals === undefined) return null;
  const required = list.filter((c) => !c.optional);
  const missing = required.filter((c) => !c.done);
  if (state?.status === 'complete' && missing.length === 0) return null;
  if (!state && missing.length === 0) return null;
  const doneCount = list.filter((c) => c.done).length;
  const next = missing[0] ?? list.find((c) => !c.done);
  const blocker = missing.find((c) => c.id === 'models' || c.id === 'team');
  const resume = state && state.status !== 'complete' ? `${base}/setup/${state.step}` : `${base}/setup/${next?.step ?? 'interview'}`;

  return (
    <section className={`setup-card${blocker ? ' setup-card-blocked' : ''}`} aria-labelledby="setup-card-title">
      <div className="setup-card-lead">
        <Ring value={doneCount} total={list.length} />
        <div className="grow">
          <span className="eyebrow">{blocker ? 'Action needed' : 'Getting started'}</span>
          <h2 id="setup-card-title">{blocker ? (blocker.id === 'models' ? 'Agents can\'t run until a model provider is set' : 'Your organization has no agents yet') : `Finish setting up ${org.name}`}</h2>
          <p className="dim">{blocker ? (blocker.id === 'models' ? 'Sign in to Claude Code or Codex on this Mac, or add an API key. It takes a minute.' : 'Create a department and hire a lead; the lead can propose the rest of the team.') : 'A few more steps and the team can work unattended.'}</p>
        </div>
        <Link className="btn btn-primary" to={resume}>{state && state.status !== 'complete' ? 'Resume setup' : 'Open guided setup'}<Icon name="right" size={15} /></Link>
      </div>
      <ul className="setup-card-steps">
        {list.map((c) => (
          <li key={c.id} className={c.done ? 'is-done' : ''}>
            <Link to={`${base}/setup/${c.step}`}>
              <span className="check-dot" aria-hidden="true">{c.done ? <Icon name="check" size={11} strokeWidth={3} /> : null}</span>
              <span className="truncate">{c.label}</span>
              <span className="sr-only">{c.done ? '(done)' : c.optional ? '(optional)' : '(to do)'}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
