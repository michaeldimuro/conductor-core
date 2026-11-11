import { z } from 'zod';
import { CONNECTOR_KINDS } from '../db/schema/capabilities.js';
import { MEMORY_KINDS, MEMORY_SCOPES } from '../db/schema/memory.js';

/** Shapes of an org bundle's parts. A bundle is untrusted input: everything is validated before use. */

const record = z.record(z.string(), z.unknown());
const ref = z.string().min(1).max(200).nullish();
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const toolName = z.string().min(1).max(300);
const policy = z.enum(['allowed', 'ask', 'off']);

export const skillSchema = z.object({
  scope: z.enum(['org', 'dept', 'agent']),
  scopeSlug: z.string().max(64).nullable(),
  name: z.string().regex(SKILL_NAME_RE, 'invalid skill name'),
  files: z.record(z.string().min(1).max(300), z.string().max(1024 * 1024)),
  status: z.string().max(40).optional(),
  author: z.string().max(40).optional(),
});

export const envelopeSchema = z.object({
  format: z.literal('conductor-org-bundle'),
  version: z.literal(1),
  org: record,
  departments: z.array(record).max(200),
  agents: z.array(record).max(1000),
  goals: z.array(record).max(2000).default([]),
  playbooks: z.array(record).max(500).default([]),
  connectors: z.array(record).max(500).default([]),
  skills: z.array(skillSchema).max(500).default([]),
  memories: z.array(record).max(20_000).default([]),
  projects: z.array(record).max(1000).default([]),
  grants: z.array(record).max(20_000).default([]),
  profileDocs: z.array(record).max(1000).default([]),
  ownerModel: z.string().max(512 * 1024).default(''),
});

export const goalSchema = z.object({
  id: ref,
  parentGoalId: ref,
  level: z.enum(['org', 'dept', 'agent']).default('org'),
  deptId: ref,
  ownerAgentId: ref,
  title: z.string().trim().min(1).max(500),
  description: z.string().max(8000).default(''),
  successMetric: z.string().max(2000).default(''),
  target: z.string().max(2000).default(''),
  weight: z.number().finite().nonnegative().default(1),
  due: z.number().int().nullish(),
  status: z.enum(['proposed', 'active', 'achieved', 'abandoned']).default('active'),
});

export const playbookSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(8000).default(''),
  process: z.enum(['sequential', 'hierarchical']).default('sequential'),
  managerAgentId: ref,
  steps: z
    .array(z.object({
      title: z.string().max(500),
      description: z.string().max(8000).default(''),
      expectedOutput: z.string().max(8000).default(''),
      agentRole: z.string().max(200).nullish(),
      agentId: ref,
    }))
    .max(100)
    .default([]),
});

export const projectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  goalId: ref,
  budgetUsd: z.number().finite().nonnegative().nullish(),
  status: z.enum(['active', 'archived']).default('active'),
  /** Relative to the org directory; never absolute. */
  workspaceRel: z.string().min(1).max(1000).nullish(),
});

export const memorySchema = z.object({
  scope: z.enum(MEMORY_SCOPES),
  scopeId: z.string().min(1),
  kind: z.enum(MEMORY_KINDS),
  content: z.string().min(1).max(100_000),
  entity: z.string().max(500).nullish(),
  taskType: z.string().max(200).nullish(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
});

export const connectorSchema = z.object({
  id: z.string().min(1).max(200),
  scope: z.enum(['org', 'dept']).default('org'),
  scopeId: ref,
  kind: z.enum(CONNECTOR_KINDS),
  name: z.string().trim().min(1).max(200),
  templateId: z.string().max(200).nullish(),
  config: record.default({}),
  toolAllowlist: z.array(toolName).max(2000).nullish(),
  status: z.string().max(40).optional(),
  needsCredential: z.boolean().default(false),
});

export const grantSchema = z.object({
  connectorId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  toolAllowlist: z.array(toolName).max(2000).nullish(),
  policies: z.array(z.object({ tool: toolName, policy })).max(2000).default([]),
  defaultPolicy: policy.default('allowed'),
  needsCredential: z.boolean().default(false),
});

export const profileDocSchema = z.object({
  agentId: z.string().min(1).max(200),
  content: z.string().min(1).max(512 * 1024),
});

/** Connector-id lists carried by the org, its departments and its agents (remapped after connectors are re-installed). */
export const idList = z.array(z.string().min(1).max(200)).max(500).catch([]);
