import { describe, expect, it } from 'vitest';
import { ownerAsk } from '../../ui/src/lib/asks.js';
import { formatWait } from '../../src/work/waits.js';

describe('what a blocked card asks the owner', () => {
  it('leads with the agent\'s plain ask and keeps its notes as details', () => {
    const a = ownerAsk(formatWait({ kind: 'owner', ask: 'Run Step A and post the VersionId here', detail: 'Rev 4 script, then Riley merges #46.' }), 'Riley');
    expect(a).toMatchObject({ ask: 'Run Step A and post the VersionId here', detail: 'Rev 4 script, then Riley merges #46.', done: 'Done, tell Riley to continue' });
  });

  it('explains the runtime\'s own parks in words', () => {
    expect(ownerAsk('budget', 'Ada').ask).toMatch(/budget cap/);
    expect(ownerAsk('repeated_failures', 'Ada').done).toBe('Try again');
    expect(ownerAsk('escalated_to_owner', 'Ada')).toMatchObject({ detailFromThread: true });
  });

  it('turns older free-text blocks into an instruction with the text as details', () => {
    const a = ownerAsk('The owner reruns Step A and posts the VersionId.', 'Riley');
    expect(a.ask).toMatch(/^Riley stopped and wrote what it needs below/);
    expect(a.detail).toBe('The owner reruns Step A and posts the VersionId.');
  });
});
