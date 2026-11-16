import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Services } from '../../daemon/container.js';
import type { Agent, Organization } from '../../contracts/rows.js';
import { OWNER } from '../../contracts/types.js';
import { settings } from '../../db/schema/index.js';
import { body, orgOf } from '../http.js';
import type {
  InterviewAnswer, InterviewResponse, OnboardingDraft, OnboardingResponse, OnboardingState,
} from '../types.js';

/**
 * Guided setup for a new organization: where the owner is in the setup flow, an
 * interview the utility model adapts to the owner's answers, and a draft
 * configuration (mission, owner profile, agent prompts, first goals, guardrails)
 * built from that interview. Every model call has an offline fallback, so setup
 * never dead-ends on a missing provider.
 */
export const onboardingKey = (orgId: string): string => `onboarding.${orgId}`;

export const ONBOARDING_STEPS = ['interview', 'models', 'team', 'connectors', 'skills', 'guardrails', 'launch'] as const;

/** The questions every interview starts with. Ids let the offline draft find the right answer. */
export const CORE_QUESTIONS: ReadonlyArray<{ id: string; question: string; hint: string }> = [
  { id: 'purpose', question: 'In a sentence or two, what does {org} do, and for whom?', hint: 'This becomes the mission every agent works toward.' },
  { id: 'outcomes', question: 'What are the most important outcomes you want in the next 90 days?', hint: 'One per line works best. These become the first goals.' },
  { id: 'voice', question: 'How should agents sound and behave when they act for you? Anything they must always or never do?', hint: 'Tone, house style, hard rules.' },
  { id: 'tools', question: 'Which tools, accounts or data sources does this work live in today?', hint: 'For example GitHub, Gmail, Notion, Stripe, a shared drive.' },
  { id: 'guardrails', question: 'Roughly how much may agents spend per month, and what should always need your sign-off?', hint: 'A number is enough, like "$200 a month, ask before anything over $25".' },
  { id: 'cadence', question: 'How often do you want to hear from the team?', hint: 'A morning digest, only when blocked, or as things happen.' },
];
const MAX_FOLLOWUPS = 3;

const answer = z.strictObject({
  id: z.string().trim().max(60).optional(),
  question: z.string().trim().min(1).max(600),
  answer: z.string().max(4000),
});
const answers = z.array(answer).max(CORE_QUESTIONS.length + MAX_FOLLOWUPS + 4);
const storedDraft = z.object({
  mission: z.string().max(600),
  ownerProfile: z.string().max(20_000),
  goals: z.array(z.object({ title: z.string().max(200), successMetric: z.string().max(300) })).max(5),
  agents: z.array(z.object({ id: z.string().max(100), goal: z.string().max(1000), backstory: z.string().max(2000) })).max(200),
  guardrails: z.object({ budgetMonthlyUsd: z.number().nonnegative().nullable(), approvalSpendThresholdUsd: z.number().nonnegative().nullable(), autonomyLevel: z.number().int().min(0).max(3) }),
  connectors: z.array(z.string().max(100)).max(8),
  summary: z.string().max(300),
  offline: z.boolean(),
});
const stateBody = z.strictObject({
  status: z.enum(['in_progress', 'complete', 'skipped']),
  step: z.enum(ONBOARDING_STEPS),
  done: z.array(z.enum(ONBOARDING_STEPS)).max(ONBOARDING_STEPS.length),
  answers: answers.default([]),
  /** The draft the owner accepted from the interview, kept so later steps can offer its suggestions. */
  draft: storedDraft.nullable().default(null),
});
const interviewBody = z.strictObject({ answers });
const storedState = stateBody.extend({ updatedAt: z.number() });

const clip = (s: unknown, max: number): string => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const money = (s: string): number | null => {
  const m = /\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/i.exec(s);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) ? n : null;
};

