import { createContext, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../components/icons.js';
import { Button, ErrorNote, Loading } from '../../components/ui.js';
import type { OnboardingDraft, OnboardingState, OnboardingStep } from '../../lib/api.js';
import { useOrg } from '../../lib/org.js';
import { useAction } from '../../lib/query.js';
import { SETUP_STEPS, saveOnboarding, stepIndex, useOnboarding, type SetupPatch } from '../../lib/setup.js';
import { toast } from '../../lib/toast.js';
import { InterviewStep } from './InterviewStep.js';
import { ModelsStep } from './ModelsStep.js';
import { TeamStep } from './TeamStep.js';
import { ConnectorsStep, SkillsStep } from './CapabilitySteps.js';
import { GuardrailsStep } from './GuardrailsStep.js';
import { LaunchStep } from './LaunchStep.js';

export interface SetupApi {
  state: OnboardingState | null;
  draft: OnboardingDraft | null;
  questions: Array<{ id: string; question: string; hint: string }>;
  save: (patch: SetupPatch) => Promise<OnboardingState | undefined>;
  /** Mark the current step done and move to the next one (or to `to`). */
  next: (patch?: SetupPatch, to?: OnboardingStep) => Promise<void>;
  go: (step: OnboardingStep) => void;
}

const SetupContext = createContext<SetupApi | null>(null);
export function useSetup(): SetupApi {
  const v = useContext(SetupContext);
  if (!v) throw new Error('useSetup outside the setup flow');
  return v;
}

/** Sticky action bar at the foot of every step: back, an optional skip, and the main action. */
export function StepActions({ onContinue, busy, disabled, continueLabel = 'Continue', skip, children, sticky = true }: {
  onContinue: () => void; busy?: boolean; disabled?: boolean; continueLabel?: string; skip?: boolean; children?: ReactNode;
  /** Off where another control (the interview composer) already holds the bottom of the screen. */
  sticky?: boolean;
}) {
  const { step = 'interview' } = useParams();
  const setup = useSetup();
  const i = stepIndex(step);
  const prev = SETUP_STEPS[i - 1];
  return (
    <div className={`setup-actions${sticky ? '' : ' setup-actions-static'}`}>
      {prev ? <Button icon="left" variant="quiet" onClick={() => setup.go(prev.id)}>Back</Button> : <span />}
      <div className="row setup-actions-main">
        {children}
        {skip ? <Button variant="quiet" onClick={() => void setup.next()}>Skip for now</Button> : null}
        <Button variant="primary" busy={busy} disabled={disabled} onClick={onContinue}>{continueLabel}<Icon name="right" size={15} /></Button>
      </div>
    </div>
  );
}

function Stepper({ current, done, base }: { current: OnboardingStep; done: Set<OnboardingStep>; base: string }) {
  return (
    <ol className="stepper" aria-label="Setup steps">
      {SETUP_STEPS.map((s, i) => {
        const state = s.id === current ? 'current' : done.has(s.id) ? 'done' : 'todo';
        return (
          <li key={s.id} className={`stepper-item is-${state}`}>
            <Link to={`${base}/setup/${s.id}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="stepper-dot" aria-hidden="true">{state === 'done' ? <Icon name="check" size={13} strokeWidth={2.5} /> : i + 1}</span>
              <span className="stepper-text">
                <span className="stepper-label">{s.label}</span>
                {s.optional ? <span className="stepper-opt">Optional</span> : null}
              </span>
              <span className="sr-only">{state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''}</span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

export function Setup() {
  const { org, base } = useOrg();
  const { step: raw } = useParams();
  const nav = useNavigate();
  const q = useOnboarding(org.id);
  const state = q.data?.state ?? null;
  const step = (SETUP_STEPS.find((s) => s.id === raw)?.id ?? state?.step ?? 'interview') as OnboardingStep;
  const meta = SETUP_STEPS[stepIndex(step)]!;
  const i = stepIndex(step);
  const done = new Set(state?.done ?? []);
  const top = useRef<HTMLDivElement>(null);

  // Remember where the owner is, so "Resume setup" lands on the same step.
  useEffect(() => {
    if (!q.data || state?.status === 'complete' || state?.step === step) return;
    void saveOnboarding(org.id, state, { step, status: state?.status === 'skipped' ? 'in_progress' : undefined }).catch(() => {});
  }, [q.data, step, org.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    top.current?.scrollIntoView({ block: 'start' });
    document.getElementById('content')?.scrollTo({ top: 0 });
  }, [step]);

  const save = useAction((patch: SetupPatch) => saveOnboarding(org.id, state, patch), { quiet: true });
  const exit = useAction(async () => {
    await saveOnboarding(org.id, state, { status: state?.status === 'complete' ? 'complete' : 'skipped' });
    nav(base);
  });

  if (!q.data) return <div className="page page-narrow">{q.error ? <ErrorNote error={q.error} retry={q.reload} /> : <Loading lines={5} label="Loading setup" />}</div>;

  const api: SetupApi = {
    state,
    draft: state?.draft ?? null,
    questions: q.data.questions,
    save: (patch) => save.run(patch),
    go: (s) => nav(`${base}/setup/${s}`),
    next: async (patch = {}, to) => {
      const following = to ?? SETUP_STEPS[i + 1]?.id;
      const saved = await save.run({ ...patch, done: [...(patch.done ?? []), step], ...(following ? { step: following } : {}) });
      if (!saved) {
        toast('Could not save your progress. Check the daemon and try again.', 'error');
        return;
      }
      if (following) nav(`${base}/setup/${following}`);
    },
  };

  return (
    <SetupContext.Provider value={api}>
      <div className="setup" ref={top}>
        <aside className="setup-side">
          <div className="setup-side-head">
            <span className="eyebrow">Setting up</span>
            <strong className="setup-org truncate">{org.name}</strong>
            <div className="setup-progress" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={SETUP_STEPS.length} aria-valuenow={done.size}>
              <span style={{ width: `${(done.size / SETUP_STEPS.length) * 100}%` }} />
            </div>
            <span className="muted setup-progress-text">{done.size} of {SETUP_STEPS.length} done</span>
          </div>
          <Stepper current={step} done={done} base={base} />
          <button type="button" className="setup-exit" onClick={() => void exit.run()} disabled={exit.busy}>
            <Icon name="close" size={14} />Exit setup
            <span className="muted">Resume any time from the overview</span>
          </button>
        </aside>
        <section className="setup-main" aria-labelledby="setup-title">
          <header className="setup-head">
            <span className="eyebrow">Step {i + 1} of {SETUP_STEPS.length}{meta.optional ? ' · optional' : ''}</span>
            <h1 id="setup-title"><span className="page-icon"><Icon name={meta.icon} size={20} /></span>{meta.title}</h1>
            <p>{meta.sub}</p>
          </header>
          <div className="setup-body" key={step}>
            {step === 'interview' ? <InterviewStep /> : null}
            {step === 'models' ? <ModelsStep /> : null}
            {step === 'team' ? <TeamStep /> : null}
            {step === 'connectors' ? <ConnectorsStep /> : null}
            {step === 'skills' ? <SkillsStep /> : null}
            {step === 'guardrails' ? <GuardrailsStep /> : null}
            {step === 'launch' ? <LaunchStep /> : null}
          </div>
        </section>
      </div>
    </SetupContext.Provider>
  );
}
