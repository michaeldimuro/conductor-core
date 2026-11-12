import { and, eq, gte, sql } from 'drizzle-orm';
import type { Kernel } from '../contracts/kernel.js';
import type { ApprovalService } from '../contracts/services.js';
import { textResult, type ToolCallContext, type ToolDef, type ToolResult } from '../contracts/tools.js';
import { approvals as approvalsTable, toolCalls } from '../db/schema/index.js';
import type { ApprovalKind } from '../db/schema/governance.js';
import { errorMessage, isConductorError } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { redact, sha256, stableStringify } from '../shared/util.js';
import type { AccessResolver } from './access.js';
import { callToolDef, findToolsDef, searchTools } from './meta.js';
import type { ToolRisk } from '../contracts/tools.js';
import type { ToolPolicy } from '../contracts/types.js';
import { classifyAction, type ActionCategory } from './actions.js';
import { ActionGates } from './gates.js';
import { assessCall, type CallIntent } from './intent.js';
import { argsPreview, escalate, isExternalRisk, redactArgs, resultSize, riskOfIntent, toolMatchKey, wrapUntrusted } from './risk.js';
import type { ConnectorStore } from './store.js';
import { AuthRequiredError, CALL_TOOL, FIND_TOOLS, META_SERVER, type ToolEntry } from './types.js';

type CallStatus = 'ok' | 'error' | 'denied' | 'approval_pending';

const TITLES: Record<string, string> = {
  payment: 'Payment', spend_threshold: 'Spend over threshold', new_recipient: 'First send to a new recipient', unknown_recipient: 'Send to an unidentified recipient', publish: 'Publish',
  credential_new_origin: 'Credential on a new site', destructive: 'Destructive action',
};

/** A reported per-call cost, when it is a sane non-negative USD amount. */
const validCost = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000 ? v : undefined);

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The single enforcement path for every tool call (direct, via `call_tool`, or over the MCP endpoint). */
export class ToolCalls {
  /** Runs known to have ingested untrusted content (mirrors runs.ingested_untrusted). */
  private readonly untrustedRuns = new Set<string>();
  private readonly gates: ActionGates;

  constructor(
    private readonly k: Kernel,
    private readonly store: ConnectorStore,
    private readonly access: AccessResolver,
    private readonly approvals: ApprovalService,
    private readonly deniedCooldownMs: number,
  ) {
    this.gates = new ActionGates(approvals);
  }

  endRun(runId: string): void {
    this.untrustedRuns.delete(runId);
    this.gates.endRun(runId);
  }

  async listTools(ctx: ToolCallContext): Promise<ToolDef[]> {
    const { direct, large } = await this.access.entries(ctx);
    const tools = direct.map((e) => ({ ...e.def, name: e.qualified }));
    if (large.length > 0) tools.push(findToolsDef([...new Set(large.map((e) => e.serverName))]), callToolDef());
    return tools;
  }

  async callTool(ctx: ToolCallContext, name: string, rawArgs: unknown): Promise<ToolResult> {
    const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
    if (typeof name !== 'string' || !name || !isPlainObject(args)) {
      return this.finish(ctx, { connectorId: META_SERVER, tool: String(name).slice(0, 200), args: {}, status: 'error', started: performance.now() },
        textResult('Invalid tool call: expected a tool name and an arguments object.', { isError: true }));
    }
    if (name === FIND_TOOLS) return this.findTools(ctx, args);
    if (name === CALL_TOOL) {
      const inner = args.name;
      const innerArgs = args.arguments ?? {};
      if (typeof inner !== 'string' || !inner || inner === CALL_TOOL || inner === FIND_TOOLS || !isPlainObject(innerArgs)) {
        return this.finish(ctx, { connectorId: META_SERVER, tool: CALL_TOOL, args, status: 'error', started: performance.now() },
          textResult('call_tool needs { name: "<server>__<tool>", arguments: { … } } with a name returned by find_tools.', { isError: true }));
      }
      return this.invoke(ctx, inner, innerArgs);
    }
    return this.invoke(ctx, name, args);
  }

  private async findTools(ctx: ToolCallContext, args: Record<string, unknown>): Promise<ToolResult> {
    const started = performance.now();
    const query = typeof args.query === 'string' ? args.query : '';
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : undefined;
    const { direct, large } = await this.access.entries(ctx);
    const matches = searchTools([...large, ...direct], query, limit);
    const text = JSON.stringify({
      query,
      matches: matches.map((e) => ({ name: e.qualified, description: e.def.description, inputSchema: e.def.inputSchema, risk: e.def.risk })),
      hint: matches.length ? 'Run one with call_tool({ name, arguments }).' : 'No matching tools. Try different keywords.',
    }, null, 2);
    return this.finish(ctx, { connectorId: META_SERVER, tool: FIND_TOOLS, args, status: 'ok', started }, textResult(text));
  }

  private ingestedUntrusted(ctx: ToolCallContext): boolean {
    return this.untrustedRuns.has(ctx.runId) || this.store.runIngestedUntrusted(ctx.orgId, ctx.runId);
  }

