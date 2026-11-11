import type { Embedder, Kernel, UtilityModel } from '../contracts/kernel.js';
import type { OrgService, WorkService } from '../contracts/org-work.js';
import type { MemoryService, SkillService } from '../contracts/services.js';
import { Consolidator } from './consolidate.js';
import { MemoryIndex } from './indexes.js';
import { Recall } from './recall.js';
import { Reflector } from './reflect.js';
import { Scorecards } from './scorecard.js';
import { MemoryStore } from './store.js';
import { createMemoryToolProvider } from './tools.js';

export interface MemoryOptionalDeps {
  skills?: Pick<SkillService, 'manage' | 'list'>;
  work?: Pick<WorkService, 'createIssue' | 'getIssue'>;
  org?: Pick<OrgService, 'listAgents' | 'listDepts' | 'leadOf'>;
}

export interface MemoryDeps extends MemoryOptionalDeps {
  utility: UtilityModel;
  embedder: Embedder;
}

/** MemoryService plus late binding for collaborators that are constructed after it. */
export interface BindableMemoryService extends MemoryService {
  bind(deps: MemoryOptionalDeps): void;
}

/**
 * Memory & learning context: typed long-term memory with hybrid retrieval,
 * post-run reflection, nightly consolidation, scorecards and the weekly review.
 */
export function createMemoryService(kernel: Kernel, deps: MemoryDeps): BindableMemoryService {
  const optional: MemoryOptionalDeps = { skills: deps.skills, work: deps.work, org: deps.org };
  const index = new MemoryIndex(kernel, deps.embedder);
  const store = new MemoryStore(kernel, index, deps.utility);
  const recall = new Recall(kernel, store);
  const reflector = new Reflector(kernel, store, deps.utility, () => optional.skills);
  const consolidator = new Consolidator(kernel, store, recall, deps.utility, () => optional.skills);
  const cards = new Scorecards(kernel, store, deps.utility, () => optional);

  const service: BindableMemoryService = {
    bind(next) {
      if (next.skills) optional.skills = next.skills;
      if (next.work) optional.work = next.work;
      if (next.org) optional.org = next.org;
    },
    write: (orgId, input, actor) => store.write(orgId, input, actor),
    search: (orgId, query) => store.search(orgId, query),
    recall: (orgId, agentId, task) => recall.recall(orgId, agentId, task),
    forget: (orgId, memoryId, actor) => store.forget(orgId, memoryId, actor),
    update: (orgId, memoryId, patch, actor) => store.update(orgId, memoryId, patch, actor),
    get: (orgId, memoryId) => store.get(orgId, memoryId),
    list: (orgId, filter) => store.list(orgId, filter),
    getProfileDoc: (orgId, agentId) => recall.getProfileDoc(orgId, agentId),
    setProfileDoc: (orgId, agentId, content, actor) => recall.setProfileDoc(orgId, agentId, content, actor),
    getOwnerModel: (orgId) => recall.getOwnerModel(orgId),
    setOwnerModel: (orgId, content, actor) => recall.setOwnerModel(orgId, content, actor),
    searchSessions: (orgId, agentId, text, limit) => recall.searchSessions(orgId, agentId, text, limit),
    reflect: (orgId, runId) => reflector.reflect(orgId, runId),
    consolidate: (orgId, agentId) => consolidator.consolidate(orgId, agentId),
    scorecard: (orgId, agentId, opts) => cards.scorecard(orgId, agentId, opts),
    snapshotScorecards: (orgId) => cards.snapshotScorecards(orgId),
    weeklyReview: (orgId) => cards.weeklyReview(orgId),
    toolProvider: () => provider,
  };
  const provider = createMemoryToolProvider(service, store);
  return service;
}

export { createUtilityModel } from './utility-model.js';
export { createEmbedder, LocalHashEmbedder, OpenAIEmbedder, cosine } from './embedder.js';
export { ensureMemoryIndexes } from './indexes.js';
export { createExternalBackend, type ExternalMemoryBackend, type ExternalHit, type BackendConfig } from './external.js';
export { scoreMemory, recencyDecay, PROFILE_TOKEN_BUDGET } from './ranking.js';
