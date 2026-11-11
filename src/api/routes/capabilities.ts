import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Services } from '../../daemon/container.js';
import type { BrowserProfile, Skill } from '../../contracts/rows.js';
import { OWNER } from '../../contracts/types.js';
import { invalid, isConductorError } from '../../shared/errors.js';
import { assertOrg, body, orgOf, param, query, resolveAgent } from '../http.js';
import * as q from '../schemas/capabilities.js';
import { optionalBody } from '../schemas/common.js';
import { memoryBackendRoutes } from './memory-backend.js';
import type { BrowserProfileDto, BrowserSessionDto, DocResponse, GrantResponse, Ok, PromoteSkillResponse, SkillDiffResponse, TakeoverLinkResponse } from '../types.js';

/** Skills, memory, connectors + grants, browser profiles and takeover sessions. */
export function capabilityRoutes(app: FastifyInstance, s: Services): void {
  const { skills, memory, connectors, browser } = s;
  const oid = (req: FastifyRequest): string => orgOf(s, req).id;

  /* ── Skills ── */
  /** Skill ids are global; one from another org behaves as not found (global-scope skills are visible to every org). */
  const skillOf = (req: FastifyRequest): Skill => {
    const orgId = oid(req);
    const id = param(req, 'skillId');
    let skill: Skill | null = null;
    try {
      skill = skills.get(id);
    } catch (e) {
      if (!isConductorError(e) || e.code !== 'not_found') throw e;
    }
    return assertOrg(skill, orgId, 'skill', id, { allowGlobal: true });
  };
  const scopeTarget = (orgId: string, scope: Skill['scope'], scopeId: string | null | undefined) => {
    if (scope === 'global') return { orgId: null, scopeId: null };
    if (scope === 'org') return { orgId, scopeId: orgId };
    if (!scopeId) throw invalid(`scopeId is required for ${scope} scope`);
    return { orgId, scopeId };
  };

  app.get('/orgs/:orgId/skills', async (req) => {
    const orgId = oid(req);
    const f = query(req, q.listSkillsQ);
    return skills.list({ ...f, orgId, includeGlobal: f.includeGlobal ?? true });
  });
  app.post('/orgs/:orgId/skills', async (req) => {
    const input = body(req, q.upsertSkill);
    const t = scopeTarget(oid(req), input.scope, input.scopeId);
    return skills.upsert(t.orgId, { ...input, scopeId: t.scopeId }, OWNER);
  });
  app.post('/orgs/:orgId/skills/import', async (req) => {
    const input = body(req, q.importSkill);
    const t = scopeTarget(oid(req), input.scope, input.scopeId);
    return skills.importSkill(t.orgId, { ...input, scopeId: t.scopeId }, OWNER);
  });
  app.get('/orgs/:orgId/skills/:skillId', async (req) => skills.read(skillOf(req).id));
  app.get('/orgs/:orgId/skills/:skillId/history', async (req) => skills.history(skillOf(req).id));
  app.get('/orgs/:orgId/skills/:skillId/diff', async (req): Promise<SkillDiffResponse> => {
    const { from, to } = query(req, q.skillDiffQ);
    return { diff: await skills.diff(skillOf(req).id, from, to) };
  });
  app.post('/orgs/:orgId/skills/:skillId/rollback', async (req) => skills.rollback(skillOf(req).id, body(req, q.skillRollback).toVersion, OWNER));
  app.post('/orgs/:orgId/skills/:skillId/evaluate', async (req) => skills.evaluate(skillOf(req).id));
  app.post('/orgs/:orgId/skills/:skillId/activate', async (req) => skills.activate(skillOf(req).id, OWNER, body(req, optionalBody(q.skillActivate))));
  app.post('/orgs/:orgId/skills/:skillId/promote', async (req): Promise<PromoteSkillResponse> => skills.promote(skillOf(req).id, body(req, q.skillPromote).toScope, OWNER));
  app.put('/orgs/:orgId/skills/:skillId/status', async (req) => skills.setStatus(skillOf(req).id, body(req, q.skillStatusBody).status, OWNER));

  /* ── Memory ── */
  app.get('/orgs/:orgId/memory', async (req) => memory.list(oid(req), query(req, q.listMemoryQ)));
  app.get('/orgs/:orgId/memory/search', async (req) => {
    const orgId = oid(req);
    const f = query(req, q.memorySearchQ);
    const agentId = f.agentId ? resolveAgent(s, orgId, f.agentId).id : undefined;
    return memory.search(orgId, { ...f, agentId });
  });
  app.post('/orgs/:orgId/memory', async (req) => memory.write(oid(req), { ...body(req, q.writeMemory), author: 'owner' }, OWNER));
  app.get('/orgs/:orgId/memory/:memoryId', async (req) => memory.get(oid(req), param(req, 'memoryId')));
  app.patch('/orgs/:orgId/memory/:memoryId', async (req) => memory.update(oid(req), param(req, 'memoryId'), body(req, q.updateMemory), OWNER));
  app.delete('/orgs/:orgId/memory/:memoryId', async (req): Promise<Ok> => {
    memory.forget(oid(req), param(req, 'memoryId'), OWNER);
    return { ok: true };
  });
  memoryBackendRoutes(app, s);
  app.get('/orgs/:orgId/owner-model', async (req): Promise<DocResponse> => ({ content: memory.getOwnerModel(oid(req)) }));
  app.put('/orgs/:orgId/owner-model', async (req): Promise<DocResponse> => {
    const orgId = oid(req);
    memory.setOwnerModel(orgId, body(req, q.docContent).content, OWNER);
    return { content: memory.getOwnerModel(orgId) };
  });
  app.get('/orgs/:orgId/sessions/search', async (req) => {
    const orgId = oid(req);
    const f = query(req, q.sessionSearchQ);
    const agentId = f.agentId ? resolveAgent(s, orgId, f.agentId).id : null;
    return memory.searchSessions(orgId, agentId, f.text, f.limit);
  });

  /* ── Connectors ── */
  app.get('/connector-catalog', async () => connectors.catalog());
  app.get('/orgs/:orgId/connectors', async (req) => connectors.list(oid(req)));
  app.post('/orgs/:orgId/connectors', async (req) => connectors.install(oid(req), body(req, q.installConnector), OWNER));
  app.post('/orgs/:orgId/connectors/from-template', async (req) => {
    const { templateId, ...input } = body(req, q.installFromTemplate);
    return connectors.installFromTemplate(oid(req), templateId, input, OWNER);
  });
  app.get('/orgs/:orgId/connectors/:connectorId', async (req) => connectors.get(oid(req), param(req, 'connectorId')));
  app.patch('/orgs/:orgId/connectors/:connectorId', async (req) => connectors.update(oid(req), param(req, 'connectorId'), body(req, q.updateConnector), OWNER));
  app.delete('/orgs/:orgId/connectors/:connectorId', async (req): Promise<Ok> => {
    await connectors.remove(oid(req), param(req, 'connectorId'), OWNER);
    return { ok: true };
  });
  app.get('/orgs/:orgId/connectors/:connectorId/tools', async (req) => connectors.discoverTools(oid(req), param(req, 'connectorId')));
  app.post('/orgs/:orgId/connectors/:connectorId/tools/:toolName/retrust', async (req): Promise<Ok> => {
    connectors.retrustTool(oid(req), param(req, 'connectorId'), param(req, 'toolName'), OWNER);
    return { ok: true };
  });
  app.get('/orgs/:orgId/connector-grants', async (req) => connectors.listGrants(oid(req), query(req, q.listGrantsQ)));
  app.put('/orgs/:orgId/connectors/:connectorId/grants/:agentId', async (req): Promise<GrantResponse> => {
    const orgId = oid(req);
    const agent = resolveAgent(s, orgId, param(req, 'agentId'));
    return connectors.grant(orgId, param(req, 'connectorId'), agent.id, body(req, optionalBody(q.grantBody)), OWNER);
  });
  app.delete('/orgs/:orgId/connectors/:connectorId/grants/:agentId', async (req): Promise<Ok> => {
    const orgId = oid(req);
    const agent = resolveAgent(s, orgId, param(req, 'agentId'));
    connectors.revokeGrant(orgId, param(req, 'connectorId'), agent.id, OWNER);
    return { ok: true };
  });

  /* ── Browser ── */
  /** Row + the settings that live beside the profile (engine, headed mode, 1Password vaults). */
  const profileDto = (p: BrowserProfile): BrowserProfileDto => ({ ...p, ...browser.profileSettings(p.orgId, p.id) });
  app.get('/orgs/:orgId/browser/profiles', async (req): Promise<BrowserProfileDto[]> => browser.listProfiles(oid(req)).map(profileDto));
  app.post('/orgs/:orgId/browser/profiles', async (req): Promise<BrowserProfileDto> => profileDto(browser.createProfile(oid(req), body(req, q.createProfile), OWNER)));
  app.patch('/orgs/:orgId/browser/profiles/:profileId', async (req): Promise<BrowserProfileDto> =>
    profileDto(browser.updateProfile(oid(req), param(req, 'profileId'), body(req, q.updateProfile), OWNER)));
  app.get('/orgs/:orgId/browser/sessions', async (req): Promise<BrowserSessionDto[]> =>
    // The share-token hash and the viewer id are credentials of the takeover flow; they never leave the daemon.
    browser.listSessions(oid(req), query(req, q.listSessionsQ)).map(({ tokenHash: _t, viewerId: _v, ...rest }) => rest));

  /**
   * Owner only: a fresh single-use takeover link for a session that is still
   * waiting. This is how a takeover is completed without a messaging gateway:
   * the previous link dies, and the new one is returned exactly once.
   */
  app.post('/orgs/:orgId/browser/sessions/:sessionId/share-link', async (req, reply): Promise<TakeoverLinkResponse> => {
    const { session, shareUrl, token } = await browser.reissueShare(oid(req), param(req, 'sessionId'), OWNER);
    reply.header('cache-control', 'no-store');
    return { sessionId: session.id, url: shareUrl, path: `/takeover/${token}`, expiresAt: session.expiresAt };
  });
}
