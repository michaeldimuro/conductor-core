import { z } from 'zod';
import { Cron } from 'croner';
import { DEFAULT_GATED_ACTIONS } from '../contracts/types.js';
import { invalid } from '../shared/errors.js';
import { redact } from '../shared/util.js';

/** Slugs double as path segments (`orgs/<slug>/agents/<slug>`), so they are strict. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const slug = z.string().regex(SLUG_RE, 'slug must be lowercase letters, digits and dashes (max 64)');
const name = z.string().trim().min(1).max(120);
const usd = z.number().finite().nonnegative().nullable();
const refList = z
  .array(z.string().trim().min(1).max(200))
  .max(500)
  .transform((xs) => [...new Set(xs)]);

const bindingBase = z.strictObject({
  adapter: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  authRef: z.string().trim().min(1).max(300).optional(),
});

/** Provider binding. Credentials are referenced (`authRef`), never embedded. */
export const providerBindingSchema = bindingBase
  .extend({ fallback: z.array(bindingBase).max(10).optional() })
  .refine((b) => {
    const json = JSON.stringify(b);
    return redact(json) === json;
  }, 'provider binding appears to contain a credential; store it in the secret store and pass authRef');

const policiesSchema = z.strictObject({
  approvalOverrides: z.partialRecord(z.enum(DEFAULT_GATED_ACTIONS), z.boolean()).optional(),
  extraGated: z.array(z.string().min(1).max(100)).max(100).optional(),
  approvalSpendThresholdUsd: z.number().finite().nonnegative().optional(),
  approvalExpiryHours: z.number().finite().min(0).max(8760).optional(),
  deptSkillPromotion: z.enum(['lead', 'auto']).optional(),
  ownerApprovesOrgSkillPromotion: z.boolean().optional(),
  networkAllowlist: z.array(z.string().min(1).max(300)).max(500).optional(),
  toolkitDefault: z.enum(['composio', 'arcade']).optional(),
});

const cron = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((expr) => {
    try {
      new Cron(expr).stop();
      return true;
    } catch {
      return false;
    }
  }, 'invalid cron expression');

export const createOrgSchema = z.strictObject({
  name,
  slug: slug.optional(),
  mission: z.string().max(4000).optional(),
  budgetMonthlyUsd: usd.optional(),
  seatSecondsMonthly: z.number().int().nonnegative().nullable().optional(),
  defaultProvider: providerBindingSchema.nullable().optional(),
  utilityModel: providerBindingSchema.nullable().optional(),
  policies: policiesSchema.optional(),
});

export const updateOrgSchema = createOrgSchema.partial().extend({
  maxConcurrentRuns: z.number().int().min(1).max(64).optional(),
  defaultSkills: refList.optional(),
  defaultConnectors: refList.optional(),
});

export const createDeptSchema = z.strictObject({
  name,
  slug: slug.optional(),
  charter: z.string().max(8000).optional(),
  budgetUsd: usd.optional(),
  sharedSkills: refList.optional(),
  sharedConnectors: refList.optional(),
});

export const updateDeptSchema = createDeptSchema.partial().extend({
  leadAgentId: z.string().min(1).nullable().optional(),
});

export const hireAgentSchema = z.strictObject({
  deptId: z.string().min(1),
  name,
  slug: slug.optional(),
  role: z.string().trim().min(1).max(200),
  goal: z.string().max(4000).optional(),
  backstory: z.string().max(8000).optional(),
  reportsTo: z.string().min(1).nullable().optional(),
  providerBinding: providerBindingSchema.nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  skills: refList.optional(),
  connectors: refList.optional(),
  heartbeatCron: cron.nullable().optional(),
  budgetUsd: usd.optional(),
  autonomyLevel: z.number().int().min(0).max(3).optional(),
  isLead: z.boolean().optional(),
});

export const agentExtrasSchema = z.strictObject({
  denySkills: refList.optional(),
  denyConnectors: refList.optional(),
  maxSteps: z.number().int().min(1).max(10_000).optional(),
  maxWallMs: z.number().int().min(1_000).max(24 * 60 * 60_000).optional(),
  maxRunsPerHour: z.number().int().min(0).max(3_600).optional(),
});

export const updateAgentSchema = hireAgentSchema
  .partial()
  .extend(agentExtrasSchema.shape)
  .extend({ browserProfileId: z.string().min(1).nullable().optional() });

export const fromTemplateSchema = z.strictObject({
  name,
  mission: z.string().max(4000).optional(),
  defaultProvider: providerBindingSchema.nullable().optional(),
});

export const pauseReasonSchema = z.string().trim().min(1).max(500);
export const reasonSchema = z.string().trim().min(1).max(2000);

export const budgetChangeSchema = z.strictObject({
  scope: z.enum(['agent', 'dept']),
  id: z.string().min(1).max(200),
  budgetUsd: usd,
  reason: reasonSchema.optional(),
});

export type CreateOrgParsed = z.infer<typeof createOrgSchema>;
export type UpdateOrgParsed = z.infer<typeof updateOrgSchema>;
export type CreateDeptParsed = z.infer<typeof createDeptSchema>;
export type UpdateDeptParsed = z.infer<typeof updateDeptSchema>;
export type HireAgentParsed = z.infer<typeof hireAgentSchema>;
export type AgentExtras = z.infer<typeof agentExtrasSchema>;
export type UpdateAgentParsed = z.infer<typeof updateAgentSchema>;
export type BudgetChangeParsed = z.infer<typeof budgetChangeSchema>;

/** Parse boundary input; failures become `validation` ConductorErrors. */
export function parse<S extends z.ZodType>(schema: S, input: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw invalid(`invalid ${what}: ${z.prettifyError(r.error)}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/** Drop keys whose value is `undefined` so a patch only touches supplied fields. */
export function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