/** Offline draft: the owner's own words, arranged. Never invents facts. */
export function heuristicDraft(org: Organization, team: Agent[], list: InterviewAnswer[], catalog: Array<{ id: string; name: string }>): OnboardingDraft {
  const by = (id: string): string => list.find((a) => a.id === id)?.answer.trim() ?? '';
  const outcomes = by('outcomes').split(/\n|;|•|(?:^|\s)\d+[.)]\s/).map((l) => l.replace(/^[-*\s]+/, '').trim()).filter((l) => l.length > 3).slice(0, 5);
  const guard = by('guardrails');
  const amounts = [...guard.matchAll(/\$?\s*\d[\d,]*(?:\.\d+)?\s*k?\b/gi)].map((m) => money(m[0])).filter((n): n is number => n !== null);
  const tools = by('tools').toLowerCase();
  const profile = [
    `# How ${org.name} works`,
    '',
    ...list.filter((a) => a.answer.trim()).flatMap((a) => [`## ${a.question.replace('{org}', org.name)}`, a.answer.trim(), '']),
  ].join('\n').trim();
  return {
    mission: clip(by('purpose') || org.mission, 600),
    ownerProfile: profile,
    goals: outcomes.map((title) => ({ title: title.slice(0, 200), successMetric: '' })),
    agents: [],
    guardrails: {
      budgetMonthlyUsd: amounts[0] ?? null,
      approvalSpendThresholdUsd: amounts.length > 1 ? amounts[1]! : null,
      autonomyLevel: /only when blocked|hands.?off|autonom/i.test(by('cadence') + guard) ? 2 : 1,
    },
    connectors: catalog.filter((c) => tools.includes(c.name.toLowerCase()) || tools.includes(c.id.toLowerCase())).map((c) => c.id).slice(0, 8),
    summary: team.length ? `Built from your answers. ${team.length} agents keep their template prompts; edit them on the Team step.` : 'Built from your answers.',
    offline: true,
  };
}

const draftSchema = z.object({
  mission: z.string().optional(),
  ownerProfile: z.string().optional(),
  summary: z.string().optional(),
  goals: z.array(z.object({ title: z.string(), successMetric: z.string().optional() })).optional(),
  agents: z.array(z.object({ id: z.string(), goal: z.string().optional(), backstory: z.string().optional() })).optional(),
  guardrails: z.object({
    budgetMonthlyUsd: z.number().nullable().optional(),
    approvalSpendThresholdUsd: z.number().nullable().optional(),
    autonomyLevel: z.number().optional(),
  }).optional(),
  connectors: z.array(z.string()).optional(),
});

const transcript = (org: Organization, list: InterviewAnswer[]): string =>
  list.map((a, i) => `Q${i + 1}: ${a.question.replace('{org}', org.name)}\nA${i + 1}: ${a.answer.trim() || '(skipped)'}`).join('\n\n');
const teamText = (team: Agent[]): string => team.map((a) => `- id=${a.id} | ${a.name} | role: ${a.role} | goal: ${a.goal || '(none)'}`).join('\n') || '(no agents yet)';

