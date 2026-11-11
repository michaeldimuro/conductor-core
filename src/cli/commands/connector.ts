import type { Command } from 'commander';
import type { ConnectorTemplate, CreateWebhookRequest, GrantInput } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import type { Ctx } from '../context.js';
import { action, arg, choice, compact, flag, list, oneOf, parseJsonObject, str } from '../command.js';
import { UsageError } from '../errors.js';
import { clip } from '../output.js';
import { agentNames, pick, resolveAgent, resolveConnector, resolveGateway, resolveWebhook } from '../resolve.js';

const GATEWAY_KINDS = ['telegram', 'slack', 'discord', 'imessage', 'email'] as const;
const WEBHOOK_SOURCES = ['github', 'stripe', 'composio', 'generic'] as const;
const POLICIES = ['allowed', 'ask', 'off'] as const;

/**
 * Secret values for a connector template. `KEY=VALUE` works but leaks into
 * shell history; `KEY` alone (or a required secret not passed at all) is taken
 * from the environment variable of that name, else a hidden prompt.
 */
async function collectSecrets(ctx: Ctx, template: ConnectorTemplate, pairs: string[]): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  const wanted = new Set(template.requiredSecrets);
  let inline = false;
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    const key = (i === -1 ? pair : pair.slice(0, i)).trim();
    if (!key) throw new UsageError('--secret expects KEY=VALUE or KEY');
    wanted.add(key);
    if (i !== -1) {
      secrets[key] = pair.slice(i + 1);
      inline = true;
    }
  }
  if (inline) ctx.warn('secret values passed with --secret KEY=VALUE land in your shell history; pass --secret KEY to be prompted, or export KEY first');
  for (const key of wanted) {
    if (secrets[key]) continue;
    const fromEnv = ctx.deps.env[key];
    if (fromEnv) secrets[key] = fromEnv;
    else if (ctx.deps.stdinIsTTY) secrets[key] = await ctx.deps.prompt(`${key} for ${template.name} (input hidden): `, { hidden: true });
    if (!secrets[key]) {
      throw new UsageError(`${template.name} needs the secret ${key}`, [`export ${key}=… and re-run, or run interactively to be prompted`, ...(template.docsUrl ? [`where to get it: ${template.docsUrl}`] : [])]);
    }
  }
  return secrets;
}

function grantInput(opts: Record<string, unknown>): GrantInput {
  const allow = list(opts, 'allow');
  const ask = list(opts, 'ask');
  const off = list(opts, 'off');
  const clash = [...allow, ...ask].filter((t) => off.includes(t)).concat(allow.filter((t) => ask.includes(t)));
  if (clash.length) throw new UsageError(`a tool can only have one policy: ${[...new Set(clash)].join(', ')}`);
  const toolPolicies: NonNullable<GrantInput['toolPolicies']> = {};
  for (const t of allow) toolPolicies[t] = 'allowed';
  for (const t of ask) toolPolicies[t] = 'ask';
  for (const t of off) toolPolicies[t] = 'off';
  return compact({
    // --allow is an allowlist: the agent sees exactly the allowed and ask-first tools.
    toolAllowlist: allow.length ? [...allow, ...ask] : undefined,
    toolPolicies: Object.keys(toolPolicies).length ? toolPolicies : undefined,
    defaultPolicy: choice(opts, 'default', POLICIES),
  });
}

