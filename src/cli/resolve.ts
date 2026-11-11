import type { Agent, Approval, Connector, Department, Gateway, Goal, Issue, Skill, WebhookDto } from '../api/types.js';
import type { Ctx } from './context.js';
import { CliError, EXIT } from './errors.js';

type Keys<T> = (item: T) => Array<string | null | undefined>;

/**
 * Find exactly one item by id, slug or name. Exact matches (case-insensitive)
 * win; otherwise a unique prefix is accepted. Several candidates is an error
 * that names them, never a silent pick.
 */
export function pick<T>(kind: string, needle: string, items: T[], keys: Keys<T>, describe: (item: T) => string, listHint?: string): T {
  const n = needle.trim().toLowerCase();
  const keysOf = (item: T) => keys(item).filter((k): k is string => typeof k === 'string' && k !== '').map((k) => k.toLowerCase());
  const exact = items.filter((it) => keysOf(it).includes(n));
  const found = exact.length ? exact : items.filter((it) => keysOf(it).some((k) => k.startsWith(n)));
  if (found.length === 1) return found[0]!;
  if (found.length === 0) {
    throw new CliError(`No ${kind} matches "${needle}".`, EXIT.failure, listHint ? [`list them: ${listHint}`] : [], 'not_found');
  }
  throw new CliError(
    `"${needle}" is ambiguous: ${found.length} ${kind}s match.`,
    EXIT.failure,
    [...found.slice(0, 10).map((it) => `  ${describe(it)}`), 'use the id to pick one'],
    'ambiguous',
  );
}

export async function resolveAgent(ctx: Ctx, org: string, needle: string): Promise<Agent> {
  const agents = await ctx.client().listAgents(org);
  return pick('agent', needle, agents, (a) => [a.id, a.slug, a.name], (a) => `${a.slug}  ${a.name} — ${a.role}  (${a.id})`, 'conductor agent list');
}

export async function resolveDept(ctx: Ctx, org: string, needle: string): Promise<Department> {
  const depts = await ctx.client().listDepartments(org);
  return pick('department', needle, depts, (d) => [d.id, d.slug, d.name], (d) => `${d.slug}  ${d.name}  (${d.id})`, 'conductor dept list');
}

export async function resolveGoal(ctx: Ctx, org: string, needle: string): Promise<Goal> {
  const goals = await ctx.client().listGoals(org);
  return pick('goal', needle, goals, (g) => [g.id, g.title], (g) => `${g.title}  (${g.id})`, 'conductor goal list');
}

/**
 * Issue reference → the key the API accepts: an id (`iss_…`) or the per-org
 * number, written `12`, `#12` or `ACME-12`.
 */
export function issueKey(ref: string): string {
  const r = ref.trim();
  if (/^iss_/i.test(r)) return r;
  const m = /^#?(\d+)$/.exec(r) ?? /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-(\d+)$/.exec(r);
  if (!m) throw new CliError(`"${ref}" is not an issue reference.`, EXIT.usage, ['use the number (12, #12, ACME-12) or the issue id (iss_…)'], 'usage');
  return String(Number(m[1]));
}

export function resolveIssue(ctx: Ctx, org: string, ref: string): Promise<Issue> {
  return ctx.client().getIssue(org, issueKey(ref));
}

/** `ACME-12` style key for display. */
export function issueLabel(orgSlug: string, issue: Pick<Issue, 'number'>): string {
  return `${orgSlug.toUpperCase()}-${issue.number}`;
}

export async function resolveSkill(ctx: Ctx, org: string, needle: string): Promise<Skill> {
  const skills = await ctx.client().listSkills(org, { includeGlobal: true });
  return pick('skill', needle, skills, (s) => [s.id, s.name], (s) => `${s.name}  ${s.scope}${s.scopeId ? `:${s.scopeId}` : ''}  v${s.version} ${s.status}  (${s.id})`, 'conductor skills list');
}

export async function resolveConnector(ctx: Ctx, org: string, needle: string): Promise<Connector> {
  const connectors = await ctx.client().listConnectors(org);
  return pick('connector', needle, connectors, (c) => [c.id, c.name, c.templateId], (c) => `${c.name}  ${c.kind}  (${c.id})`, 'conductor connector list');
}

export async function resolveGateway(ctx: Ctx, needle: string): Promise<Gateway> {
  const gateways = await ctx.client().listGateways();
  return pick('gateway', needle, gateways, (g) => [g.id, g.name], (g) => `${g.name}  ${g.kind}  (${g.id})`, 'conductor gateway list');
}

export async function resolveWebhook(ctx: Ctx, org: string, needle: string): Promise<WebhookDto> {
  const hooks = await ctx.client().listWebhooks(org);
  return pick('webhook', needle, hooks, (w) => [w.id, w.name], (w) => `${w.name}  ${w.direction}  (${w.id})`, 'conductor webhook list');
}

/** Approvals live in a cross-org inbox; the row tells us which org to decide in. */
export async function resolveApproval(ctx: Ctx, needle: string): Promise<Approval> {
  const explicit = ctx.globals.org;
  const all = explicit ? await ctx.client().listApprovals(explicit, { limit: 1000 }) : await ctx.client().approvalInbox({ limit: 1000 });
  return pick('approval', needle, all, (a) => [a.id], (a) => `${a.kind}: ${a.title}  [${a.status}]  (${a.id})`, 'conductor approvals list');
}

/** Agent id → display slug, for tables that only carry ids. */
export async function agentNames(ctx: Ctx, org: string): Promise<(id: string | null | undefined) => string> {
  const agents = await ctx.client().listAgents(org);
  const byId = new Map(agents.map((a) => [a.id, a.slug]));
  return (id) => (id ? byId.get(id) ?? id : '-');
}
