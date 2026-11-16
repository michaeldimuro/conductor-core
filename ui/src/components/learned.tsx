import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { Memory, Organization } from '../lib/api.js';
import { ago, humanize } from '../lib/format.js';
import { k, useDirectory } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';
import { plain } from '../lib/chain.js';
import { Icon } from './icons.js';
import { Button } from './ui.js';

/** Learning that waits on the owner: memories held for review and skill drafts. Lower stakes than decisions, so it sits below them. */
export function useLearned(orgId: string) {
  const memories = useQuery(k(orgId, 'memory', 'review', 'all'), () => api.listMemory(orgId, { status: 'review', limit: 50 }), { orgId, events: ['memory.'] });
  const skills = useQuery(k(orgId, 'skills'), () => api.listSkills(orgId), { orgId, events: ['skill.'] });
  return { memories: memories.data ?? [], drafts: (skills.data ?? []).filter((s) => s.status === 'draft').length };
}

function MemoryCard({ memory, org }: { memory: Memory; org: Organization }) {
  const dir = useDirectory(org.id);
  const inv = { invalidate: [k(org.id, 'memory')] };
  const keep = useAction(() => api.updateMemory(org.id, memory.id, { status: 'active' }), { ...inv, success: 'Kept. Agents will recall it.' });
  const forget = useAction(() => api.forgetMemory(org.id, memory.id), { ...inv, success: 'Forgotten.' });
  const who = memory.scope === 'agent' ? dir.agentName(memory.scopeId) : memory.scope === 'dept' ? `${dir.dept(memory.scopeId)?.name ?? 'Department'} department` : 'Whole organization';
  return (
    <li className="need need-info need-memory">
      <div className="need-top">
        <span className="need-kind"><Icon name="memory" size={13} />{humanize(memory.kind)}</span>
        <span className="need-chain">{Math.round(memory.confidence * 100)}% sure</span>
        <span className="grow" />
        <span className="muted need-age">{ago(memory.createdAt)}</span>
      </div>
      <p className="need-ask need-memory-text">{plain(memory.content, 320)}</p>
      <p className="need-who muted"><Icon name="agent" size={12} />Remembered for {who}</p>
      <div className="need-actions">
        <span className="grow" />
        <Button small variant="danger" busy={forget.busy} onClick={() => void forget.run()}>Forget</Button>
        <Button small variant="primary" icon="check" busy={keep.busy} onClick={() => void keep.run()}>Keep</Button>
      </div>
    </li>
  );
}

export function LearnedSection({ org, base }: { org: Organization; base: string }) {
  const { memories, drafts } = useLearned(org.id);
  if (!memories.length && !drafts) return null;
  return (
    <section className="today-section" aria-labelledby="learned">
      <header className="today-section-head">
        <h2 id="learned">What your agents learned<span className="today-count">{memories.length + drafts}</span></h2>
      </header>
      {drafts ? (
        <Link className="learned-row" to={`${base}/skills`}>
          <span className="setup-row-icon" aria-hidden="true"><Icon name="skills" size={16} /></span>
          <span className="grow"><strong>{drafts} new {drafts === 1 ? 'skill' : 'skills'} to review</strong><span className="muted">Procedures agents wrote from repeated work. Test or activate them.</span></span>
          <Icon name="right" size={16} />
        </Link>
      ) : null}
      {memories.length ? <ul className="needs">{memories.slice(0, 5).map((m) => <MemoryCard key={m.id} memory={m} org={org} />)}</ul> : null}
      {memories.length > 5 ? <p className="muted">{memories.length - 5} more memories wait in each agent&apos;s Memory tab.</p> : null}
    </section>
  );
}
