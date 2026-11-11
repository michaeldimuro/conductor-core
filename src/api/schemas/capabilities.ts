import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { CONNECTOR_KINDS, SKILL_STATUSES } from '../../db/schema/capabilities.js';
import { MEMORY_KINDS, MEMORY_SCOPES } from '../../db/schema/memory.js';
import { GATEWAY_KINDS } from '../../db/schema/reach.js';
import { boolQ, csvQ, idStr, intQ, jsonRecord, nameStr, scope, secretRef, text, toolPolicy } from './common.js';

/* ── Skills ── */
const skillStatus = z.enum(SKILL_STATUSES);
const skillFiles = z.record(z.string().min(1).max(500), z.string().max(2_000_000));
export const listSkillsQ = z.object({
  scope: scope.optional(),
  scopeId: idStr.optional(),
  status: skillStatus.optional(),
  includeGlobal: boolQ.optional(),
});
export const upsertSkill = z.strictObject({
  scope,
  scopeId: idStr.nullable().optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(2000),
  body: z.string().min(1).max(500_000),
  files: skillFiles.optional(),
  status: skillStatus.optional(),
});
export const importSkill = z.strictObject({
  sourceDir: z.string().min(1).max(4000).refine((p) => isAbsolute(p) && !p.includes('\0'), 'sourceDir must be an absolute path'),
  scope,
  scopeId: idStr.nullable().optional(),
  source: z.string().max(2000).optional(),
});
export const skillDiffQ = z.object({ from: intQ(1, 1_000_000).optional(), to: intQ(1, 1_000_000).optional() });
export const skillRollback = z.strictObject({ toVersion: z.number().int().min(1) });
export const skillActivate = z.strictObject({ force: z.boolean().optional() });
const expectList = z.array(z.string().min(1).max(2000)).max(50);
export const addEvalCase = z.strictObject({
  prompt: z.string().trim().min(1).max(20_000),
  criteria: z.string().max(8000).optional(),
  expect: z.strictObject({ contains: expectList.optional(), notContains: expectList.optional(), regex: expectList.optional(), files: expectList.optional() }).optional(),
  issueId: idStr.nullable().optional(),
});
export const skillPromote = z.strictObject({ toScope: scope });
export const skillStatusBody = z.strictObject({ status: skillStatus });

/* ── Memory ── */
const memoryKind = z.enum(MEMORY_KINDS);
const memoryScope = z.enum(MEMORY_SCOPES);
const memoryStatus = z.enum(['active', 'review', 'superseded', 'forgotten']);
const unit = z.number().finite().min(0).max(1);
export const memorySearchQ = z.object({
  text: z.string().min(1).max(2000),
  agentId: idStr.optional(),
  kinds: csvQ(MEMORY_KINDS).optional(),
  entity: z.string().min(1).max(300).optional(),
  taskType: z.string().min(1).max(100).optional(),
  limit: intQ(1, 200).optional(),
  includeReview: boolQ.optional(),
});
export const listMemoryQ = z.object({
  scope: memoryScope.optional(),
  scopeId: idStr.optional(),
  kind: memoryKind.optional(),
  status: memoryStatus.optional(),
  limit: intQ(1, 500).optional(),
  offset: intQ(0, 10_000_000).optional(),
});
export const writeMemory = z.strictObject({
  scope: memoryScope,
  scopeId: idStr,
  kind: memoryKind,
  content: z.string().trim().min(1).max(20_000),
  entity: z.string().max(300).nullable().optional(),
  taskType: z.string().max(100).nullable().optional(),
  importance: unit.optional(),
  confidence: unit.optional(),
  pinned: z.boolean().optional(),
});
export const updateMemory = z.strictObject({
  content: z.string().trim().min(1).max(20_000).optional(),
  importance: unit.optional(),
  confidence: unit.optional(),
  pinned: z.boolean().optional(),
  status: memoryStatus.optional(),
  kind: memoryKind.optional(),
});
export const docContent = z.strictObject({ content: text(200_000) });
export const memoryBackend = z.strictObject({
  kind: z.enum(['honcho', 'mem0', 'zep', 'supermemory']),
  baseUrl: z.url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL').optional(),
  authRef: secretRef,
  options: z.record(z.string().min(1).max(100), z.string().max(1000)).optional(),
});
export const sessionSearchQ = z.object({ text: z.string().min(1).max(2000), agentId: idStr.optional(), limit: intQ(1, 200).optional() });

