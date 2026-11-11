import type { Services } from '../daemon/container.js';
import type { Agent, Gateway, Organization } from '../contracts/rows.js';
import { OWNER } from '../contracts/types.js';
import { errorMessage, isConductorError } from '../shared/errors.js';
import { redact } from '../shared/util.js';
import type { Decisions } from './actions.js';
import type { GatewayChat, GatewayStore } from './store.js';
import type { GatewayAdapter, GatewayConfig, OutboundButton } from './types.js';
import { APPROVAL_ID_RE, ISSUE_ID_RE, SLUG_RE, normalizeId } from './util.js';

export const COMMAND_NAMES = [
  'help', 'start', 'pair', 'orgs', 'org', 'agents', 'agent', 'status', 'approvals', 'approve', 'deny',
  'accept', 'reject', 'issue', 'run', 'digest', 'stop',
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export interface ParsedCommand {
  name: CommandName;
  args: string;
}

/** `/name[@bot] [args]` — strict; returns null for anything that is not a known command. */
export function parseCommand(text: string): ParsedCommand | null {
  const m = /^\/([A-Za-z_]{1,32})(?:@[A-Za-z0-9_.-]{1,64})?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  if (!(COMMAND_NAMES as readonly string[]).includes(name)) return null;
  return { name: name as CommandName, args: (m[2] ?? '').trim() };
}

export const HELP_TEXT = [
  'Conductor commands',
  '/orgs — list organizations',
  '/org <slug> — choose the organization for this chat',
  '/agents — list agents',
  '/agent <slug> — choose who you are talking to',
  '/status — what is running',
  '/approvals — pending approvals',
  '/approve <id> — approve · /deny <id> [note] — deny',
  '/accept <issue> — accept a review · /reject <issue> [note] — send back',
  '/issue <title> — create an issue for the selected agent',
  '/run — wake the selected agent now',
  '/digest — the digest, on demand',
  '/stop — engage this organization\'s kill switch',
  '/help — this list',
  'Anything else is sent to the selected agent.',
].join('\n');

/** Everything a handler needs about the chat it is answering. */
export interface ChatContext {
  gateway: Gateway;
  config: GatewayConfig;
  adapter: GatewayAdapter;
  chatId: string;
  userId: string;
  reply(text: string, buttons?: OutboundButton[]): Promise<void>;
}

export interface CommandDeps {
  services: Services;
  store: GatewayStore;
  decisions: Decisions;
  digest(org: Organization): string;
}

const STOP_CONFIRM_TTL_MS = 2 * 60_000;
const NO_ORG = 'Choose an organization first: /orgs, then /org <slug>.';
const NO_AGENT = 'Choose who you are talking to first: /agents, then /agent <slug>.';

export class Commands {
  private pendingStops = new Map<string, { orgId: string; at: number }>();

  constructor(private readonly d: CommandDeps) {}

  /* ── scope resolution (shared with the chat path) ── */

  servedOrgs(gateway: Gateway): Organization[] {
    const all = this.d.services.org.listOrgs();
    return gateway.orgId ? all.filter((o) => o.id === gateway.orgId) : all;
  }

  currentOrg(gateway: Gateway, chat: GatewayChat | null): Organization | null {
    const orgs = this.servedOrgs(gateway);
    if (gateway.orgId) return orgs[0] ?? null;
    if (chat?.orgId) return orgs.find((o) => o.id === chat.orgId) ?? null;
    return orgs.length === 1 ? orgs[0]! : null;
  }

  currentAgent(org: Organization, chat: GatewayChat | null): Agent | null {
    const { org: orgService } = this.d.services;
    if (chat?.agentId && chat.orgId === org.id) {
      const agent = orgService.findAgent(org.id, chat.agentId);
      if (agent && agent.status !== 'terminated') return agent;
    }
    const candidates = orgService.listAgents(org.id).filter((a) => a.status !== 'terminated');
    return candidates.length === 1 ? candidates[0]! : null;
  }

  /* ── dispatch ── */

  async run(ctx: ChatContext, cmd: ParsedCommand): Promise<void> {
    try {
      await this.dispatch(ctx, cmd);
    } catch (err) {
      const msg = isConductorError(err) ? redact(err.message) : 'something went wrong';
      if (!isConductorError(err)) this.d.services.kernel.log.error({ err: errorMessage(err), gatewayId: ctx.gateway.id, command: cmd.name }, 'gateway command failed');
      await ctx.reply(`Could not do that: ${msg}`);
    }
  }

  private async dispatch(ctx: ChatContext, cmd: ParsedCommand): Promise<void> {
    switch (cmd.name) {
      case 'help':
      case 'start':
        return ctx.reply(HELP_TEXT);
      case 'pair':
        return ctx.reply('This chat is already paired.');
      case 'orgs':
        return this.orgs(ctx);
      case 'org':
        return this.selectOrg(ctx, cmd.args);
      case 'agents':
        return this.agents(ctx);
      case 'agent':
        return this.selectAgent(ctx, cmd.args);
      case 'status':
        return this.status(ctx);
      case 'approvals':
        return this.approvals(ctx);
      case 'approve':
      case 'deny':
        return this.decide(ctx, cmd.name, cmd.args);
      case 'accept':
      case 'reject':
        return this.reviewIssue(ctx, cmd.name, cmd.args);
      case 'issue':
        return this.createIssue(ctx, cmd.args);
      case 'run':
        return this.runNow(ctx);
      case 'digest':
        return this.digest(ctx);
      case 'stop':
        return this.stop(ctx, cmd.args);
    }
  }

  private chat(ctx: ChatContext): GatewayChat | null {
    return this.d.store.getChat(ctx.gateway.id, ctx.chatId);
  }

  private async orgs(ctx: ChatContext): Promise<void> {
    const orgs = this.servedOrgs(ctx.gateway);
    if (orgs.length === 0) return ctx.reply('No organizations yet.');
    const current = this.currentOrg(ctx.gateway, this.chat(ctx));
    const lines = orgs.map((o) => `${o.id === current?.id ? '→' : '•'} ${o.slug} — ${o.name}${o.killSwitch ? ' (kill switch engaged)' : ''}`);
    await ctx.reply(['Organizations:', ...lines, 'Select one with /org <slug>.'].join('\n'));
  }

  private async selectOrg(ctx: ChatContext, args: string): Promise<void> {
    const slug = args.toLowerCase();
    if (!SLUG_RE.test(slug)) return ctx.reply('Usage: /org <slug> — see /orgs.');
    const org = this.servedOrgs(ctx.gateway).find((o) => o.slug === slug);
    if (!org) return ctx.reply(`No organization "${slug}" here. See /orgs.`);
    const chat = this.chat(ctx);
    // Switching org drops the agent + conversation of the previous one.
    if (chat?.orgId === org.id) this.d.store.saveChat(ctx.gateway.id, ctx.chatId, { orgId: org.id });
    else this.d.store.saveChat(ctx.gateway.id, ctx.chatId, { orgId: org.id, agentId: null, issueId: null });
    await ctx.reply(`Organization: ${org.name}. Pick an agent with /agents.`);
  }

  private async agents(ctx: ChatContext): Promise<void> {
    const chat = this.chat(ctx);
    const org = this.currentOrg(ctx.gateway, chat);
    if (!org) return ctx.reply(NO_ORG);
    const agents = this.d.services.org.listAgents(org.id).filter((a) => a.status !== 'terminated');
    if (agents.length === 0) return ctx.reply(`${org.name} has no agents yet.`);
    const current = this.currentAgent(org, chat);
    const lines = agents.map((a) => `${a.id === current?.id ? '→' : '•'} ${a.slug} — ${a.name}, ${a.role}${a.status === 'paused' ? ' (paused)' : ''}`);
    await ctx.reply([`Agents in ${org.name}:`, ...lines, 'Select one with /agent <slug>.'].join('\n'));
  }

  private async selectAgent(ctx: ChatContext, args: string): Promise<void> {
    const slug = args.toLowerCase();
    if (!SLUG_RE.test(slug)) return ctx.reply('Usage: /agent <slug> — see /agents.');
    const chat = this.chat(ctx);
    const org = this.currentOrg(ctx.gateway, chat);
    if (!org) return ctx.reply(NO_ORG);
    const agent = this.d.services.org.listAgents(org.id).find((a) => a.slug === slug && a.status !== 'terminated');
    if (!agent) return ctx.reply(`No agent "${slug}" in ${org.name}. See /agents.`);
    const sameAgent = chat?.orgId === org.id && chat.agentId === agent.id;
    this.d.store.saveChat(ctx.gateway.id, ctx.chatId, sameAgent ? { orgId: org.id, agentId: agent.id } : { orgId: org.id, agentId: agent.id, issueId: null });
    await ctx.reply(`You are now talking to ${agent.name} (${agent.role}) in ${org.name}.`);
  }

  private async status(ctx: ChatContext): Promise<void> {
    const { runtime, governance } = this.d.services;
    const chat = this.chat(ctx);
    const org = this.currentOrg(ctx.gateway, chat);
    const s = runtime.status();
    const lines: string[] = [];
    if (org) {
      const agent = this.currentAgent(org, chat);
      lines.push(`Organization: ${org.name} (${org.slug})${governance.killSwitch.isEngaged(org.id) ? ' — KILL SWITCH ENGAGED' : ''}`);
      lines.push(agent ? `Talking to: ${agent.name} (${agent.slug}), ${agent.role}${agent.status === 'paused' ? ' — paused' : ''}` : 'Talking to: nobody yet (/agent <slug>)');
      lines.push(`Runs in this organization: ${s.perOrg[org.id] ?? 0}`);
      lines.push(`Pending approvals: ${governance.approvals.list(org.id, { status: 'pending' }).length}`);
    } else {
      lines.push('No organization selected (/org <slug>).');
    }
    if (!ctx.gateway.orgId) lines.push(`Daemon: ${s.running} running, ${s.queued} queued`);
    await ctx.reply(lines.join('\n'));
  }

  private async approvals(ctx: ChatContext): Promise<void> {
    const selected = this.currentOrg(ctx.gateway, this.chat(ctx));
    const orgs = selected ? [selected] : this.servedOrgs(ctx.gateway);
    const lines: string[] = [];
    for (const org of orgs) {
      for (const a of this.d.services.governance.approvals.list(org.id, { status: 'pending', limit: 20 })) {
        lines.push(`• ${a.title} [${a.kind}]${orgs.length > 1 ? ` (${org.slug})` : ''}\n  ${a.id}`);
      }
    }
    if (lines.length === 0) return ctx.reply('No pending approvals.');
    await ctx.reply(['Pending approvals:', ...lines, 'Decide with /approve <id> or /deny <id> [note].'].join('\n'));
  }

  private async decide(ctx: ChatContext, name: 'approve' | 'deny', args: string): Promise<void> {
    const [rawId = '', ...rest] = args.split(/\s+/);
    const id = normalizeId(rawId);
    if (!APPROVAL_ID_RE.test(id)) return ctx.reply(`Usage: /${name} <approval id>${name === 'deny' ? ' [note]' : ''} — see /approvals.`);
    const note = rest.join(' ').trim().slice(0, 1000) || undefined;
    const outcome = this.d.decisions.approval(ctx.gateway, id, name === 'approve' ? 'approved' : 'denied', note, ctx);
    await ctx.reply(outcome.text);
  }

  private async reviewIssue(ctx: ChatContext, name: 'accept' | 'reject', args: string): Promise<void> {
    const [rawRef = '', ...rest] = args.split(/\s+/);
    const note = rest.join(' ').trim().slice(0, 1000) || undefined;
    let issueId: string | null = null;
    const id = normalizeId(rawRef);
    if (ISSUE_ID_RE.test(id)) {
      issueId = id;
    } else if (/^#?\d{1,9}$/.test(rawRef)) {
      const org = this.currentOrg(ctx.gateway, this.chat(ctx));
      if (!org) return ctx.reply(NO_ORG);
      issueId = this.d.services.work.findIssue(org.id, Number(rawRef.replace('#', '')))?.id ?? null;
      if (!issueId) return ctx.reply(`No issue ${rawRef} in ${org.name}.`);
    }
    if (!issueId) return ctx.reply(`Usage: /${name} <issue id or #number>${name === 'reject' ? ' [note]' : ''}`);
    const outcome = this.d.decisions.review(ctx.gateway, issueId, name === 'accept' ? 'accepted' : 'rejected', note, ctx);
    await ctx.reply(outcome.text);
  }

  private async createIssue(ctx: ChatContext, args: string): Promise<void> {
    const title = args.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!title) return ctx.reply('Usage: /issue <title>');
    const chat = this.chat(ctx);
    const org = this.currentOrg(ctx.gateway, chat);
    if (!org) return ctx.reply(NO_ORG);
    const agent = this.currentAgent(org, chat);
    if (!agent) return ctx.reply(NO_AGENT);
    const issue = this.d.services.work.createIssue(org.id, { title, assigneeAgentId: agent.id, status: 'todo' }, OWNER);
    this.audit(ctx, org.id, 'issue', { issueId: issue.id, agentId: agent.id });
    await ctx.reply(`Created #${issue.number} "${issue.title}" for ${agent.name}.`);
  }

  private async runNow(ctx: ChatContext): Promise<void> {
    const chat = this.chat(ctx);
    const org = this.currentOrg(ctx.gateway, chat);
    if (!org) return ctx.reply(NO_ORG);
    const agent = this.currentAgent(org, chat);
    if (!agent) return ctx.reply(NO_AGENT);
    await this.d.services.runtime.runNow(org.id, agent.id, { trigger: 'manual' });
    this.audit(ctx, org.id, 'run', { agentId: agent.id });
    await ctx.reply(`${agent.name} has been woken up.`);
  }

  private async digest(ctx: ChatContext): Promise<void> {
    const selected = this.currentOrg(ctx.gateway, this.chat(ctx));
    const orgs = selected ? [selected] : this.servedOrgs(ctx.gateway);
    if (orgs.length === 0) return ctx.reply('No organizations yet.');
    for (const org of orgs) await ctx.reply(redact(this.d.digest(org)));
  }

  private async stop(ctx: ChatContext, args: string): Promise<void> {
    const { kernel, governance } = this.d.services;
    const key = `${ctx.gateway.id}:${ctx.chatId}`;
    const org = this.currentOrg(ctx.gateway, this.chat(ctx));
    if (!org) return ctx.reply(NO_ORG);
    const now = kernel.clock.now();

    if (args === '') {
      this.pendingStops.set(key, { orgId: org.id, at: now });
      return ctx.reply(`This engages the kill switch for ${org.name}: every running agent is stopped and nothing new starts. Send "/stop confirm" within 2 minutes to go ahead.`);
    }
    if (args.toLowerCase() !== 'confirm') return ctx.reply('Usage: /stop, then /stop confirm.');
    const pending = this.pendingStops.get(key);
    this.pendingStops.delete(key);
    if (!pending || pending.orgId !== org.id || now - pending.at > STOP_CONFIRM_TTL_MS) {
      return ctx.reply('Nothing to confirm. Send /stop first.');
    }
    governance.killSwitch.engage(org.id, OWNER);
    this.audit(ctx, org.id, 'stop', {});
    await ctx.reply(`Kill switch engaged for ${org.name}. Release it from the web UI or CLI when you are ready.`);
  }

  private audit(ctx: ChatContext, orgId: string, command: string, data: Record<string, unknown>): void {
    this.d.services.kernel.audit.record({
      orgId, actor: OWNER, action: 'gateway.command', entityKind: 'gateway', entityId: ctx.gateway.id,
      issueId: typeof data.issueId === 'string' ? data.issueId : undefined,
      data: { ...data, command, gatewayKind: ctx.gateway.kind, chatId: ctx.chatId, userId: ctx.userId },
    });
  }
}
