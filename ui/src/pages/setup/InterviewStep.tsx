import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Icon } from '../../components/icons.js';
import { Button, Chip, ErrorNote, Field, Logo } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { InterviewAnswer, InterviewQuestion, OnboardingDraft } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import { autonomyName, useDirectory, useOrg } from '../../lib/org.js';
import { invalidate, useAction } from '../../lib/query.js';
import { StepActions, useSetup } from './Setup.js';

function Bubble({ from, children, onEdit }: { from: 'ai' | 'you'; children: ReactNode; onEdit?: () => void }) {
  return (
    <li className={`bubble bubble-${from}`}>
      {from === 'ai' ? <span className="bubble-avatar" aria-hidden="true"><Logo size={26} /></span> : null}
      <div className="bubble-body">
        <span className="sr-only">{from === 'ai' ? 'Conductor: ' : 'You: '}</span>
        {children}
        {onEdit ? <button type="button" className="bubble-edit" onClick={onEdit}><Icon name="edit" size={12} />Edit</button> : null}
      </div>
    </li>
  );
}

function Typing() {
  return (
    <li className="bubble bubble-ai" aria-label="Conductor is thinking">
      <span className="bubble-avatar" aria-hidden="true"><Logo size={26} /></span>
      <div className="bubble-body typing" aria-hidden="true"><span /><span /><span /></div>
    </li>
  );
}

