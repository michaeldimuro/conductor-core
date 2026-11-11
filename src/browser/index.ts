import type { Kernel } from '../contracts/kernel.js';
import type { OrgService } from '../contracts/org-work.js';
import type { ApprovalService, BrowserService, RunControl } from '../contracts/services.js';
import type { BuiltinToolProvider } from '../contracts/tools.js';
import { BrowserEngine } from './engine.js';
import { ProfileStore, type CreateProfileInput, type UpdateProfileInput } from './profiles.js';
import { ActionGate } from './sensitive.js';
import { TakeoverManager } from './takeover.js';
import { createToolProvider } from './tools.js';

export interface BrowserServiceDeps {
  approvals: ApprovalService;
  runControl: RunControl;
  org: Pick<OrgService, 'getAgent' | 'getOrg' | 'getDept'>;
  /** Base URL the owner reaches the daemon on (tunnel address); share links are `<base>/takeover/<token>`. */
  shareBaseUrl: () => string;
  /** Headless by default; takeover works headless via CDP screencast. */
  headless?: boolean;
}

/**
 * Browser Service: persistent per-agent (or department-shared) Chromium
 * profiles leased to one run at a time, the `conductor-browser` tool server,
 * and human takeover over one-time signed share links.
 */
export function createBrowserService(kernel: Kernel, deps: BrowserServiceDeps): BrowserService {
  const profiles = new ProfileStore(kernel, deps.org);
  const engine = new BrowserEngine(kernel, profiles, { headless: deps.headless ?? true });
  const takeover = new TakeoverManager(kernel, engine, { runControl: deps.runControl, org: deps.org, shareBaseUrl: deps.shareBaseUrl });
  const provider: BuiltinToolProvider = createToolProvider(
    { kernel, engine, gate: new ActionGate(kernel, deps.approvals), org: deps.org },
    takeover,
  );

  const endRun = async (runId: string): Promise<void> => {
    await takeover.cancelForRun(runId);
    await engine.close(runId);
  };

  return {
    ensureProfile: (orgId, agentId) => profiles.ensure(orgId, agentId),
    // Both accept an optional `engine` ({kind:'chromium'} | {kind:'channel',channel:'chrome'} | {kind:'cdp',endpoint}).
    createProfile: (orgId, input, actor) => profiles.create(orgId, input as CreateProfileInput, actor),
    updateProfile: (orgId, profileId, patch, actor) => profiles.update(orgId, profileId, patch as UpdateProfileInput, actor),
    listProfiles: (orgId) => profiles.list(orgId),
    toolProvider: () => provider,

    listSessions: (orgId, filter) => takeover.list(orgId, filter),
    createTakeover: (input) => takeover.create(input),
    claimShare: (token, viewerId) => takeover.claim(token, viewerId),
    attachViewer: (sessionId, viewerId, io) => takeover.attach(sessionId, viewerId, io),
    handBack: (sessionId, viewerId) => takeover.handBack(sessionId, viewerId),

    endRun,
    recoverLeases(liveRunIds) {
      const live = new Set(liveRunIds);
      // Contexts this process still holds for runs that are gone: close them (which also releases their lease).
      for (const runId of engine.liveRunIds()) {
        if (!live.has(runId)) void endRun(runId).catch((e) => kernel.log.warn({ err: String(e), runId }, 'could not close browser of dead run'));
      }
      profiles.recoverLeases(liveRunIds);
      takeover.cancelOrphans(liveRunIds);
    },
    async shutdown() {
      await takeover.cancelAll();
      await engine.closeAll();
    },
  };
}

export type { EngineConfig } from './profiles.js';
