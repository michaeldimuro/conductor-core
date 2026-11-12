import { useState } from 'react';
import { api } from '../lib/api.js';
import type { Skill, SkillVersion } from '../lib/api.js';
import { ago, dateTime, humanize, money, pct } from '../lib/format.js';
import { k, useDirectory, useOrg, type Directory } from '../lib/org.js';
import { useAction, useQuery } from '../lib/query.js';
import { toast } from '../lib/toast.js';
import { Button, Chip, ConfirmButton, ErrorNote, Load, Modal, Status } from './ui.js';

const WIDER: Record<Skill['scope'], Array<Skill['scope']>> = { agent: ['dept', 'org', 'global'], dept: ['org', 'global'], org: ['global'], global: [] };
const SCOPE_LABEL: Record<Skill['scope'], string> = { agent: 'Agent', dept: 'Department', org: 'Organization', global: 'Every organization' };

export function scopeName(skill: Pick<Skill, 'scope' | 'scopeId'>, dir: Directory): string {
  if (skill.scope === 'agent') return dir.agentName(skill.scopeId, 'Agent');
  if (skill.scope === 'dept') return dir.dept(skill.scopeId)?.name ?? 'Department';
  return SCOPE_LABEL[skill.scope];
}

export const evalText = (score: number | null): string => (score == null ? 'Not evaluated' : `Eval ${pct(score)}`);

function Diff({ text }: { text: string }) {
  if (!text.trim()) return <p className="muted">These versions are identical.</p>;
  return (
    <pre className="code diff">
      {text.split('\n').map((line, i) => (
        <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-del' : line.startsWith('@@') ? 'diff-hunk' : undefined}>{line}{'\n'}</span>
      ))}
    </pre>
  );
}

