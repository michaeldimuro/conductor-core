import { describe, expect, it } from 'vitest';
import { chainSize, holdingUp, plain } from '../../ui/src/lib/chain.js';

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