export function onboardingRoutes(app: FastifyInstance, s: Services): void {
  const { db, clock, audit } = s.kernel;

  const read = (orgId: string): OnboardingState | null => {
    const parsed = storedState.safeParse(db.select().from(settings).where(eq(settings.key, onboardingKey(orgId))).get()?.value);
    return parsed.success ? parsed.data : null;
  };
  const team = (orgId: string): Agent[] => s.org.listAgents(orgId).filter((a) => a.status !== 'terminated');
  const catalog = (): Array<{ id: string; name: string }> => {
    try {
      return s.connectors.catalog().map((t) => ({ id: t.id, name: t.name }));
    } catch {
      return [];
    }
  };

  app.get('/orgs/:orgId/onboarding', async (req): Promise<OnboardingResponse> => {
    const org = orgOf(s, req);
    return { state: read(org.id), steps: [...ONBOARDING_STEPS], questions: CORE_QUESTIONS.map((q) => ({ ...q, question: q.question.replace('{org}', org.name) })) };
  });

  app.put('/orgs/:orgId/onboarding', async (req): Promise<OnboardingResponse> => {
    const org = orgOf(s, req);
    const input = body(req, stateBody);
    const now = clock.now();
    const prev = read(org.id);
    const value: OnboardingState = { ...input, done: [...new Set(input.done)], updatedAt: now };
    db.insert(settings).values({ key: onboardingKey(org.id), value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } }).run();
    if (prev?.status !== value.status) {
      audit.record({ orgId: org.id, actor: OWNER, action: 'config.changed', entityKind: 'setting', entityId: onboardingKey(org.id), data: { onboarding: value.status, step: value.step } });
    }
    return { state: value, steps: [...ONBOARDING_STEPS], questions: CORE_QUESTIONS.map((q) => ({ ...q, question: q.question.replace('{org}', org.name) })) };
  });

  /** The next interview question: the core set first, then up to three the model tailors to the answers so far. */
  app.post('/orgs/:orgId/onboarding/interview', async (req): Promise<InterviewResponse> => {
    const org = orgOf(s, req);
    const { answers: list } = body(req, interviewBody);
    const core = CORE_QUESTIONS[list.length];
    if (core) return { done: false, question: { ...core, question: core.question.replace('{org}', org.name) }, offline: false };
    if (list.length >= CORE_QUESTIONS.length + MAX_FOLLOWUPS) return { done: true, question: null, offline: false };
    try {
      const res = await s.utility.complete({
        orgId: org.id, purpose: 'plan', json: true, maxTokens: 300,
        system: 'You are onboarding a business owner onto a team of AI agents. Ask at most one short follow-up question that would most change how the agents should operate. If the answers already cover what the team needs, reply {"done": true}. Reply with JSON only: {"question": string, "hint": string} or {"done": true}.',
        prompt: `Organization: ${org.name}\nTeam:\n${teamText(team(org.id))}\n\nInterview so far:\n${transcript(org, list)}`,
      });
      if (res.offline) return { done: true, question: null, offline: true };
      const parsed = z.object({ question: z.string().optional(), hint: z.string().optional(), done: z.boolean().optional() }).safeParse(res.json);
      const question = parsed.success ? clip(parsed.data.question, 400) : '';
      if (!question || parsed.data?.done) return { done: true, question: null, offline: false };
      return { done: false, question: { id: `followup-${list.length - CORE_QUESTIONS.length + 1}`, question, hint: clip(parsed.success ? parsed.data.hint : '', 200) }, offline: false };
    } catch {
      return { done: true, question: null, offline: true };
    }
  });

  /** A draft configuration from the interview. Proposals only: nothing is saved until the owner applies it. */
  app.post('/orgs/:orgId/onboarding/draft', async (req): Promise<OnboardingDraft> => {
    const org = orgOf(s, req);
    const { answers: list } = body(req, interviewBody);
    const staff = team(org.id);
    const cat = catalog();
    const fallback = heuristicDraft(org, staff, list, cat);
    try {
      const res = await s.utility.complete({
        orgId: org.id, purpose: 'plan', json: true, maxTokens: 2500,
        system: [
          'You configure a team of AI agents for a business owner from an onboarding interview. Use only what the owner said; never invent facts, numbers or customers.',
          'Reply with JSON only, shaped as:',
          '{"mission": string (1-2 sentences), "ownerProfile": markdown describing the owner\'s preferences, tone, hard rules and reporting cadence,',
          '"goals": [{"title": string, "successMetric": string}] (at most 5), "agents": [{"id": agent id from the team list, "goal": string, "backstory": string}],',
          '"guardrails": {"budgetMonthlyUsd": number|null, "approvalSpendThresholdUsd": number|null, "autonomyLevel": 0-3}, "connectors": [catalog ids], "summary": one sentence}',
        ].join('\n'),
        prompt: `Organization: ${org.name}\nCurrent mission: ${org.mission || '(none)'}\nTeam:\n${teamText(staff)}\nConnector catalog ids: ${cat.map((c) => `${c.id} (${c.name})`).join(', ') || '(none)'}\n\nInterview:\n${transcript(org, list)}`,
      });
      if (res.offline) return fallback;
      const parsed = draftSchema.safeParse(res.json);
      if (!parsed.success) return fallback;
      const d = parsed.data;
      const ids = new Set(staff.map((a) => a.id));
      const catIds = new Set(cat.map((c) => c.id));
      const level = d.guardrails?.autonomyLevel;
      const nonNeg = (n: number | null | undefined, alt: number | null): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : n === null ? null : alt);
      return {
        mission: clip(d.mission, 600) || fallback.mission,
        ownerProfile: clip(d.ownerProfile, 8000) || fallback.ownerProfile,
        goals: (d.goals ?? []).map((g) => ({ title: clip(g.title, 200), successMetric: clip(g.successMetric, 300) })).filter((g) => g.title).slice(0, 5),
        agents: (d.agents ?? []).filter((a) => ids.has(a.id)).map((a) => ({ id: a.id, goal: clip(a.goal, 1000), backstory: clip(a.backstory, 2000) })),
        guardrails: {
          budgetMonthlyUsd: nonNeg(d.guardrails?.budgetMonthlyUsd, fallback.guardrails.budgetMonthlyUsd),
          approvalSpendThresholdUsd: nonNeg(d.guardrails?.approvalSpendThresholdUsd, fallback.guardrails.approvalSpendThresholdUsd),
          autonomyLevel: typeof level === 'number' && level >= 0 && level <= 3 ? Math.round(level) : fallback.guardrails.autonomyLevel,
        },
        connectors: (d.connectors ?? []).filter((c) => catIds.has(c)).slice(0, 8),
        summary: clip(d.summary, 300),
        offline: false,
      };
    } catch {
      return fallback;
    }
  });
}