export function connectorCommands(program: Command, deps: CliDeps): void {
  const connector = program.command('connector').alias('connectors').description('connectors: MCP servers and toolkits agents can be granted');

  connector
    .command('catalog')
    .description('list connector templates you can install')
    .action(action(deps, async (ctx) => {
      const catalog = await ctx.client().connectorCatalog();
      ctx.emit(catalog, () => ctx.table(['template', 'name', 'category', 'kind', 'secrets', 'description'], catalog.map((t) => [t.id, t.name, t.category, t.kind, t.requiredSecrets.join(', '), clip(t.description, 60)])));
    }));

  connector
    .command('list')
    .description('list installed connectors')
    .action(action(deps, async (ctx) => {
      const o = await ctx.org();
      const [connectors, grants] = await Promise.all([ctx.client().listConnectors(o), ctx.client().listGrants(o)]);
      ctx.emit(connectors, () => ctx.table(
        ['name', 'kind', 'scope', 'status', 'grants', 'template', 'id'],
        connectors.map((c) => [c.name, c.kind, c.scope, c.status === 'error' && c.lastError ? `error: ${clip(c.lastError, 40)}` : c.status, grants.filter((g) => g.connectorId === c.id).length, c.templateId, c.id]),
        'no connectors yet — browse: conductor connector catalog',
      ));
    }));

  connector
    .command('install <template>')
    .description('install a connector from the catalog')
    .option('--name <name>', 'name for this connector')
    .option('--secret <pair>', 'secret the template needs, repeatable: KEY prompts (hidden) or reads $KEY; KEY=VALUE is accepted but lands in shell history', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--config <json>', 'extra non-secret config as a JSON object')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const template = pick('connector template', arg(args, 0, 'template'), await ctx.client().connectorCatalog(), (t) => [t.id, t.name], (t) => `${t.id}  ${t.name}`, 'conductor connector catalog');
      const secrets = await collectSecrets(ctx, template, Array.isArray(opts.secret) ? opts.secret.map(String) : []);
      const c = await ctx.client().installConnectorFromTemplate(o, compact({
        templateId: template.id,
        name: str(opts, 'name'),
        secrets: Object.keys(secrets).length ? secrets : undefined,
        config: str(opts, 'config') ? parseJsonObject(str(opts, 'config')!, '--config') : undefined,
      }));
      ctx.emit(c, () => {
        ctx.ok(`installed ${c.name} (${c.kind})`);
        ctx.line(`  no agent can use it yet — grant it: conductor connector grant ${c.name} <agent> [--allow tool,…] [--ask tool,…]`);
        ctx.line(`  see its tools: conductor connector tools ${c.name}`);
      });
    }));

  connector
    .command('grant <connector> <agent>')
    .description('let an agent use a connector, with per-tool policies')
    .option('--allow <tool,...>', 'allowlist: only these tools (plus --ask ones) are visible, and may be called freely')
    .option('--ask <tool,...>', 'tools that need your approval before each call')
    .option('--off <tool,...>', 'tools hidden from the agent')
    .option('--default <policy>', `policy for tools not listed (${POLICIES.join(' | ')})`)
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const [c, a] = await Promise.all([resolveConnector(ctx, o, arg(args, 0, 'connector')), resolveAgent(ctx, o, arg(args, 1, 'agent'))]);
      const input = grantInput(opts);
      const r = await ctx.client().grantConnector(o, c.id, a.id, input);
      ctx.emit(r, () => {
        if (r.grant) {
          const visible = r.grant.toolAllowlist ? `${r.grant.toolAllowlist.length} tools` : 'all tools';
          ctx.ok(`${a.slug} can use ${c.name}: ${visible}, default policy ${r.grant.defaultPolicy}`);
        } else if (r.approval) {
          ctx.line(`queued for approval: ${r.approval.title}\n  decide with: conductor approvals approve ${r.approval.id}`);
        }
      });
    }));

  connector
    .command('revoke <connector> <agent>')
    .description('take a connector away from an agent')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const [c, a] = await Promise.all([resolveConnector(ctx, o, arg(args, 0, 'connector')), resolveAgent(ctx, o, arg(args, 1, 'agent'))]);
      await ctx.client().revokeGrant(o, c.id, a.id);
      ctx.emit({ ok: true, connectorId: c.id, agentId: a.id }, () => ctx.ok(`${a.slug} can no longer use ${c.name}`));
    }));

  connector
    .command('tools <connector>')
    .description('list the tools a connector offers (connects to it)')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const c = await resolveConnector(ctx, o, arg(args, 0, 'connector'));
      const tools = await ctx.client().connectorTools(o, c.id);
      ctx.emit(tools, () => {
        ctx.table(['tool', 'trust', 'description'], tools.map((t) => [t.name, t.quarantined ? 'QUARANTINED' : 'trusted', clip(t.description, 90)]), 'the connector reports no tools');
        if (tools.some((t) => t.quarantined)) ctx.note(`quarantined tools changed upstream and are blocked until you re-trust them: conductor connector retrust ${c.name} <tool>`);
      });
    }));

  connector
    .command('retrust <connector> <tool>')
    .description('re-trust a tool whose upstream schema changed')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const c = await resolveConnector(ctx, o, arg(args, 0, 'connector'));
      const tool = arg(args, 1, 'tool');
      await ctx.client().retrustTool(o, c.id, tool);
      ctx.emit({ ok: true, connectorId: c.id, tool }, () => ctx.ok(`${tool} on ${c.name} is trusted again`));
    }));

  connector
    .command('remove <connector>')
    .description('uninstall a connector and its grants')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const c = await resolveConnector(ctx, o, arg(args, 0, 'connector'));
      await ctx.client().removeConnector(o, c.id);
      ctx.emit({ ok: true, connectorId: c.id }, () => ctx.ok(`removed ${c.name}`));
    }));

  const gateway = program.command('gateway').alias('gateways').description('messaging gateways: reach your agents from Telegram, Slack, Discord, iMessage or email');

  gateway
    .command('list')
    .description('list gateways (every org, or one with --org)')
    .action(action(deps, async (ctx) => {
      const gateways = await ctx.client().listGateways(ctx.globals.org ? { orgId: ctx.globals.org } : undefined);
      ctx.emit(gateways, () => ctx.table(
        ['name', 'kind', 'org', 'status', 'secret ref', 'id'],
        gateways.map((g) => [g.name, g.kind, g.orgId ?? 'all orgs', g.status === 'error' && g.lastError ? `error: ${clip(g.lastError, 40)}` : g.status, g.authRef, g.id]),
        'no gateways yet — add one: conductor gateway add telegram --name "My bot" --secret-ref conductor/telegram-bot-token',
      ));
    }));

  gateway
    .command('add <kind>')
    .description(`add a gateway (${GATEWAY_KINDS.join(', ')}); it serves every org unless --org is given`)
    .requiredOption('--name <name>', 'display name')
    .option('--config <json>', 'non-secret config as a JSON object (allowed chat ids, channel, …)')
    .option('--secret-ref <ref>', 'secret holding the bot token (store it with `conductor secret set <ref>`)')
    .option('--disabled', 'create it disabled')
    .action(action(deps, async (ctx, args, opts) => {
      const kind = oneOf(arg(args, 0, 'kind'), '<kind>', GATEWAY_KINDS);
      const authRef = str(opts, 'secretRef');
      const g = await ctx.client().createGateway(compact({
        kind,
        name: str(opts, 'name')!,
        orgId: ctx.globals.org,
        config: str(opts, 'config') ? parseJsonObject(str(opts, 'config')!, '--config') : undefined,
        authRef,
        status: flag(opts, 'disabled') ? ('disabled' as const) : undefined,
      }));
      const missing = authRef ? !(await ctx.client().secretExists(authRef)).exists : false;
      ctx.emit(g, () => {
        ctx.ok(`added ${g.kind} gateway ${g.name} (${g.orgId ? 'one org' : 'all orgs'})`);
        if (missing) ctx.line(`  the secret ${authRef} is not stored yet: conductor secret set ${authRef}`);
      });
    }));

  gateway
    .command('remove <gateway>')
    .description('remove a gateway')
    .action(action(deps, async (ctx, args) => {
      const g = await resolveGateway(ctx, arg(args, 0, 'gateway'));
      await ctx.client().deleteGateway(g.id);
      ctx.emit({ ok: true, gatewayId: g.id }, () => ctx.ok(`removed ${g.name}`));
    }));

  const webhook = program.command('webhook').alias('webhooks').description('webhooks: inbound triggers wake agents, outbound events notify other systems');

  webhook
    .command('list')
    .description('list webhooks')
    .action(action(deps, async (ctx) => {
      const o = await ctx.org();
      const hooks = await ctx.client().listWebhooks(o);
      if (ctx.json) return ctx.printJson(hooks);
      const name = await agentNames(ctx, o);
      ctx.table(
        ['name', 'dir', 'source', 'agent', 'status', 'endpoint', 'id'],
        hooks.map((w) => [w.name, w.direction, w.source, w.agentId ? name(w.agentId) : '-', w.status, w.direction === 'in' ? w.inboundUrl : w.url, w.id]),
        'no webhooks yet — add one: conductor webhook add in --name "GitHub" --source github --agent <agent>',
      );
    }));

  webhook
    .command('add <direction>')
    .description('add a webhook: `in` (an external service wakes an agent) or `out` (Conductor posts events to a URL)')
    .requiredOption('--name <name>', 'display name')
    .option('--source <source>', `inbound: who sends it (${WEBHOOK_SOURCES.join(', ')})`)
    .option('--agent <agent>', 'inbound: the agent to wake')
    .option('--target <url>', 'outbound: where to POST events')
    .option('--events <event,...>', 'event names to deliver or accept, e.g. issue.done,approval.requested')
    .option('--secret-ref <ref>', 'secret used to verify (in) or sign (out) deliveries')
    .action(action(deps, async (ctx, args, opts) => {
      const o = await ctx.org();
      const direction = oneOf(arg(args, 0, 'direction'), '<direction>', ['in', 'out'] as const);
      if (direction === 'out' && !str(opts, 'target')) throw new UsageError('an outbound webhook needs --target <url>');
      if (direction === 'in' && str(opts, 'target')) throw new UsageError('--target only applies to outbound webhooks');
      const events = list(opts, 'events');
      const input: CreateWebhookRequest = compact({
        direction,
        name: str(opts, 'name')!,
        source: choice(opts, 'source', WEBHOOK_SOURCES),
        agentId: str(opts, 'agent') ? (await resolveAgent(ctx, o, str(opts, 'agent')!)).id : undefined,
        url: str(opts, 'target'),
        events: events.length ? events : undefined,
        secretRef: str(opts, 'secretRef'),
      });
      const w = await ctx.client().createWebhook(o, input);
      ctx.emit(w, () => {
        ctx.ok(`added ${w.direction === 'in' ? 'inbound' : 'outbound'} webhook ${w.name}`);
        if (w.inboundUrl) ctx.line(`  point the external service at: ${w.inboundUrl}`);
      });
    }));

  webhook
    .command('remove <webhook>')
    .description('remove a webhook')
    .action(action(deps, async (ctx, args) => {
      const o = await ctx.org();
      const w = await resolveWebhook(ctx, o, arg(args, 0, 'webhook'));
      await ctx.client().deleteWebhook(o, w.id);
      ctx.emit({ ok: true, webhookId: w.id }, () => ctx.ok(`removed ${w.name}`));
    }));
}