  private recentlyDenied(orgId: string, kind: ApprovalKind, matchKey: string): string | null {
    const row = this.k.db
      .select({ id: approvalsTable.id })
      .from(approvalsTable)
      .where(and(
        eq(approvalsTable.orgId, orgId), eq(approvalsTable.kind, kind), eq(approvalsTable.status, 'denied'),
        gte(approvalsTable.decidedAt, this.k.clock.now() - this.deniedCooldownMs),
        sql`json_extract(${approvalsTable.payload}, '$.matchKey') = ${matchKey}`,
      ))
      .get();
    return row?.id ?? null;
  }

  private async invoke(ctx: ToolCallContext, qualified: string, args: Record<string, unknown>): Promise<ToolResult> {
    const started = performance.now();
    const base = { tool: qualified.slice(0, 300), args, started };
    let resolution;
    try {
      resolution = await this.access.resolve(ctx, qualified);
    } catch (e) {
      return this.finish(ctx, { ...base, connectorId: qualified.split('__')[0]!.slice(0, 100), status: 'error' },
        textResult(`Tool server unavailable: ${redact(errorMessage(e))}`, { isError: true }));
    }
    if (resolution.kind === 'none') {
      // Unknown, not granted, off, outside the allowlist and quarantined all look the same to the agent.
      return this.finish(ctx, { ...base, connectorId: resolution.connectorId, status: 'denied' },
        textResult(`Tool "${qualified}" is not available to you. Use only the tools you were given.`, { isError: true }));
    }
    if (resolution.kind === 'auth') {
      return this.finish(ctx, { ...base, connectorId: resolution.connector.id, status: 'approval_pending', approvalId: resolution.approval.id },
        this.authPending(resolution.connector.name, resolution.approval.id, resolution.authUrl));
    }
    const entry = resolution.entry;
    const log = { ...base, connectorId: entry.connectorId };
    const untrustedBefore = this.ingestedUntrusted(ctx);
    const assessed = this.assess(entry, args);
    const { category, risk, policy, intent } = assessed;
    const escalated = escalate(policy, risk, ctx.autonomyLevel, untrustedBefore, category, intent?.egress ?? false);
    // Default approval gates (payment, spend threshold, first send, publish, org extras) come before the tool policy.
    const gate = this.gates.evaluate(ctx, risk === entry.def.risk ? entry : { ...entry, def: { ...entry.def, risk } }, args, category, untrustedBefore);
    const asked = escalated.policy === 'ask' ? escalated.reason ?? 'policy' : assessed.destructive ? 'destructive' : null;
    const ask = gate ?? (asked ? { kind: 'tool_call' as const, reason: asked, detail: intent ? { intent: intent.why } : {}, remember: [] } : null);
    let approvalId: string | undefined;

    if (ask) {
      const matchKey = toolMatchKey(ctx.agentId, qualified, args);
      const approved = this.approvals.consume(ctx.orgId, ask.kind, matchKey);
      if (approved) {
        approvalId = approved.id;
      } else {
        const open = this.approvals.findOpen(ctx.orgId, ask.kind, matchKey);
        if (open) {
          return this.finish(ctx, { ...log, status: 'approval_pending', approvalId: open.id }, textResult(
            `Still pending: "${qualified}" with these exact arguments is awaiting board approval (${open.id}). It has NOT run. ` +
            'Do not retry now — continue with other work or finish; you will be woken when it is decided, then repeat this exact call.'));
        }
        const denied = this.recentlyDenied(ctx.orgId, ask.kind, matchKey);
        if (denied) {
          return this.finish(ctx, { ...log, status: 'denied', approvalId: denied }, textResult(
            `The board denied this exact call (${denied}). It was not executed. Do not repeat it; choose a different approach or report back.`, { isError: true }));
        }
        const approval = this.approvals.request({
          orgId: ctx.orgId,
          kind: ask.kind,
          title: `${TITLES[ask.reason] ?? 'Tool call'}: ${qualified}`,
          payload: { matchKey, tool: qualified, connectorId: entry.connectorId, args: redactArgs(args), risk, category, reason: ask.reason, ...ask.detail },
          requesterAgentId: ctx.agentId,
          runId: ctx.runId,
          issueId: ctx.issueId,
        });
        return this.finish(ctx, { ...log, status: 'approval_pending', approvalId: approval.id }, textResult(
          `Approval required: "${qualified}" is awaiting board approval (${approval.id}). It has NOT been executed and will not run until approved. ` +
          'Continue with other work or finish this run. You will be woken when the decision is made; then repeat this exact call with the same arguments to execute it once.'));
      }
    }

    let result: ToolResult;
    let status: CallStatus = 'ok';
    let costUsd = 0;
    try {
      if (entry.builtin) {
        const r = await entry.builtin.call(ctx, entry.def.name, args);
        costUsd = validCost(r.costUsd) ?? 0;
        result = r.untrusted ? wrapUntrusted(r, qualified) : r;
      } else {
        const r = await this.access.callUpstream(ctx, entry, args);
        // What the upstream reported for this call, else the connector's flat per-call price.
        costUsd = validCost(r.costUsd) ?? validCost((entry.connector?.config as { costPerCallUsd?: unknown } | undefined)?.costPerCallUsd) ?? 0;
        // Anything an external-facing upstream tool returns is outside-world content.
        result = isExternalRisk(entry.def.risk) ? wrapUntrusted(r, qualified) : { content: r.content, ...(r.isError ? { isError: true } : {}) };
      }
      if (result.isError) status = 'error';
      else {
        this.gates.observe(ctx, entry, args);
        // The board approved this send / credential use: it is no longer "new".
        if (approvalId && ask) this.gates.remember(ctx.orgId, ask.remember);
      }
    } catch (e) {
      if (e instanceof AuthRequiredError && entry.connector) {
        const approval = this.access.requestAuth(ctx, entry.connector, entry.grant, e);
        return this.finish(ctx, { ...log, status: 'approval_pending', approvalId: approval.id }, this.authPending(entry.connector.name, approval.id, e.authUrl));
      }
      status = 'error';
      const message = isConductorError(e) ? e.message : `tool failed: ${errorMessage(e)}`;
      result = textResult(redact(message), { isError: true });
    }
    if (result.untrusted) {
      this.untrustedRuns.add(ctx.runId);
      this.store.markRunUntrusted(ctx.orgId, ctx.runId);
    }
    return this.finish(ctx, { ...log, status, approvalId, costUsd }, result);
  }

