import { useState } from 'react';
import { SkillModal, SkillTable } from '../../components/SkillDetail.js';
import { Button, Empty, Field, Load, Panel, TagInput } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { Agent, Skill } from '../../lib/api.js';
import { k, useDirectory, useOrg } from '../../lib/org.js';
import { useAction, useQuery } from '../../lib/query.js';

export function SkillsTab({ agent }: { agent: Agent }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const skills = useQuery(k(org.id, 'skills'), () => api.listSkills(org.id), { events: ['skill.'] });
  const caps = useQuery(k(org.id, 'agent', agent.id, 'capabilities'), () => api.agentCapabilities(org.id, agent.id), { events: ['agent.', 'skill.', 'org.updated'], orgId: org.id });
  const [open, setOpen] = useState<Skill | null>(null);
  const [own, setOwn] = useState(agent.skills);
  const [deny, setDeny] = useState(agent.denySkills);
  const save = useAction(() => api.updateAgent(org.id, agent.id, { skills: own, denySkills: deny }), { invalidate: [`${org.id}/`], success: 'Skill assignments saved' });
  const dirty = own.join('\n') !== agent.skills.join('\n') || deny.join('\n') !== agent.denySkills.join('\n');

  // What this agent can see: global, its org, its department, and its own scope.
  const inScope = (skills.data ?? []).filter((s) => s.scope === 'global' || s.scope === 'org' || (s.scope === 'dept' && s.scopeId === agent.deptId) || (s.scope === 'agent' && s.scopeId === agent.id));
  const names = new Set(caps.data?.skillNames ?? []);
  const effective = inScope.filter((s) => s.status === 'active' && names.has(s.name));
  const drafts = inScope.filter((s) => s.status === 'draft' && s.scope === 'agent');
  const other = inScope.filter((s) => !effective.includes(s) && !drafts.includes(s));

  return (
    <div className="stack-lg">
      {drafts.length > 0 ? (
        <Panel icon="review" title={`Drafts awaiting your review (${drafts.length})`} flush>
          <SkillTable skills={drafts} onOpen={setOpen} dir={dir} />
        </Panel>
      ) : null}
      <Panel icon="skills" title="Effective skills" flush>
        <Load q={skills} empty={<Empty icon="skills" title="No skills exist in this organization yet" />}>
          {() => (effective.length === 0 ? <Empty icon="skills" title="This agent loads no skills"><p>It inherits organization and department skills, plus any named below.</p></Empty> : <SkillTable skills={effective} onOpen={setOpen} dir={dir} />)}
        </Load>
      </Panel>
      <Panel icon="link" title="Assignments">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <div className="form-grid">
            <Field label="This agent's own skills" hint="Skill names it loads in addition to what it inherits."><TagInput label="Own skills" value={own} onChange={setOwn} placeholder="Type a skill name and press Enter" /></Field>
            <Field label="Never load" hint="Inherited skills this agent must not use."><TagInput label="Denied skills" value={deny} onChange={setDeny} placeholder="Type a skill name and press Enter" /></Field>
          </div>
          <div className="form-actions"><Button icon="check" type="submit" variant="primary" busy={save.busy} disabled={!dirty}>Save assignments</Button></div>
        </form>
      </Panel>
      {other.length > 0 ? (
        <Panel icon="docs" title="In scope but not loaded" flush>
          <SkillTable skills={other} onOpen={setOpen} dir={dir} />
        </Panel>
      ) : null}
      <SkillModal skill={open} onClose={() => setOpen(null)} />
    </div>
  );
}
