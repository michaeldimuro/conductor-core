import { useState } from 'react';
import { SkillModal, SkillTable, scopeName } from '../components/SkillDetail.js';
import { Icon } from '../components/icons.js';
import { Button, Empty, Field, FormShell, Load, Modal, PageHead, Panel, Segmented } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { Skill } from '../lib/api.js';
import { humanize } from '../lib/format.js';
import { k, useDirectory, useOrg, type Directory } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';

const SCOPES: ReadonlyArray<{ value: Skill['scope']; label: string }> = [
  { value: 'org', label: 'This organization' }, { value: 'dept', label: 'One department' }, { value: 'agent', label: 'One agent' }, { value: 'global', label: 'Every organization' },
];
const STATUSES = ['draft', 'active', 'deprecated', 'quarantined'] as const;

function ScopeFields({ scope, setScope, scopeId, setScopeId, dir }: { scope: Skill['scope']; setScope: (s: Skill['scope']) => void; scopeId: string; setScopeId: (s: string) => void; dir: Directory }) {
  return (
    <>
      <Field label="Available to">
        <select value={scope} onChange={(e) => { setScope(e.target.value as Skill['scope']); setScopeId(''); }}>{SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
      </Field>
      {scope === 'dept' ? (
        <Field label="Department"><select value={scopeId} onChange={(e) => setScopeId(e.target.value)} required><option value="">Choose</option>{dir.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      ) : null}
      {scope === 'agent' ? (
        <Field label="Agent"><select value={scopeId} onChange={(e) => setScopeId(e.target.value)} required><option value="">Choose</option>{dir.staff.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      ) : null}
    </>
  );
}

export function SkillForm({ onClose, dir }: { onClose: () => void; dir: Directory }) {
  const { org } = useOrg();
  const [mode, setMode] = useState<'write' | 'import'>('write');
  const [scope, setScope] = useState<Skill['scope']>('org');
  const [scopeId, setScopeId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [sourceDir, setSourceDir] = useState('');
  const [source, setSource] = useState('');
  const save = useAction(async () => {
    const target = { scope, scopeId: scope === 'dept' || scope === 'agent' ? scopeId : null };
    if (mode === 'write') await api.upsertSkill(org.id, { ...target, name: name.trim(), description: description.trim(), body, status: 'draft' });
    else await api.importSkill(org.id, { ...target, sourceDir: sourceDir.trim(), ...(source.trim() ? { source: source.trim() } : {}) });
    onClose();
  }, { invalidate: [k(org.id, 'skill')], success: 'Saved as a draft. Review and activate it when ready.' });
  return (
    <FormShell onSubmit={() => void save.run()} onCancel={onClose} busy={save.busy} error={save.error} submitLabel={mode === 'write' ? 'Save draft' : 'Import as draft'}>
      <Segmented label="Source" value={mode} onChange={setMode} options={[{ value: 'write', label: 'Write here' }, { value: 'import', label: 'Import a folder' }]} />
      <div className="form-grid">
        <ScopeFields scope={scope} setScope={setScope} scopeId={scopeId} setScopeId={setScopeId} dir={dir} />
        {mode === 'write' ? (
          <>
            <Field label="Name" hint="Lowercase letters, digits and dashes."><input value={name} onChange={(e) => setName(e.target.value)} required pattern="[a-z0-9][a-z0-9\-]*" placeholder="weekly-seo-audit" autoCapitalize="none" spellCheck={false} /></Field>
            <Field label="Description" wide hint="Agents read this to decide whether the skill applies, so say when to use it."><input value={description} onChange={(e) => setDescription(e.target.value)} required /></Field>
            <Field label="Instructions (SKILL.md body)" wide><textarea className="mono" rows={12} value={body} onChange={(e) => setBody(e.target.value)} required spellCheck={false} /></Field>
          </>
        ) : (
          <>
            <Field label="Folder on the Mac" wide hint="Absolute path to a folder containing SKILL.md. Imported skills are pinned by hash and start as drafts."><input value={sourceDir} onChange={(e) => setSourceDir(e.target.value)} required placeholder="/Users/you/skills/pdf-forms" autoCapitalize="none" spellCheck={false} /></Field>
            <Field label="Where it came from (optional)" wide><input value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://github.com/…" autoCapitalize="none" spellCheck={false} /></Field>
          </>
        )}
      </div>
    </FormShell>
  );
}

export function Skills() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [scope, setScope] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Skill | null>(null);
  const [creating, setCreating] = useState(false);
  const skills = useQuery(k(org.id, 'skills'), () => api.listSkills(org.id), { events: ['skill.'] });
  const needle = search.trim().toLowerCase();
  const shown = (skills.data ?? []).filter((s) => (!scope || s.scope === scope) && (!status || s.status === status) && (!needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle)));
  const drafts = (skills.data ?? []).filter((s) => s.status === 'draft').length;
  // Activation is gated on an evaluation; an untested draft can be tested first or activated anyway by the owner.
  const activate = useAction((id: string, force?: boolean) => api.activateSkill(org.id, id, force ? { force: true } : {}), { invalidate: [k(org.id, 'skill')], success: 'Activated. Agents can load it now.' });
  const evaluate = useAction((id: string) => api.evaluateSkill(org.id, id), { invalidate: [k(org.id, 'skill')], success: (r) => (r.passed ? `Passed (${Math.round(r.score * 100)}%). Activate it when ready.` : r.needsReview ? 'Inconclusive. Open it to review the result.' : 'It did not beat the baseline. Review or retire it.') });
  const retire = useAction((id: string) => api.setSkillStatus(org.id, id, 'deprecated'), { invalidate: [k(org.id, 'skill')], success: 'Retired. It stays in history.' });
  return (
    <div className="page">
      <PageHead icon="skills" eyebrow="Library" title="Skills" sub="Reusable procedures agents load when a task calls for them. Agents write their own as drafts; you decide what becomes active." actions={<Button icon="add" variant="primary" onClick={() => setCreating(true)}>New skill</Button>} />
      {drafts > 0 ? (
        <section className="stack review-queue" aria-labelledby="skill-queue">
          <h2 id="skill-queue" className="section-title"><Icon name="review" size={15} />Waiting for your review <span className="today-count">{drafts}</span></h2>
          <ul className="needs">
            {(skills.data ?? []).filter((x) => x.status === 'draft').map((x) => (
              <li key={x.id} className="need need-info">
                <div className="need-top">
                  <span className="need-kind"><Icon name="skills" size={13} />{x.author === 'human' ? 'Your draft' : 'Written by an agent'}</span>
                  <span className="need-chain">{x.evalScore != null ? `Eval ${Math.round(x.evalScore * 100)}%` : 'Not tested yet'}</span>
                  <span className="grow" />
                  <span className="muted need-age">{scopeName(x, dir)}</span>
                </div>
                <button type="button" className="need-title link-btn skill-open" onClick={() => setOpen(x)}>{x.name}</button>
                <p className="need-ask">{x.description}</p>
                <div className="need-actions">
                  <Button small variant="quiet" icon="view" onClick={() => setOpen(x)}>Review</Button>
                  <span className="grow" />
                  <Button small variant="danger" busy={retire.busy} onClick={() => void retire.run(x.id)}>Retire</Button>
                  {x.evalScore == null ? (
                    <>
                      <Button small busy={activate.busy} onClick={() => void activate.run(x.id, true)} title="Skip the evaluation and make it available now">Activate anyway</Button>
                      <Button small variant="primary" icon="spark" busy={evaluate.busy} onClick={() => void evaluate.run(x.id)} title="Replay past tasks with and without this skill">Test it</Button>
                    </>
                  ) : <Button small variant="primary" icon="check" busy={activate.busy} onClick={() => void activate.run(x.id)}>Activate</Button>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="toolbar" role="search">
        <input className="toolbar-search" type="search" data-search placeholder="Search skills" aria-label="Search skills" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Filter by scope" value={scope} onChange={(e) => setScope(e.target.value)}><option value="">Any scope</option>{SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
      </div>
      <Panel flush>
        <Load q={skills} empty={<Empty icon="skills" title="No skills yet"><p>Write one, import a folder, or let agents distill their own from repeated work.</p></Empty>}>
          {() => (shown.length === 0 ? <Empty icon="skills" title="No skills match these filters" /> : <SkillTable skills={shown} onOpen={setOpen} dir={dir} />)}
        </Load>
      </Panel>
      <SkillModal skill={open} onClose={() => setOpen(null)} />
      <Modal open={creating} onClose={() => setCreating(false)} title="New skill" wide>{creating ? <SkillForm onClose={() => setCreating(false)} dir={dir} /> : null}</Modal>
    </div>
  );
}
