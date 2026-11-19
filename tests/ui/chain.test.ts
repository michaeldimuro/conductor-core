import { describe, expect, it } from 'vitest';
import { blockedOnOwner, chainSize, holdingUp, plain } from '../../ui/src/lib/chain.js';

const node = (id: string, blockedBy: string[] = [], parentIssueId: string | null = null) => ({ id, blockedBy, parentIssueId });

describe('what a task is holding up', () => {
  it('counts explicit blockers and the waiting parent, once', () => {
    const open = [node('parent'), node('a', [], 'parent'), node('b', ['a']), node('c', ['a', 'b'])];
    expect(holdingUp(node('a', [], 'parent'), open).map((i) => i.id).sort()).toEqual(['b', 'c', 'parent']);
    // a → b → c, and a → parent: three distinct tasks wait, c is reached twice but counted once.
    expect(chainSize('a', 'parent', open)).toBe(3);
  });

  it('survives cycles and ignores closed work', () => {
    const open = [node('x', ['y']), node('y', ['x'])];
    expect(chainSize('x', null, open)).toBe(2);
    expect(chainSize('z', null, open)).toBe(0);
  });
});

describe('plain', () => {
  it('turns markdown into one readable line and clips it', () => {
    expect(plain('## Done\n\n- Posted to **#growth** via [Slack](https://x)\n```js\ncode()\n```')).toBe('Done Posted to #growth via Slack');
    expect(plain('a'.repeat(300), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});

describe('blocked work that is on the owner', () => {
  const none = { approvalIssues: new Set<string>(), takeoverIssues: new Set<string>() };
  const blocked = (id: string, blockedReason: string | null, blockedBy: string[] = []) => ({ id, blockedReason, blockedBy });

  it('leaves out a parent whose children other agents are still doing', () => {
    expect(blockedOnOwner(blocked('p', 'waiting_on_children'), [node('p'), node('c', [], 'p')], none)).toBe(false);
    // Every child closed but the parent never woke: nothing else will move it.
    expect(blockedOnOwner(blocked('p', 'waiting_on_children'), [node('p')], none)).toBe(true);
  });

  it('leaves out work still waiting on open blocker tasks', () => {
    expect(blockedOnOwner(blocked('x', 'waiting on #4', ['y']), [node('x'), node('y')], none)).toBe(false);
    expect(blockedOnOwner(blocked('x', 'waiting on #4', ['y']), [node('x')], none)).toBe(true);
  });

  it('leaves out parks whose decision already has its own card', () => {
    const decided = { approvalIssues: new Set(['a']), takeoverIssues: new Set(['t']) };
    expect(blockedOnOwner(blocked('a', 'awaiting_approval'), [], decided)).toBe(false);
    expect(blockedOnOwner(blocked('t', 'needs_human'), [], decided)).toBe(false);
    expect(blockedOnOwner(blocked('a', 'awaiting_approval'), [], none)).toBe(true);
  });

  it('keeps blocks only the owner can clear', () => {
    for (const reason of ['budget', 'repeated_failures', 'escalated_to_owner', 'Need the API key for Stripe', null]) {
      expect(blockedOnOwner(blocked('x', reason), [node('x')], none)).toBe(true);
    }
  });
});
