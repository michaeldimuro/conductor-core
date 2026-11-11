import { z } from 'zod';
import { CONNECTOR_KINDS, type ConnectorKind } from '../db/schema/capabilities.js';
import { invalid } from '../shared/errors.js';
import { redact } from '../shared/util.js';
import { TOOL_NS_SEP } from '../contracts/tools.js';
import { CALL_TOOL, FIND_TOOLS, META_SERVER } from './types.js';

const secretRef = z.object({ secretRef: z.string().min(1).max(200) }).strict();
const strOrRef = z.union([z.string().min(1), secretRef]);
const headerMap = z.record(z.string().min(1), strOrRef);

const stdioConfig = z.looseObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), strOrRef).optional(),
  cwd: z.string().min(1).optional(),
});

const httpAuth = z.object({
  type: z.enum(['bearer', 'oauth', 'none']),
  /** Secret name (default `token` for bearer, `access_token` for oauth). */
  secretRef: z.string().min(1).optional(),
  /** OAuth client id used when building the authorization URL. */
  clientId: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
});

const httpConfig = z.looseObject({
  url: strOrRef,
  headers: headerMap.optional(),
  auth: httpAuth.optional(),
  transport: z.enum(['auto', 'streamable', 'sse']).optional(),
});

const composioConfig = z
  .looseObject({
    mcpUrl: strOrRef.optional(),
    toolkit: z.string().min(1).optional(),
    serverId: z.string().min(1).optional(),
    baseUrl: z.url().optional(),
    /** Fixed entity id; otherwise the `entity_id` secret under the grant/connector auth ref, else per entityMode. */
    entityId: z.string().min(1).optional(),
    entityMode: z.enum(['org', 'agent']).optional(),
    apiKeyRef: z.string().min(1).optional(),
    headers: headerMap.optional(),
  })
  .refine((c) => c.mcpUrl !== undefined || c.toolkit !== undefined || c.serverId !== undefined, {
    message: 'composio config needs mcpUrl, serverId or toolkit',
  });

const arcadeConfig = z
  .looseObject({
    mcpUrl: strOrRef.optional(),
    gateway: z.string().min(1).optional(),
    toolkit: z.string().min(1).optional(),
    baseUrl: z.url().optional(),
    userId: z.string().min(1).optional(),
    userMode: z.enum(['org', 'agent']).optional(),
    apiKeyRef: z.string().min(1).optional(),
    headers: headerMap.optional(),
  })
  .refine((c) => c.mcpUrl !== undefined || c.gateway !== undefined || c.toolkit !== undefined, {
    message: 'arcade config needs mcpUrl, gateway or toolkit',
  });

const openapiAuth = z.object({
  type: z.enum(['bearer', 'apiKey']),
  in: z.enum(['header', 'query']).optional(),
  /** Header or query parameter name for apiKey auth. */
  name: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
});

const openapiConfig = z
  .looseObject({
    spec: z.record(z.string(), z.unknown()).optional(),
    specPath: z.string().min(1).optional(),
    specUrl: z.url().optional(),
    /** Must be one of the spec's servers. */
    baseUrl: z.url().optional(),
    auth: openapiAuth.optional(),
    headers: headerMap.optional(),
  })
  .refine((c) => [c.spec, c.specPath, c.specUrl].filter((v) => v !== undefined).length === 1, {
    message: 'openapi config needs exactly one of spec, specPath or specUrl',
  });

const builtinConfig = z.looseObject({ server: z.string().min(1) });

export type StdioConfig = z.infer<typeof stdioConfig>;
export type HttpConfig = z.infer<typeof httpConfig>;
export type ComposioConfig = z.infer<typeof composioConfig>;
export type ArcadeConfig = z.infer<typeof arcadeConfig>;
export type OpenApiConfig = z.infer<typeof openapiConfig>;
export type BuiltinConfig = z.infer<typeof builtinConfig>;

const CONFIG_SCHEMAS = {
  mcp_stdio: stdioConfig,
  mcp_http: httpConfig,
  composio: composioConfig,
  arcade: arcadeConfig,
  openapi: openapiConfig,
  builtin: builtinConfig,
} satisfies Record<ConnectorKind, z.ZodType>;

export function parseWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw invalid(`invalid ${what}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  }
  return r.data;
}

export function parseConfig<K extends ConnectorKind>(kind: K, config: unknown): z.infer<(typeof CONFIG_SCHEMAS)[K]> {
  return parseWith(CONFIG_SCHEMAS[kind] as z.ZodType<z.infer<(typeof CONFIG_SCHEMAS)[K]>>, config, `${kind} config`);
}

/** Config is stored in the DB, so it must never carry a credential-looking literal. */
export function assertNoSecrets(config: Record<string, unknown>): void {
  const raw = JSON.stringify(config);
  if (redact(raw) !== raw) {
    throw invalid('connector config appears to contain a secret; store it in the secret store and use { secretRef }');
  }
}

/** Connector names become the `<name>__<tool>` prefix agents see. */
const connectorName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/, 'must be 1-48 chars of letters, digits, "-" or "_"')
  .refine((n) => !n.includes(TOOL_NS_SEP), `must not contain "${TOOL_NS_SEP}"`)
  .refine((n) => ![META_SERVER, FIND_TOOLS, CALL_TOOL].includes(n), 'is reserved');

const authRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,180}$/, 'invalid secret ref').refine((r) => !r.includes('..'), 'invalid secret ref');
const allowlist = z.array(z.string().min(1)).max(2000).nullable();
const toolPolicy = z.enum(['allowed', 'ask', 'off']);

export const installSchema = z.object({
  name: connectorName,
  kind: z.enum(CONNECTOR_KINDS),
  scope: z.enum(['org', 'dept']).optional(),
  scopeId: z.string().min(1).nullable().optional(),
  config: z.record(z.string(), z.unknown()),
  authRef: authRef.nullable().optional(),
  toolAllowlist: allowlist.optional(),
  templateId: z.string().min(1).nullable().optional(),
});

export const updateSchema = installSchema.partial().extend({ status: z.enum(['active', 'disabled', 'error']).optional() });

export const grantSchema = z.object({
  toolAllowlist: allowlist.optional(),
  toolPolicies: z.record(z.string().min(1), toolPolicy).optional(),
  defaultPolicy: toolPolicy.optional(),
  authRef: authRef.nullable().optional(),
});

export const templateInstallSchema = z.object({
  name: connectorName.optional(),
  scope: z.enum(['org', 'dept']).optional(),
  scopeId: z.string().min(1).nullable().optional(),
  secrets: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), z.string().min(1)).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const idSchema = z.string().min(1).max(200);
