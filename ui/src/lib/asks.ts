import { parseWait } from '../../../src/work/waits.js';

/**
 * What a blocked card in Needs you asks the owner to do, in plain words, plus the
 * agent's own notes (behind "Details") and the label of the button that hands the
 * work back. Pure, so it tests without a browser.
 */
export interface OwnerAsk {
  ask: string;
  /** The agent's fuller note; shown collapsed. Empty when there is none. */
  detail: string;
  /** Primary button when the owner did the thing (no reply typed). */
  done: string;
  /** Posted on the thread with that button, so the agent is woken knowing why. */
  doneNote: string;
  /** Show the latest comment as the detail (the escalation note lives there, not in the reason). */
  detailFromThread?: boolean;
}

export function ownerAsk(blockedReason: string | null | undefined, agent: string): OwnerAsk {
  const w = parseWait(blockedReason);
  const resume = { done: `Done, tell ${agent} to continue`, doneNote: 'Done. Please continue.' };
  if (w.kind === 'owner') return { ask: w.ask || `Read what ${agent} needs below, then reply.`, detail: w.detail, ...resume };
  if (w.kind === 'legacy') {
    return { ask: `${agent} stopped and wrote what it needs below. Do it or reply, then tell ${agent} to continue.`, detail: w.text, ...resume };
  }
  if (w.kind === 'system') {
    switch (w.reason) {
      case 'budget':
        return { ask: `${agent} hit a budget cap. Raise it on the Costs page, then continue.`, detail: w.note, done: 'Budget raised, continue', doneNote: 'Budget raised. Please continue.' };
      case 'repeated_failures':
        return { ask: `${agent} failed on this several times in a row. Open the task, reply with what to change, then let it try again.`, detail: w.note, done: 'Try again', doneNote: 'Please try again.' };
      case 'escalated_to_owner':
        return { ask: 'No one on the team could move this forward. Reply with what should happen, or open the task to reassign or cancel it.', detail: w.note, detailFromThread: true, done: `Tell ${agent} to continue`, doneNote: 'Please continue.' };
      case 'awaiting_approval':
        return { ask: `The approval this waited on has been decided. Continue so ${agent} picks it back up.`, detail: w.note, done: 'Continue', doneNote: 'The approval is decided. Please continue.' };
      case 'needs_human':
        return { ask: `The sign-in this waited on has ended. Continue so ${agent} picks it back up.`, detail: w.note, done: 'Continue', doneNote: 'Please continue.' };
      case 'waiting_on_children':
        return { ask: `All its sub-tasks are finished. Continue so ${agent} wraps it up.`, detail: w.note, done: 'Continue', doneNote: 'All sub-tasks are finished. Please wrap this up.' };
    }
  }
  // Other waits do not reach Needs you; if one is shown anyway (its blockers closed), hand it back.
  return { ask: `${agent} was waiting on something that is no longer open. Continue so it picks the work back up.`, detail: 'note' in w ? w.note : '', ...resume };
}