/* ── Connectors ── */
const connectorScope = z.enum(['org', 'dept']);
export const installConnector = z.strictObject({
  name: nameStr,
  kind: z.enum(CONNECTOR_KINDS),
  scope: connectorScope.optional(),
  scopeId: idStr.nullable().optional(),
  config: jsonRecord,
  authRef: secretRef.nullable().optional(),
  toolAllowlist: z.array(z.string().min(1).max(300)).max(2000).nullable().optional(),
  templateId: idStr.nullable().optional(),
});
export const updateConnector = installConnector.partial().extend({ status: z.enum(['active', 'disabled', 'error']).optional() });
export const installFromTemplate = z.strictObject({
  templateId: idStr,
  name: nameStr.optional(),
  scope: connectorScope.optional(),
  scopeId: idStr.nullable().optional(),
  /** Secret VALUES for the template's required secrets; stored in the secret store, never echoed. */
  secrets: z.record(z.string().min(1).max(200), z.string().min(1).max(20_000)).optional(),
  config: jsonRecord.optional(),
});
export const grantBody = z.strictObject({
  toolAllowlist: z.array(z.string().min(1).max(300)).max(2000).nullable().optional(),
  toolPolicies: z.record(z.string().min(1).max(300), toolPolicy).optional(),
  defaultPolicy: toolPolicy.optional(),
  authRef: secretRef.nullable().optional(),
});
export const listGrantsQ = z.object({ agentId: idStr.optional(), connectorId: idStr.optional() });

/* ── Browser ── */
const domains = z.array(z.string().trim().min(1).max(300)).max(500);
/** Shape only; the browser service enforces the rules (CDP on loopback, vault names). */
const browserEngine = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chromium') }),
  z.strictObject({ kind: z.literal('channel'), channel: z.enum(['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary', 'msedge']) }),
  z.strictObject({ kind: z.literal('cdp'), endpoint: z.string().trim().min(1).max(500) }),
]);
const profileSettings = {
  engine: browserEngine.optional(),
  headed: z.boolean().nullable().optional(),
  onePasswordVaults: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
};
export const createProfile = z.strictObject({
  name: nameStr,
  agentId: idStr.nullable().optional(),
  deptId: idStr.nullable().optional(),
  domainAllowlist: domains.optional(),
  sensitiveDomains: domains.optional(),
  ...profileSettings,
});
export const updateProfile = z.strictObject({ name: nameStr.optional(), domainAllowlist: domains.optional(), sensitiveDomains: domains.optional(), ...profileSettings });
export const listSessionsQ = z.object({ status: z.enum(['pending', 'active', 'handed_back', 'expired', 'cancelled']).optional() });

/* ── Gateways / webhooks (rows owned by the API; secrets by reference only) ── */
export const createGateway = z.strictObject({
  orgId: idStr.nullable().optional(),
  kind: z.enum(GATEWAY_KINDS),
  name: nameStr,
  config: jsonRecord.optional(),
  authRef: secretRef.nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export const updateGateway = createGateway.omit({ kind: true }).partial();
export const listGatewaysQ = z.object({ orgId: idStr.optional() });

const eventNames = z.array(z.string().trim().min(1).max(200)).max(200);
export const createWebhook = z.strictObject({
  direction: z.enum(['in', 'out']),
  name: nameStr,
  source: z.enum(['github', 'stripe', 'composio', 'generic']).optional(),
  agentId: idStr.nullable().optional(),
  url: z.string().min(1).max(2000).nullable().optional(),
  events: eventNames.optional(),
  secretRef: secretRef.nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export const updateWebhook = createWebhook.omit({ direction: true }).partial();
export const listWebhooksQ = z.object({ direction: z.enum(['in', 'out']).optional() });

/* ── System ── */
export const secretValue = z.strictObject({ value: z.string().min(1).max(100_000) });
export const settingValue = z.strictObject({ value: z.unknown() });
export const testAdapter = z.strictObject({
  config: jsonRecord.optional(),
  authRef: secretRef.nullable().optional(),
  model: z.string().min(1).max(200).nullable().optional(),
  orgId: idStr.optional(),
});
export const doctorQ = z.object({ orgId: idStr.optional() });
export const loginCode = z.strictObject({
  label: text(200).optional(),
  /** Lifetime of the device session the code turns into. */
  ttlMs: z.number().int().min(60_000).max(90 * 86_400_000).optional(),
});
export const sessionBody = z.strictObject({ token: z.string().min(1).max(500) });
export const claimBody = z.strictObject({ token: z.string().min(1).max(4000) });
export const callTool = z.strictObject({ arguments: jsonRecord.optional() });

export const browserInput = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('mouse'), action: z.enum(['move', 'down', 'up', 'click']), x: z.number().finite(), y: z.number().finite(), button: z.enum(['left', 'right', 'middle']).optional() }),
  z.strictObject({ type: z.literal('wheel'), x: z.number().finite(), y: z.number().finite(), deltaX: z.number().finite(), deltaY: z.number().finite() }),
  z.strictObject({ type: z.literal('key'), action: z.enum(['down', 'up', 'press']), key: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal('text'), text: z.string().max(10_000) }),
  z.strictObject({ type: z.literal('navigate'), url: z.string().min(1).max(4000) }),
]);
export const wsClientMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('subscribe'), orgId: idStr.optional(), runId: idStr.optional() }),
  z.strictObject({ type: z.literal('unsubscribe'), orgId: idStr.optional(), runId: idStr.optional() }),
  z.strictObject({ type: z.literal('ping') }),
]);
