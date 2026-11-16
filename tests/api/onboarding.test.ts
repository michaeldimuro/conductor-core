import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './fake-services.js';
import { CORE_QUESTIONS, heuristicDraft } from '../../src/api/routes/onboarding.js';
import type { Organization } from '../../src/contracts/rows.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  h.api.app.inject({ method, url: `/api/v1${url}`, headers: h.owner, ...(payload !== undefined ? { payload: payload as object } : {}) });

const offline = { text: '', json: null, tokensIn: 0, tokensOut: 0, costUsd: 0, offline: true };
const coreAnswers = CORE_QUESTIONS.map((q) => ({ id: q.id, question: q.question, answer: '' }));

describe('onboarding', () => {
  it('has no state until setup starts, then saves and returns it', async () => {
    const first = await call('GET', `/orgs/${h.orgA.slug}/onboarding`);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ state: null, steps: ['interview', 'models', 'team', 'connectors', 'skills', 'guardrails', 'launch'] });
    expect(first.json().questions[0].question).toContain(h.orgA.name);

    const put = await call('PUT', `/orgs/${h.orgA.id}/onboarding`, { status: 'in_progress', step: 'models', done: ['interview', 'interview'], answers: [] });
    expect(put.statusCode).toBe(200);
    expect(put.json().state).toMatchObject({ status: 'in_progress', step: 'models', done: ['interview'] });
    expect((await call('GET', `/orgs/${h.orgA.id}/onboarding`)).json().state.step).toBe('models');
  });

  it('rejects unknown steps and keeps organizations apart', async () => {
    expect((await call('PUT', `/orgs/${h.orgA.id}/onboarding`, { status: 'in_progress', step: 'nope', done: [] })).statusCode).toBe(400);
    await call('PUT', `/orgs/${h.orgA.id}/onboarding`, { status: 'complete', step: 'launch', done: [] });
    expect((await call('GET', `/orgs/${h.orgB.id}/onboarding`)).json().state).toBeNull();
  });

  it('asks the core questions in order, then stops when no model is available', async () => {
    const q1 = await call('POST', `/orgs/${h.orgA.id}/onboarding/interview`, { answers: [] });
    expect(q1.json()).toMatchObject({ done: false, question: { id: 'purpose' } });
    const q2 = await call('POST', `/orgs/${h.orgA.id}/onboarding/interview`, { answers: coreAnswers.slice(0, 1) });
    expect(q2.json().question.id).toBe('outcomes');

    h.services.utility.complete = async () => offline;
    const end = await call('POST', `/orgs/${h.orgA.id}/onboarding/interview`, { answers: coreAnswers });
    expect(end.json()).toEqual({ done: true, question: null, offline: true });
  });

  it('asks a model-tailored follow-up after the core questions', async () => {
    h.services.utility.complete = async () => ({ ...offline, offline: false, json: { question: 'Who signs off on refunds?', hint: 'A name or a role' } });
    const res = await call('POST', `/orgs/${h.orgA.id}/onboarding/interview`, { answers: coreAnswers });
    expect(res.json()).toMatchObject({ done: false, question: { id: 'followup-1', question: 'Who signs off on refunds?' } });
  });

  it('drafts from the model, dropping agent ids and connectors that do not exist', async () => {
    h.services.utility.complete = async () => ({
      ...offline, offline: false,
      json: {
        mission: 'Help indie founders ship.', ownerProfile: '# Owner', summary: 'Ready.',
        goals: [{ title: 'Reach 100 customers', successMetric: 'paying accounts' }],
        agents: [{ id: h.agent.id, goal: 'Grow', backstory: 'Seasoned' }, { id: 'agent_ghost', goal: 'x', backstory: 'y' }],
        guardrails: { budgetMonthlyUsd: 150, approvalSpendThresholdUsd: -5, autonomyLevel: 9 },
        connectors: ['github', 'not-in-catalog'],
      },
    });
    const res = await call('POST', `/orgs/${h.orgA.id}/onboarding/draft`, { answers: coreAnswers });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d).toMatchObject({ mission: 'Help indie founders ship.', offline: false, connectors: [] });
    expect(d.agents).toEqual([{ id: h.agent.id, goal: 'Grow', backstory: 'Seasoned' }]);
    expect(d.guardrails.budgetMonthlyUsd).toBe(150);
    expect(d.guardrails.autonomyLevel).toBe(1);
  });

  it('falls back to the owner\'s own words when the model is offline', async () => {
    h.services.utility.complete = async () => offline;
    const answers = coreAnswers.map((a) => ({
      ...a,
      answer: a.id === 'purpose' ? 'We build bookkeeping for bakeries.' : a.id === 'outcomes' ? '- Launch the beta\n- Sign 20 bakeries' : a.id === 'guardrails' ? '$300 a month, ask over $40' : '',
    }));
    const d = (await call('POST', `/orgs/${h.orgA.id}/onboarding/draft`, { answers })).json();
    expect(d).toMatchObject({ offline: true, mission: 'We build bookkeeping for bakeries.', guardrails: { budgetMonthlyUsd: 300, approvalSpendThresholdUsd: 40 } });
    expect(d.goals.map((g: { title: string }) => g.title)).toEqual(['Launch the beta', 'Sign 20 bakeries']);
  });
});

describe('heuristicDraft', () => {
  it('matches connectors the owner named and reads "k" amounts', () => {
    const org = { name: 'Acme', mission: '' } as Organization;
    const d = heuristicDraft(org, [], [
      { id: 'tools', question: 'tools', answer: 'Mostly GitHub and Notion' },
      { id: 'guardrails', question: 'g', answer: 'about 1.5k per month' },
    ], [{ id: 'github', name: 'GitHub' }, { id: 'slack', name: 'Slack' }, { id: 'notion', name: 'Notion' }]);
    expect(d.connectors).toEqual(['github', 'notion']);
    expect(d.guardrails.budgetMonthlyUsd).toBe(1500);
  });
});
