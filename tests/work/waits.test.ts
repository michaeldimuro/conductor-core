import { describe, expect, it } from 'vitest';
import { formatWait, parseWait } from '../../src/work/waits.js';
import { blockedOnOwner } from '../../src/work/owner-blocks.js';

describe('what a blocked issue waits on', () => {
  it('round-trips every structured wait', () => {
    const until = Date.parse('2026-11-19T15:00:00Z');
    expect(parseWait(formatWait({ kind: 'owner', ask: 'Post the VersionId', detail: 'Step A, rev 4.\n\nThen Riley merges.' })))
      .toEqual({ kind: 'owner', ask: 'Post the VersionId', detail: 'Step A, rev 4.\n\nThen Riley merges.' });
    expect(parseWait(formatWait({ kind: 'agent', agent: 'riley', note: 'Release first.' }))).toEqual({ kind: 'agent', agent: 'riley', note: 'Release first.' });
    expect(parseWait(formatWait({ kind: 'until', until, note: 'Window: 15:00Z.' }))).toEqual({ kind: 'until', until, note: 'Window: 15:00Z.' });
    expect(parseWait(formatWait({ kind: 'approval', approvalIds: ['apr_1', 'apr_2'], note: '' }))).toEqual({ kind: 'approval', approvalIds: ['apr_1', 'apr_2'], note: '' });
    expect(parseWait(formatWait({ kind: 'external', note: 'Moderators reply.' }))).toEqual({ kind: 'external', note: 'Moderators reply.' });
  });

  it('reads the runtime parks and older free text', () => {
    expect(parseWait('budget')).toEqual({ kind: 'system', reason: 'budget', note: '' });
    expect(parseWait('needs_human: login wall')).toEqual({ kind: 'system', reason: 'needs_human', note: 'login wall' });
    expect(parseWait('Waiting on Riley: the release.')).toEqual({ kind: 'legacy', text: 'Waiting on Riley: the release.' });
    expect(parseWait(null)).toEqual({ kind: 'legacy', text: '' });
  });
});

describe('which blocks reach the owner', () => {
  const none = { approvalIssues: new Set<string>(), takeoverIssues: new Set<string>() };
  const on = (blockedReason: string) => blockedOnOwner({ id: 'x', blockedReason, blockedBy: [] }, [], none);

  it('shows owner asks and parks only the owner can clear', () => {
    expect(on(formatWait({ kind: 'owner', ask: 'Post the VersionId', detail: '' }))).toBe(true);
    for (const reason of ['budget', 'repeated_failures', 'escalated_to_owner']) expect(on(reason)).toBe(true);
  });

  it('leaves out waits something else ends', () => {
    expect(on(formatWait({ kind: 'agent', agent: 'riley', note: '' }))).toBe(false);
    expect(on(formatWait({ kind: 'until', until: 0, note: '' }))).toBe(false);
    expect(on(formatWait({ kind: 'approval', approvalIds: ['apr_1'], note: '' }))).toBe(false);
    expect(on(formatWait({ kind: 'external', note: '' }))).toBe(false);
  });
});
