/**
 * Child process for the FR-4 multi-connection race (see checkout.test.ts).
 * Opens its own connection to the shared SQLite file, waits for the parent's
 * start signal, then races on the real WorkService.
 *
 * argv: home orgId mode(checkout|create) target label attempts
 */
import { createKernel, MemorySecretStore } from '../../src/kernel/index.js';
import type { OrgService } from '../../src/contracts/org-work.js';
import { OWNER } from '../../src/contracts/types.js';
import { createWorkService } from '../../src/work/index.js';

const [home, orgId, mode, target, label, attemptsArg] = process.argv.slice(2);
if (!home || !orgId || !mode || !target || !label || !attemptsArg) throw new Error('checkout-worker: missing arguments');
const attempts = Number(attemptsArg);

const kernel = createKernel({ home, secrets: new MemorySecretStore() });
// Human actors and checkout never consult the Org context.
const work = createWorkService(kernel, { org: {} as OrgService });

process.on('message', (msg: { startAt: number }) => {
  // Spin until the shared start instant so every process hits the database together.
  while (Date.now() < msg.startAt) {
    /* busy-wait */
  }
  const winners: string[] = [];
  const numbers: number[] = [];
  for (let i = 0; i < attempts; i++) {
    if (mode === 'checkout') {
      const runId = `run_${label}_${i}`;
      if (work.checkout(orgId, target, runId)) winners.push(runId);
    } else {
      numbers.push(work.createIssue(orgId, { title: `${target} ${label}-${i}` }, OWNER).number);
    }
  }
  process.send?.({ winners, numbers, attempts }, () => {
    kernel.close();
    process.exit(0);
  });
});

process.send?.({ ready: true });
