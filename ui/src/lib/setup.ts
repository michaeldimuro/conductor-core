import { api, isNotFound } from './api.js';
import type { OnboardingDraft, OnboardingResponse, OnboardingState, OnboardingStep, Organization } from './api.js';
import type { IconName } from '../components/icons.js';
import { k, useDirectory } from './org.js';
import { invalidate, setQueryData, useQuery, type QueryResult } from './query.js';

/** The guided-setup steps, in order, with what each one is for. */
export const SETUP_STEPS: ReadonlyArray<{ id: OnboardingStep; label: string; title: string; sub: string; icon: IconName; optional?: boolean }> = [
  { id: 'interview', label: 'Interview', title: 'Tell the team how you work', sub: 'A short conversation so every agent knows what this organization is for, how to sound, and when to ask you.', icon: 'conversation' },
  { id: 'models', label: 'Models', title: 'Choose the models that do the work', sub: 'Sign in to a local CLI or point at an API key. Every agent uses this default unless you give it its own.', icon: 'model' },
  { id: 'team', label: 'Team & prompts', title: 'Meet your team', sub: 'Review each agent\'s role, goal and backstory. These are the prompts that shape how it thinks and works.', icon: 'agents' },
  { id: 'connectors', label: 'Connectors', title: 'Connect the tools the work lives in', sub: 'Connectors give agents tools through the Conductor gateway, with approvals on anything risky.', icon: 'connectors', optional: true },
  { id: 'skills', label: 'Skills', title: 'Give agents their playbook', sub: 'Skills are reusable procedures agents load when a task calls for them. Start with a few, and agents will write more as they learn.', icon: 'skills', optional: true },
  { id: 'guardrails', label: 'Guardrails', title: 'Set budgets and approvals', sub: 'Decide how much the team may spend and which actions always wait for your sign-off.', icon: 'policy' },
  { id: 'launch', label: 'Launch', title: 'Set the first goals and launch', sub: 'Goals give the team direction. The lead breaks them into issues and the work begins.', icon: 'launch' },
];

export const stepIndex = (id: string | undefined): number => Math.max(0, SETUP_STEPS.findIndex((s) => s.id === id));

const EMPTY_RESPONSE: OnboardingResponse = { state: null, steps: SETUP_STEPS.map((s) => s.id), questions: [] };

/** Guided-setup state of one organization. An older daemon without the endpoint reads as "never started". */
export function useOnboarding(orgId: string): QueryResult<OnboardingResponse> {
  return useQuery(k(orgId, 'onboarding'), async () => {
    try {
      return await api.getOnboarding(orgId);
    } catch (e) {
      if (isNotFound(e)) return EMPTY_RESPONSE;
      throw e;
    }
  }, { orgId });
}

export type SetupPatch = Partial<Omit<OnboardingState, 'updatedAt'>>;

/** Merge a patch into the stored state and save it; the cache updates first so navigation feels instant. */
export async function saveOnboarding(orgId: string, current: OnboardingState | null, patch: SetupPatch): Promise<OnboardingState> {
  const next: Omit<OnboardingState, 'updatedAt'> = {
    status: patch.status ?? current?.status ?? 'in_progress',
    step: patch.step ?? current?.step ?? 'interview',
    done: [...new Set([...(current?.done ?? []), ...(patch.done ?? [])])],
    answers: patch.answers ?? current?.answers ?? [],
    draft: patch.draft !== undefined ? patch.draft : (current?.draft ?? null),
  };
  const key = k(orgId, 'onboarding');
  const restore = setQueryData<OnboardingResponse>(key, (prev) => ({ ...(prev ?? EMPTY_RESPONSE), state: { ...next, updatedAt: Date.now() } }));
  try {
    const res = await api.putOnboarding(orgId, next);
    setQueryData<OnboardingResponse>(key, () => res);
    return res.state!;
  } catch (e) {
    restore();
    throw e;
  } finally {
    invalidate('status');
  }
}

export interface ChecklistItem {
  id: OnboardingStep | 'mission' | 'goal';
  step: OnboardingStep;
  label: string;
  detail: string;
  done: boolean;
  optional?: boolean;
}

/**
 * What a working organization needs, read from live data rather than from the
 * wizard, so it is right for organizations set up before guided setup existed.
 */
export function useChecklist(org: Organization, extra: { goals?: number; connectors?: number; skills?: number }): ChecklistItem[] {
  const dir = useDirectory(org.id);
  const staff = dir.staff.length;
  const unbound = dir.staff.filter((a) => !a.providerBinding).length;
  const providerOk = !!org.defaultProvider?.adapter || (staff > 0 && unbound === 0);
  return [
    { id: 'mission', step: 'interview', label: 'Describe the organization', detail: org.mission ? 'Mission set' : 'Agents work best with a clear mission', done: !!org.mission.trim() },
    { id: 'models', step: 'models', label: 'Choose a model provider', detail: providerOk ? (org.defaultProvider ? `${org.defaultProvider.adapter}${org.defaultProvider.model ? `, ${org.defaultProvider.model}` : ''}` : 'Every agent has its own') : 'Agents cannot run without one', done: providerOk },
    { id: 'team', step: 'team', label: 'Staff the team', detail: staff ? `${staff} ${staff === 1 ? 'agent' : 'agents'}` : 'No agents yet', done: staff > 0 },
    { id: 'connectors', step: 'connectors', label: 'Connect tools', detail: extra.connectors ? `${extra.connectors} installed` : 'Optional, but most work needs tools', done: (extra.connectors ?? 0) > 0, optional: true },
    { id: 'skills', step: 'skills', label: 'Add skills', detail: extra.skills ? `${extra.skills} available` : 'Optional; agents also write their own', done: (extra.skills ?? 0) > 0, optional: true },
    { id: 'guardrails', step: 'guardrails', label: 'Set a budget', detail: org.budgetMonthlyUsd == null ? 'No monthly cap yet' : `$${org.budgetMonthlyUsd} a month`, done: org.budgetMonthlyUsd != null },
    { id: 'goal', step: 'launch', label: 'Set the first goal', detail: extra.goals ? `${extra.goals} ${extra.goals === 1 ? 'goal' : 'goals'}` : 'Goals give the team direction', done: (extra.goals ?? 0) > 0 },
  ];
}

export const draftFor = (state: OnboardingState | null | undefined): OnboardingDraft | null => state?.draft ?? null;
