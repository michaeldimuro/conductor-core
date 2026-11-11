import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../daemon/container.js';
import { CLI_PROVIDERS, type CliProvider, type ModelCatalogService, type ProviderAuthService } from '../../contracts/providers.js';
import { ConductorError, notFound } from '../../shared/errors.js';
import { body, param, query, resolveOrg } from '../http.js';
import { boolQ, optionalBody, secretRef } from '../schemas/common.js';

const providerOf = (raw: string): CliProvider => {
  if (!(CLI_PROVIDERS as readonly string[]).includes(raw)) throw notFound('provider', raw);
  return raw as CliProvider;
};
const orgQ = z.strictObject({ orgId: z.string().min(1).max(200).optional(), refresh: boolQ.optional() });
const modelsQ = z.strictObject({ orgId: z.string().min(1).max(200).optional(), authRef: secretRef.optional(), refresh: boolQ.optional() });
const startLogin = z.strictObject({
  method: z.enum(['subscription', 'console', 'token', 'device', 'browser', 'api_key']),
  /** Pasted credential: written to the secret store or the CLI's stdin, never logged or returned. */
  secret: z.string().min(1).max(4096).optional(),
  secretRef: secretRef.optional(),
  saveAs: secretRef.optional(),
  orgId: z.string().min(1).max(200).optional(),
  openBrowser: z.boolean().optional(),
});
const codeBody = z.strictObject({ code: z.string().min(1).max(2000) });
const forgetBody = z.strictObject({ auth: z.enum(['token', 'api_key']), ref: secretRef.optional(), orgId: z.string().min(1).max(200).optional() });

const missing = (what: string) => new ConductorError('unavailable', `${what} is not available in this daemon build`);

/**
 * Provider accounts and model catalogs (owner-only, like the rest of `/api/v1`):
 * how Conductor authenticates with the Claude Code / Codex CLIs, and what models each adapter offers.
 */
export function providerRoutes(app: FastifyInstance, s: Services): void {
  const auth = (): ProviderAuthService => s.providerAuth ?? (() => { throw missing('provider login'); })();
  const models = (): ModelCatalogService => s.models ?? (() => { throw missing('the model catalog'); })();
  const slugOf = (orgId: string | undefined): string | undefined => (orgId ? resolveOrg(s, orgId).slug : undefined);

  app.get('/providers', async (req) => {
    const qy = query(req, orgQ);
    return auth().statusAll({ ...(qy.orgId ? { orgSlug: slugOf(qy.orgId) } : {}), refresh: qy.refresh ?? false });
  });
  app.get('/providers/:provider', async (req) => {
    const qy = query(req, orgQ);
    return auth().status(providerOf(param(req, 'provider')), { ...(qy.orgId ? { orgSlug: slugOf(qy.orgId) } : {}), refresh: qy.refresh ?? false });
  });
  app.post('/providers/:provider/login', async (req) => {
    const provider = providerOf(param(req, 'provider'));
    const b = body(req, startLogin);
    const { orgId, ...rest } = b;
    const orgSlug = slugOf(orgId);
    return auth().startLogin(provider, { ...rest, ...(orgSlug ? { orgSlug } : {}) });
  });
  app.post('/providers/:provider/logout', async (req) => auth().logout(providerOf(param(req, 'provider'))));
  app.post('/providers/:provider/forget', async (req) => {
    const b = body(req, forgetBody);
    return auth().forgetCredential(providerOf(param(req, 'provider')), b.auth, b.ref, slugOf(b.orgId));
  });

  app.get('/login-sessions/:sessionId', async (req) => auth().getSession(param(req, 'sessionId')));
  app.post('/login-sessions/:sessionId/code', async (req) => auth().submitCode(param(req, 'sessionId'), body(req, codeBody).code));
  app.post('/login-sessions/:sessionId/cancel', async (req) => {
    body(req, optionalBody(z.strictObject({})));
    return auth().cancelSession(param(req, 'sessionId'));
  });

  app.get('/adapters/:adapterId/models', async (req) => {
    const qy = query(req, modelsQ);
    const orgSlug = slugOf(qy.orgId);
    return models().list(param(req, 'adapterId'), { ...(orgSlug ? { orgSlug } : {}), ...(qy.authRef ? { authRef: qy.authRef } : {}), refresh: qy.refresh ?? false });
  });
}
