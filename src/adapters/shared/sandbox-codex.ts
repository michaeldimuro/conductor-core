import type { RunContext, RunEvent } from '../../contracts/adapter.js';
import { announceSandbox, planSandbox, type SandboxRequest, type SandboxSpec } from './sandbox.js';

const INNER_MODE = /^sandbox_mode="?(read-only|workspace-write|danger-full-access)"?$/;
const BYPASS = '--dangerously-bypass-approvals-and-sandbox';
const FULL_ACCESS = 'sandbox_mode="danger-full-access"';

/**
 * Process sandbox for `codex exec`.
 *
 * Codex confines model-generated shell commands with its own seatbelt
 * profile, and seatbelt profiles do not nest: under an outer profile every
 * inner `sandbox-exec` fails with "sandbox_apply: Operation not permitted".
 * So exactly one of the two is in force per run:
 *
 *  - `workspace-write` / `danger-full-access` (or the bypass flag): the
 *    Conductor profile wraps the whole Codex process (workspace-confined
 *    writes, no access to Conductor's home or secret stores) and Codex is told
 *    not to add its own (`sandbox_mode="danger-full-access"`).
 *  - `read-only`: Codex's stricter no-write sandbox is kept and the process
 *    wrapper is skipped, since ours would allow workspace writes.
 *
 * The binding opts out with `config.processSandbox: false` (`config.sandbox`
 * is Codex's own mode on this adapter).
 */
export function codexSandbox(
  ctx: RunContext,
  emit: (e: RunEvent) => void,
  args: string[],
  req: Omit<SandboxRequest, 'cli' | 'binding'> = {},
): { args: string[]; sandbox?: SandboxSpec } {
  const modeIndex = args.findIndex((a, i) => i > 0 && args[i - 1] === '-c' && INNER_MODE.test(a));
  const inner = args.includes(BYPASS) ? 'bypass' : (INNER_MODE.exec(args[modeIndex] ?? '')?.[1] ?? 'workspace-write');
  const full: SandboxRequest = { ...req, cli: 'codex', binding: { value: ctx.config.processSandbox } };

  if (inner === 'read-only') {
    const plan = planSandbox(ctx, full);
    if (plan.spec) {
      emit({
        type: 'status',
        status: 'sandbox: Codex read-only sandbox in force; the Conductor process sandbox is skipped (seatbelt profiles do not nest)',
        sandbox: { enabled: false, reason: 'codex read-only sandbox in force (seatbelt profiles do not nest)' },
      });
      return { args };
    }
    announceSandbox(ctx, emit, plan, req);
    return { args };
  }

  const sandbox = announceSandbox(ctx, emit, planSandbox(ctx, full), req);
  if (!sandbox || inner !== 'workspace-write') return { args, ...(sandbox ? { sandbox } : {}) };
  const next = [...args];
  if (modeIndex >= 0) next[modeIndex] = FULL_ACCESS;
  else next.splice(1, 0, '-c', FULL_ACCESS);
  emit({ type: 'status', status: 'sandbox: Codex\'s own command sandbox is replaced by the Conductor process sandbox for this run' });
  return { args: next, sandbox };
}
