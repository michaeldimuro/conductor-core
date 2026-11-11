/**
 * A stand-in for `conductord` that is meant to be SIGKILLed mid-run: the real
 * composition root on the home given in argv, one org, one agent (process
 * adapter), one assigned issue. Once the run is in flight (worker pid
 * journaled, agent process started) it writes a marker file and waits to die.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { createServices } from '../../../src/daemon/compose.js';
import { MemorySecretStore } from '../../../src/kernel/index.js';
import { OWNER } from '../../../src/contracts/types.js';

const [home, marker, flag, started] = process.argv.slice(2) as [string, string, string, string];

// Hangs until the test drops the flag file; after the restart it finishes at once.
const script = 'cat > /dev/null; if [ -f "$E2E_FLAG" ]; then echo "finished after restart"; else touch "$E2E_STARTED"; sleep 300; fi';

const s = await createServices({
  home, secrets: new MemorySecretStore(), config: { port: 1, host: '127.0.0.1' },
  runtime: { tickMs: 100, systemJobs: false, powerAssertion: false },
});
await s.runtime.start();

const org = s.org.createOrg({
  name: 'Crash Co',
  defaultProvider: { adapter: 'process', config: { command: '/bin/sh', args: ['-c', script], env: { E2E_FLAG: flag, E2E_STARTED: started } } },
}, OWNER);
const dept = s.org.createDept(org.id, { name: 'Engineering' }, OWNER);
const agent = s.org.hireAgent(org.id, { deptId: dept.id, name: 'Ada', role: 'Engineer', autonomyLevel: 2 }, OWNER).agent!; // no heartbeat cron
const issue = s.work.createIssue(org.id, { title: 'Survive a restart', assigneeAgentId: agent.id }, OWNER);

const timer = setInterval(() => {
  const run = s.runtime.listRuns(org.id, { issueId: issue.id })[0];
  if (!run?.pid || run.phase !== 'execute' || !existsSync(started)) return;
  clearInterval(timer);
  writeFileSync(marker, JSON.stringify({ orgId: org.id, agentId: agent.id, issueId: issue.id, runId: run.id, workerPid: run.pid, daemonPid: process.pid }));
}, 50);

// Stay alive until killed.
setInterval(() => {}, 1 << 30);
