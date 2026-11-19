import { z } from 'zod';
import { invalid } from '../../shared/errors.js';
import type { ToolCallContext } from '../../contracts/tools.js';
import { formatWait } from '../waits.js';
import { resolveAgent, type ToolEnv } from './support.js';

/** The fields an agent uses to say what a blocked issue waits on (update_issue, report_progress). */
export const waitFields = {
  waitingOn: z.enum(['owner', 'agent', 'date', 'approval', 'external']).optional().describe(
    'Required with status "blocked": what the issue waits on. "owner" ONLY when the owner personally must do something (answer a question, ' +
    'run a step only they can, supply a credential); a pending approval is "approval", not "owner". "agent" when another agent acts next ' +
    '(prefer hand_off when the issue itself should move to them). "date" when nothing can happen before a time. "external" for something ' +
    'outside the company (a reply, a first customer). Only "owner" waits are shown to the owner; the others reopen or are chased automatically.',
  ),
  ownerAsk: z.string().trim().min(1).max(300).optional().describe(
    'With waitingOn "owner": one plain sentence telling the owner exactly what to do, e.g. "Run Step A of the Stripe script and post the VersionId here". ' +
    'No ids, SHAs or jargon; details go in blockedReason.',
  ),
  waitingForAgent: z.string().min(1).max(200).optional().describe('With waitingOn "agent": id or slug of the agent who acts next.'),
  waitUntil: z.iso.datetime().optional().describe('With waitingOn "date": ISO time (UTC) the work can resume. The issue reopens and you are woken then.'),
  waitingForApprovals: z.array(z.string().min(1).max(200)).min(1).max(20).optional().describe('With waitingOn "approval": the approval ids. The issue reopens once all are decided.'),
};

export interface WaitArgs {
  waitingOn?: 'owner' | 'agent' | 'date' | 'approval' | 'external';
  ownerAsk?: string;
  waitingForAgent?: string;
  waitUntil?: string;
  waitingForApprovals?: string[];
}

/** The `blockedReason` for an agent's block, or an error that tells it what is missing. */
export function blockedReasonFor(env: ToolEnv, ctx: ToolCallContext, args: WaitArgs, note: string): string {
  switch (args.waitingOn) {
    case 'owner':
      if (!args.ownerAsk) throw invalid('waitingOn "owner" needs ownerAsk: one plain sentence telling the owner exactly what to do');
      return formatWait({ kind: 'owner', ask: args.ownerAsk, detail: note });
    case 'agent': {
      if (!args.waitingForAgent) throw invalid('waitingOn "agent" needs waitingForAgent (the agent who acts next)');
      return formatWait({ kind: 'agent', agent: resolveAgent(env, ctx, args.waitingForAgent).slug, note });
    }
    case 'date': {
      const until = args.waitUntil ? Date.parse(args.waitUntil) : NaN;
      if (!Number.isFinite(until)) throw invalid('waitingOn "date" needs waitUntil (an ISO time, UTC)');
      return formatWait({ kind: 'until', until, note });
    }
    case 'approval':
      if (!args.waitingForApprovals?.length) throw invalid('waitingOn "approval" needs waitingForApprovals (the approval ids)');
      return formatWait({ kind: 'approval', approvalIds: args.waitingForApprovals, note });
    case 'external':
      return formatWait({ kind: 'external', note });
    default:
      throw invalid('status "blocked" needs waitingOn: owner, agent, date, approval or external');
  }
}