function History({ skill, versions }: { skill: Skill; versions: SkillVersion[] }) {
  const { org } = useOrg();
  const ordered = [...versions].sort((a, b) => b.version - a.version);
  const [from, setFrom] = useState(Math.max(1, skill.version - 1));
  const [to, setTo] = useState(skill.version);
  const diff = useQuery(ordered.length > 1 ? k(org.id, 'skill', skill.id, 'diff', from, to) : null, () => api.skillDiff(org.id, skill.id, { from, to }));
  const rollback = useAction((v: number) => api.rollbackSkill(org.id, skill.id, v), { invalidate: [k(org.id, 'skill')], success: (s) => `Rolled back to a new version ${s.version}` });
  return (
    <div className="stack">
      <table className="table">
        <thead><tr><th>Version</th><th>Author</th><th>Change</th><th>Eval</th><th>When</th><th /></tr></thead>
        <tbody>
          {ordered.map((v) => (
            <tr key={v.id}>
              <td data-label="Version">v{v.version}{v.version === skill.version ? <> <Chip tone="go">current</Chip></> : null}</td>
              <td data-label="Author">{v.author}</td>
              <td data-label="Change">{v.message || <span className="muted">No message</span>}</td>
              <td data-label="Eval">{v.eval ? <span title={`With skill: ${v.eval.withSkill.steps} steps, ${money(v.eval.withSkill.costUsd)}. Baseline: ${v.eval.baseline.steps} steps, ${money(v.eval.baseline.costUsd)}.`}><Chip tone={v.eval.passed ? 'go' : 'stop'}>{v.eval.passed ? 'Beat baseline' : 'Lost to baseline'}</Chip> {pct(v.eval.score)}</span> : <span className="muted">Not run</span>}</td>
              <td data-label="When" title={dateTime(v.createdAt)}>{ago(v.createdAt)}</td>
              <td className="num">
                {v.version !== skill.version ? (
                  <ConfirmButton icon="runs" small label="Roll back" title={`Roll back to v${v.version}`} confirmLabel="Roll back" message={`The content of v${v.version} becomes a new version. Nothing is deleted.`} onConfirm={() => rollback.run(v.version)} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ordered.length > 1 ? (
        <>
          <div className="toolbar">
            <label className="row">Compare <select value={from} onChange={(e) => setFrom(Number(e.target.value))} style={{ width: 'auto' }}>{ordered.map((v) => <option key={v.id} value={v.version}>v{v.version}</option>)}</select></label>
            <label className="row">with <select value={to} onChange={(e) => setTo(Number(e.target.value))} style={{ width: 'auto' }}>{ordered.map((v) => <option key={v.id} value={v.version}>v{v.version}</option>)}</select></label>
          </div>
          <Load q={diff} lines={2}>{(d) => <Diff text={d.diff} />}</Load>
        </>
      ) : <p className="muted">There is only one version, so there is nothing to compare.</p>}
    </div>
  );
}

function Detail({ skillId }: { skillId: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const detail = useQuery(k(org.id, 'skill', skillId), () => api.readSkill(org.id, skillId), { events: ['skill.'] });
  const history = useQuery(k(org.id, 'skill', skillId, 'history'), () => api.skillHistory(org.id, skillId), { events: ['skill.'] });
  const [tab, setTab] = useState<'body' | 'history'>('body');
  const inv = { invalidate: [k(org.id, 'skill')] };
  const activate = useAction((force: boolean) => api.activateSkill(org.id, skillId, { force }), { ...inv, success: 'Skill is active', quiet: true });
  const evaluate = useAction(() => api.evaluateSkill(org.id, skillId), { ...inv, success: (r) => (r.passed ? `Beat the baseline (${pct(r.score)})` : `Did not beat the baseline (${pct(r.score)})`) });
  const setStatus = useAction((status: Skill['status']) => api.setSkillStatus(org.id, skillId, status), inv);
  const promote = useAction(async (toScope: Skill['scope']) => {
    const res = await api.promoteSkill(org.id, skillId, toScope);
    toast(res.approval ? 'Promotion sent for approval' : `Promoted to ${SCOPE_LABEL[toScope].toLowerCase()} scope`, 'ok');
  }, inv);

  return (
    <Load q={detail} lines={6}>
      {({ skill, body, files }) => (
        <div className="stack-lg">
          <div className="stack">
            <p className="row">
              <Status value={skill.status} />
              <Chip>{scopeName(skill, dir)}</Chip>
              <Chip>v{skill.version}</Chip>
              <Chip tone={skill.evalScore == null ? undefined : skill.evalScore >= 0.5 ? 'go' : 'warn'}>{evalText(skill.evalScore)}</Chip>
              {skill.hasScripts ? <Chip tone="warn">Runs scripts</Chip> : null}
              <span className="muted">by {skill.author}, used {skill.useCount} times{skill.useCount ? `, ${pct(skill.successCount / skill.useCount)} success` : ''}</span>
            </p>
            <p className="dim">{skill.description}</p>
            {skill.scanFindings.length > 0 ? (
              <ul className="stack">
                {skill.scanFindings.map((f, i) => <li key={i} className={`note note-${f.severity === 'block' ? 'stop' : f.severity === 'warn' ? 'warn' : 'info'}`}><span><strong>{humanize(f.rule)}</strong>: {f.detail}</span></li>)}
              </ul>
            ) : null}
            <div className="row">
              {skill.status === 'draft' || skill.status === 'deprecated' ? <Button icon="check" variant="primary" busy={activate.busy} onClick={() => void activate.run(false)}>Activate</Button> : null}
              <Button busy={evaluate.busy} onClick={() => void evaluate.run()}>{evaluate.busy ? 'Evaluating…' : 'Run eval'}</Button>
              {skill.status === 'active' ? <ConfirmButton icon="archive" label="Deprecate" title={`Deprecate ${skill.name}`} confirmLabel="Deprecate" message="Agents stop loading this skill. You can activate it again later." onConfirm={() => setStatus.run('deprecated')} /> : null}
              {skill.status === 'quarantined' ? <Button icon="archive" onClick={() => void setStatus.run('draft')}>Release to draft</Button> : null}
              {WIDER[skill.scope].length > 0 ? (
                <select aria-label="Promote to a wider scope" value="" disabled={promote.busy} onChange={(e) => e.target.value && void promote.run(e.target.value as Skill['scope'])} style={{ width: 'auto' }}>
                  <option value="">Promote to…</option>
                  {WIDER[skill.scope].map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
                </select>
              ) : null}
            </div>
            {activate.error ? (
              <div className="note note-stop" role="alert">
                <ErrorNote error={activate.error} />
                <Button icon="check" small onClick={() => void activate.run(true)}>Activate anyway</Button>
              </div>
            ) : null}
          </div>
          <nav className="tabs" aria-label="Skill sections">
            <a href="#body" className={tab === 'body' ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab('body'); }}>Instructions</a>
            <a href="#history" className={tab === 'history' ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab('history'); }}>Versions and diff</a>
          </nav>
          {tab === 'body' ? (
            <div className="stack">
              <pre className="code skill-body">{body}</pre>
              {files.length ? <p className="row row-tight"><span className="muted">Files:</span>{files.map((f) => <Chip key={f}>{f}</Chip>)}</p> : null}
            </div>
          ) : <Load q={history} lines={3}>{(versions) => <History skill={skill} versions={versions} />}</Load>}
        </div>
      )}
    </Load>
  );
}

export function SkillModal({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  return (
    <Modal open={skill !== null} onClose={onClose} title={skill?.name ?? 'Skill'} wide>
      {skill ? <Detail key={skill.id} skillId={skill.id} /> : null}
    </Modal>
  );
}

export function SkillTable({ skills, onOpen, dir }: { skills: Skill[]; onOpen: (s: Skill) => void; dir: Directory }) {
  return (
    <table className="table">
      <thead><tr><th>Skill</th><th>Scope</th><th>Status</th><th>Eval</th><th className="num">Used</th><th>Updated</th></tr></thead>
      <tbody>
        {skills.map((s) => (
          <tr key={s.id}>
            <td data-label="Skill"><button type="button" className="link-btn" onClick={() => onOpen(s)}><strong>{s.name}</strong></button><span className="field-hint">{s.description}</span></td>
            <td data-label="Scope">{scopeName(s, dir)}</td>
            <td data-label="Status"><Status value={s.status} /></td>
            <td data-label="Eval">{s.evalScore == null ? <span className="muted">Not run</span> : pct(s.evalScore)}</td>
            <td data-label="Used" className="num">{s.useCount}</td>
            <td data-label="Updated" title={dateTime(s.updatedAt)}>{ago(s.updatedAt)} <span className="muted">v{s.version}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