function DraftReview({ draft, onChange }: { draft: OnboardingDraft; onChange: (d: OnboardingDraft) => void }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const g = draft.guardrails;
  const setGoal = (i: number, patch: Partial<OnboardingDraft['goals'][number]>) => onChange({ ...draft, goals: draft.goals.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div className="draft">
      <div className="draft-head">
        <span className="draft-mark" aria-hidden="true"><Icon name="spark" size={16} /></span>
        <div className="grow">
          <h2>Your draft setup</h2>
          <p className="dim">{draft.summary || 'Built from your answers.'} Nothing is saved until you apply it, and every part stays editable later.</p>
        </div>
        {draft.offline ? <Chip tone="warn">Built offline</Chip> : <Chip tone="info">Drafted by AI</Chip>}
      </div>
      {draft.offline ? <p className="note note-warn"><Icon name="warn" className="note-icon" /><span>No utility model is set up, so this draft arranges your own words instead of writing new ones. Add a model on the next step and the team will refine it as it works.</span></p> : null}
      <div className="form-grid">
        <Field label="Mission" wide hint="Every agent sees this at the top of its instructions.">
          <textarea rows={2} value={draft.mission} onChange={(e) => onChange({ ...draft, mission: e.target.value })} maxLength={600} />
        </Field>
      </div>
      <fieldset>
        <legend>First goals</legend>
        {draft.goals.length === 0 ? <p className="muted">No goals came out of the interview. You can add them on the Launch step.</p> : null}
        <ul className="draft-goals">
          {draft.goals.map((goal, i) => (
            <li key={i}>
              <Icon name="goals" size={15} />
              <input aria-label={`Goal ${i + 1}`} value={goal.title} onChange={(e) => setGoal(i, { title: e.target.value })} maxLength={200} />
              <input aria-label={`Success metric for goal ${i + 1}`} placeholder="Success metric" value={goal.successMetric} onChange={(e) => setGoal(i, { successMetric: e.target.value })} maxLength={300} />
              <button type="button" className="icon-btn" aria-label={`Remove goal ${i + 1}`} onClick={() => onChange({ ...draft, goals: draft.goals.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>
            </li>
          ))}
        </ul>
        {draft.goals.length < 5 ? <Button small icon="add" variant="quiet" onClick={() => onChange({ ...draft, goals: [...draft.goals, { title: '', successMetric: '' }] })}>Add a goal</Button> : null}
      </fieldset>
      <dl className="draft-facts">
        <div><dt>Monthly budget</dt><dd>{g.budgetMonthlyUsd == null ? 'No cap' : money(g.budgetMonthlyUsd)}</dd></div>
        <div><dt>Always ask above</dt><dd>{g.approvalSpendThresholdUsd == null ? 'No threshold' : money(g.approvalSpendThresholdUsd)}</dd></div>
        <div><dt>Suggested autonomy</dt><dd>{g.autonomyLevel} · {autonomyName(g.autonomyLevel)}</dd></div>
        <div><dt>Prompt updates</dt><dd>{draft.agents.length ? `${draft.agents.length} of ${dir.staff.length} agents` : 'None'}</dd></div>
      </dl>
      <details className="draft-profile">
        <summary>How you like to work <span className="muted">(owner profile every agent reads)</span></summary>
        <textarea className="mono" rows={10} value={draft.ownerProfile} onChange={(e) => onChange({ ...draft, ownerProfile: e.target.value })} spellCheck={false} aria-label="Owner profile" />
      </details>
    </div>
  );
}

export function InterviewStep() {
  const { org } = useOrg();
  const setup = useSetup();
  const [answers, setAnswers] = useState<InterviewAnswer[]>(setup.state?.answers ?? []);
  const [question, setQuestion] = useState<InterviewQuestion | null>(null);
  const [finished, setFinished] = useState(false);
  const [offline, setOffline] = useState(false);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<OnboardingDraft | null>(setup.draft);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  const ask = useAction(async (list: InterviewAnswer[]) => {
    const res = await api.interviewNext(org.id, list);
    setQuestion(res.question);
    setFinished(res.done);
    setOffline(res.offline);
    return res;
  }, { quiet: true });
  const makeDraft = useAction((list: InterviewAnswer[]) => api.draftOnboarding(org.id, list), { quiet: true });
  const apply = useAction(async (d: OnboardingDraft) => {
    await api.updateOrg(org.id, { mission: d.mission.trim() });
    if (d.ownerProfile.trim()) await api.putOwnerModel(org.id, d.ownerProfile);
    invalidate('orgs', `${org.id}/`);
    await setup.next({ answers, draft: { ...d, goals: d.goals.filter((x) => x.title.trim()) } });
  });

  useEffect(() => {
    if (!draft) void ask.run(answers);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (question && !ask.busy) input.current?.focus({ preventScroll: true });
  }, [question, answers.length, ask.busy, finished, makeDraft.busy]);

  const send = (value: string) => {
    if (!question) return;
    const next = [...answers, { id: question.id, question: question.question, answer: value.trim() }];
    setAnswers(next);
    setText('');
    setQuestion(null);
    void setup.save({ answers: next });
    void ask.run(next);
  };
  const saveEdit = (i: number, value: string) => {
    const next = answers.map((a, j) => (j === i ? { ...a, answer: value.trim() } : a));
    setAnswers(next);
    setEditing(null);
    void setup.save({ answers: next });
  };
  const restart = () => {
    setAnswers([]);
    setDraft(null);
    setFinished(false);
    void setup.save({ answers: [], draft: null });
    void ask.run([]);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (text.trim()) send(text);
    }
  };

  if (draft) {
    return (
      <div className="stack-lg">
        <DraftReview draft={draft} onChange={setDraft} />
        <ErrorNote error={apply.error} />
        <StepActions continueLabel="Apply and continue" busy={apply.busy} disabled={!draft.mission.trim()} onContinue={() => void apply.run(draft)}>
          <Button variant="quiet" icon="refresh" onClick={restart}>Start the interview over</Button>
        </StepActions>
      </div>
    );
  }

  const answered = answers.filter((a) => a.answer).length;
  return (
    <div className="stack-lg">
      <div className="interview">
        <ol className="thread" aria-live="polite">
          <Bubble from="ai">
            <p>Hi! I&apos;ll ask a few questions about <strong>{org.name}</strong> so your agents know what they&apos;re working toward and how you like things done. Answer in your own words; short is fine, and you can skip anything.</p>
          </Bubble>
          {answers.map((a, i) => (
            <li key={i} className="thread-pair">
              <ol>
                <Bubble from="ai"><p>{a.question}</p></Bubble>
                {editing === i ? (
                  <li className="bubble bubble-you">
                    <form className="bubble-body bubble-editing" onSubmit={(e) => { e.preventDefault(); saveEdit(i, new FormData(e.currentTarget).get('answer') as string); }}>
                      <textarea name="answer" rows={3} defaultValue={a.answer} aria-label="Edit your answer" autoFocus />
                      <div className="row"><Button small onClick={() => setEditing(null)}>Cancel</Button><Button small variant="primary" type="submit">Save</Button></div>
                    </form>
                  </li>
                ) : (
                  <Bubble from="you" onEdit={() => setEditing(i)}>{a.answer ? <p>{a.answer}</p> : <p className="muted">Skipped</p>}</Bubble>
                )}
              </ol>
            </li>
          ))}
          {question ? (
            <Bubble from="ai">
              <p>{question.question}</p>
              {question.hint ? <p className="bubble-hint">{question.hint}</p> : null}
              {question.id.startsWith('followup') ? <span className="bubble-tag"><Icon name="spark" size={11} />Follow-up</span> : null}
            </Bubble>
          ) : null}
          {ask.busy || makeDraft.busy ? <Typing /> : null}
          {finished && !ask.busy && !makeDraft.busy ? (
            <Bubble from="ai">
              <p>{answered ? 'Thanks, that\'s everything I need.' : 'No problem. I can still set up a starting point.'} Next I&apos;ll draft a mission, a profile of how you like to work, prompt updates for each agent, the first goals and some guardrails. You&apos;ll review it all before anything changes.</p>
              {offline ? <p className="bubble-hint">No model is connected yet, so I stuck to the core questions.</p> : null}
            </Bubble>
          ) : null}
        </ol>
        <div ref={end} className="interview-end" />
        <ErrorNote error={ask.error ?? makeDraft.error} retry={ask.error ? () => void ask.run(answers) : undefined} />
        {question ? (
          <form className="composer" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send(text); }}>
            <textarea ref={input} rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Type your answer…" aria-label="Your answer" maxLength={4000} />
            <div className="composer-bar">
              <span className="muted composer-hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</span>
              <Button small variant="quiet" onClick={() => send('')}>Skip question</Button>
              <Button small variant="primary" type="submit" icon="send" disabled={!text.trim()}>Send</Button>
            </div>
          </form>
        ) : null}
      </div>
      <StepActions sticky={finished} skip continueLabel={finished ? 'Draft my setup' : 'Continue'} disabled={!finished} busy={makeDraft.busy} onContinue={() => void makeDraft.run(answers).then((d) => d && setDraft(d))} />
    </div>
  );
}
