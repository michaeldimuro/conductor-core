import { goals } from '../db/schema/index.js';
import type { Actor, ProviderBinding } from '../contracts/types.js';
import type { Organization } from '../contracts/rows.js';
import type { OrgTemplate } from '../contracts/org-work.js';
import { ConductorError, notFound } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { assertBoard, type Ctx } from './context.js';
import { insertAgent } from './agents.js';
import { createDeptCore } from './departments.js';
import { createOrgCore } from './orgs.js';
import { createDeptSchema, createOrgSchema, fromTemplateSchema, hireAgentSchema, parse } from './schemas.js';
import { agency } from './templates/agency.js';
import { contentStudio } from './templates/content-studio.js';
import { saasStartup } from './templates/saas-startup.js';
import { soloOperator } from './templates/solo-operator.js';

const TEMPLATES: readonly OrgTemplate[] = [saasStartup, contentStudio, agency, soloOperator];

export function listTemplates(): OrgTemplate[] {
  return structuredClone(TEMPLATES) as OrgTemplate[];
}

/** Insert a goal row + audit + `goal.created`. Call inside `ctx.mutate`. */
export function insertGoal(
  ctx: Ctx,
  orgId: string,
  values: Omit<typeof goals.$inferInsert, 'orgId' | 'createdAt' | 'updatedAt' | 'id'> & { id?: string },
  actor: Actor,
): string {
  const k = ctx.kernel;
  const now = k.clock.now();
  const id = values.id ?? newId('goal');
  k.db.insert(goals).values({ ...values, id, orgId, createdAt: now, updatedAt: now }).run();
  k.audit.record({ orgId, actor, action: 'goal.created', entityKind: 'goal', entityId: id, data: { title: values.title } });
  ctx.after(() => k.bus.emit('goal.created', { orgId, goalId: id }));
  return id;
}

/**
 * Stand up a whole organization from a template in ONE transaction: org,
 * departments, agents (managers before their reports), lead seats and seed
 * goals. Either everything exists afterwards or nothing does.
 */
export function createFromTemplate(
  ctx: Ctx,
  templateId: string,
  raw: { name: string; mission?: string; defaultProvider?: ProviderBinding | null },
  actor: Actor,
): Organization {
  assertBoard(actor, 'create organizations');
  const template = TEMPLATES.find((t) => t.id === templateId);
  if (!template) throw notFound('org template', templateId);
  const input = parse(fromTemplateSchema, raw, 'template input');

  return ctx.mutate(() => {
    const org = createOrgCore(
      ctx,
      parse(createOrgSchema, { name: input.name, mission: input.mission ?? template.description, defaultProvider: input.defaultProvider }, 'organization'),
      actor,
      { note: `created from template ${template.id}`, audit: { templateId: template.id } },
    );

    const pending: Array<{ deptId: string; spec: OrgTemplate['departments'][number]['agents'][number] }> = [];
    for (const d of template.departments) {
      const dept = createDeptCore(ctx, org, parse(createDeptSchema, { name: d.name, charter: d.charter }, 'template department'), actor);
      for (const spec of d.agents) pending.push({ deptId: dept.id, spec });
    }

    // Hire top-down: an agent is hired once the role it reports to exists.
    const idByRole = new Map<string, string>();
    let remaining = pending;
    while (remaining.length > 0) {
      const next: typeof remaining = [];
      for (const item of remaining) {
        const { reportsToRole, ...rest } = item.spec;
        const managerId = reportsToRole === undefined ? null : idByRole.get(reportsToRole);
        if (managerId === undefined) {
          next.push(item);
          continue;
        }
        const agent = insertAgent(
          ctx,
          org,
          parse(hireAgentSchema, { ...rest, deptId: item.deptId, reportsTo: managerId }, 'template agent'),
          actor,
          { audit: { templateId: template.id } },
        );
        idByRole.set(agent.role, agent.id);
      }
      if (next.length === remaining.length) {
        throw new ConductorError('internal', `template ${template.id} has an unresolvable reportsToRole`, {
          roles: next.map((n) => n.spec.reportsToRole),
        });
      }
      remaining = next;
    }

    for (const g of template.goals ?? []) {
      insertGoal(ctx, org.id, { title: g.title, successMetric: g.successMetric ?? '', level: 'org' }, actor);
    }
    return org;
  });
}