  /**
   * What this call actually does. For opaque executors (shell, HTTP proxy,
   * multi-action, code) the arguments decide (`intent.ts`): read-only and
   * ordinary calls run without the Ask-first that their tool name alone would
   * earn, destructive ones ask. An Ask-first the owner set on the grant always
   * stands; so does an explicit owner Allow, even for a destructive call.
   */
  private assess(entry: ToolEntry, args: Record<string, unknown>): {
    category: ActionCategory; risk: ToolRisk; policy: ToolPolicy; intent: CallIntent | null; destructive: boolean;
  } {
    const intent = assessCall(entry.def.name, args);
    if (!intent) {
      const category = classifyAction(entry.def.name, { builtin: !!entry.builtin, description: entry.def.description, annotations: entry.annotations, args });
      return { category, risk: entry.def.risk, policy: entry.policy, intent: null, destructive: false };
    }
    const byDefault = entry.policySource === 'default';
    const policy = byDefault && entry.policy === 'ask' && intent.level !== 'destructive' ? 'allowed' : entry.policy;
    const destructive = intent.level === 'destructive' && byDefault && policy === 'allowed';
    return { category: intent.category, risk: riskOfIntent(intent.level, entry.def.risk), policy, intent, destructive };
  }

  private authPending(connectorName: string, approvalId: string, authUrl: string | null): ToolResult {
    return textResult(
      `Connector "${connectorName}" needs a human to authorize its account before it can be used (approval ${approvalId}` +
      `${authUrl ? `, authorization URL sent to the board` : ''}). The call did NOT run. ` +
      'Continue with other work or finish; you will be woken when it is resolved, then repeat the same call.');
  }

  /** Log to `tool_calls` and the audit trail (hash + redacted preview only — never raw args). */
  private finish(
    ctx: ToolCallContext,
    call: { connectorId: string; tool: string; args: Record<string, unknown>; status: CallStatus; started: number; approvalId?: string; costUsd?: number },
    result: ToolResult,
  ): ToolResult {
    const id = newId('toolCall');
    const argsHash = sha256(stableStringify(call.args));
    const latencyMs = Math.max(0, Math.round(performance.now() - call.started));
    const size = resultSize(result.content);
    const costUsd = call.costUsd ?? 0;
    try {
      this.k.db.insert(toolCalls).values({
        id, orgId: ctx.orgId, runId: ctx.runId, agentId: ctx.agentId, issueId: ctx.issueId, connectorId: call.connectorId, tool: call.tool,
        argsHash, resultSize: size, latencyMs, costUsd, status: call.status, approvalId: call.approvalId ?? null, ts: this.k.clock.now(),
      }).run();
      this.k.audit.record({
        orgId: ctx.orgId,
        actor: { kind: 'agent', id: ctx.agentId, runId: ctx.runId },
        action: 'tool.called',
        entityKind: 'tool_call',
        entityId: id,
        runId: ctx.runId,
        issueId: ctx.issueId ?? undefined,
        data: {
          tool: call.tool, connectorId: call.connectorId, status: call.status, argsHash, argsPreview: argsPreview(call.args),
          resultSize: size, latencyMs, costUsd, approvalId: call.approvalId ?? null, untrusted: result.untrusted === true,
        },
      });
    } catch (e) {
      this.k.log.error({ err: errorMessage(e), tool: call.tool }, 'failed to log tool call');
    }
    return result;
  }
}
