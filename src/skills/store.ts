import { and, asc, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { skills, skillVersions, type Scope } from '../db/schema/index.js';
import type { Kernel, UtilityModel } from '../contracts/kernel.js';
import type { OrgService } from '../contracts/org-work.js';
import type { ApprovalService, EvalRunner, SkillService } from '../contracts/services.js';
import type { Skill, SkillVersion, Agent } from '../contracts/rows.js';
import type { Actor } from '../contracts/types.js';
import { ConductorError, forbidden, invalid, isConductorError, notFound } from '../shared/errors.js';
import { resolveInside } from '../shared/paths.js';
import { assertSkillName } from './format.js';
import type { SkillGit } from './git.js';
import type { SkillWriter } from './writer.js';

export type SkillStatus = Skill['status'];

export interface SkillDeps {
  org: Pick<OrgService, 'resolveCapabilityRefs' | 'getAgent' | 'getOrg' | 'getDept' | 'leadOf'>;
  approvals: ApprovalService;
  utility: UtilityModel;
  evalRunner?: EvalRunner;
}

/** Everything the skills modules share. */
export interface SkillCtx {
  kernel: Kernel;
  deps: SkillDeps;
  store: SkillStore;
  git: SkillGit;
  writer: SkillWriter;
  /** runId → skill ids loaded through `load_skill` (usage attribution). */
  loaded: Map<string, Set<string>>;
}

export interface ScopeTarget {
  orgId: string | null;
  scope: Scope;
  scopeId: string | null;
  name: string;
  /** Absolute skill folder: <scopeDir>/<name>. */
  dir: string;
}

export type ListFilter = Parameters<SkillService['list']>[0];

/** `human`, `agent:<id>` or `system` — stored on rows and used as the commit author. */
export function authorOf(actor: Actor): string {
  if (actor.kind === 'agent') {
    if (!actor.id) throw invalid('agent actor requires an id');
    return `agent:${actor.id}`;
  }
  return actor.kind === 'system' ? 'system' : 'human';
}

export const authorAgentId = (author: string): string | null => (author.startsWith('agent:') ? author.slice('agent:'.length) : null);

export class SkillStore {
  constructor(private readonly kernel: Kernel, private readonly deps: SkillDeps) {}

  get(skillId: string): Skill {
    const row = this.kernel.db.select().from(skills).where(eq(skills.id, skillId)).get();
    if (!row) throw notFound('skill', skillId);
    return row;
  }

  /** Org-scoped lookup: a skill of another org behaves as not found; global skills are visible. */
  getVisible(orgId: string, skillId: string): Skill {
    const row = this.kernel.db
      .select()
      .from(skills)
      .where(and(eq(skills.id, skillId), or(eq(skills.orgId, orgId), isNull(skills.orgId))))
      .get();
    if (!row) throw notFound('skill', skillId);
    return row;
  }

  findInScope(scope: Scope, scopeId: string | null, name: string): Skill | null {
    const row = this.kernel.db
      .select()
      .from(skills)
      .where(and(eq(skills.scope, scope), scopeId === null ? isNull(skills.scopeId) : eq(skills.scopeId, scopeId), eq(skills.name, name)))
      .get();
    return row ?? null;
  }

  list(filter: ListFilter): Skill[] {
    const where: SQL[] = [];
    if (filter.orgId === null) where.push(isNull(skills.orgId));
    else if (filter.orgId !== undefined) {
      const mine = eq(skills.orgId, filter.orgId);
      const withGlobal = filter.includeGlobal ? or(mine, isNull(skills.orgId)) : mine;
      if (withGlobal) where.push(withGlobal);
    }
    if (filter.scope) where.push(eq(skills.scope, filter.scope));
    if (filter.scopeId === null) where.push(isNull(skills.scopeId));
    else if (filter.scopeId !== undefined) where.push(eq(skills.scopeId, filter.scopeId));
    if (filter.status) where.push(eq(skills.status, filter.status));
    return this.kernel.db
      .select()
      .from(skills)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(skills.name), asc(skills.id))
      .all();
  }

  /** Active skills in an agent's inheritance chain (own, department, org) plus the named global ones. */
  activeCandidates(orgId: string, agent: Agent, globalNames: string[]): Skill[] {
    const db = this.kernel.db;
    const scoped = db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.orgId, orgId),
          eq(skills.status, 'active'),
          or(
            and(eq(skills.scope, 'agent'), eq(skills.scopeId, agent.id)),
            and(eq(skills.scope, 'dept'), eq(skills.scopeId, agent.deptId)),
            and(eq(skills.scope, 'org'), eq(skills.scopeId, orgId)),
          ),
        ),
      )
      .all();
    if (globalNames.length === 0) return scoped;
    const global = db
      .select()
      .from(skills)
      .where(and(eq(skills.scope, 'global'), isNull(skills.orgId), eq(skills.status, 'active'), inArray(skills.name, globalNames)))
      .all();
    return [...scoped, ...global];
  }

  versions(skillId: string): SkillVersion[] {
    return this.kernel.db.select().from(skillVersions).where(eq(skillVersions.skillId, skillId)).orderBy(desc(skillVersions.version)).all();
  }

  version(skillId: string, version: number): SkillVersion | null {
    const row = this.kernel.db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)))
      .get();
    return row ?? null;
  }

  /** Validate (orgId, scope, scopeId) and compute the skill folder for a name. */
  target(orgId: string | null, scope: Scope, scopeId: string | null, name: string): ScopeTarget {
    const skillName = assertSkillName(name);
    const paths = this.kernel.paths;
    if (scope === 'global') {
      if (orgId !== null || scopeId !== null) throw invalid('global skills take no org or scope id');
      return { orgId: null, scope, scopeId: null, name: skillName, dir: resolveInside(paths.globalSkills, skillName) };
    }
    if (!orgId) throw invalid(`an org id is required for ${scope}-scoped skills`);
    const org = this.deps.org.getOrg(orgId);
    if (scope === 'org') {
      if (scopeId !== null && scopeId !== orgId) throw invalid('scopeId of an org-scoped skill must be the org id');
      return { orgId, scope, scopeId: orgId, name: skillName, dir: resolveInside(paths.orgSkills(org.slug), skillName) };
    }
    if (!scopeId) throw invalid(`scopeId is required for ${scope}-scoped skills`);
    if (scope === 'dept') {
      const dept = this.deps.org.getDept(orgId, scopeId);
      return { orgId, scope, scopeId: dept.id, name: skillName, dir: resolveInside(paths.deptSkills(org.slug, dept.slug), skillName) };
    }
    const agent = this.deps.org.getAgent(orgId, scopeId);
    return { orgId, scope, scopeId: agent.id, name: skillName, dir: resolveInside(paths.agentSkills(org.slug, agent.slug), skillName) };
  }

  /** The acting agent's row, provided it belongs to the skill's org; null for a foreign/unknown agent. */
  actorAgent(orgId: string | null, actor: Actor): Agent | null {
    if (actor.kind !== 'agent' || !actor.id || !orgId) return null;
    try {
      return this.deps.org.getAgent(orgId, actor.id);
    } catch (e) {
      if (isConductorError(e) && e.code === 'not_found') return null;
      throw e;
    }
  }

  /**
   * PRD "Who can edit": global — owner only; org — owner, lead agents;
   * department — its lead agent; agent — the agent itself. Humans and the
   * system may edit everything.
   */
  canEdit(scope: { orgId: string | null; scope: Scope; scopeId: string | null }, actor: Actor): boolean {
    if (actor.kind !== 'agent') return true;
    const agent = this.actorAgent(scope.orgId, actor);
    if (!agent) return false;
    if (scope.scope === 'agent') return scope.scopeId === agent.id;
    if (scope.scope === 'dept') return scope.scopeId !== null && this.deps.org.leadOf(agent.orgId, scope.scopeId)?.id === agent.id;
    if (scope.scope === 'org') return this.deps.org.leadOf(agent.orgId, agent.deptId)?.id === agent.id;
    return false;
  }

  assertCanEdit(scope: { orgId: string | null; scope: Scope; scopeId: string | null }, actor: Actor): void {
    if (!this.canEdit(scope, actor)) throw forbidden(`agents may not modify ${scope.scope}-scoped skills they do not own`);
  }
}

export function policyDenied(message: string, details?: Record<string, unknown>): ConductorError {
  return new ConductorError('policy_denied', message, details);
}
